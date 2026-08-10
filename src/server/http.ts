import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { ToolContext } from "../types.js";
import { createServer as createMcpServer, createMonitorServer } from "./mcp-server.js";
import { SingleUserOAuthProvider, type OAuthConfig } from "../auth/oauth-provider.js";
import { verifyOwnerToken } from "../auth/owner-token.js";
import { registerActionRoutes } from "./actions.js";

/**
 * HTTP + OAuth 2.1 transport gateway (PRD §4 Transport Gateway, §5 CLI,
 * §7 auth, §11 SR-05/SR-12) exposing the configured MCP surface over a
 * Streamable HTTP `/mcp` endpoint. When CHATGPT2CODEX_ACTIONS_MODE is
 * `github-pr-monitor`, `/mcp` is monitor-only and exposes only the dynamic
 * read adapter; general mode keeps the regular catalog.
 *
 * Does not alter or remove the stdio transport path in src/cli.ts.
 */

export interface HttpServerConfig {
  /** Bind host, default 127.0.0.1 (loopback only unless overridden). */
  host: string;
  /** Bind port, default 7979 (PRD §5). */
  port: number;
  /** Public origin ChatGPT/clients will reach this server at, e.g.
   * https://my-tunnel.example.com. Used as the OAuth issuer/resource base
   * and to derive the allowed Origin/Host for DNS-rebinding defense. */
  publicUrl: string;
  /** Extra hostnames to allow in the Host header allowlist (SR-12), beyond
   * the host derived from publicUrl and standard loopback aliases. */
  extraAllowedHosts?: string[];
  oauth: {
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    scopes: string[];
    allowedRedirectHosts: string[];
  };
  /** Idle TTL for a session transport before it is evicted (NFR-03). */
  sessionTtlMs: number;
  /** Hard cap on concurrently tracked session transports (SR-09/NFR-03). */
  maxSessions: number;
  /** Optional process-level idle shutdown when no MCP sessions are active. */
  idleShutdownMs?: number;
  /** Called once after idleShutdownMs elapses with no active MCP sessions. */
  onIdleTimeout?: () => void;
}

export function defaultHttpServerConfig(overrides: Partial<HttpServerConfig> = {}): HttpServerConfig {
  return {
    host: "127.0.0.1",
    port: 7979,
    publicUrl: "http://127.0.0.1:7979",
    oauth: {
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 30 * 24 * 3600,
      scopes: ["chatgpt2codex"],
      allowedRedirectHosts: ["chatgpt.com", "chat.openai.com"],
    },
    sessionTtlMs: 30 * 60 * 1000,
    maxSessions: 100,
    ...overrides,
  };
}

type HttpMcpMode = "general" | "github-pr-monitor";
const ACTIONS_MODE_ENV = "CHATGPT2CODEX_ACTIONS_MODE";

