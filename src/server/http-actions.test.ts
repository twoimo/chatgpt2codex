import { createServer as createNodeServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeOwnerToken } from "../auth/owner-token.js";
import type { Lease, ToolContext } from "../types.js";
import { createHttpServer, defaultHttpServerConfig } from "./http.js";
import { ActionReceiptAuthority, type MutationOutcomeBinding } from "./action-receipts.js";

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
async function establishAuthoritativeMonitorPlan(
  baseUrl: string,
  identity: {
    runId: string;
    actionPlanId: string;
    repository: string;
    author: string;
    prNumber: number;
  },
): Promise<void> {
  const coordinationId = `coord-${identity.actionPlanId}`;
  const readReceipt = await postAction(
    baseUrl,
    "/actions/github-pr-monitor-read",
    {
      runId: identity.runId,
      actionPlanId: coordinationId,
      repository: identity.repository,
      author: identity.author,
      prNumber: identity.prNumber,
    },
  ).then((response) => response.json() as Promise<Record<string, unknown>>);
  expect(readReceipt.ok).toBe(true);

  const snapshot = (
    (readReceipt.structuredContent as Record<string, unknown>).prs as Array<Record<string, unknown>>
  )[0] as Record<string, unknown>;
  const state = async (command: "ingest" | "plan-cycle", input: Record<string, unknown>): Promise<void> => {
    const response = await postAction(baseUrl, "/actions/github-pr-monitor-state", {
      runId: identity.runId,
      actionPlanId: coordinationId,
      idempotencyKey: `fixture-${command}-${identity.actionPlanId}`,
      eventId: `fixture-${command}-${identity.actionPlanId}`,
      command,
      input: JSON.stringify(input),
    });
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  };

  await state("ingest", { receipt: readReceipt });
  await state("plan-cycle", {
    receipt: readReceipt,
    prs: [{
      number: snapshot.number,
      author: "twoimo",
      headRef: snapshot.headRefName,
      headOid: snapshot.headRefOid,
      attempts: 0,
      tier: 1,
    }],
  });
}
async function installFakeGithubCli(root: string): Promise<() => void> {
  const binDir = path.join(root, "fake-bin");
  const ghPath = path.join(binDir, "gh");
  const gitPath = path.join(binDir, "git");
  const npmPath = path.join(binDir, "npm");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(path.join(root, "fake-bin", "gh-state.json"))};
const hasState = fs.existsSync(statePath);
const state = hasState ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const isReviewerPost = args[0] === "api" && args[1]?.endsWith("/requested_reviewers") && args.includes("POST");
const postedReviewer = isReviewerPost
  ? args.find((arg) => arg.startsWith("reviewers[]="))?.slice("reviewers[]=".length)
  : undefined;
