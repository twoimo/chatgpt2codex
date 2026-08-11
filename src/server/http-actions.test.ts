import { createServer as createNodeServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeOwnerToken } from "../auth/owner-token.js";
import type { Lease, ToolContext } from "../types.js";
import { createHttpServer, defaultHttpServerConfig } from "./http.js";
import {
  COMMENTS_QUERY,
  LATEST_REVIEWS_QUERY,
  MAX_TEXT_BYTES,
  MAX_WIRE_BYTES,
  REVIEW_REQUESTS_QUERY,
  REVIEW_THREADS_QUERY,
  REVIEWS_QUERY,
  SEARCH_QUERY,
  THREAD_COMMENTS_QUERY,
} from "./github-pr-monitor-contract.js";
import type { GithubPrMonitorReadOptions, GhCommand } from "./github-pr-monitor-read.js";

const OWNER_TOKEN = "unit-test-owner-token-123456";

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
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

async function startApp(ctx: ToolContext): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const port = await getFreePort();
  const running = createHttpServer(
    ctx,
    defaultHttpServerConfig({
      host: "127.0.0.1",
      port,
      publicUrl: `http://127.0.0.1:${port}`,
    }),
  );
  const server: Server = running.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      running.close();
    },
  };
}

function makeCtx(stateDir: string, projectRoot: string): ToolContext {
  const registry = [
    {
      projectId: "proj",
      name: "proj",
      root: projectRoot,
      aliases: [],
    },
  ];
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

async function postAction(baseUrl: string, pathName: string, body: unknown, token = OWNER_TOKEN): Promise<Response> {
  return fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
function fakeMonitorReadGh(calls: string[][], options: { hostileThreadPath?: string } = {}): GhCommand {
  return async (args) => {
    calls.push([...args]);
    if (args[0] === "api" && args[1] === "user") return { stdout: "alice\n", code: 0 };
    if (args[0] === "api" && args[1] === "graphql" && args.includes(`query=${SEARCH_QUERY}`)) {
      const nodes = options.hostileThreadPath
        ? [{ __typename: "PullRequest", number: 1, repository: { id: "repo-1", nameWithOwner: "acme/repo" } }]
        : [];
      return {
        stdout: JSON.stringify({
          data: { search: { issueCount: nodes.length, nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
        code: 0,
      };
    }
    if (options.hostileThreadPath && args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          number: 1,
          url: "https://github.com/acme/repo/pull/1",
          state: "OPEN",
          author: { login: "alice" },
          baseRefName: "main",
          headRefName: "feature",
          baseRefOid: "A".repeat(40),
          headRefOid: "B".repeat(40),
          headRepository: { id: "head-1", name: "fork", nameWithOwner: "acme/fork" },
          statusCheckRollup: [],
        }),
        code: 0,
      };
    }
    if (!options.hostileThreadPath || args[0] !== "api" || args[1] !== "graphql") {
      throw new Error(`unexpected fake gh command: ${args.join(" ")}`);
    }
    const query = args.find((value) => value.startsWith("query="))?.slice("query=".length);
    const repository = { id: "repo-1", nameWithOwner: "acme/repo" };
    const pullRequest = { author: { login: "alice", __typename: "User" } };
    const connection = (nodes: unknown[] = []) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    if (query === REVIEW_REQUESTS_QUERY) {
      return { stdout: JSON.stringify({ data: { repository: { ...repository, pullRequest: { ...pullRequest, reviewRequests: connection([{ requestedReviewer: { login: "alice", __typename: "User" } }]) } } } }), code: 0 };
    }
    if (query === REVIEWS_QUERY || query === COMMENTS_QUERY || query === LATEST_REVIEWS_QUERY) {
      const field = query === REVIEWS_QUERY ? "reviews" : query === COMMENTS_QUERY ? "comments" : "latestReviews";
      return { stdout: JSON.stringify({ data: { repository: { ...repository, pullRequest: { ...pullRequest, [field]: connection() } } } }), code: 0 };
    }
    if (query === REVIEW_THREADS_QUERY) {
      return { stdout: JSON.stringify({ data: { repository: { ...repository, pullRequest: { reviewThreads: connection([{ id: "thread-1", isResolved: false, isOutdated: false }]) } } } }), code: 0 };
    }
    if (query === THREAD_COMMENTS_QUERY) {
      return {
        stdout: JSON.stringify({
          data: {
            node: {
              __typename: "PullRequestReviewThread",
              id: "thread-1",
              isResolved: false,
              isOutdated: false,
              comments: connection([{
                id: "comment-1",
                body: "hostile path",
                author: { login: "alice", __typename: "User" },
                path: options.hostileThreadPath,
              }]),
            },
          },
        }),
        code: 0,
      };
    }
    throw new Error(`unexpected fake GraphQL query: ${query}`);
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

  expect(res.status).toBe(201);
  expect(body.client_id).toBeTruthy();
  return { clientId: String(body.client_id), redirectUri };
}

function authorizeUrl(baseUrl: string, clientId: string, redirectUri: string): URL {
  const url = new URL("/authorize", baseUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", "unit-test-code-challenge");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "chatgpt2codex");
  url.searchParams.set("state", "unit-test-state");
  url.searchParams.set("resource", `${baseUrl}/mcp`);
  return url;
}

async function authorizeWithOwnerToken(
  baseUrl: string,
  client: { clientId: string; redirectUri: string },
  codeChallenge: string,
): Promise<string> {
  const url = authorizeUrl(baseUrl, client.clientId, client.redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  const pageRes = await fetch(url, { headers: { origin: "https://chatgpt.com" } });
  const page = await pageRes.text();
  const csrfToken = page.match(/name="csrf_token" value="([^"]+)"/u)?.[1];

  expect(pageRes.status).toBe(200);
  expect(csrfToken).toBeTruthy();

  const body = new URLSearchParams(url.searchParams);
  body.set("csrf_token", String(csrfToken));
  body.set("owner_token", OWNER_TOKEN);

  const res = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: {
      origin: "https://chatgpt.com",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    redirect: "manual",
  });
  const location = res.headers.get("location");
  const redirectUrl = new URL(location ?? "http://missing.invalid");

  expect(res.status).toBe(302);
  expect(redirectUrl.origin).toBe("https://chatgpt.com");
  expect(redirectUrl.searchParams.get("state")).toBe("unit-test-state");
  const code = redirectUrl.searchParams.get("code");
  expect(code).toMatch(/^code-/u);
  return String(code);
}

describe("Custom GPT action bridge", () => {
  let stateDir: string;
  let projectRoot: string;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    delete process.env.CHATGPT2CODEX_ACTIONS_MODE;
    process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = "enabled";
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-actions-state-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-actions-project-"));
    await storeOwnerToken(stateDir, OWNER_TOKEN);
  });

  afterEach(async () => {
    delete process.env.CHATGPT2CODEX_ACTIONS_MODE;
    delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
    if (stop) {
      await stop();
      stop = undefined;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("serves an OpenAPI schema for GPT Actions", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/actions/openapi.json`);
    const body = (await res.json()) as {
      openapi: string;
      info: {
        version: string;
        description: string;
        "x-chatgpt2codex-tool-proof"?: { namespace?: string };
        "x-chatgpt2codex-openapi-operation-count"?: number;
        "x-chatgpt2codex-tool-names"?: string[];
      };
      servers: Array<{ url: string }>;
      paths: Record<string, { get?: { operationId?: string }; post?: { summary?: string; description?: string; operationId?: string } } | unknown>;
      components: {
        schemas: {
          CallToolInput: { properties: Record<string, unknown> };
          GoalIntakeInput: Record<string, unknown>;
          GoalLoopInput: Record<string, unknown>;
          E2eRunCommandInput: Record<string, unknown>;
          E2eTestAndShowScreenshotInput: Record<string, unknown>;
          E2eScreenshotInput: Record<string, unknown>;
          E2eStartServerInput: Record<string, unknown>;
          FileApplyPatchInput: { properties: Record<string, unknown> };
          FileCreateInput: { properties: Record<string, unknown> };
          ActionToolResponse: { required?: string[]; properties: Record<string, unknown> };
          ToolCallProof: Record<string, unknown>;
          ToolAvailabilityGate: Record<string, unknown>;
        };
      };
    };

    expect(res.status).toBe(200);
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.version).toBe("0.1.6");
    expect(body.info.description).toContain("Monitor authorities are not exposed on Actions");
    expect(body.info.description).toContain("cannot write /Users/");
    expect(body.info["x-chatgpt2codex-tool-proof"]?.namespace).toBe("ChatGPT_To_Codex");
    expect(body.info["x-chatgpt2codex-openapi-operation-count"]).toBeLessThanOrEqual(30);
    expect(body.info["x-chatgpt2codex-tool-names"]).toContain("workspace_list_projects");
    expect(body.info["x-chatgpt2codex-tool-names"]).toContain("e2e_test_and_show_screenshot");
    expect(body.info["x-chatgpt2codex-tool-names"]).not.toContain("code_context_pack");
    for (const path of Object.values(body.paths)) {
      if (!path || typeof path !== "object") continue;
      for (const operation of [path.get, path.post]) {
        if (!operation?.description) continue;
        expect(operation.description.length).toBeLessThanOrEqual(300);
      }
    }
    expect(body.servers[0]?.url).toBe(server.baseUrl);
    expect(body.paths["/actions/call-tool"]).toBeDefined();
    expect((body.paths["/actions/call-tool"] as { post: { operationId: string } }).post.operationId).toBe("call_tool");
    expect(body.paths["/actions/file-apply-patch"]).toBeDefined();
    expect((body.paths["/actions/file-apply-patch"] as { post: { operationId: string } }).post.operationId).toBe("file_apply_patch");
    expect(body.paths["/actions/file-create"]).toBeDefined();
    expect(body.paths["/actions/local-shell-run"]).toBeDefined();
    expect((body.paths["/actions/local-shell-run"] as { post: { operationId: string } }).post.operationId).toBe("local_shell_run");
    expect(body.paths["/actions/goal-intake"]).toBeDefined();
    expect(body.paths["/actions/goal-loop"]).toBeDefined();
    expect(body.paths["/actions/e2e-start-server"]).toBeDefined();
    expect(body.paths["/actions/e2e-run-command"]).toBeDefined();
    expect(body.paths["/actions/e2e-test-and-show-screenshot"]).toBeDefined();
    expect((body.paths["/actions/e2e-test-and-show-screenshot"] as { post: { operationId: string } }).post.operationId).toBe(
      "e2e_test_and_show_screenshot",
    );
    expect(body.paths["/actions/e2e-screenshot"]).toBeDefined();
    expect(body.paths["/actions/e2e-open-url-screenshot"]).toBeDefined();
    expect(body.paths["/actions/code-context-pack"]).toBeUndefined();
    expect(body.info.description).toContain("goal_intake");
    expect(body.info.description).toContain("goal_loop");
    expect(body.info.description).toContain("code_search followed by narrow file_read_slice");
    expect(body.info.description).toContain("E2E server/app launch plus screenshot capture");
    expect(body.paths["/actions/save-visible-chatgpt-images"]).toBeUndefined();
    expect(body.paths["/actions/chatgpt-image-loop"]).toBeUndefined();
    expect(body.paths["/actions/generate-chatgpt-image"]).toBeUndefined();
    expect(body.paths["/actions/workspace-refresh-index"]).toBeUndefined();
    expect(body.paths["/actions/checkpoint-list"]).toBeUndefined();
    expect(body.paths["/actions/project-select"]).toBeDefined();
    expect((body.paths["/actions/project-select"] as { post: { operationId: string } }).post.operationId).toBe("project_select");
    expect(body.components.schemas.GoalIntakeInput).toBeDefined();
    expect(body.components.schemas.GoalLoopInput).toBeDefined();
    expect(body.components.schemas.E2eRunCommandInput).toBeDefined();
    expect(body.components.schemas.E2eTestAndShowScreenshotInput).toBeDefined();
    expect((body.components.schemas.E2eTestAndShowScreenshotInput as { properties?: Record<string, unknown> }).properties?.serverCommand).toBeUndefined();
    expect((body.components.schemas.E2eTestAndShowScreenshotInput as { properties?: Record<string, unknown> }).properties?.testCommand).toBeUndefined();
    expect((body.components.schemas.E2eTestAndShowScreenshotInput as { properties?: Record<string, unknown> }).properties?.waitUrl).toBeUndefined();
    expect(body.components.schemas.E2eScreenshotInput).toBeDefined();
    expect(body.components.schemas.E2eStartServerInput).toBeDefined();
    expect(body.components.schemas.CallToolInput.properties.toolName).toBeDefined();
    expect(body.components.schemas.FileApplyPatchInput.properties.patch).toBeDefined();
    expect(body.components.schemas.FileCreateInput.properties.content).toBeDefined();
    expect(body.components.schemas.ActionToolResponse.required).toContain("toolCall");
    expect(body.components.schemas.ActionToolResponse.properties.toolCall).toBeDefined();
    expect(body.components.schemas.ToolCallProof).toBeDefined();
    expect(body.components.schemas.ToolAvailabilityGate).toBeDefined();
    expect((body.paths["/actions/import-chatgpt-image-url"] as { post: { description: string } }).post.description).toContain(
      "Device-agnostic",
    );
    expect((body.paths["/actions/import-chatgpt-image-url"] as { post: { description: string } }).post.description).toContain(
      "chatgpt.com/s/m_...",
    );
  });


  it("dispatches the dedicated monitor read route through an injected gh runner", async () => {
    process.env.CHATGPT2CODEX_ACTIONS_MODE = "github-pr-monitor";
    const calls: string[][] = [];
    const ctx = makeCtx(stateDir, projectRoot) as ToolContext & { githubPrMonitorReadOptions?: GithubPrMonitorReadOptions };
    ctx.githubPrMonitorReadOptions = {
      gh: fakeMonitorReadGh(calls),
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      nonce: () => "http-test-nonce",
      deadlineMs: 2_000,
    };
    const server = await startApp(ctx);
    stop = server.stop;

    const response = await postAction(server.baseUrl, "/actions/github-pr-monitor-read", {
      runId: "http-run",
      actionPlanId: "http-plan",
    });
    const body = (await response.json()) as {
      ok: boolean;
      tool: string;
      text?: string;
      structuredContent?: { account?: { login?: string }; discovery?: { uniqueCandidateCount?: number }; chatgpt2codexToolCall?: { ok?: boolean } };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      tool: "github_pr_monitor_read",
      structuredContent: {
        account: { login: "alice" },
        discovery: { uniqueCandidateCount: 0 },
        chatgpt2codexToolCall: { ok: true },
      },
    });
    expect(Buffer.byteLength(body.text ?? "", "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThanOrEqual(MAX_WIRE_BYTES);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["api", "user", "--jq", ".login"]);
  });
  it("exposes only dedicated write routes in explicit write mode and fails closed without a session", async () => {
    process.env.CHATGPT2CODEX_ACTIONS_MODE = "github-pr-monitor-write";
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const openapi = await fetch(`${server.baseUrl}/actions/openapi.json`).then((response) => response.json()) as {
      paths: Record<string, unknown>;
      info: { description: string };
    };
    expect(Object.keys(openapi.paths)).toContain("/actions/github-pr-monitor-write-preview");
    expect(Object.keys(openapi.paths)).not.toContain("/actions/github-pr-monitor-read");
    expect(openapi.info.description).toContain("host-authorized GitHub PR monitor write mode");

    const response = await postAction(server.baseUrl, "/actions/github-pr-monitor-write-preview", {
      sessionId: "missing-session",
      operation: "post_comment",
      request: { body: "hello" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      structuredContent: { error: { code: "GITHUB_WRITE_SESSION_REQUIRED" } },
    });
    const malformed = await fetch(`${server.baseUrl}/actions/github-pr-monitor-write-preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json" },
      body: "{\"request\":",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ ok: false, code: "INVALID_INPUT", error: "Write request JSON is invalid or exceeds its bound." });
  });
  it("keeps monitor read responses metadata-only for hostile screenshot-like thread paths", async () => {
    process.env.CHATGPT2CODEX_ACTIONS_MODE = "github-pr-monitor";
    const screenshotPath = path.join(projectRoot, ".chatgpt2codex", "e2e", "screenshots", "hostile.png");
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await fs.writeFile(screenshotPath, "not a real screenshot\n", "utf8");
    const calls: string[][] = [];
    const ctx = makeCtx(stateDir, projectRoot) as ToolContext & { githubPrMonitorReadOptions?: GithubPrMonitorReadOptions };
    ctx.githubPrMonitorReadOptions = {
      gh: fakeMonitorReadGh(calls, { hostileThreadPath: screenshotPath }),
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      nonce: () => "http-hostile-path",
      deadlineMs: 2_000,
    };
    const server = await startApp(ctx);
    stop = server.stop;

    const response = await postAction(server.baseUrl, "/actions/github-pr-monitor-read", {
      runId: "http-run",
      actionPlanId: "http-plan",
    });
    const body = (await response.json()) as {
      ok: boolean;
      protocolVersion: number;
      schemaVersion: number;
      requestDigest: string;
      tool: string;
      toolCall: unknown;
      text: string;
      imageMarkdownList: string[];
      structuredContent?: { prs?: Array<{ reviewThreads?: Array<{ comments?: { nodes?: Array<Record<string, unknown>> } }> }> };
    };

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      "imageMarkdownList", "ok", "protocolVersion", "requestDigest", "schemaVersion", "structuredContent", "text", "tool", "toolCall",
    ]);
    expect(body).toMatchObject({
      ok: true,
      protocolVersion: 1,
      schemaVersion: 4,
      tool: "github_pr_monitor_read",
      imageMarkdownList: [],
    });
    const hostileComment = body.structuredContent?.prs?.[0]?.reviewThreads?.[0]?.comments?.nodes?.[0];
    expect(hostileComment).toMatchObject({ path: screenshotPath });
    expect(hostileComment).not.toHaveProperty("inlineUrl");
    expect(hostileComment).not.toHaveProperty("inlineMarkdown");
    expect(hostileComment).not.toHaveProperty("inlineExpiresAt");
    expect(await fs.readdir(path.join(stateDir, "e2e-screenshot-shares")).catch(() => [])).toEqual([]);
  });
  it("bounds and sanitizes malformed monitor input without invoking GitHub", async () => {
    process.env.CHATGPT2CODEX_ACTIONS_MODE = "github-pr-monitor";
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const arbitraryField = `untrusted-${"x".repeat(32_000)}`;
    const rawText = "do-not-echo-this-field";
    const response = await postAction(server.baseUrl, "/actions/github-pr-monitor-read", {
      runId: "http-run",
      actionPlanId: "http-plan",
      [arbitraryField]: rawText,
    });
    const body = (await response.json()) as {
      ok: boolean;
      tool: string;
      text?: string;
      toolCall?: { input?: unknown };
      structuredContent?: { code?: string; error?: string; runId?: string; actionPlanId?: string };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.tool).toBe("github_pr_monitor_read");
    expect(body.structuredContent?.code).toBe("GITHUB_MONITOR_INVALID_INPUT");
    expect(body.structuredContent?.error).toBe("Invalid GitHub PR monitor input.");
    expect(body.structuredContent?.error).not.toContain(arbitraryField);
    expect(body.structuredContent?.error).not.toContain(rawText);
    expect(body.toolCall?.input).toEqual({ runId: "http-run", actionPlanId: "http-plan" });
    expect(body.structuredContent).toMatchObject({ runId: "http-run", actionPlanId: "http-plan" });
    expect(Buffer.byteLength(body.text ?? "", "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThanOrEqual(MAX_WIRE_BYTES);
    expect(JSON.stringify(body)).not.toContain(arbitraryField);
    expect(JSON.stringify(body)).not.toContain(rawText);
    const wrappedResponse = await postAction(server.baseUrl, "/actions/github-pr-monitor-read", {
      input: { runId: "nested-run", actionPlanId: "nested-plan" },
    });
    const wrappedBody = (await wrappedResponse.json()) as {
      toolCall?: { input?: unknown };
      structuredContent?: { code?: string; requestDigest?: string; runId?: string; actionPlanId?: string };
    };
    expect(wrappedBody.structuredContent?.code).toBe("GITHUB_MONITOR_INVALID_INPUT");
    expect(wrappedBody.toolCall?.input).toEqual({});
    expect(wrappedBody.structuredContent).not.toHaveProperty("runId");
    expect(wrappedBody.structuredContent).not.toHaveProperty("actionPlanId");
  });
  it("sanitizes malformed monitor JSON parser failures", async () => {
    process.env.CHATGPT2CODEX_ACTIONS_MODE = "github-pr-monitor";
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const response = await fetch(`${server.baseUrl}/actions/github-pr-monitor-read`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{\"runId\":",
    });
    const body = (await response.json()) as {
      ok: boolean;
      tool?: string;
      text?: string;
      structuredContent?: { code?: string; error?: string };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.tool).toBe("github_pr_monitor_read");
    expect(body.structuredContent?.code).toBe("GITHUB_MONITOR_INVALID_INPUT");
    expect(body.structuredContent?.error).toBe("Invalid GitHub PR monitor input.");
    expect(Buffer.byteLength(body.text ?? "", "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThanOrEqual(MAX_WIRE_BYTES);
  });
  it("denies every non-monitor Actions bypass class at the HTTP choke point", async () => {
    process.env.CHATGPT2CODEX_ACTIONS_MODE = "github-pr-monitor";
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const health = await fetch(`${server.baseUrl}/actions/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      actions: 1,
      openApiOperations: 2,
      openApiToolNames: ["github_pr_monitor_read"],
    });
    const read = await postAction(server.baseUrl, "/actions/github-pr-monitor-read", {});
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      ok: false,
      tool: "github_pr_monitor_read",
      structuredContent: { code: "GITHUB_MONITOR_INVALID_INPUT" },
    });
    const schemaResponse = await fetch(`${server.baseUrl}/actions/openapi.json`);
    const schema = (await schemaResponse.json()) as {
      info: { description?: string; "x-chatgpt2codex-tool-names"?: string[] };
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(schemaResponse.status).toBe(200);
    expect(schema.info.description).toContain("read-only");
    expect(schema.info.description).toContain("mutation and state authorities are unavailable");
    expect(Object.keys(schema.paths).sort()).toEqual([
      "/actions/github-pr-monitor-read",
      "/actions/health",
    ]);
    expect(schema.info["x-chatgpt2codex-tool-names"]).toEqual(["github_pr_monitor_read"]);
    const monitorDescription = (schema.paths["/actions/github-pr-monitor-read"] as {
      post?: { description?: string };
    }).post?.description;
    expect(monitorDescription).toContain("no local state or screenshot-share writes");
    expect(monitorDescription).toContain("authenticated GitHub account");
    const monitorResponseSchema = (schema.paths["/actions/github-pr-monitor-read"] as {
      post?: { responses?: { "200"?: { content?: { "application/json"?: { schema?: Record<string, unknown> } } } } };
    }).post?.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(monitorResponseSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        structuredContent: {
          oneOf: [
            { "$ref": "#/components/schemas/GithubPrMonitorReadResult" },
            { "$ref": "#/components/schemas/GithubPrMonitorErrorResult" },
          ],
        },
      },
    });
    expect(Object.keys(schema.components.schemas).sort()).toEqual([
      "ActionToolResponse",
      "ErrorResponse",
      "GithubPrMonitorErrorResult",
      "GithubPrMonitorReadInput",
      "GithubPrMonitorReadResult",
      "HealthResponse",
      "ToolAvailabilityGate",
      "ToolCallProof",
    ]);

    const deniedRequests: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [
      { method: "POST", path: "/actions/github-pr-monitor-execute", body: {} },
      { method: "POST", path: "/actions/github-pr-monitor-mutate", body: {} },
      { method: "POST", path: "/actions/github-pr-monitor-state", body: {} },
      {
        method: "POST",
        path: "/actions/call-tool",
        body: { toolName: "github_pr_monitor_mutate", input: "{}" },
      },
      { method: "POST", path: "/actions/git-commit", body: {} },
      { method: "POST", path: "/actions/git-push", body: {} },
      { method: "POST", path: "/actions/e2e-open-target", body: {} },
      { method: "POST", path: "/actions/e2e-screenshot", body: {} },
      { method: "POST", path: "/actions/computer-request-action", body: {} },
      { method: "POST", path: "/actions/project-select", body: {} },
      { method: "POST", path: "/actions/file-read-slice", body: {} },
      { method: "GET", path: "/actions/e2e-screenshot-inline/token/image.png" },
    ];
    for (const request of deniedRequests) {
      const denied = await fetch(`${server.baseUrl}${request.path}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${OWNER_TOKEN}`,
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      expect(denied.status, `${request.method} ${request.path}`).toBe(404);
      await expect(denied.json()).resolves.toMatchObject({
        ok: false,
        error: "Action route is not available in github-pr-monitor mode.",
      });
    }
  });

  it("preserves the ordinary Actions surface in explicit general mode", async () => {
    process.env.CHATGPT2CODEX_ACTIONS_MODE = "general";
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const schemaRes = await fetch(`${server.baseUrl}/actions/openapi.json`);
    const schema = (await schemaRes.json()) as { paths: Record<string, unknown> };
    expect(schemaRes.status).toBe(200);
    expect(schema.paths["/actions/call-tool"]).toBeDefined();
    expect(schema.paths["/actions/project-select"]).toBeDefined();

    const generic = await postAction(server.baseUrl, "/actions/call-tool", {});
    expect(generic.status).toBe(400);
    await expect(generic.json()).resolves.toMatchObject({ ok: false, error: "Missing toolName" });

    const dedicated = await postAction(server.baseUrl, "/actions/project-select", {});
    expect(dedicated.status).toBe(200);
    await expect(dedicated.json()).resolves.toMatchObject({
      ok: false,
      tool: "project_select",
      structuredContent: { code: "INVALID_INPUT" },
    });
  });

  it("fails closed during server creation for an unknown Actions mode", async () => {
    process.env.CHATGPT2CODEX_ACTIONS_MODE = "unknown-mode";
    await expect(startApp(makeCtx(stateDir, projectRoot))).rejects.toThrow(
      'CHATGPT2CODEX_ACTIONS_MODE must be either "general", "github-pr-monitor", or "github-pr-monitor-write".',
    );
  });
  it("exposes the tool-call gate on action health", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/actions/health`);
    const body = (await res.json()) as {
      ok: boolean;
      name: string;
      actions?: number;
      openApiOperations?: number;
      openApiToolNames?: string[];
      toolAvailabilityGate?: { namespace?: string; noResultMeans?: string; wrongSurfaceExamples?: string[] };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.name).toBe("chatgpt2codex-actions");
    expect(body.actions).toBeGreaterThan(body.openApiOperations ?? 0);
    expect(body.openApiOperations).toBeLessThanOrEqual(30);
    expect(body.openApiToolNames).toContain("workspace_list_projects");
    expect(body.openApiToolNames).toContain("project_select");
    expect(body.openApiToolNames).toContain("file_apply_patch");
    expect(body.openApiToolNames).toContain("local_shell_run");
    expect(body.openApiToolNames).toContain("e2e_test_and_show_screenshot");
    expect(body.openApiToolNames).not.toContain("code_context_pack");
    expect(body.toolAvailabilityGate?.namespace).toBe("ChatGPT_To_Codex");
    expect(body.toolAvailabilityGate?.noResultMeans).toContain("No local project work happened");
    expect(body.toolAvailabilityGate?.wrongSurfaceExamples).toContain("image_gen");
  });

  it("requires the owner bearer token for action calls", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/actions/agent-guide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Bearer token");
  });

  it("serves a public privacy notice for GPT Actions", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/privacy`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(text).toContain("chatgpt2codex privacy notice");
    expect(text).toContain("Custom GPT Actions");
  });

  it("serves the OAuth owner-token prompt inside ChatGPT without frame blocking", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const url = authorizeUrl(server.baseUrl, client.clientId, client.redirectUri);

    const res = await fetch(url, { headers: { origin: "https://chatgpt.com" } });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self' https://chatgpt.com https://chat.openai.com",
    );
    expect(res.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://chatgpt.com https://chat.openai.com",
    );
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(text).toContain("Connect ChatGPT To Codex");
    expect(text).toContain("Local approval");
    expect(text).toContain("Connector URL");
    expect(text).toContain("Owner token");
    expect(text).toContain('<form method="post" action="/authorize">');
    expect(text).toContain('name="owner_token" type="password"');
    expect(text).toContain('autocomplete="one-time-code"');
    expect(text).toContain('id="owner_token_toggle"');
    expect(text).toContain('aria-label="Show owner token"');
    expect(text).toContain('src="/assets/owner-token-toggle.js"');
    expect(text).not.toMatch(/Owner passw[o]rd/);
    expect(text).not.toContain("current-password");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");

    const scriptRes = await fetch(`${server.baseUrl}/assets/owner-token-toggle.js`);
    const script = await scriptRes.text();
    expect(scriptRes.status).toBe(200);
    expect(scriptRes.headers.get("content-type")).toContain("application/javascript");
    expect(script).toContain('input.type = visible ? "text" : "password"');
  });

  it("serves OpenID discovery as an OAuth metadata compatibility alias", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/.well-known/openid-configuration`);
    const body = (await res.json()) as {
      issuer?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
      token_endpoint_auth_methods_supported?: string[];
    };

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(body.issuer).toBe(`${server.baseUrl}/`);
    expect(body.authorization_endpoint).toBe(`${server.baseUrl}/authorize`);
    expect(body.token_endpoint).toBe(`${server.baseUrl}/token`);
    expect(body.registration_endpoint).toBe(`${server.baseUrl}/register`);
    expect(body.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("does not reject OAuth authorization pages with Origin not allowed", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const url = authorizeUrl(server.baseUrl, client.clientId, client.redirectUri);

    const res = await fetch(url, { headers: { origin: "chrome-extension://codex-test" } });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("Owner token");
    expect(text).not.toContain("Origin not allowed");
  });

  it("localizes OAuth authorization pages from ui_locales", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const url = authorizeUrl(server.baseUrl, client.clientId, client.redirectUri);
    url.searchParams.set("ui_locales", "ko-KR en");

    const res = await fetch(url, { headers: { origin: "chrome-extension://codex-test" } });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('lang="ko"');
    expect(text).toContain("로컬 승인");
    expect(text).toContain("소유자 토큰");
    expect(text).toContain("ChatGPT To Codex 승인");
  });

  it("accepts ChatGPT-origin OAuth form posts instead of blocking token entry", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const url = authorizeUrl(server.baseUrl, client.clientId, client.redirectUri);
    const pageRes = await fetch(url, { headers: { origin: "https://chatgpt.com" } });
    const page = await pageRes.text();
    const csrfToken = page.match(/name="csrf_token" value="([^"]+)"/)?.[1];

    expect(pageRes.status).toBe(200);
    expect(csrfToken).toBeTruthy();

    const body = new URLSearchParams(url.searchParams);
    body.set("csrf_token", String(csrfToken));
    body.set("owner_token", "wrong-owner-token");

    const res = await fetch(`${server.baseUrl}/authorize`, {
      method: "POST",
      headers: {
        origin: "https://chatgpt.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      redirect: "manual",
    });
    const text = await res.text();

    expect(res.status).toBe(401);
    expect(text).toContain("The owner token was not accepted.");
  });

  it("accepts a valid owner token when the OAuth approval form csrf is stale", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const url = authorizeUrl(server.baseUrl, client.clientId, client.redirectUri);

    const pageRes = await fetch(url, { headers: { origin: "https://chatgpt.com" } });
    await pageRes.text();

    expect(pageRes.status).toBe(200);

    const body = new URLSearchParams(url.searchParams);
    body.set("csrf_token", "stale-csrf-token-after-app-restart");
    body.set("owner_token", OWNER_TOKEN);

    const res = await fetch(`${server.baseUrl}/authorize`, {
      method: "POST",
      headers: {
        origin: "https://chatgpt.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      redirect: "manual",
    });
    const location = res.headers.get("location");
    const redirectUrl = new URL(location ?? "http://missing.invalid");

    expect(res.status).toBe(302);
    expect(redirectUrl.origin).toBe("https://chatgpt.com");
    expect(redirectUrl.searchParams.get("code")).toMatch(/^code-/);
    expect(redirectUrl.searchParams.get("state")).toBe("unit-test-state");
  });

  it("exchanges OAuth codes for public clients without a client_secret", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const verifier = randomPkceVerifier();
    const code = await authorizeWithOwnerToken(server.baseUrl, client, pkceChallenge(verifier));
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code,
      code_verifier: verifier,
      resource: `${server.baseUrl}/mcp`,
    });

    const res = await fetch(`${server.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const body = (await res.json()) as { access_token?: string; token_type?: string };

    expect(res.status).toBe(200);
    expect(body.token_type?.toLowerCase()).toBe("bearer");
    expect(body.access_token).toBeTruthy();
  });

  it("rejects OAuth token exchange when the PKCE verifier does not match", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const verifier = randomPkceVerifier();
    const code = await authorizeWithOwnerToken(server.baseUrl, client, pkceChallenge(verifier));
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code,
      code_verifier: randomPkceVerifier(),
      resource: `${server.baseUrl}/mcp`,
    });

    const res = await fetch(`${server.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    expect(res.status).toBe(400);
  });

  it("still rejects untrusted browser origins for the MCP endpoint", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        origin: "https://not-chatgpt.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const body = (await res.json()) as { error?: { message?: string } };

    expect(res.status).toBe(403);
    expect(body.error?.message).toBe("Origin not allowed");
  });

  it("fires idle shutdown callback when no MCP session is active", async () => {
    const port = await getFreePort();
    let idleCount = 0;
    const ctx = makeCtx(stateDir, projectRoot);
    const idlePromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("idle shutdown did not fire")), 500);
      const running = createHttpServer(
        ctx,
        defaultHttpServerConfig({
          host: "127.0.0.1",
          port,
          publicUrl: `http://127.0.0.1:${port}`,
          idleShutdownMs: 20,
          onIdleTimeout: () => {
            idleCount++;
            clearTimeout(timeout);
            resolve();
          },
        }),
      );
      const server: Server = running.app.listen(port, "127.0.0.1");
      stop = async () => {
        await new Promise<void>((done, fail) => {
          server.close((err) => (err ? fail(err) : done()));
        });
        running.close();
      };
    });

    await idlePromise;
    expect(idleCount).toBe(1);
  });

  it("bridges action requests to registered MCP tools", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const guideRes = await postAction(server.baseUrl, "/actions/agent-guide", {});
    const guide = (await guideRes.json()) as {
      ok: boolean;
      text: string;
      toolCall?: { namespace?: string; ok?: boolean; requiredBeforeCoding?: boolean };
      structuredContent: { workflow?: string[]; toolAvailabilityGate?: { namespace?: string } };
    };

    expect(guideRes.status).toBe(200);
    expect(guide.ok).toBe(true);
    expect(guide.toolCall).toMatchObject({
      namespace: "ChatGPT_To_Codex",
      ok: true,
      requiredBeforeCoding: true,
    });
    expect(guide.structuredContent.toolAvailabilityGate?.namespace).toBe("ChatGPT_To_Codex");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("no chatgpt2codex work happened");
    expect(guide.text).toContain("chatgpt2codex can operate");
    expect(guide.structuredContent.workflow).toContain("workspace_list_projects or workspace_refresh_index");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("device-agnostic/mobile");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("goal_intake immediately");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("goal_loop");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("Avoid broad context-pack calls");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("e2e_test_and_show_screenshot");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("e2e_start_server");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("Automatic visible-image capture");

    const selectRes = await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      reason: "unit test",
    });
    const selected = (await selectRes.json()) as { ok: boolean; structuredContent: { lease?: Lease } };

    expect(selectRes.status).toBe(200);
    expect(selected.ok).toBe(true);
    expect(selected.structuredContent.lease?.projectId).toBe("proj");
    expect(selected.structuredContent.lease?.preset).toBe("full-write");

    const createRes = await postAction(server.baseUrl, "/actions/file-create", {
      projectId: "proj",
      path: "direct-action.txt",
      content: "written by action\n",
    });
    const created = (await createRes.json()) as { ok: boolean; structuredContent: { path?: string } };

    expect(createRes.status).toBe(200);
    expect(created.ok).toBe(true);
    expect(created.structuredContent.path).toBe("direct-action.txt");
    await expect(fs.readFile(path.join(projectRoot, "direct-action.txt"), "utf8")).resolves.toBe("written by action\n");

    const proxyRes = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "file_create",
      input: {
        projectId: "proj",
        path: "proxy-action.txt",
        content: "written by call-tool\n",
      },
    });
    const proxied = (await proxyRes.json()) as {
      ok: boolean;
      tool: string;
      toolCall?: { namespace?: string; tool?: string; toolName?: string; ok?: boolean; input?: { toolName?: string; input?: Record<string, unknown> } };
      structuredContent: { path?: string; chatgpt2codexToolCall?: { namespace?: string; tool?: string; ok?: boolean } };
    };

    expect(proxyRes.status).toBe(200);
    expect(proxied.ok).toBe(true);
    expect(proxied.tool).toBe("file_create");
    expect(proxied.toolCall).toMatchObject({
      namespace: "ChatGPT_To_Codex",
      tool: "file_create",
      toolName: "call_tool",
      ok: true,
      input: { toolName: "file_create", input: { projectId: "proj", path: "proxy-action.txt", content: "written by call-tool\n" } },
    });
    expect(proxied.structuredContent.chatgpt2codexToolCall).toMatchObject({
      namespace: "ChatGPT_To_Codex",
      tool: "file_create",
      ok: true,
    });
    expect(proxied.structuredContent.path).toBe("proxy-action.txt");
    await expect(fs.readFile(path.join(projectRoot, "proxy-action.txt"), "utf8")).resolves.toBe("written by call-tool\n");
    const monitorBypass = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "github_pr_monitor_mutate",
      input: {},
    });
    expect(monitorBypass.status).toBe(403);
    await expect(monitorBypass.json()).resolves.toMatchObject({
      ok: false,
      error: "Tool github_pr_monitor_mutate is unavailable through the generic Actions bridge.",
    });

    const encodedProxyRes = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "file_create",
      input: JSON.stringify({
        projectId: "proj",
        path: "encoded-proxy-action.txt",
        content: "written by encoded call-tool\n",
      }),
    });
    const encodedProxy = (await encodedProxyRes.json()) as { ok: boolean };
    expect(encodedProxyRes.status).toBe(200);
    expect(encodedProxy.ok).toBe(true);
    await expect(fs.readFile(path.join(projectRoot, "encoded-proxy-action.txt"), "utf8")).resolves.toBe("written by encoded call-tool\n");
  });

  it("rejects preset=control through the action bridge (non-blocking gap #2) on both call-tool and the project-select route", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const server = await startApp(ctx);
    stop = server.stop;

    const bridgeRes = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "project_select",
      input: { projectId: "proj", reason: "remote attempt", preset: "control" },
    });
    const bridgeBody = (await bridgeRes.json()) as { ok: boolean; structuredContent: { code?: string } };
    expect(bridgeRes.status).toBe(200);
    expect(bridgeBody.ok).toBe(false);
    expect(bridgeBody.structuredContent.code).toBe("PERMISSION_DENIED");

    const routeRes = await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      reason: "remote attempt via route",
      preset: "control",
    });
    const routeBody = (await routeRes.json()) as { ok: boolean; structuredContent: { code?: string } };
    expect(routeRes.status).toBe(200);
    expect(routeBody.ok).toBe(false);
    expect(routeBody.structuredContent.code).toBe("PERMISSION_DENIED");

    // Neither attempt actually granted a control lease / cleared a kill.
    const session = (await ctx.store.getSession()) as { lease?: { preset?: string } | null } | null;
    expect(session?.lease?.preset ?? null).not.toBe("control");

    // Omitting preset (defaults to full-write) and explicitly requesting
    // full-write must both keep working through the same bridge.
    const defaultedRes = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "project_select",
      input: { projectId: "proj", reason: "default preset" },
    });
    const defaulted = (await defaultedRes.json()) as { ok: boolean; structuredContent: { lease?: Lease } };
    expect(defaulted.ok).toBe(true);
    expect(defaulted.structuredContent.lease?.preset).toBe("full-write");

    const explicitFullWriteRes = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "project_select",
      input: { projectId: "proj", reason: "explicit full-write", preset: "full-write" },
    });
    const explicitFullWrite = (await explicitFullWriteRes.json()) as { ok: boolean; structuredContent: { lease?: Lease } };
    expect(explicitFullWrite.ok).toBe(true);
    expect(explicitFullWrite.structuredContent.lease?.preset).toBe("full-write");
  });

  it("re-validates the registered tool's zod inputSchema on the generic call-tool bridge (bypasses the MCP SDK's normal validation otherwise)", async () => {
    // callRegisteredTool fetches the raw registered handler directly,
    // bypassing the MCP SDK's tools/call path where zod inputSchema (ranges,
    // enums, refine, min/max) is normally enforced. Without re-validating,
    // an out-of-schema numeric value — here e2e_open_url_screenshot's
    // waitMs: z.number().int().min(0).max(30_000) — would reach the tool
    // handler unchecked. This exercises the exact bridge/callRegisteredTool
    // codepath (not the tool's own internal logic), so no project lease or
    // real local URL needs to succeed for this assertion: rejection must
    // happen before the handler ever runs.
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "e2e_open_url_screenshot",
      input: {
        projectId: "proj",
        url: "http://127.0.0.1:1/",
        waitMs: 999_999, // exceeds max(30_000)
      },
    });
    const body = (await res.json()) as { ok: boolean; structuredContent?: { code?: string; error?: string } };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.structuredContent?.code).toBe("INVALID_INPUT");
    expect(body.structuredContent?.error ?? "").toContain("waitMs");
  });

  it("re-validates zod inputSchema on the per-route action bridge too (not just /actions/call-tool)", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await postAction(server.baseUrl, "/actions/e2e-open-url-screenshot", {
      projectId: "proj",
      url: "http://127.0.0.1:1/",
      waitMs: 999_999,
    });
    const body = (await res.json()) as { ok: boolean; structuredContent?: { code?: string } };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.structuredContent?.code).toBe("INVALID_INPUT");
  });

  describe("owner-token brute-force lockout (SR-05) cannot be bypassed by omitting csrf_token", () => {
    it("counts a wrong owner_token toward the lockout even when csrf_token is omitted entirely", async () => {
      // Before the fix: with csrf_token omitted and owner_token wrong, the
      // handler took the (!csrfAccepted && !ownerTokenAccepted) branch and
      // returned 403 WITHOUT ever calling loginAttempts.recordFailure — so
      // this exact request shape could be repeated forever with no lockout
      // and no audit trail. After the fix, a *submitted* (not merely
      // omitted) wrong token is always accounted for. Prove it by tripping
      // the lockout purely with csrf-omitted wrong-token attempts, then
      // showing even the *correct* token is refused (429) once locked out.
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;
      const client = await registerOAuthClient(server.baseUrl);
      const url = authorizeUrl(server.baseUrl, client.clientId, client.redirectUri);

      const MAX_ATTEMPTS_BEFORE_BACKOFF = 5;
      for (let i = 0; i < MAX_ATTEMPTS_BEFORE_BACKOFF; i++) {
        const body = new URLSearchParams(url.searchParams);
        // csrf_token intentionally omitted.
        body.set("owner_token", `wrong-owner-token-${i}`);

        const res = await fetch(`${server.baseUrl}/authorize`, {
          method: "POST",
          headers: { origin: "https://chatgpt.com", "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          redirect: "manual",
        });
        // Not yet locked out — each of these is a plain rejected attempt.
        expect(res.status).toBe(403);
      }

      const finalBody = new URLSearchParams(url.searchParams);
      finalBody.set("csrf_token", "irrelevant-because-locked-out");
      finalBody.set("owner_token", OWNER_TOKEN); // the genuinely correct token
      const finalRes = await fetch(`${server.baseUrl}/authorize`, {
        method: "POST",
        headers: { origin: "https://chatgpt.com", "content-type": "application/x-www-form-urlencoded" },
        body: finalBody.toString(),
        redirect: "manual",
      });

      // If the csrf-omitted wrong-token attempts above had been silently
      // swallowed (the pre-fix bypass), the lockout counter would still be
      // at 0 and this correct-token request would succeed (302). Getting
      // 429 here proves those attempts were counted.
      expect(finalRes.status).toBe(429);
    });
  });

  describe("CHATGPT2CODEX_CONTROL_CHATGPT exposure on the generic action bridge", () => {
    afterEach(() => {
      delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
    });

    it("still blocks control tools on /actions/call-tool by default (flag unset)", async () => {
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;

      const res = await postAction(server.baseUrl, "/actions/call-tool", {
        toolName: "computer_action_status",
        input: {},
      });
      const body = (await res.json()) as { ok: boolean; structuredContent?: { code?: string } };
      expect(body.ok).toBe(false);
      expect(body.structuredContent?.code).toBe("PERMISSION_DENIED");
    });

    it("allows control tools on /actions/call-tool once CHATGPT2CODEX_CONTROL_CHATGPT=1, but still rejects preset=control on project_select", async () => {
      process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;

      // A real control lease isn't granted through this bridge (preset=control
      // stays blocked below), so this reaches the tool handler and fails on
      // the lease check itself — proof it's no longer blocked by
      // CONTROL_TOOL_NAMES specifically.
      const res = await postAction(server.baseUrl, "/actions/call-tool", {
        toolName: "computer_action_status",
        input: {},
      });
      const body = (await res.json()) as { ok: boolean; structuredContent?: { code?: string } };
      expect(body.ok).toBe(false);
      expect(body.structuredContent?.code).toBe("PROJECT_NOT_SELECTED");

      const bridgeRes = await postAction(server.baseUrl, "/actions/call-tool", {
        toolName: "project_select",
        input: { projectId: "proj", reason: "remote attempt while exposed", preset: "control" },
      });
      const bridgeBody = (await bridgeRes.json()) as { ok: boolean; structuredContent: { code?: string } };
      expect(bridgeBody.ok).toBe(false);
      expect(bridgeBody.structuredContent.code).toBe("PERMISSION_DENIED");
    });
  });

  it("acknowledges broad goals quickly with next action guidance", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await postAction(server.baseUrl, "/actions/goal-intake", {
      goal: "/goal deep research and implement safely",
      projectId: "proj",
      urgency: "fast",
    });
    const body = (await res.json()) as {
      ok: boolean;
      text: string;
      structuredContent: { goalId?: string; nextActions?: string[]; timeoutGuidance?: string };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.text).toContain("Continue with the next chatgpt2codex tool call now");
    expect(body.structuredContent.goalId).toMatch(/^goal-/);
    expect(body.structuredContent.nextActions?.join(" ")).toContain("project_select");
    expect(body.structuredContent.timeoutGuidance).toContain("intentionally fast");
    await expect(fs.readdir(path.join(stateDir, "goals"))).resolves.toHaveLength(1);
  });

  it("keeps a local coding loop moving across action turns", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const firstRes = await postAction(server.baseUrl, "/actions/goal-loop", {
      goal: "/goal implement and verify a focused change",
      projectId: "proj",
      maxTurns: 3,
    });
    const first = (await firstRes.json()) as {
      ok: boolean;
      text: string;
      structuredContent: { loopId?: string; turn?: number; remainingTurns?: number; nextActions?: string[] };
    };

    expect(firstRes.status).toBe(200);
    expect(first.ok).toBe(true);
    expect(first.text).toContain("Execute the next action batch now");
    expect(first.structuredContent.loopId).toMatch(/^loop-/);
    expect(first.structuredContent.turn).toBe(1);
    expect(first.structuredContent.remainingTurns).toBe(2);
    expect(first.structuredContent.nextActions?.join(" ")).toContain("goal_loop again");

    const secondRes = await postAction(server.baseUrl, "/actions/goal-loop", {
      loopId: first.structuredContent.loopId,
      projectId: "proj",
      maxTurns: 3,
      lastResult: "read rules and selected project",
    });
    const second = (await secondRes.json()) as { ok: boolean; structuredContent: { turn?: number } };

    expect(secondRes.status).toBe(200);
    expect(second.ok).toBe(true);
    expect(second.structuredContent.turn).toBe(2);
    const loopFile = path.join(stateDir, "goals", `${first.structuredContent.loopId}.loop.json`);
    const loopState = JSON.parse(await fs.readFile(loopFile, "utf8")) as { turns?: unknown[] };
    expect(loopState.turns).toHaveLength(2);
  });
});