function configuredHttpMcpMode(): HttpMcpMode {
  const raw = process.env[ACTIONS_MODE_ENV];
  if (raw === undefined) return "general";
  const mode = raw.trim().toLowerCase();
  if (mode === "") return "general";
  if (mode === "general" || mode === "github-pr-monitor") return mode;
  throw new Error(`${ACTIONS_MODE_ENV} must be either "general" or "github-pr-monitor".`);
}
interface TrackedSession {
  transport: StreamableHTTPServerTransport;
  lastActiveAtMs: number;
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function hashAuditValue(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

const TRUSTED_CHATGPT_ORIGINS = ["https://chatgpt.com", "https://chat.openai.com"] as const;
const OWNER_TOKEN_TOGGLE_SCRIPT = `
(() => {
  const input = document.getElementById("owner_token");
  const toggle = document.getElementById("owner_token_toggle");
  if (!(input instanceof HTMLInputElement) || !(toggle instanceof HTMLButtonElement)) return;

  const showLabel = toggle.dataset.labelShow || "Show owner token";
  const hideLabel = toggle.dataset.labelHide || "Hide owner token";
  const setVisible = (visible) => {
    input.type = visible ? "text" : "password";
    toggle.setAttribute("aria-pressed", String(visible));
    toggle.setAttribute("aria-label", visible ? hideLabel : showLabel);
  };

  toggle.addEventListener("click", () => setVisible(input.type === "password"));
  setVisible(false);
})();
`.trimStart();

/** SR-12: strict security headers applied to every response. The OAuth HTML
 * form is intentionally frameable by ChatGPT because connector authorization
 * may be shown inside ChatGPT's web UI. */
function securityHeaders(_req: Request, res: Response, next: () => void): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "script-src 'self'",
      `form-action 'self' ${TRUSTED_CHATGPT_ORIGINS.join(" ")}`,
      `frame-ancestors 'self' ${TRUSTED_CHATGPT_ORIGINS.join(" ")}`,
      "style-src 'unsafe-inline'",
    ].join("; "),
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

/** SR-05/SR-12: reject cross-origin browser requests to /mcp and the OAuth
 * endpoints whose Origin header does not match the configured public origin
 * or a loopback origin. Non-browser clients (no Origin header, e.g. the
 * ChatGPT backend or curl) are unaffected — Origin is only ever sent by
 * browsers, so this only closes the browser/DNS-rebinding attack surface. */
function makeOriginAllowlist(allowedOrigins: Set<string>) {
  return function originAllowlist(req: Request, res: Response, next: () => void): void {
    if (isOAuthBrowserFlowPath(req.path)) {
      next();
      return;
    }
    const origin = req.header("origin");
    if (!origin) {
      next();
      return;
    }
    if (allowedOrigins.has(origin)) {
      next();
      return;
    }
    sendJsonRpcError(res, 403, -32000, "Origin not allowed");
  };
}

function isOAuthBrowserFlowPath(pathName: string): boolean {
  return (
    pathName === "/authorize" ||
    pathName.startsWith("/authorize/") ||
    pathName === "/token" ||
    pathName.startsWith("/token/") ||
    pathName === "/register" ||
    pathName.startsWith("/register/") ||
    pathName === "/revoke" ||
    pathName.startsWith("/revoke/") ||
    pathName.startsWith("/.well-known/")
  );
}

export interface RunningHttpServer {
  app: Express;
  config: HttpServerConfig;
  close(): void;
}

export function createHttpServer(ctx: ToolContext, config: HttpServerConfig): RunningHttpServer {
  const mcpMode = configuredHttpMcpMode();
  const publicUrl = new URL(config.publicUrl);
  const mcpUrl = new URL("/mcp", publicUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);

  const loopbackHosts = ["127.0.0.1", "localhost", "[::1]", "::1"];
  const allowedHostnames = Array.from(
    new Set([publicUrl.hostname, ...loopbackHosts, ...(config.extraAllowedHosts ?? [])]),
  );
  // createMcpExpressApp's DNS-rebinding middleware matches Host headers
  // against this list; include host:port forms too since browsers/clients
  // typically send `Host: host:port`.
  const allowedHostHeaders = Array.from(
    new Set([
      ...allowedHostnames,
      `${publicUrl.hostname}:${publicUrl.port || (publicUrl.protocol === "https:" ? "443" : "80")}`,
      `127.0.0.1:${config.port}`,
      `localhost:${config.port}`,
    ]),
  );

  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: allowedHostHeaders,
  });
  // Cloudflare tunnels terminate on loopback and forward X-Forwarded-For; trust
  // only loopback proxies so express-rate-limit keys clients without warning.
  app.set("trust proxy", "loopback");
  app.use(securityHeaders);

  const allowedOrigins = new Set<string>([
    publicUrl.origin,
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    ...TRUSTED_CHATGPT_ORIGINS,
  ]);
  app.use(makeOriginAllowlist(allowedOrigins));

  const oauthConfig: OAuthConfig = {
    verifyOwnerToken: (candidate) => verifyOwnerToken(ctx.stateDir, candidate),
    accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
    scopes: config.oauth.scopes,
    allowedRedirectHosts: config.oauth.allowedRedirectHosts,
    onOwnerTokenAttempt: (event) =>
      ctx.ledger.append({
        type: "oauth.owner_token_attempt",
        outcome: event.outcome,
        clientIpHash: hashAuditValue(event.clientIp),
        clientIdHash: hashAuditValue(event.clientId),
        hasClientName: event.clientName !== undefined,
      }),
  };
  const oauthProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, ctx.stateDir);
  const oauthMetadata = createOAuthMetadata({
    provider: oauthProvider,
    issuerUrl: publicUrl,
    baseUrl: publicUrl,
    scopesSupported: config.oauth.scopes,
  });
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "chatgpt2codex"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: publicUrl,
      baseUrl: publicUrl,
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "chatgpt2codex",
    }),
  );

  app.get("/assets/owner-token-toggle.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("application/javascript").send(OWNER_TOKEN_TOGGLE_SCRIPT);
  });

  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.json(oauthMetadata);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "chatgpt2codex" });
  });

  app.get("/privacy", (_req, res) => {
    res
      .type("text/plain")
      .send(
        [
          "chatgpt2codex privacy notice",
          "",
          "chatgpt2codex is a local MCP/action bridge controlled by the owner of this server.",
          "Custom GPT Actions sent to this server are used only to select local projects, save/import ChatGPT images, list saved images, and check action status.",
          "The server stores operational audit entries and saved image files on the owner's local machine. It does not sell data, run advertising profiles, or call OpenAI Images/Codex APIs to generate images.",
          "Do not send secrets or unrelated personal data to this action bridge.",
        ].join("\n"),
      );
  });

  registerActionRoutes(app, ctx, publicUrl);

  // Per-session transport map with TTL + hard cap (NFR-03/SR-09): every
  // initialize request creates one transport, keyed by MCP session id.
  // Idle sessions are swept on a timer; the map never grows unbounded even
  // under a client that never sends a clean close.
  const sessions = new Map<string, TrackedSession>();
  let lastSessionActivityAtMs = Date.now();
  let idleShutdownQueued = false;

  function evictOldestSession(): void {
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, session] of sessions) {
      if (session.lastActiveAtMs < oldestAt) {
        oldestAt = session.lastActiveAtMs;
        oldestId = id;
      }
    }
    if (oldestId) {
      sessions.get(oldestId)?.transport.close();
      sessions.delete(oldestId);
    }
  }

  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActiveAtMs > config.sessionTtlMs) {
        session.transport.close();
        sessions.delete(id);
      }
    }
    if (
      config.idleShutdownMs !== undefined &&
      config.idleShutdownMs > 0 &&
      sessions.size === 0 &&
      now - lastSessionActivityAtMs > config.idleShutdownMs &&
      !idleShutdownQueued
    ) {
      idleShutdownQueued = true;
      setImmediate(() => config.onIdleTimeout?.());
    }
  }, Math.min(config.sessionTtlMs, config.idleShutdownMs ?? 60_000, 60_000));
  sweepInterval.unref();

  app.all("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    }).catch(() => undefined);
    if (res.headersSent) return;

    if (
      !req.auth?.resource ||
      !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })
    ) {
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    try {
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId) {
        const tracked = sessions.get(sessionId);
        if (!tracked) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
        tracked.lastActiveAtMs = Date.now();
        lastSessionActivityAtMs = tracked.lastActiveAtMs;
        transport = tracked.transport;
      } else if (initializeRequest) {
        if (sessions.size >= config.maxSessions) evictOldestSession();

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) {
              lastSessionActivityAtMs = Date.now();
              sessions.set(newSessionId, { transport, lastActiveAtMs: lastSessionActivityAtMs });
            }
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) sessions.delete(closedSessionId);
        };

        // Mark this session remote: it's how ChatGPT (and any other network
        // MCP client) connects, so project_select preset=control must be
        // refused here even when the desktop-control tools are exposed to
        // ChatGPT (see src/server/tools.ts project_select handler /
        // isControlChatGptExposed) — lease arming stays local-only (stdio).
        const mcpServer = mcpMode === "github-pr-monitor"
          ? await createMonitorServer({ ...ctx, remote: true })
          : await createMcpServer({ ...ctx, remote: true });
        await mcpServer.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, error instanceof Error ? error.message : "Internal server error");
      }
    }
  });

  let closed = false;
  return {
    app,
    config,
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(sweepInterval);
      for (const session of sessions.values()) session.transport.close();
      sessions.clear();
      oauthProvider.close();
    },
  };
}