if (isReviewerPost && (state.failReviewerPost ?? []).includes(postedReviewer)) {
  process.stderr.write("injected requested-reviewer transport failure before GitHub applied it\\n");
  process.exit(3);
}
fs.appendFileSync(${JSON.stringify(path.join(root, "fake-bin", "gh-invocations.log"))}, JSON.stringify(args) + "\\n");
if (args[0] === "api" && args[1] === "user") {
  console.log(JSON.stringify({ login: "twoimo" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: Number(args[2]),
    url: "https://github.com/Yeachan-Heo/gajae-code/pull/" + args[2],
    state: "OPEN",
    author: { login: "twoimo" },
    headRefName: "feature/strict-actions",
    headRefOid: state.headRefOid ?? "0123456789abcdef0123456789abcdef01234567",
    reviewRequests: state.reviewRequests ?? [
      { login: "requested-reviewer" },
      { login: "unconfirmed-reviewer" },
      { login: "malformed-json-reviewer" },
      { login: "malformed-shape-reviewer" }
    ],
    reviews: [{ author: { login: "previous-reviewer" } }],
    comments: [],
    latestReviews: [],
    statusCheckRollup: []
  }));
} else if (args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("resolveReviewThread"))) {
  const threadId = args.find((arg) => arg.startsWith("id="))?.slice(3);
  if (threadId === "THREAD_GRAPHQL_ERROR") {
    console.log(JSON.stringify({ errors: [{ message: "mutation denied" }], data: null }));
  } else {
    if (hasState) {
      const resolvedThreads = state.resolvedThreads ?? [];
      if (!resolvedThreads.includes(threadId)) resolvedThreads.push(threadId);
      state.resolvedThreads = resolvedThreads;
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
    console.log(JSON.stringify({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } }));
  }
} else if (args[0] === "api" && args[1] === "graphql") {
  const number = Number(args.find((arg) => arg.startsWith("number="))?.slice(7));
  if (number === 901) {
    console.log(JSON.stringify({ errors: [{ message: "denied" }], data: null }));
  } else if (number === 902) {
    console.log(JSON.stringify({ data: { repository: {} } }));
  } else if (number === 903) {
    console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: [], pageInfo: { hasNextPage: true, endCursor: null }
    } } } } }));
  } else {
    const hiddenThreads = state.hiddenThreads ?? [];
    const resolvedThreads = state.resolvedThreads ?? [];
    const nodes = ["THREAD_CURRENT", "THREAD_GRAPHQL_ERROR", "THREAD_RESOLVED"]
      .filter((id) => !hiddenThreads.includes(id))
      .map((id) => ({
        id,
        isResolved: id === "THREAD_RESOLVED" || resolvedThreads.includes(id),
        comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
      }));
    console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
      nodes, pageInfo: { hasNextPage: false, endCursor: null }
    } } } } }));
  }
} else if (isReviewerPost) {
  if (postedReviewer === "malformed-json-reviewer") {
    console.log("{not-json");
  } else if (postedReviewer === "malformed-shape-reviewer") {
    console.log(JSON.stringify({ requested_reviewers: "not-an-array" }));
  } else if (postedReviewer === "unconfirmed-reviewer") {
    console.log(JSON.stringify({ requested_reviewers: [{ login: "different-reviewer" }] }));
  } else {
    if (hasState) {
      const reviewRequests = Array.isArray(state.reviewRequests) ? state.reviewRequests : [];
      if (!reviewRequests.some((value) => value?.login === postedReviewer)) {
        state.reviewRequests = [...reviewRequests, { login: postedReviewer }];
        fs.writeFileSync(statePath, JSON.stringify(state));
      }
    }
    console.log(JSON.stringify({ requested_reviewers: [{ login: postedReviewer }] }));
  }
} else if (args.includes("--paginate")) {
  console.log("[]");
} else {
  console.log(JSON.stringify({ id: 99, html_url: "https://github.com/Yeachan-Heo/gajae-code/pull/7#issuecomment-99" }));
}
`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    gitPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) {
  console.log(args.at(-1) === "origin"
    ? "git@github.com:twoimo/gajae-code.git"
    : "https://github.com/Yeachan-Heo/gajae-code.git");
}
`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    npmPath,
    `#!/usr/bin/env node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
};
const digest = (value) => crypto.createHash("sha256").update(canonical(value)).digest("hex");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const command = argv[argv.indexOf("--") + 1];
  const body = JSON.parse(input || "{}");
  if (command === "recover") {
    console.log(JSON.stringify({ ok: true, command, ...body, committed: false }));
    return;
  }
  if (command === "claim-action") {
    assert.equal(argv.includes("--json"), false);
    assert.equal(body.prNumber, 7);
    fs.appendFileSync(${JSON.stringify(path.join(root, "fake-bin", "claim-invocations.log"))}, JSON.stringify(body) + "\\n");
    if (String(body.actionPlanId).includes("reject")) {
      console.log(JSON.stringify({ ok: false, error: { code: "NO_PLAN", message: "unplanned" } }));
      process.exit(1);
    }
    console.log(JSON.stringify({
      command,
      ok: true,
      claimId: "claim-" + body.idempotencyKey,
      claimedAt: "2026-07-27T00:00:00.000Z",
      payloadDigest: digest(body),
      runId: body.runId,
      coordinationId: "coord-" + body.actionPlanId,
      actionPlanId: body.actionPlanId,
      idempotencyKey: body.idempotencyKey
    }));
    return;
  }
  if (command === "ingest") {
    assert.deepEqual(Object.keys(body).sort(), ["actionPlanId", "readReceipt", "runId"]);
    console.log(JSON.stringify({
      ok: true,
      command,
      runId: body.runId,
      coordinationId: body.actionPlanId,
      requestDigest: digest(body),
      result: { ingested: true }
    }));
    return;
  }
  if (command === "plan-cycle") {
    assert.deepEqual(Object.keys(body).sort(), ["actionPlanId", "prs", "readReceipt", "runId"]);
    assert.equal(Array.isArray(body.prs), true);
    const actionPlanId = body.actionPlanId.startsWith("coord-")
      ? body.actionPlanId.slice("coord-".length)
      : body.actionPlanId;
    console.log(JSON.stringify({
      ok: true,
      command,
      runId: body.runId,
      coordinationId: body.actionPlanId,
      actionPlanId,
      requestDigest: digest(body),
      result: { actionPlanId }
    }));
    return;
  }
  console.log(JSON.stringify({ ok: true, command, result: {} }));
});
`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
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
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-actions-state-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-actions-project-"));
    await storeOwnerToken(stateDir, OWNER_TOKEN);
  });

  afterEach(async () => {
    delete process.env.CHATGPT2CODEX_ACTIONS_MODE;
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
          GithubPrMonitorReadInput: { required: string[]; additionalProperties: boolean; properties: Record<string, Record<string, unknown>> };
          GithubPrMonitorPrepareInput: { required: string[]; additionalProperties: boolean; properties: Record<string, Record<string, unknown>> };
          GithubPrMonitorMutateInput: { required: string[]; additionalProperties: boolean; properties: Record<string, Record<string, unknown>> };
          GithubPrMonitorStateInput: { required: string[]; additionalProperties: boolean; properties: Record<string, Record<string, unknown>> };
        };
      };
    };

    expect(res.status).toBe(200);
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.version).toBe("0.1.6");
    expect(body.info.description).toContain("source editing");
    expect(body.info.description).toContain("cannot write /Users/");
    expect(body.info.description).toContain("30 operations");
    expect(body.info.description).toContain("workspace_list_projects");
    expect(body.info.description).toContain("save_chatgpt_image/save_chatgpt_image_from_url");
    expect(body.info["x-chatgpt2codex-tool-proof"]?.namespace).toBe("ChatGPT_To_Codex");
    expect(body.info["x-chatgpt2codex-openapi-operation-count"]).toBeLessThanOrEqual(30);
    expect(body.info["x-chatgpt2codex-tool-names"]).toContain("workspace_list_projects");
    expect(body.info["x-chatgpt2codex-tool-names"]).toContain("e2e_test_and_show_screenshot");
    expect(body.info["x-chatgpt2codex-tool-names"]).toContain("github_pr_monitor_read");
    expect(body.info["x-chatgpt2codex-tool-names"]).toContain("github_pr_monitor_prepare");
    expect(body.info["x-chatgpt2codex-tool-names"]).toContain("github_pr_monitor_mutate");
    expect(body.info["x-chatgpt2codex-tool-names"]).toContain("github_pr_monitor_state");
    expect(body.info["x-chatgpt2codex-tool-names"]).not.toContain("code_context_pack");
    expect(body.info.description).toContain("toolCall.namespace=ChatGPT_To_Codex");
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
    for (const [routePath, operationId] of [
      ["/actions/github-pr-monitor-read", "github_pr_monitor_read"],
      ["/actions/github-pr-monitor-prepare", "github_pr_monitor_prepare"],
      ["/actions/github-pr-monitor-mutate", "github_pr_monitor_mutate"],
      ["/actions/github-pr-monitor-state", "github_pr_monitor_state"],
    ] as const) {
      expect((body.paths[routePath] as { post: { operationId: string } }).post.operationId).toBe(operationId);
    }
    const monitorSchemas = [
      body.components.schemas.GithubPrMonitorReadInput,
      body.components.schemas.GithubPrMonitorPrepareInput,
      body.components.schemas.GithubPrMonitorMutateInput,
      body.components.schemas.GithubPrMonitorStateInput,
    ];
    for (const schema of monitorSchemas) {
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.runId).toMatchObject({ type: "string", maxLength: 300 });
      expect(schema.properties.actionPlanId).toMatchObject({ type: "string", maxLength: 300 });
    }
    expect(body.components.schemas.GithubPrMonitorReadInput.properties.repository).toMatchObject({
      type: "string",
      const: "Yeachan-Heo/gajae-code",
    });
    expect(body.components.schemas.GithubPrMonitorReadInput.properties.author).toMatchObject({
      type: "string",
      const: "twoimo",
    });
    for (const schema of [
      body.components.schemas.GithubPrMonitorPrepareInput,
      body.components.schemas.GithubPrMonitorMutateInput,
    ]) {
      expect(schema.properties.repository).toMatchObject({ type: "string", const: "Yeachan-Heo/gajae-code" });
      expect(schema.properties.author).toMatchObject({ type: "string", const: "twoimo" });
    }
    expect(body.components.schemas.GithubPrMonitorPrepareInput.properties.operation.enum).toEqual(["create", "quarantine"]);
    expect(body.components.schemas.GithubPrMonitorMutateInput.properties.operation.enum).toEqual([
      "post_reply",
      "resolve_thread",
      "rerequest_reviewer",
      "push_prepared_worktree",
    ]);
    expect(body.components.schemas.GithubPrMonitorStateInput.properties.input).toMatchObject({
      type: "string",
      maxLength: 65536,
    });
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

  it("emits only health and the four dedicated operations in github-pr-monitor mode", async () => {
    process.env.CHATGPT2CODEX_ACTIONS_MODE = "github-pr-monitor";
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/actions/openapi.json`);
    const body = (await res.json()) as {
      info: {
        title: string;
        description: string;
        "x-chatgpt2codex-openapi-operation-count": number;
        "x-chatgpt2codex-tool-names": string[];
      };
      paths: Record<string, { get?: { operationId: string }; post?: { operationId: string } }>;
      components: {
        schemas: {
          GithubPrMonitorReadInput: { properties: Record<string, Record<string, unknown>> };
          GithubPrMonitorPrepareInput: { properties: Record<string, Record<string, unknown>> };
          GithubPrMonitorMutateInput: { properties: Record<string, Record<string, unknown>> };
        };
      };
    };
    const monitorOperations = [
      ["/actions/github-pr-monitor-read", "github_pr_monitor_read"],
      ["/actions/github-pr-monitor-prepare", "github_pr_monitor_prepare"],
      ["/actions/github-pr-monitor-mutate", "github_pr_monitor_mutate"],
      ["/actions/github-pr-monitor-state", "github_pr_monitor_state"],
    ] as const;

    expect(res.status).toBe(200);
    expect(Object.keys(body.paths).sort()).toEqual([
      "/actions/github-pr-monitor-mutate",
      "/actions/github-pr-monitor-prepare",
      "/actions/github-pr-monitor-read",
      "/actions/github-pr-monitor-state",
      "/actions/health",
    ]);
    expect(body.paths["/actions/health"]?.get?.operationId).toBe("action_health");
    for (const [routePath, operationId] of monitorOperations) {
      expect(body.paths[routePath]?.post?.operationId).toBe(operationId);
    }
    expect(body.info.title).toContain("GitHub PR Monitor");
    expect(body.info.description).toContain("Yeachan-Heo/gajae-code");
    expect(body.info.description).toContain("twoimo");
    expect(body.info["x-chatgpt2codex-openapi-operation-count"]).toBe(5);
    expect(body.info["x-chatgpt2codex-tool-names"]).toEqual(monitorOperations.map(([, operationId]) => operationId));
    expect(body.components.schemas.GithubPrMonitorReadInput.properties.repository).toMatchObject({
      const: "Yeachan-Heo/gajae-code",
    });
    expect(body.components.schemas.GithubPrMonitorReadInput.properties.author).toMatchObject({ const: "twoimo" });
    expect(body.components.schemas.GithubPrMonitorPrepareInput.properties.repository).toMatchObject({
      const: "Yeachan-Heo/gajae-code",
    });
    expect(body.components.schemas.GithubPrMonitorMutateInput.properties.author).toMatchObject({ const: "twoimo" });
  });

  it("denies every non-monitor Actions bypass class at the HTTP choke point", async () => {
    process.env.CHATGPT2CODEX_ACTIONS_MODE = "github-pr-monitor";
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const health = await fetch(`${server.baseUrl}/actions/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      actions: 4,
      openApiOperations: 5,
      openApiToolNames: [
        "github_pr_monitor_read",
        "github_pr_monitor_prepare",
        "github_pr_monitor_mutate",
        "github_pr_monitor_state",
      ],
    });

    for (const [routePath, tool] of [
      ["/actions/github-pr-monitor-read", "github_pr_monitor_read"],
      ["/actions/github-pr-monitor-prepare", "github_pr_monitor_prepare"],
      ["/actions/github-pr-monitor-mutate", "github_pr_monitor_mutate"],
      ["/actions/github-pr-monitor-state", "github_pr_monitor_state"],
    ] as const) {
      const allowed = await postAction(server.baseUrl, routePath, {});
      expect(allowed.status).toBe(200);
      await expect(allowed.json()).resolves.toMatchObject({
        ok: false,
        tool,
        structuredContent: { code: "INVALID_INPUT" },
      });
    }

    const deniedRequests: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [
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
      'CHATGPT2CODEX_ACTIONS_MODE must be either "general" or "github-pr-monitor".',
    );
  });
  it("fails closed on missing, extra, wrapped, and non-fixed PR action inputs", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const validRead = {
      runId: "run-1",
      actionPlanId: "plan-1",
      repository: "Yeachan-Heo/gajae-code",
      author: "twoimo",
      prNumber: 7,
    };

    const unauthorized = await postAction(server.baseUrl, "/actions/github-pr-monitor-read", validRead, "wrong-token");
    expect(unauthorized.status).toBe(401);

    for (const input of [
      { ...validRead, actionPlanId: undefined },
      { ...validRead, extra: true },
      { input: validRead },
      { ...validRead, repository: "attacker/example" },
      { ...validRead, author: "attacker" },
    ]) {
      const res = await postAction(server.baseUrl, "/actions/github-pr-monitor-read", input);
      const body = (await res.json()) as {
        ok: boolean;
        tool: string;
        toolCall: { namespace?: string; tool?: string; ok?: boolean };
        structuredContent: { code?: string };
      };

      expect(res.status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.tool).toBe("github_pr_monitor_read");
      expect(body.toolCall).toMatchObject({
        namespace: "ChatGPT_To_Codex",
        tool: "github_pr_monitor_read",
        ok: false,
      });
      expect(body.structuredContent.code).toBe("INVALID_INPUT");
    }
    for (const [routePath, validInput] of [
      ["/actions/github-pr-monitor-prepare", {
        ...validRead,
        idempotencyKey: "idem-prepare",
        eventId: "event-prepare",
        expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
        operation: "quarantine",
      }],
      ["/actions/github-pr-monitor-mutate", {
        ...validRead,
        idempotencyKey: "idem-mutate",
        eventId: "event-mutate",
        expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
        operation: "post_reply",
        body: "reply",
      }],
      ["/actions/github-pr-monitor-state", {
        runId: "run-state",
        actionPlanId: "plan-state",
        idempotencyKey: "idem-state",
        eventId: "event-state",
        command: "status",
        input: "{}",
      }],
    ] as const) {
      for (const input of [
        { ...validInput, runId: undefined },
        { ...validInput, unexpected: true },
      ]) {
        const res = await postAction(server.baseUrl, routePath, input);
        const body = (await res.json()) as {
          ok: boolean;
          toolCall: { namespace?: string; ok?: boolean };
          structuredContent: { code?: string };
        };
        expect(body.ok).toBe(false);
        expect(body.toolCall).toMatchObject({ namespace: "ChatGPT_To_Codex", ok: false });
        expect(body.structuredContent.code).toBe("INVALID_INPUT");
      }
    }
  });

  it("decodes encoded PR monitor state input before registered MCP dispatch", async () => {
    const events: Array<Record<string, unknown>> = [];
    const ctx = makeCtx(stateDir, projectRoot);
    ctx.ledger.append = async (event) => {
      events.push(event as unknown as Record<string, unknown>);
    };
    const server = await startApp(ctx);
    stop = server.stop;

    const res = await postAction(server.baseUrl, "/actions/github-pr-monitor-state", {
      runId: "run-state",
      actionPlanId: "plan-state",
      idempotencyKey: "idem-state",
      eventId: "event-state",
      command: "record-side-effect",
      input: JSON.stringify({ marker: "decoded-before-dispatch" }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      toolCall: { namespace?: string; tool?: string };
      structuredContent: { code?: string };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.toolCall).toMatchObject({
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_state",
    });
    expect(body.structuredContent.code).toBe("APPROVAL_REQUIRED");
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.call.failed",
      tool: "github_pr_monitor_state",
      input: expect.objectContaining({
        input: { marker: "decoded-before-dispatch" },
      }),
    }));

    const malformed = await postAction(server.baseUrl, "/actions/github-pr-monitor-state", {
      runId: "run-state",
      actionPlanId: "plan-state",
      idempotencyKey: "idem-state",
      eventId: "event-state",
      command: "status",
      input: "{not-json",
    });
    const malformedBody = (await malformed.json()) as { structuredContent: { code?: string } };
    expect(malformedBody.structuredContent.code).toBe("INVALID_INPUT");
  });

  it("dispatches valid dedicated PR actions and preserves action receipts", async () => {
    const restorePath = await installFakeGithubCli(projectRoot);
    try {
      const events: Array<Record<string, unknown>> = [];
      const ctx = makeCtx(stateDir, projectRoot);
      ctx.ledger.append = async (event) => {
        events.push(event as unknown as Record<string, unknown>);
      };
      const server = await startApp(ctx);
      stop = server.stop;
      const identity = {
        runId: "run-7",
        actionPlanId: "plan-7",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 7,
      };

      const readRes = await postAction(server.baseUrl, "/actions/github-pr-monitor-read", identity);
      const readBody = (await readRes.json()) as {
        ok: boolean;
        tool: string;
        toolCall: { namespace?: string; tool?: string; toolName?: string; ok?: boolean; input?: Record<string, unknown> };
        structuredContent: { repository?: string; author?: string; prs?: unknown[] };
      };
      expect(readBody).toMatchObject({
        ok: true,
        tool: "github_pr_monitor_read",
        toolCall: { namespace: "ChatGPT_To_Codex", tool: "github_pr_monitor_read", toolName: "github_pr_monitor_read", ok: true, input: identity },
        structuredContent: { repository: "Yeachan-Heo/gajae-code", author: "twoimo" },
      });
      expect(readBody.structuredContent.prs).toHaveLength(1);
      await establishAuthoritativeMonitorPlan(server.baseUrl, identity);

      const prepareRes = await postAction(server.baseUrl, "/actions/github-pr-monitor-prepare", {
        ...identity,
        idempotencyKey: "idem-prepare",
        eventId: "event-prepare",
        expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
        operation: "quarantine",
      });
      const prepareBody = (await prepareRes.json()) as {
        ok: boolean;
        structuredContent: { code?: string };
      };
      expect(prepareBody.ok).toBe(false);
      expect(prepareBody.structuredContent.code).toBe("PROJECT_NOT_FOUND");
      expect(events).toContainEqual(expect.objectContaining({
        type: "tool.call.failed",
        tool: "github_pr_monitor_prepare",
      }));

      const mutateRes = await postAction(server.baseUrl, "/actions/github-pr-monitor-mutate", {
        ...identity,
        idempotencyKey: "idem-mutate",
        eventId: "event-mutate",
        expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
        operation: "post_reply",
        body: "Bounded reply",
      });
      const mutateBody = (await mutateRes.json()) as {
        ok: boolean;
        tool: string;
        toolCall: { namespace?: string; tool?: string; ok?: boolean };
        structuredContent: {
          receiptId?: string;
          operation?: string;
          repository?: string;
          author?: string;
          idempotencyKey?: string;
          ok?: boolean;
        };
      };
      expect(mutateBody).toMatchObject({
        ok: true,
        tool: "github_pr_monitor_mutate",
        toolCall: { namespace: "ChatGPT_To_Codex", tool: "github_pr_monitor_mutate", ok: true },
        structuredContent: {
          operation: "post_reply",
          repository: "Yeachan-Heo/gajae-code",
          author: "twoimo",
          idempotencyKey: "idem-mutate",
          ok: true,
        },
      });
      expect(mutateBody.structuredContent.receiptId).toMatch(/^[0-9a-f]{64}$/u);
      const claims = (await fs.readFile(path.join(projectRoot, "fake-bin", "claim-invocations.log"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(claims.at(-1)).toEqual({
        runId: "run-7",
        actionPlanId: "plan-7",
        idempotencyKey: "idem-mutate",
        repository: "Yeachan-Heo/gajae-code",
        prNumber: 7,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        operation: "post_reply",
        phase: "mutate",
        operationFields: { body: "Bounded reply" },
      });
      const retryRes = await postAction(server.baseUrl, "/actions/github-pr-monitor-mutate", {
        ...identity,
        idempotencyKey: "idem-mutate",
        eventId: "event-mutate",
        expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
        operation: "post_reply",
        body: "Bounded reply",
      });
      const retryBody = await retryRes.json();
      expect(JSON.stringify(retryBody)).toBe(JSON.stringify(mutateBody));
      const ghInvocations = (await fs.readFile(path.join(projectRoot, "fake-bin", "gh-invocations.log"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(ghInvocations.filter((args) =>
        args[1]?.endsWith("/comments") && !args.includes("--paginate")
        && args.some((arg) => arg.includes("idem-mutate")))).toHaveLength(1);
    } finally {
      restorePath();
    }
  });
  it("rejects malformed and unplanned mutations before GitHub I/O", async () => {
    const restorePath = await installFakeGithubCli(projectRoot);
    try {
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;
      const baseInput = {
        runId: "run-unplanned",
        actionPlanId: "plan-unplanned",
        idempotencyKey: "idem-unplanned",
        eventId: "event-unplanned",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 7,
        expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
        operation: "post_reply",
        body: "Must not be posted",
      };
      const malformed = await postAction(server.baseUrl, "/actions/github-pr-monitor-mutate", {
        ...baseInput,
        threadId: "EXTRANEOUS_THREAD",
      });
      expect(((await malformed.json()) as { ok: boolean }).ok).toBe(false);
      const claimLogPath = path.join(projectRoot, "fake-bin", "claim-invocations.log");
      const ghLogPath = path.join(projectRoot, "fake-bin", "gh-invocations.log");
      expect(await fs.readFile(claimLogPath, "utf8").catch(() => "")).toBe("");
      expect(await fs.readFile(ghLogPath, "utf8").catch(() => "")).toBe("");
      await establishAuthoritativeMonitorPlan(server.baseUrl, {
        ...baseInput,
        actionPlanId: "reject-plan",
      });
      await fs.writeFile(ghLogPath, "");

      const response = await postAction(server.baseUrl, "/actions/github-pr-monitor-mutate", {
        ...baseInput,
        actionPlanId: "reject-plan",
      });
      const body = (await response.json()) as { ok: boolean; structuredContent: { code?: string } };
      expect(body.ok).toBe(false);
      expect(body.structuredContent.code).toBe("APPROVAL_REQUIRED");
      expect(await fs.readFile(ghLogPath, "utf8").catch(() => "")).toBe("");
    } finally {
      restorePath();
    }
  });

  it("fails closed on GraphQL errors, missing review-thread shape, and incomplete pagination", async () => {
    const restorePath = await installFakeGithubCli(projectRoot);
    try {
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;
      for (const prNumber of [901, 902, 903]) {
        const response = await postAction(server.baseUrl, "/actions/github-pr-monitor-read", {
          runId: `run-graphql-${prNumber}`,
          actionPlanId: `plan-graphql-${prNumber}`,
          repository: "Yeachan-Heo/gajae-code",
          author: "twoimo",
          prNumber,
        });
        const body = (await response.json()) as { ok: boolean; structuredContent: { code?: string; error?: string } };
        expect(body.ok, String(prNumber)).toBe(false);
        expect(body.structuredContent.code, String(prNumber)).toBe("APPROVAL_REQUIRED");
      }
    } finally {
      restorePath();
    }
  });

  it("rejects foreign and already-resolved review threads from the current PR snapshot", async () => {
    const restorePath = await installFakeGithubCli(projectRoot);
    try {
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;
      const baseInput = {
        runId: "run-thread",
        actionPlanId: "plan-thread",
        idempotencyKey: "idem-thread",
        eventId: "event-thread",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 7,
        expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
        operation: "resolve_thread",
      };
      const mutationIdentity = (suffix: string) => ({
        idempotencyKey: `idem-thread-${suffix}`,
        eventId: `event-thread-${suffix}`,
      });
      await establishAuthoritativeMonitorPlan(server.baseUrl, baseInput);

      for (const threadId of ["THREAD_FOREIGN", "THREAD_RESOLVED"]) {
        const res = await postAction(server.baseUrl, "/actions/github-pr-monitor-mutate", {
          ...baseInput,
          ...mutationIdentity(threadId.toLowerCase()),
          threadId,
        });
        const body = (await res.json()) as {
          ok: boolean;
          structuredContent: { code?: string; error?: string };
        };

        expect(body.ok, threadId).toBe(false);
        expect(body.structuredContent.code, threadId).toBe("APPROVAL_REQUIRED");
        expect(body.structuredContent.error, threadId).toMatch(
          /unresolved thread from the current fixed PR snapshot|no unique exact thread evidence|already applied without an exact pending intent/,
        );
      }
      const graphqlError = await postAction(server.baseUrl, "/actions/github-pr-monitor-mutate", {
        ...baseInput,
        ...mutationIdentity("graphql-error"),
        threadId: "THREAD_GRAPHQL_ERROR",
      });
      const graphqlErrorBody = (await graphqlError.json()) as {
        ok: boolean;
        structuredContent: { code?: string; error?: string };
      };
      expect(graphqlErrorBody.ok).toBe(false);
      expect(graphqlErrorBody.structuredContent.code).toBe("APPROVAL_REQUIRED");
      expect(graphqlErrorBody.structuredContent.error).toContain("GraphQL errors");
      const current = await postAction(server.baseUrl, "/actions/github-pr-monitor-mutate", {
        ...baseInput,
        ...mutationIdentity("current"),
        threadId: "THREAD_CURRENT",
      });
      const currentBody = (await current.json()) as {
        ok: boolean;
        structuredContent: { operation?: string; remoteObject?: { id?: string } };
      };
      expect(currentBody.ok).toBe(true);
      expect(currentBody.structuredContent).toMatchObject({
        operation: "resolve_thread",
        remoteObject: { id: "THREAD_CURRENT" },
      });
    } finally {
      restorePath();
    }
  });
  it("re-requests only a snapshot-known reviewer and confirms the exact reviewer in GitHub's response", async () => {
    const restorePath = await installFakeGithubCli(projectRoot);
    try {
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;
      const baseInput = {
        runId: "run-reviewer",
        actionPlanId: "plan-reviewer",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 7,
        expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
        operation: "rerequest_reviewer",
      };
      await establishAuthoritativeMonitorPlan(server.baseUrl, baseInput);

      async function rerequest(reviewer: string): Promise<{
        ok: boolean;
        text?: string;
        structuredContent: {
          code?: string;
          error?: string;
          operation?: string;
          reviewer?: string;
          remoteObject?: { id?: string; reviewer?: string };
        };
      }> {
        const response = await postAction(server.baseUrl, "/actions/github-pr-monitor-mutate", {
          ...baseInput,
          idempotencyKey: `idem-${reviewer}`,
          eventId: `event-${reviewer}`,
          reviewer,
        });
        return response.json() as Promise<{
          ok: boolean;
          text?: string;
          structuredContent: {
            code?: string;
            error?: string;
            operation?: string;
            remoteObject?: { id?: string; reviewer?: string };
          };
        }>;
      }

      const foreign = await rerequest("foreign-reviewer");
      expect(foreign.ok).toBe(false);
      expect(foreign.structuredContent).toMatchObject({
        code: "APPROVAL_REQUIRED",
        error: expect.stringContaining("current request or reviewer"),
      });
      const afterForeign = await fs.readFile(path.join(projectRoot, "fake-bin", "gh-invocations.log"), "utf8");
      expect(afterForeign).not.toContain("reviewers[]=foreign-reviewer");

      for (const reviewer of ["requested-reviewer", "previous-reviewer"]) {
        const success = await rerequest(reviewer);
        expect(success.ok, reviewer).toBe(true);
        expect(success.text, reviewer).toBe("Applied rerequest_reviewer to PR #7.");
        expect(success.structuredContent, reviewer).toMatchObject({
          operation: "rerequest_reviewer",
          remoteObject: { id: reviewer, reviewer },
        });
      }

      const unconfirmed = await rerequest("unconfirmed-reviewer");
      expect(unconfirmed.ok).toBe(false);
      expect(unconfirmed.structuredContent).toMatchObject({
        code: "APPROVAL_REQUIRED",
        error: expect.stringContaining("did not confirm the exact reviewer"),
      });

      const malformedJson = await rerequest("malformed-json-reviewer");
      expect(malformedJson.ok).toBe(false);
      expect(malformedJson.structuredContent).toMatchObject({
        code: "APPROVAL_REQUIRED",
        error: expect.stringContaining("returned malformed JSON"),
      });

      const malformedShape = await rerequest("malformed-shape-reviewer");
      expect(malformedShape.ok).toBe(false);
      expect(malformedShape.structuredContent).toMatchObject({
        code: "APPROVAL_REQUIRED",
        error: expect.stringContaining("omitted the requested-reviewer set"),
      });
    } finally {
      restorePath();
    }
  });
  it("recovers a stranded resolve_thread intent from already-resolved evidence and fails closed on ambiguous evidence", async () => {
    const restorePath = await installFakeGithubCli(projectRoot);
    const originalComplete = ActionReceiptAuthority.prototype.completeMutationOutcome;
    try {
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;
      const statePath = path.join(projectRoot, "fake-bin", "gh-state.json");
      const ghLogPath = path.join(projectRoot, "fake-bin", "gh-invocations.log");
      const patchGhState = async (patch: Record<string, unknown>): Promise<void> => {
        const current = JSON.parse(
          await fs.readFile(statePath, "utf8").catch(() => "{}"),
        ) as Record<string, unknown>;
        await fs.writeFile(statePath, JSON.stringify({ ...current, ...patch }));
      };
      const resolveMutationCount = async (threadId: string): Promise<number> =>
        (await fs.readFile(ghLogPath, "utf8").catch(() => ""))
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as string[])
          .filter((args) => args.some((arg) => arg.includes("resolveReviewThread"))
            && args.includes(`id=${threadId}`)).length;
      const baseInput = {
        runId: "run-resolve-recovery",
        actionPlanId: "plan-resolve-recovery",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 7,
        expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
        operation: "resolve_thread",
      };
      const mutate = async (suffix: string, threadId: string): Promise<{
        ok: boolean;
        text?: string;
        structuredContent: {
          code?: string;
          error?: string;
          operation?: string;
          remoteObject?: { id?: string; html_url?: string };
        };
      }> => {
        const response = await postAction(server.baseUrl, "/actions/github-pr-monitor-mutate", {
          ...baseInput,
          idempotencyKey: `idem-resolve-${suffix}`,
          eventId: `event-resolve-${suffix}`,
          threadId,
        });
        return response.json() as Promise<{
          ok: boolean;
          text?: string;
          structuredContent: {
            code?: string;
            error?: string;
            operation?: string;
            remoteObject?: { id?: string; html_url?: string };
          };
        }>;
      };

      await patchGhState({});
      await establishAuthoritativeMonitorPlan(server.baseUrl, baseInput);

      let strandResolve = true;
      ActionReceiptAuthority.prototype.completeMutationOutcome = async function (...args) {
        if (strandResolve) {
          strandResolve = false;
          throw new Error("injected crash after GitHub resolved the thread before outcome completion");
        }
        return originalComplete.apply(this, args);
      };
      const lostResolve = await mutate("current", "THREAD_CURRENT");
      ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
      expect(lostResolve.ok).toBe(false);
      expect(await resolveMutationCount("THREAD_CURRENT")).toBe(1);
      const strandedState = JSON.parse(await fs.readFile(statePath, "utf8")) as { resolvedThreads?: string[] };
      expect(strandedState.resolvedThreads).toEqual(["THREAD_CURRENT"]);

      const recovered = await mutate("current", "THREAD_CURRENT");
      expect(recovered.ok, JSON.stringify(recovered.structuredContent)).toBe(true);
      expect(recovered.text).toBe("Applied resolve_thread to PR #7.");
      expect(recovered.structuredContent).toMatchObject({
        operation: "resolve_thread",
        remoteObject: {
          id: "THREAD_CURRENT",
          html_url: "https://github.com/Yeachan-Heo/gajae-code/pull/7",
        },
      });
      expect(await resolveMutationCount("THREAD_CURRENT")).toBe(1);
      const replayedResolve = await mutate("current", "THREAD_CURRENT");
      expect(JSON.stringify(replayedResolve)).toBe(JSON.stringify(recovered));
      expect(await resolveMutationCount("THREAD_CURRENT")).toBe(1);

      const strandedHead = await mutate("head", "THREAD_GRAPHQL_ERROR");
      expect(strandedHead.ok).toBe(false);
      expect(strandedHead.structuredContent.error).toContain("GraphQL errors");
      expect(await resolveMutationCount("THREAD_GRAPHQL_ERROR")).toBe(1);
      await patchGhState({ headRefOid: "cccccccccccccccccccccccccccccccccccccccc" });
      const ambiguousHead = await mutate("head", "THREAD_GRAPHQL_ERROR");
      expect(ambiguousHead.ok).toBe(false);
      expect(ambiguousHead.structuredContent).toMatchObject({
        code: "APPROVAL_REQUIRED",
        error: expect.stringContaining("Pending resolve intent has ambiguous remote-head evidence"),
      });
      expect(await resolveMutationCount("THREAD_GRAPHQL_ERROR")).toBe(1);
      await patchGhState({ headRefOid: baseInput.expectedHeadSha });

      const strandedMissing = await mutate("missing", "THREAD_GRAPHQL_ERROR");
      expect(strandedMissing.ok).toBe(false);
      expect(await resolveMutationCount("THREAD_GRAPHQL_ERROR")).toBe(2);
      await patchGhState({ hiddenThreads: ["THREAD_GRAPHQL_ERROR"] });
      const noUniqueThread = await mutate("missing", "THREAD_GRAPHQL_ERROR");
      expect(noUniqueThread.ok).toBe(false);
      expect(noUniqueThread.structuredContent).toMatchObject({
        code: "APPROVAL_REQUIRED",
        error: expect.stringContaining("Pending resolve intent has no unique exact thread evidence"),
      });
      expect(await resolveMutationCount("THREAD_GRAPHQL_ERROR")).toBe(2);
    } finally {
      ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
      restorePath();
    }
  });
  it("recovers rerequest_reviewer before and after GitHub applies the request without duplicating the effect", async () => {
    const restorePath = await installFakeGithubCli(projectRoot);
    const originalComplete = ActionReceiptAuthority.prototype.completeMutationOutcome;
    try {
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;
      const statePath = path.join(projectRoot, "fake-bin", "gh-state.json");
      const ghLogPath = path.join(projectRoot, "fake-bin", "gh-invocations.log");
      const patchGhState = async (patch: Record<string, unknown>): Promise<void> => {
        const current = JSON.parse(
          await fs.readFile(statePath, "utf8").catch(() => "{}"),
        ) as Record<string, unknown>;
        await fs.writeFile(statePath, JSON.stringify({ ...current, ...patch }));
      };
      const reviewerPostCount = async (reviewer: string): Promise<number> =>
        (await fs.readFile(ghLogPath, "utf8").catch(() => ""))
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as string[])
          .filter((args) => args.includes(`reviewers[]=${reviewer}`)).length;
      const baseInput = {
        runId: "run-reviewer-recovery",
        actionPlanId: "plan-reviewer-recovery",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 7,
        expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
        operation: "rerequest_reviewer",
      };
      const mutate = async (suffix: string, reviewer: string): Promise<{
        ok: boolean;
        text?: string;
        structuredContent: {
          code?: string;
          error?: string;
          operation?: string;
          remoteObject?: { id?: string; reviewer?: string };
        };
      }> => {
        const response = await postAction(server.baseUrl, "/actions/github-pr-monitor-mutate", {
          ...baseInput,
          idempotencyKey: `idem-reviewer-${suffix}`,
          eventId: `event-reviewer-${suffix}`,
          reviewer,
        });
        return response.json() as Promise<{
          ok: boolean;
          text?: string;
          structuredContent: {
            code?: string;
            error?: string;
            operation?: string;
            remoteObject?: { id?: string; reviewer?: string };
          };
        }>;
      };
      const preexistingRequests = [
        { login: "preexisting-reviewer" },
        { login: "duplicate-reviewer" },
        { login: "head-reviewer" },
      ];

      await patchGhState({ reviewRequests: preexistingRequests });
      await establishAuthoritativeMonitorPlan(server.baseUrl, baseInput);

      // "previous-reviewer" is a past reviewer but is NOT currently requested,
      // so a recovered intent can safely re-perform the request exactly once.
      await patchGhState({ failReviewerPost: ["previous-reviewer"] });
      const lostReviewer = await mutate("previous", "previous-reviewer");
      expect(lostReviewer.ok).toBe(false);
      expect(await reviewerPostCount("previous-reviewer")).toBe(0);
      await patchGhState({ failReviewerPost: [] });
      const recoveredReviewer = await mutate("previous", "previous-reviewer");
      expect(recoveredReviewer.ok, JSON.stringify(recoveredReviewer.structuredContent)).toBe(true);
      expect(recoveredReviewer.text).toBe("Applied rerequest_reviewer to PR #7.");
      expect(recoveredReviewer.structuredContent).toMatchObject({
        operation: "rerequest_reviewer",
        remoteObject: { id: "previous-reviewer", reviewer: "previous-reviewer" },
      });
      expect(await reviewerPostCount("previous-reviewer")).toBe(1);
      const replayedReviewer = await mutate("previous", "previous-reviewer");
      expect(JSON.stringify(replayedReviewer)).toBe(JSON.stringify(recoveredReviewer));
      expect(await reviewerPostCount("previous-reviewer")).toBe(1);

      await patchGhState({ reviewRequests: preexistingRequests });
      const postsBeforeStrand = await reviewerPostCount("previous-reviewer");
      let strandPostApply = true;
      ActionReceiptAuthority.prototype.completeMutationOutcome = async function (...args) {
        if (strandPostApply) {
          strandPostApply = false;
          throw new Error("injected crash after reviewer request applied before outcome completion");
        }
        return originalComplete.apply(this, args);
      };
      const lostPostApply = await mutate("postapply", "previous-reviewer");
      ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
      expect(lostPostApply.ok).toBe(false);
      expect(await reviewerPostCount("previous-reviewer")).toBe(postsBeforeStrand + 1);
      const recoveredPostApply = await mutate("postapply", "previous-reviewer");
      expect(recoveredPostApply.ok, JSON.stringify(recoveredPostApply.structuredContent)).toBe(true);
      expect(recoveredPostApply.structuredContent).toMatchObject({
        operation: "rerequest_reviewer",
        remoteObject: { id: "previous-reviewer", reviewer: "previous-reviewer" },
      });
      expect(await reviewerPostCount("previous-reviewer")).toBe(postsBeforeStrand + 1);
      const replayedPostApply = await mutate("postapply", "previous-reviewer");
      expect(JSON.stringify(replayedPostApply)).toBe(JSON.stringify(recoveredPostApply));
      expect(await reviewerPostCount("previous-reviewer")).toBe(postsBeforeStrand + 1);

      // A reviewer already requested before the intent is never proof
      // that this intent's request landed, so recovery must fail closed.
      await patchGhState({ failReviewerPost: ["preexisting-reviewer"] });
      const lostPreexisting = await mutate("preexisting", "preexisting-reviewer");
      expect(lostPreexisting.ok).toBe(false);
      expect(await reviewerPostCount("preexisting-reviewer")).toBe(0);
      await patchGhState({ failReviewerPost: [] });
      const ambiguousPreexisting = await mutate("preexisting", "preexisting-reviewer");
      expect(ambiguousPreexisting.ok).toBe(false);
      expect(ambiguousPreexisting.structuredContent).toMatchObject({
        code: "APPROVAL_REQUIRED",
        error: expect.stringContaining("Pending reviewer intent has ambiguous preexisting requested-reviewer evidence"),
      });
      expect(await reviewerPostCount("preexisting-reviewer")).toBe(0);

      await patchGhState({ failReviewerPost: ["duplicate-reviewer"] });
      const lostDuplicate = await mutate("duplicate", "duplicate-reviewer");
      expect(lostDuplicate.ok).toBe(false);
      await patchGhState({
        failReviewerPost: [],
        reviewRequests: [...preexistingRequests, { login: "duplicate-reviewer" }],
      });
      const duplicateEvidence = await mutate("duplicate", "duplicate-reviewer");
      expect(duplicateEvidence.ok).toBe(false);
      expect(duplicateEvidence.structuredContent).toMatchObject({
        code: "APPROVAL_REQUIRED",
        error: expect.stringContaining("Pending reviewer intent has duplicate exact reviewer evidence"),
      });
      expect(await reviewerPostCount("duplicate-reviewer")).toBe(0);

      await patchGhState({
        failReviewerPost: ["head-reviewer"],
        reviewRequests: preexistingRequests,
      });
      const lostHead = await mutate("head", "head-reviewer");
      expect(lostHead.ok).toBe(false);
      await patchGhState({
        failReviewerPost: [],
        headRefOid: "cccccccccccccccccccccccccccccccccccccccc",
      });
      const ambiguousReviewerHead = await mutate("head", "head-reviewer");
      expect(ambiguousReviewerHead.ok).toBe(false);
      expect(ambiguousReviewerHead.structuredContent).toMatchObject({
        code: "APPROVAL_REQUIRED",
        error: expect.stringContaining("Pending reviewer intent has ambiguous remote-head evidence"),
      });
      expect(await reviewerPostCount("head-reviewer")).toBe(0);
    } finally {
      ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
      restorePath();
    }
  });

  it("accepts one exact read receipt through ingest then plan-cycle and rejects forged, altered, and replayed reads", async () => {
    const restorePath = await installFakeGithubCli(projectRoot);
    try {
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;
      const identity = {
        runId: "run-read-lifecycle",
        actionPlanId: "plan-read-lifecycle",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 7,
      };
      const readResponse = await postAction(server.baseUrl, "/actions/github-pr-monitor-read", identity);
      const readReceipt = (await readResponse.json()) as Record<string, unknown>;
      expect(readReceipt.ok).toBe(true);

      async function state(command: "ingest" | "plan-cycle", receipt: Record<string, unknown>, actionPlanId = identity.actionPlanId, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        const response = await postAction(server.baseUrl, "/actions/github-pr-monitor-state", {
          runId: identity.runId,
          actionPlanId,
          idempotencyKey: `idem-${command}`,
          eventId: `event-${command}`,
          command,
          input: JSON.stringify({ ...extra, receipt }),
        });
        return (await response.json()) as Record<string, unknown>;
      }
      const snapshot = ((readReceipt.structuredContent as Record<string, unknown>).prs as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
      const planInput = {
        prs: [{
          number: snapshot.number,
          author: "twoimo",
          headRef: snapshot.headRefName,
          headOid: snapshot.headRefOid,
          attempts: 0,
          tier: 1,
          reply: "Bounded reply",
        }],
      };

      const fullyForged = structuredClone(readReceipt);
      (fullyForged.structuredContent as Record<string, unknown>).receiptId = "f".repeat(64);
      expect((await state("ingest", fullyForged)).ok).toBe(false);

      for (const [label, rewrite] of [
        ["outer.text", (receipt: Record<string, unknown>) => { receipt.text = "forged"; }],
        ["outer.extra", (receipt: Record<string, unknown>) => { receipt.extra = true; }],
        ["toolCall.input", (receipt: Record<string, unknown>) => {
          ((receipt.toolCall as Record<string, unknown>).input as Record<string, unknown>).prNumber = 8;
        }],
        ["read.prs", (receipt: Record<string, unknown>) => {
          (receipt.structuredContent as Record<string, unknown>).prs = [];
        }],
        ["read.observedAt", (receipt: Record<string, unknown>) => {
          (receipt.structuredContent as Record<string, unknown>).observedAt = "2020-01-01T00:00:00.000Z";
        }],
        ["read.actionPlanId", (receipt: Record<string, unknown>) => {
          (receipt.structuredContent as Record<string, unknown>).actionPlanId = "plan-forged";
        }],
      ] as const) {
        const altered = structuredClone(readReceipt);
        rewrite(altered);
        const rejected = await state("ingest", altered);
        expect(rejected.ok, label).toBe(false);
        expect((rejected.structuredContent as Record<string, unknown>).code, label).toBe("APPROVAL_REQUIRED");
      }

      expect((await state("ingest", readReceipt, "plan-transplanted")).ok).toBe(false);
      expect((await state("plan-cycle", readReceipt)).ok).toBe(false);
      expect((await state("ingest", readReceipt)).ok).toBe(true);
      expect((await state("ingest", readReceipt)).ok).toBe(false);
      expect((await state("plan-cycle", readReceipt, identity.actionPlanId, planInput)).ok).toBe(true);
      expect((await state("plan-cycle", readReceipt)).ok).toBe(false);
    } finally {
      restorePath();
    }
  });
  it("rejects field-by-field receipt rewrites and non-exact outer Action receipts for state commands", async () => {
    const restorePath = await installFakeGithubCli(projectRoot);
    try {
      const repositoryRoot = path.join(projectRoot, "gajae-code");
      await fs.mkdir(repositoryRoot, { recursive: true });
      const ctx = makeCtx(stateDir, projectRoot);
      ctx.registry.splice(0, ctx.registry.length, {
        projectId: "gajae-code",
        name: "gajae-code",
        root: repositoryRoot,
        aliases: [],
      });
      const server = await startApp(ctx);
      stop = server.stop;
      const identity = {
        runId: "run-receipt",
        actionPlanId: "plan-receipt",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 7,
        expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
      };
      const prepareInput = {
        ...identity,
        idempotencyKey: "idem-prepare-receipt",
        eventId: "event-prepare-receipt",
        operation: "quarantine",
      };
      const mutateInput = {
        ...identity,
        idempotencyKey: "idem-mutate-receipt",
        eventId: "event-mutate-receipt",
        operation: "post_reply",
        body: "Receipt-bound reply",
      };
      await establishAuthoritativeMonitorPlan(server.baseUrl, identity);
      const prepareResponse = await postAction(server.baseUrl, "/actions/github-pr-monitor-prepare", prepareInput);
      const prepareReceipt = (await prepareResponse.json()) as Record<string, unknown>;
      const mutateResponse = await postAction(server.baseUrl, "/actions/github-pr-monitor-mutate", mutateInput);
      const mutateReceipt = (await mutateResponse.json()) as Record<string, unknown>;

      expect(prepareReceipt.ok).toBe(true);
      expect(mutateReceipt.ok).toBe(true);

      async function expectStateReceiptRejected(
        command: "record-side-effect" | "reconcile",
        receipt: Record<string, unknown>,
        label: string,
      ): Promise<void> {
        const res = await postAction(server.baseUrl, "/actions/github-pr-monitor-state", {
          runId: `run-state-${command}`,
          actionPlanId: `plan-state-${command}`,
          idempotencyKey: `idem-state-${command}`,
          eventId: `event-state-${command}`,
          command,
          input: JSON.stringify({ receipt }),
        });
        const body = (await res.json()) as {
          ok: boolean;
          structuredContent: { code?: string };
        };
        expect(body.ok, label).toBe(false);
        expect(body.structuredContent.code, label).toBe("APPROVAL_REQUIRED");
      }

      function adversarialValue(current: unknown): unknown {
        return typeof current === "boolean"
          ? !current
          : typeof current === "number"
            ? current + 1
            : typeof current === "string"
              ? `${current}-rewritten`
              : { rewritten: true };
      }

      function rewrittenField(receipt: Record<string, unknown>, field: string): Record<string, unknown> {
        const rewritten = structuredClone(receipt);
        const structured = rewritten.structuredContent as Record<string, unknown>;
        structured[field] = adversarialValue(structured[field]);
        return rewritten;
      }

      for (const [kind, receipt] of [
        ["prepare", prepareReceipt],
        ["mutate", mutateReceipt],
      ] as const) {
        const structured = receipt.structuredContent as Record<string, unknown>;
        for (const field of Object.keys(structured).filter((key) => key !== "receiptId")) {
          const rewritten = rewrittenField(receipt, field);
          expect(
            (rewritten.structuredContent as Record<string, unknown>).receiptId,
            `${kind}.${field}`,
          ).toBe(structured.receiptId);
          await expectStateReceiptRejected(
            "record-side-effect",
            rewritten,
            `${kind}.${field}`,
          );
        }
      }
      const issuedToolCallInput = (mutateReceipt.toolCall as { input: Record<string, unknown> }).input;
      for (const field of Object.keys(issuedToolCallInput)) {
        const rewritten = structuredClone(mutateReceipt);
        const input = (rewritten.toolCall as { input: Record<string, unknown> }).input;
        input[field] = adversarialValue(input[field]);
        await expectStateReceiptRejected(
          "record-side-effect",
          rewritten,
          `mutate.toolCall.input.${field}`,
        );
      }

      const outerRewrites: Array<[string, (receipt: Record<string, unknown>) => void]> = [
        ["ok", (receipt) => { receipt.ok = false; }],
        ["tool", (receipt) => { receipt.tool = "github_pr_monitor_prepare"; }],
        ["text", (receipt) => { receipt.text = "rewritten"; }],
        ["imageMarkdownList", (receipt) => { receipt.imageMarkdownList = ["rewritten"]; }],
        ["extraOuterField", (receipt) => { receipt.extra = true; }],
        ["toolCall.namespace", (receipt) => {
          (receipt.toolCall as Record<string, unknown>).namespace = "foreign";
        }],
        ["toolCall.tool", (receipt) => {
          (receipt.toolCall as Record<string, unknown>).tool = "github_pr_monitor_prepare";
        }],
        ["toolCall.toolName", (receipt) => {
          (receipt.toolCall as Record<string, unknown>).toolName = "call_tool";
        }],
        ["toolCall.currentTurnProof", (receipt) => {
          (receipt.toolCall as Record<string, unknown>).currentTurnProof = false;
        }],
        ["toolCall.input.actionPlanId", (receipt) => {
          const toolCall = receipt.toolCall as { input: Record<string, unknown> };
          toolCall.input.actionPlanId = "plan-rewritten";
        }],
        ["toolCall.input.crossOperation", (receipt) => {
          (receipt.toolCall as Record<string, unknown>).input = prepareInput;
        }],
        ["structuredContent.crossOperation", (receipt) => {
          receipt.structuredContent = prepareReceipt.structuredContent;
        }],
      ];

      for (const command of ["record-side-effect", "reconcile"] as const) {
        for (const [label, rewrite] of outerRewrites) {
          const rewritten = structuredClone(mutateReceipt);
          rewrite(rewritten);
          await expectStateReceiptRejected(command, rewritten, `${command}.${label}`);
        }
      }
    } finally {
      restorePath();
    }
    // Every field of both receipts, every toolCall.input field, and every outer
    // rewrite is replayed as its own HTTP round-trip against a live server, so this
    // case issues dozens of requests and cannot fit the 5s default (measured 8s).
    // Widening the clock only; every assertion still runs.
  }, 45_000);
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
    expect(monitorBypass.status).toBe(400);
    await expect(monitorBypass.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("strict Action route"),
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
  it("releases a crashed cross-process SQLite writer lock and preserves both outcomes", async () => {
    const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-lock-takeover-")));
    const canonical = (value: unknown): string => {
      if (value === null || typeof value !== "object") {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new TypeError("Test value is not JSON-serializable");
        return serialized;
      }
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
    };
    const binding = (suffix: string): MutationOutcomeBinding => {
      const claim = {
        runId: `run-lock-${suffix}`,
        actionPlanId: `plan-lock-${suffix}`,
        idempotencyKey: `idem-lock-${suffix}`,
        repository: "Yeachan-Heo/gajae-code" as const,
        prNumber: 7,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        phase: "mutate" as const,
        operation: "post_reply" as const,
        operationFields: { body: `reply-${suffix}` },
      };
      return {
        runId: claim.runId,
        coordinationId: `coordination-lock-${suffix}`,
        actionPlanId: claim.actionPlanId,
        idempotencyKey: claim.idempotencyKey,
        claimId: `claim-lock-${suffix}`,
        claimPayloadDigest: createHash("sha256").update(canonical(claim)).digest("hex"),
        repository: claim.repository,
        author: "twoimo",
        prNumber: claim.prNumber,
        expectedHeadSha: claim.headSha,
        eventId: `event-lock-${suffix}`,
        phase: claim.phase,
        operation: claim.operation,
        operationFields: claim.operationFields,
        input: {
          runId: claim.runId,
          actionPlanId: claim.actionPlanId,
          idempotencyKey: claim.idempotencyKey,
          eventId: `event-lock-${suffix}`,
          repository: claim.repository,
          author: "twoimo",
          prNumber: claim.prNumber,
          expectedHeadSha: claim.headSha,
          operation: claim.operation,
          body: `reply-${suffix}`,
        },
      };
    };

    try {
      const first = new ActionReceiptAuthority(stateDir);
      await first.beginMutationOutcome(binding("first"));
      const databasePath = path.join(stateDir, "action-receipts.sqlite");
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(${JSON.stringify(databasePath)});
database.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => process.exit(71), 300);`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await new Promise<void>((resolve, reject) => {
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });
        child.stdout.setEncoding("utf8");
        child.stdout.once("data", (chunk: string) => {
          if (chunk.includes("locked")) resolve();
          else reject(new Error(`SQLite lock child returned unexpected output: ${chunk}`));
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code !== null && code !== 71) reject(new Error(`SQLite lock child exited ${code}: ${stderr}`));
        });
      });

      const startedAt = Date.now();
      await expect(new ActionReceiptAuthority(stateDir).beginMutationOutcome(binding("after-crash")))
        .resolves.toMatch(/^[0-9a-f]{64}$/u);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
      await expect(new ActionReceiptAuthority(stateDir).mutationOutcomeStatus(binding("first"), "claimed"))
        .resolves.toMatchObject({ state: "intent" });
      await expect(new ActionReceiptAuthority(stateDir).mutationOutcomeStatus(binding("after-crash"), "claimed"))
        .resolves.toMatchObject({ state: "intent" });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
