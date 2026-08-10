import { createServer as createNodeServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { storeOwnerToken } from "../auth/owner-token.js";
import type { ToolContext } from "../types.js";
import { createHttpServer, defaultHttpServerConfig } from "./http.js";

/**
 * End-to-end proof that the remote `/mcp` surface in github-pr-monitor mode is
 * least privilege: it exposes only the dynamic read operation and does not
 * register deferred state, mutation, or desktop-control tools.
 */

const OWNER_TOKEN = "unit-test-owner-token-mcp-remote";

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomPkceVerifier(): string {
  return base64Url(randomBytes(32));
}

function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

async function getFreePort(): Promise<number> {
  const server = createNodeServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

function makeCtx(stateDir: string, projectRoot: string): ToolContext {
  const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }];
  let currentSession: unknown = { activeProjectId: null, mode: "observe", lease: null };
  return {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => currentSession,
      setSession: async (next) => {
        currentSession = next;
      },
    },
    config: {
      workspaceRoot: path.dirname(projectRoot),
      stateDir,
      maxReadBytes: 10 * 1024 * 1024,
      maxPatchBytes: 10 * 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

async function startApp(ctx: ToolContext): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const port = await getFreePort();
  const running = createHttpServer(ctx, defaultHttpServerConfig({ host: "127.0.0.1", port, publicUrl: `http://127.0.0.1:${port}` }));
  const server: Server = running.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      running.close();
    },
  };
}

async function registerOAuthClient(baseUrl: string): Promise<{ clientId: string; redirectUri: string }> {
  const redirectUri = "https://chatgpt.com/aip/gpt/oauth/callback";
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ChatGPT",
    }),
  });
  const body = (await res.json()) as { client_id?: string };
  return { clientId: String(body.client_id), redirectUri };
}

async function getMcpAccessToken(baseUrl: string): Promise<string> {
  const client = await registerOAuthClient(baseUrl);
  const verifier = randomPkceVerifier();
  const url = new URL("/authorize", baseUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "chatgpt2codex");
  url.searchParams.set("state", "unit-test-state");
  url.searchParams.set("resource", `${baseUrl}/mcp`);

  const pageRes = await fetch(url, { headers: { origin: "https://chatgpt.com" } });
  const page = await pageRes.text();
  const csrfToken = page.match(/name="csrf_token" value="([^"]+)"/u)?.[1];

  const body = new URLSearchParams(url.searchParams);
  body.set("csrf_token", String(csrfToken));
  body.set("owner_token", OWNER_TOKEN);

  const authRes = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: { origin: "https://chatgpt.com", "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
  const redirectUrl = new URL(String(authRes.headers.get("location")));
  const code = String(redirectUrl.searchParams.get("code"));

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    code,
    code_verifier: verifier,
    resource: `${baseUrl}/mcp`,
  });
  const tokenRes = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokenJson)}`);
  return tokenJson.access_token;
}

async function connectMcpClient(baseUrl: string, accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "unit-test-remote-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("remote MCP session (/mcp) exposes the read-only dynamic monitor surface", () => {
  let stateDir: string;
  let projectRoot: string;
  let stop: (() => Promise<void>) | undefined;
  let client: Client | undefined;

  beforeEach(async () => {
    process.env.CHATGPT2CODEX_ACTIONS_MODE = "github-pr-monitor";
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-mcp-remote-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-mcp-remote-project-"));
    await storeOwnerToken(stateDir, OWNER_TOKEN);
  });

  afterEach(async () => {
    delete process.env.CHATGPT2CODEX_ACTIONS_MODE;
    await client?.close().catch(() => undefined);
    client = undefined;
    await stop?.();
    stop = undefined;
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  }, 15_000);

  it("lists exactly the dynamic read operation with read-only annotations", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const app = await startApp(ctx);
    stop = app.stop;

    const token = await getMcpAccessToken(app.baseUrl);
    client = await connectMcpClient(app.baseUrl, token);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["github_pr_monitor_read"]);
    expect(listed.tools[0]).toMatchObject({
      name: "github_pr_monitor_read",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId", "actionPlanId"],
      },
    });
    expect((listed.tools[0]?.inputSchema as { properties?: Record<string, unknown> }).properties).toEqual({
      runId: expect.any(Object),
      actionPlanId: expect.any(Object),
    });
    expect(listed.tools[0]).not.toHaveProperty("outputSchema");
  }, 20_000);

  it("rejects deferred state, mutation, and control tools over the same remote session", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const app = await startApp(ctx);
    stop = app.stop;

    const token = await getMcpAccessToken(app.baseUrl);
    client = await connectMcpClient(app.baseUrl, token);

    for (const name of [
      "github_pr_monitor_state",
      "github_pr_monitor_prepare",
      "github_pr_monitor_execute",
      "github_pr_monitor_mutate",
      "project_select",
      "computer_request_action",
    ]) {
      const result = (await client.callTool({ name, arguments: {} })) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("not found");
    }
  }, 20_000);
});
