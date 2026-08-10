import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMonitorServer, createServer } from "./mcp-server.js";
import { ActionReceiptAuthority } from "./action-receipts.js";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";

const execFileAsync = promisify(execFile);

async function fixtureGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { env: { ...process.env, ...env } });
  return result.stdout.trim();
}
const CONTROL_TOOL_NAMES = ["computer_screenshot", "computer_request_action", "computer_action_status", "computer_kill_switch"];

function makeCtx(): ToolContext {
  const stateDir = "/tmp/chatgpt2codex-tools-catalog-test";
  return {
    workspaceRoot: "/tmp",
    stateDir,
    registry: [],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => null,
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: "/tmp",
      stateDir,
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

function canonicalTestJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Test value is not JSON-serializable");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalTestJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalTestJson(record[key])}`).join(",")}}`;
}

type MonitorEffectKind = "prepare_create" | "prepare_quarantine" | "post_reply" | "resolve_thread" | "rerequest_reviewer" | "commit" | "normal_push";

function testDigest(value: unknown): string {
  return createHash("sha256").update(canonicalTestJson(value)).digest("hex");
}

function monitorAuthorization(
  input: Record<string, unknown>,
  effectKind?: MonitorEffectKind,
): Record<string, unknown> {
  const operationHeadSha = String(input.expectedHeadSha ?? input.headSha);
  const identity = {
    runId: input.runId,
    actionPlanId: input.actionPlanId,
    prNumber: input.prNumber,
    operation: input.operation,
    operationHeadSha,
  };
  const digest = (kind: string) => testDigest({ kind, ...identity });
  const unsigned = {
    protocolVersion: 1,
    schemaVersion: 4,
    ownerId: String(input.runId),
    leaseKey: `pr:Yeachan-Heo/gajae-code:${String(input.prNumber)}`,
    fence: 1,
    logicalIdentity: digest("logicalIdentity"),
    operationKey: digest("operationKey"),
    operationHeadSha,
    effectIdentity: digest("effectIdentity"),
    ...(effectKind === undefined ? {} : { effectKey: digest(`effectKey:${effectKind}`), effectKind }),
    targetDigest: digest("targetDigest"),
    policyDigest: digest("policyDigest"),
  };
  return { ...unsigned, bindingDigest: testDigest(unsigned) };
}

function authorizedMonitorInput<T extends Record<string, unknown>>(input: T): T & Record<string, unknown> {
  const effectKind = input.operation === "post_reply"
    ? "post_reply"
    : input.operation === "resolve_thread"
      ? "resolve_thread"
      : input.operation === "rerequest_reviewer"
        ? "rerequest_reviewer"
        : input.operation === "apply_suggestions"
          ? "commit"
          : input.operation === "push_prepared_worktree"
            ? "normal_push"
            : undefined;
  return { ...input, ...monitorAuthorization(input, effectKind) };
}

function durableOutcomeBinding(
  index: number,
  overrides: { idempotencyKey?: string; claimId?: string; body?: string; threadId?: string } = {},
) {
  const idempotencyKey = overrides.idempotencyKey ?? `idem-retention-${index}`;
  const body = overrides.body ?? `reply-${index}`;
  const threadId = overrides.threadId ?? `thread-retention-${index}`;
  const input = {
    runId: `run-retention-${index}`,
    actionPlanId: `plan-retention-${index}`,
    idempotencyKey,
    eventId: `event-retention-${index}`,
    repository: "Yeachan-Heo/gajae-code" as const,
    author: "twoimo" as const,
    prNumber: 7,
    expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
    operation: "post_reply" as const,
    body,
    threadId,
  };
  const authorization = monitorAuthorization(input, "post_reply");
  const authorizedInput = { ...input, ...authorization };
  const claim = {
    runId: input.runId,
    actionPlanId: input.actionPlanId,
    idempotencyKey,
    repository: input.repository,
    prNumber: input.prNumber,
    headSha: input.expectedHeadSha,
    phase: "mutate" as const,
    operation: input.operation,
    operationFields: { body, threadId },
    ...authorization,
  };
  return {
    runId: claim.runId,
    coordinationId: `coordination-retention-${index}`,
    actionPlanId: claim.actionPlanId,
    idempotencyKey,
    claimId: overrides.claimId ?? `claim-retention-${index}`,
    claimPayloadDigest: testDigest(claim),
    repository: claim.repository,
    author: input.author,
    prNumber: claim.prNumber,
    expectedHeadSha: claim.headSha,
    eventId: input.eventId,
    phase: claim.phase,
    operation: claim.operation,
    operationFields: claim.operationFields,
    input: authorizedInput,
    authorization,
  };
}

function durableReviewerBinding(index: number, reviewer = `reviewer-${index}`) {
  const idempotencyKey = `idem-reviewer-retention-${index}`;
  const input = {
    runId: `run-reviewer-retention-${index}`,
    actionPlanId: `plan-reviewer-retention-${index}`,
    idempotencyKey,
    eventId: `event-reviewer-retention-${index}`,
    repository: "Yeachan-Heo/gajae-code" as const,
    author: "twoimo" as const,
    prNumber: 7,
    expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
    operation: "rerequest_reviewer" as const,
    reviewer,
  };
  const authorization = monitorAuthorization(input, "rerequest_reviewer");
  const authorizedInput = { ...input, ...authorization };
  const claim = {
    runId: input.runId,
    actionPlanId: input.actionPlanId,
    idempotencyKey,
    repository: input.repository,
    prNumber: input.prNumber,
    headSha: input.expectedHeadSha,
    phase: "mutate" as const,
    operation: input.operation,
    operationFields: { reviewer },
    ...authorization,
  };
  return {
    runId: claim.runId,
    coordinationId: `coordination-reviewer-retention-${index}`,
    actionPlanId: claim.actionPlanId,
    idempotencyKey,
    claimId: `claim-reviewer-retention-${index}`,
    claimPayloadDigest: testDigest(claim),
    repository: claim.repository,
    author: input.author,
    prNumber: claim.prNumber,
    expectedHeadSha: claim.headSha,
    eventId: input.eventId,
    phase: claim.phase,
    operation: claim.operation,
    operationFields: claim.operationFields,
    input: authorizedInput,
    authorization,
  };
}
interface TestSqliteStatement {
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  all(...parameters: unknown[]): Record<string, unknown>[];
  run(...parameters: unknown[]): { changes: number | bigint };
}

interface TestSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): TestSqliteStatement;
  close(): void;
}

interface TestSqliteDatabaseConstructor {
  new (location: string): TestSqliteDatabase;
}

const testSqliteModuleId = `node:${"sqlite"}`;
const { DatabaseSync: TestDatabaseSync } = createRequire(import.meta.url)(testSqliteModuleId) as {
  DatabaseSync: TestSqliteDatabaseConstructor;
};

function withActionReceiptDatabase<T>(stateDir: string, operation: (database: TestSqliteDatabase) => T): T {
  const database = new TestDatabaseSync(path.join(stateDir, "action-receipts.sqlite"));
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function readAuthorityDocuments(stateDir: string): {
  receipts: Array<Record<string, unknown>>;
  mutationOutcomes: Array<Record<string, unknown>>;
} {
  return withActionReceiptDatabase(stateDir, (database) => ({
    receipts: database.prepare("SELECT document FROM receipts ORDER BY receipt_id").all()
      .map((row) => JSON.parse(String(row.document)) as Record<string, unknown>),
    mutationOutcomes: database.prepare("SELECT document FROM mutation_outcomes ORDER BY outcome_key").all()
      .map((row) => JSON.parse(String(row.document)) as Record<string, unknown>),
  }));
}

async function seedPlanBinding(stateDir: string, runId: string, actionPlanId: string): Promise<void> {
  const receiptId = createHash("sha256").update(`${runId}:${actionPlanId}`).digest("hex");
  const input = {
    runId,
    actionPlanId: "bootstrap",
    repository: "Yeachan-Heo/gajae-code",
    author: "twoimo",
  };
  const response = {
    tool: "github_pr_monitor_read",
    toolCall: { toolName: "github_pr_monitor_read", input },
    structuredContent: {
      receiptId,
      repository: "Yeachan-Heo/gajae-code",
      author: "twoimo",
    },
  };
  const authority = new ActionReceiptAuthority(stateDir);
  await authority.issue({
    receiptId,
    kind: "monitor-read",
    response,
    input,
    issuedAt: Date.now(),
    metadata: { runId, actionPlanId: "bootstrap" },
  });
  await authority.transitionExact(receiptId, "monitor-read", response, ["issued"], "consumed", {
    monitorActionPlanId: actionPlanId,
    coordinationId: "bootstrap",
    requestDigest: createHash("sha256").update(`request:${runId}:${actionPlanId}`).digest("hex"),
  });
}

const MONITOR_CLAIM_FAKE = `#!/usr/bin/env node
const crypto = require("node:crypto");
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
};
const authorizationKeys = ["protocolVersion", "schemaVersion", "ownerId", "leaseKey", "fence", "logicalIdentity", "operationKey", "operationHeadSha", "effectIdentity", "effectKey", "effectKind", "targetDigest", "policyDigest", "bindingDigest"];
let payload = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { payload += chunk; });
process.stdin.on("end", () => {
  const command = process.argv[process.argv.indexOf("--") + 1];
  const input = JSON.parse(payload || "{}");
  if (command === "recover") {
    console.log(JSON.stringify({ ok: true, command, ...input, committed: false }));
    return;
  }
  if (command === "lease-renew") {
    const serverTime = "2026-07-27T00:00:00.000Z";
    console.log(JSON.stringify({
      ok: true,
      command,
      protocolVersion: 1,
      schemaVersion: 4,
      requestDigest: crypto.createHash("sha256").update(canonical(input)).digest("hex"),
      result: {
        protocolVersion: 1,
        schemaVersion: 4,
        leaseKey: input.leaseKey,
        ownerId: input.ownerId,
        runId: input.runId,
        fence: input.fence,
        serverTime,
        expiresAt: "2026-07-27T00:00:30.000Z"
      }
    }));
    return;
  }
  console.log(JSON.stringify({
    ...Object.fromEntries(authorizationKeys.flatMap((key) => input[key] === undefined ? [] : [[key, input[key]]])),
    command: "claim-action",
    ok: true,
    claimId: "claim-" + input.idempotencyKey,
    claimedAt: "2026-07-27T00:00:00.000Z",
    payloadDigest: crypto.createHash("sha256").update(canonical(input)).digest("hex"),
    runId: input.runId,
    coordinationId: "bootstrap",
    actionPlanId: input.actionPlanId,
    idempotencyKey: input.idempotencyKey
  }));
});
`;


const RUN_DEFERRED_MONITOR_TESTS = process.env.CHATGPT2CODEX_RUN_DEFERRED_MONITOR_TESTS === "1";
async function createDeferredMonitorServerForTests(ctx: ToolContext): Promise<McpServer> {
  if (process.env.CHATGPT2CODEX_RUN_DEFERRED_MONITOR_TESTS !== "1") {
    throw new Error("Deferred monitor tools require CHATGPT2CODEX_RUN_DEFERRED_MONITOR_TESTS=1.");
  }
  const server = new McpServer({
    name: "chatgpt2codex-deferred-monitor-test",
    version: "0.1.1",
  });
  const { registerTools } = await import("./tools.js");
  registerTools(server, ctx, { monitorOnly: true, includeDeferredMonitorTools: true });
  return server;
}
function registeredNames(server: unknown): string[] {
  const tools = (server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
  return Object.keys(tools).sort();
}

const DEFERRED_NAMES = [
  "github_pr_monitor_execute",
  "github_pr_monitor_mutate",
  "github_pr_monitor_prepare",
  "github_pr_monitor_state",
] as const;

describe("deferred monitor authority registration", () => {
  it("keeps active stdio and monitor factories free of deferred tools", async () => {
    const activeNames = registeredNames(await createServer(makeCtx()));
    const monitorNames = registeredNames(await createMonitorServer(makeCtx()));

    for (const name of DEFERRED_NAMES) {
      expect(activeNames).not.toContain(name);
      expect(monitorNames).not.toContain(name);
    }
    expect(monitorNames).toEqual(["github_pr_monitor_read"]);
  });

  it.skipIf(!RUN_DEFERRED_MONITOR_TESTS)("exposes deferred tools only through the guarded test factory", async () => {
    const names = registeredNames(await createDeferredMonitorServerForTests(makeCtx()));
    expect(names).toEqual([
      "github_pr_monitor_execute",
      "github_pr_monitor_mutate",
      "github_pr_monitor_prepare",
      "github_pr_monitor_read",
      "github_pr_monitor_state",
    ]);
  });

  it("requires the exact deferred-test opt-in before registering deferred tools", async () => {
    const previous = process.env.CHATGPT2CODEX_RUN_DEFERRED_MONITOR_TESTS;
    try {
      delete process.env.CHATGPT2CODEX_RUN_DEFERRED_MONITOR_TESTS;
      await expect(createDeferredMonitorServerForTests(makeCtx())).rejects.toThrow(/CHATGPT2CODEX_RUN_DEFERRED_MONITOR_TESTS=1/);
      process.env.CHATGPT2CODEX_RUN_DEFERRED_MONITOR_TESTS = "0";
      await expect(createDeferredMonitorServerForTests(makeCtx())).rejects.toThrow(/CHATGPT2CODEX_RUN_DEFERRED_MONITOR_TESTS=1/);
    } finally {
      if (previous === undefined) delete process.env.CHATGPT2CODEX_RUN_DEFERRED_MONITOR_TESTS;
      else process.env.CHATGPT2CODEX_RUN_DEFERRED_MONITOR_TESTS = previous;
    }
  });
});


describe.skipIf(!RUN_DEFERRED_MONITOR_TESTS)("deferred monitor prepare, execute, and mutate authority", () => {
  beforeEach(() => {
    process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = "enabled";
  });
  afterEach(() => {
    delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
    delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
  });
    it.each([undefined, "invalid"])("fails closed for absent or unknown monitor rollout (%s)", async (rollout) => {
      if (rollout === undefined) delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
      else process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = rollout;
      const server = await createDeferredMonitorServerForTests(makeCtx());
      const tools = (server as unknown as {
        _registeredTools?: Record<string, {
          handler?: (input: unknown) => Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }>;
        }>;
      })._registeredTools;
      const identity = {
        runId: "run-rollout", actionPlanId: "plan-rollout", idempotencyKey: "idem-rollout", eventId: "event-rollout",
        repository: "Yeachan-Heo/gajae-code", author: "twoimo", prNumber: 1, expectedHeadSha: "0".repeat(40),
      };
      const results = await Promise.all([
        tools?.github_pr_monitor_state?.handler?.({ ...identity, command: "ingest", input: {} }),
        tools?.github_pr_monitor_prepare?.handler?.({ ...identity, operation: "create", headRef: "feature/test" }),
        tools?.github_pr_monitor_execute?.handler?.({
          ...identity, operation: "apply_suggestions", worktreePath: "/tmp/worktree", headRef: "feature/test",
          ociImageDigest: `sha256:${"a".repeat(64)}`, suggestions: [],
        }),
        tools?.github_pr_monitor_mutate?.handler?.({ ...identity, operation: "post_reply", body: "bounded" }),
      ]);
      expect(results).toHaveLength(4);
      for (const result of results) {
        expect(result?.isError).toBe(true);
        expect(result?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
        expect(String(result?.structuredContent?.error)).toMatch(/rollout|requires enabled/);
      }
    });
    it("rejects a symlinked monitor parent before creating through it", async () => {
      const workspaceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-monitor-parent-")));
      const repositoryRoot = path.join(workspaceRoot, "gajae-code");
      const outsideRoot = path.join(workspaceRoot, "outside");
      const monitorContainer = path.join(workspaceRoot, "gajae-code-pr-monitor-pr-worktrees");
      const escapedRepositoryDir = path.join(outsideRoot, "Yeachan-Heo--gajae-code");
      const binDir = path.join(workspaceRoot, "fake-bin");
      const originalPath = process.env.PATH;
      try {
        await mkdir(repositoryRoot);
        await mkdir(outsideRoot);
        await mkdir(binDir);
        await symlink(outsideRoot, monitorContainer);
        await writeFile(
          path.join(binDir, "npm"),
          MONITOR_CLAIM_FAKE,
          { mode: 0o755 },
        );
        await writeFile(
          path.join(binDir, "gh"),
          `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") {
  console.log(JSON.stringify({ login: "twoimo" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 7,
    url: "https://github.com/Yeachan-Heo/gajae-code/pull/7",
    state: "OPEN",
    author: { login: "twoimo" },
    headRepository: { id: "repo-node-id", name: "gajae-code", nameWithOwner: "Yeachan-Heo/gajae-code" },
    baseRepository: { nameWithOwner: "Yeachan-Heo/gajae-code" },
    baseRefName: "main",
    baseRefOid: "1111111111111111111111111111111111111111",
    headRefName: "feature/strict-actions",
    headRefOid: "0123456789abcdef0123456789abcdef01234567",
    reviewRequests: [],
    reviews: [],
    comments: [],
    latestReviews: [],
    statusCheckRollup: [],
  }));
} else {
  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
    nodes: [], pageInfo: { hasNextPage: false, endCursor: null }
  } } } } }));
}
`,
          { mode: 0o755 },
        );
        await writeFile(
          path.join(binDir, "git"),
          `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) {
  console.log(args.at(-1) === "origin"
    ? "git@github.com:Yeachan-Heo/gajae-code.git"
    : "https://github.com/Yeachan-Heo/gajae-code.git");
}
`,
          { mode: 0o755 },
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

        const ctx = makeCtx();
        ctx.workspaceRoot = workspaceRoot;
        ctx.config.workspaceRoot = workspaceRoot;
        ctx.stateDir = path.join(workspaceRoot, "state");
        ctx.config.stateDir = ctx.stateDir;
        ctx.registry = [{ projectId: "repository", name: "gajae-code", root: repositoryRoot, aliases: [] }];
        await seedPlanBinding(ctx.stateDir, "run-symlink-parent", "plan-symlink-parent");
        const server = await createDeferredMonitorServerForTests(ctx);
        const tools = (server as unknown as {
          _registeredTools?: Record<string, {
            handler?: (input: unknown) => Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }>;
          }>;
        })._registeredTools;
        const result = await tools?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput({
          runId: "run-symlink-parent",
          actionPlanId: "plan-symlink-parent",
          idempotencyKey: "idem-symlink-parent",
          eventId: "event-symlink-parent",
          repository: "Yeachan-Heo/gajae-code",
          author: "twoimo",
          prNumber: 7,
          expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
          operation: "create",
          headRef: "feature/strict-actions",
        }));

        expect(result?.isError).toBe(true);
        expect(result?.structuredContent?.error).toContain("parent topology");
        await expect(lstat(escapedRepositoryDir)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    }, 15_000);
    it("distinguishes a completed quarantine from a verified already-absent no-op", async () => {
      const workspaceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-monitor-quarantine-")));
      const repositoryRoot = path.join(workspaceRoot, "gajae-code");
      const expectedHeadSha = "0123456789abcdef0123456789abcdef01234567";
      const monitorRepositoryRoot = path.join(
        workspaceRoot,
        "gajae-code-pr-monitor-pr-worktrees",
        "Yeachan-Heo--gajae-code",
      );
      const existingWorktree = path.join(monitorRepositoryRoot, `pr-7-${expectedHeadSha}`);
      const absentWorktree = path.join(monitorRepositoryRoot, `pr-8-${expectedHeadSha}`);
      const binDir = path.join(workspaceRoot, "fake-bin");
      const originalPath = process.env.PATH;
      try {
        await mkdir(repositoryRoot, { recursive: true });
        await mkdir(existingWorktree, { recursive: true });
        await mkdir(binDir, { recursive: true });
        await writeFile(
          path.join(binDir, "npm"),
          MONITOR_CLAIM_FAKE,
          { mode: 0o755 },
        );
        await writeFile(
          path.join(binDir, "gh"),
          `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") {
  console.log(JSON.stringify({ login: "twoimo" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: Number(args[2]),
    url: "https://github.com/Yeachan-Heo/gajae-code/pull/" + args[2],
    state: "OPEN",
    author: { login: "twoimo" },
    headRepository: { id: "repo-node-id", name: "gajae-code", nameWithOwner: "Yeachan-Heo/gajae-code" },
    baseRepository: { nameWithOwner: "Yeachan-Heo/gajae-code" },
    baseRefName: "main",
    baseRefOid: "1111111111111111111111111111111111111111",
    headRefName: "feature/strict-actions",
    headRefOid: ${JSON.stringify(expectedHeadSha)},
    reviewRequests: [],
    reviews: [],
    comments: [],
    latestReviews: [],
    statusCheckRollup: [],
  }));
} else {
  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
    nodes: [], pageInfo: { hasNextPage: false, endCursor: null }
  } } } } }));
}
`,
          { mode: 0o755 },
        );
        await writeFile(
          path.join(binDir, "git"),
          `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) {
  console.log(args.at(-1) === "origin"
    ? "git@github.com:Yeachan-Heo/gajae-code.git"
    : "https://github.com/Yeachan-Heo/gajae-code.git");
}
`,
          { mode: 0o755 },
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

        const ctx = makeCtx();
        ctx.workspaceRoot = workspaceRoot;
        ctx.config.workspaceRoot = workspaceRoot;
        ctx.stateDir = path.join(workspaceRoot, "state");
        ctx.config.stateDir = ctx.stateDir;
        ctx.registry = [{ projectId: "repository", name: "gajae-code", root: repositoryRoot, aliases: [] }];
        const server = await createDeferredMonitorServerForTests(ctx);
        const tools = (server as unknown as {
          _registeredTools?: Record<string, {
            handler?: (input: unknown) => Promise<{
              isError?: boolean;
              structuredContent?: Record<string, unknown>;
              content?: Array<{ text?: string }>;
            }>;
          }>;
        })._registeredTools;
        const quarantine = async (prNumber: number) => {
          await seedPlanBinding(ctx.stateDir, `run-quarantine-${prNumber}`, `plan-quarantine-${prNumber}`);
          return tools?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput({
            runId: `run-quarantine-${prNumber}`,
            actionPlanId: `plan-quarantine-${prNumber}`,
            idempotencyKey: `idem-quarantine-${prNumber}`,
            eventId: `event-quarantine-${prNumber}`,
            repository: "Yeachan-Heo/gajae-code",
            author: "twoimo",
            prNumber,
            expectedHeadSha,
            operation: "quarantine",
          }));
        };

        const moved = await quarantine(7);
        const quarantinedPath = String(moved?.structuredContent?.quarantinedPath);
        expect(moved?.isError).not.toBe(true);
        expect(moved?.structuredContent).toMatchObject({
          operation: "quarantine",
          worktreePath: existingWorktree,
          quarantinedPath,
          safePath: quarantinedPath,
          remoteObject: { safePath: quarantinedPath },
        });
        expect(moved?.structuredContent?.alreadyAbsent).toBeUndefined();
        expect(moved?.content?.[0]?.text).toBe("Quarantined monitor worktree for PR #7.");
        expect(quarantinedPath.startsWith(`${existingWorktree}.quarantine-`)).toBe(true);
        await expect(lstat(existingWorktree)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await lstat(quarantinedPath)).isDirectory()).toBe(true);
        const restarted = await createDeferredMonitorServerForTests({ ...ctx, registry: [...ctx.registry] });
        const restartedTools = (restarted as unknown as {
          _registeredTools?: Record<string, {
            handler?: (input: unknown) => Promise<{
              isError?: boolean;
              structuredContent?: Record<string, unknown>;
              content?: Array<{ text?: string }>;
            }>;
          }>;
        })._registeredTools;
        const recoveredMoved = await restartedTools?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput({
          runId: "run-quarantine-7",
          actionPlanId: "plan-quarantine-7",
          idempotencyKey: "idem-quarantine-7",
          eventId: "event-quarantine-7",
          repository: "Yeachan-Heo/gajae-code",
          author: "twoimo",
          prNumber: 7,
          expectedHeadSha,
          operation: "quarantine",
        }));
        expect(recoveredMoved?.isError).not.toBe(true);
        expect(recoveredMoved?.structuredContent).toEqual(moved?.structuredContent);
        expect(recoveredMoved?.content).toEqual(moved?.content);
        expect((await lstat(quarantinedPath)).isDirectory()).toBe(true);

        const absent = await quarantine(8);
        expect(absent?.isError).not.toBe(true);
        expect(absent?.structuredContent).toMatchObject({
          operation: "quarantine",
          worktreePath: absentWorktree,
          alreadyAbsent: true,
          remoteObject: { worktreePath: absentWorktree, alreadyAbsent: true },
        });
        expect(absent?.structuredContent?.quarantinedPath).toBeUndefined();
        expect(absent?.structuredContent?.safePath).toBeUndefined();
        expect(absent?.content?.[0]?.text).toBe("Monitor worktree for PR #8 was already absent; no quarantine was needed.");
        await expect(lstat(absentWorktree)).rejects.toMatchObject({ code: "ENOENT" });
        const crashWorktree = path.join(monitorRepositoryRoot, `pr-9-${expectedHeadSha}`);
        await mkdir(crashWorktree, { recursive: true });
        await seedPlanBinding(ctx.stateDir, "run-quarantine-9", "plan-quarantine-9");
        const crashInput = {
          runId: "run-quarantine-9",
          actionPlanId: "plan-quarantine-9",
          idempotencyKey: "idem-quarantine-9",
          eventId: "event-quarantine-9",
          repository: "Yeachan-Heo/gajae-code",
          author: "twoimo",
          prNumber: 9,
          expectedHeadSha,
          operation: "quarantine",
        };
        const originalComplete = ActionReceiptAuthority.prototype.completeMutationOutcome;
        let injectBeforeOutcome = true;
        ActionReceiptAuthority.prototype.completeMutationOutcome = async function (...args) {
          if (injectBeforeOutcome) {
            injectBeforeOutcome = false;
            throw new Error("injected crash after quarantine rename before outcome completion");
          }
          return originalComplete.apply(this, args);
        };
        const lostPrepareResponse = await tools?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput(crashInput));
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        expect(lostPrepareResponse?.isError).toBe(true);
        await expect(lstat(crashWorktree)).rejects.toMatchObject({ code: "ENOENT" });

        const crashRestart = await createDeferredMonitorServerForTests({ ...ctx, registry: [...ctx.registry] });
        const crashRestartTools = (crashRestart as unknown as {
          _registeredTools?: Record<string, {
            handler?: (input: unknown) => Promise<{
              isError?: boolean;
              content?: Array<{ text?: string }>;
              structuredContent?: Record<string, unknown>;
            }>;
          }>;
        })._registeredTools;
        const recoveredPrepare = await crashRestartTools?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput(crashInput));
        const replayedPrepare = await crashRestartTools?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput(crashInput));
        expect(recoveredPrepare?.isError).toBeUndefined();
        expect(replayedPrepare?.structuredContent).toEqual(recoveredPrepare?.structuredContent);
        expect(replayedPrepare?.content).toEqual(recoveredPrepare?.content);
        const crashQuarantinePath = String(recoveredPrepare?.structuredContent?.quarantinedPath);
        expect((await lstat(crashQuarantinePath)).isDirectory()).toBe(true);
        expect((await readdir(monitorRepositoryRoot)).filter((name) =>
          name.startsWith(`pr-9-${expectedHeadSha}.quarantine-`))).toEqual([path.basename(crashQuarantinePath)]);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    }, 15_000);
    it("recovers a stranded prepare create intent from exact worktree evidence and fails closed on non-exact evidence", async () => {
      const workspaceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-monitor-create-recovery-")));
      const repositoryRoot = path.join(workspaceRoot, "gajae-code");
      const expectedHeadSha = "0123456789abcdef0123456789abcdef01234567";
      const expectedTreeSha = "1111111111111111111111111111111111111111";
      const monitorRepositoryRoot = path.join(
        workspaceRoot,
        "gajae-code-pr-monitor-pr-worktrees",
        "Yeachan-Heo--gajae-code",
      );
      const binDir = path.join(workspaceRoot, "fake-bin");
      const gitLog = path.join(workspaceRoot, "git-invocations.jsonl");
      const dirtyState = path.join(workspaceRoot, "dirty-state");
      const originalPath = process.env.PATH;
      const originalComplete = ActionReceiptAuthority.prototype.completeMutationOutcome;
      try {
        await mkdir(repositoryRoot, { recursive: true });
        await mkdir(binDir, { recursive: true });
        await writeFile(dirtyState, "", "utf8");
        await writeFile(path.join(binDir, "npm"), MONITOR_CLAIM_FAKE, { mode: 0o755 });
        await writeFile(
          path.join(binDir, "gh"),
          `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") {
  console.log(JSON.stringify({ login: "twoimo" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: Number(args[2]),
    url: "https://github.com/Yeachan-Heo/gajae-code/pull/" + args[2],
    state: "OPEN",
    author: { login: "twoimo" },
    headRepository: { id: "repo-node-id", name: "gajae-code", nameWithOwner: "Yeachan-Heo/gajae-code" },
    baseRepository: { nameWithOwner: "Yeachan-Heo/gajae-code" },
    baseRefName: "main",
    baseRefOid: "1111111111111111111111111111111111111111",
    headRefName: "feature/strict-actions",
    headRefOid: ${JSON.stringify(expectedHeadSha)},
    reviewRequests: [],
    reviews: [],
    comments: [],
    latestReviews: [],
    statusCheckRollup: [],
  }));
} else {
  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
    nodes: [], pageInfo: { hasNextPage: false, endCursor: null }
  } } } } }));
}
`,
          { mode: 0o755 },
        );
        await writeFile(
          path.join(binDir, "git"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const cwd = args[args.indexOf("-C") + 1];
fs.appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(args) + "\\n");
if (args.includes("get-url")) {
  console.log(args.at(-1) === "origin"
    ? "git@github.com:Yeachan-Heo/gajae-code.git"
    : "https://github.com/Yeachan-Heo/gajae-code.git");
} else if (args.includes("--show-toplevel")) {
  console.log(cwd);
} else if (args.includes("status")) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(dirtyState)}, "utf8"));
} else if (args.includes("cat-file")) {
  process.exit(0);
} else if (args.at(-1) === "HEAD^{tree}" || args.includes("write-tree")) {
  console.log(${JSON.stringify(expectedTreeSha)});
} else if (args.includes("rev-parse") && args.at(-1) === "HEAD") {
  console.log(${JSON.stringify(expectedHeadSha)});
} else if (args.includes("worktree") && args.includes("add")) {
  fs.mkdirSync(args[args.indexOf("--detach") + 1], { recursive: true });
}
`,
          { mode: 0o755 },
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

        const ctx = makeCtx();
        ctx.workspaceRoot = workspaceRoot;
        ctx.config.workspaceRoot = workspaceRoot;
        ctx.stateDir = path.join(workspaceRoot, "state");
        ctx.config.stateDir = ctx.stateDir;
        ctx.registry = [{ projectId: "repository", name: "gajae-code", root: repositoryRoot, aliases: [] }];
        type MonitorTools = Record<string, {
          handler?: (input: unknown) => Promise<{
            isError?: boolean;
            content?: Array<{ text?: string }>;
            structuredContent?: Record<string, unknown>;
          }>;
        }> | undefined;
        const monitorTools = async (): Promise<MonitorTools> => {
          const server = await createDeferredMonitorServerForTests({ ...ctx, registry: [...ctx.registry] });
          return (server as unknown as { _registeredTools?: MonitorTools })._registeredTools;
        };
        const createInput = (prNumber: number) => ({
          runId: `run-create-${prNumber}`,
          actionPlanId: `plan-create-${prNumber}`,
          idempotencyKey: `idem-create-${prNumber}`,
          eventId: `event-create-${prNumber}`,
          repository: "Yeachan-Heo/gajae-code",
          author: "twoimo",
          prNumber,
          expectedHeadSha,
          operation: "create",
          headRef: "feature/strict-actions",
        });
        const worktreeAddCount = async (prNumber: number): Promise<number> =>
          (await readFile(gitLog, "utf8").catch(() => ""))
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as string[])
            .filter((args) => args.includes("worktree")
              && args.includes("add")
              && args.includes(path.join(monitorRepositoryRoot, `pr-${prNumber}-${expectedHeadSha}`))).length;
        const strandNextOutcome = (message: string): void => {
          let strand = true;
          ActionReceiptAuthority.prototype.completeMutationOutcome = async function (...args) {
            if (strand) {
              strand = false;
              throw new Error(message);
            }
            return originalComplete.apply(this, args);
          };
        };

        // Exact worktree evidence: the create landed, then the outcome was lost.
        const recoveredWorktree = path.join(monitorRepositoryRoot, `pr-7-${expectedHeadSha}`);
        await seedPlanBinding(ctx.stateDir, "run-create-7", "plan-create-7");
        strandNextOutcome("injected crash after worktree add before outcome completion");
        const lostCreate = await (await monitorTools())?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput(createInput(7)));
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        expect(lostCreate?.isError).toBe(true);
        expect((await lstat(recoveredWorktree)).isDirectory()).toBe(true);
        expect(await worktreeAddCount(7)).toBe(1);

        const restartedTools = await monitorTools();
        const recoveredCreate = await restartedTools?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput(createInput(7)));
        expect(recoveredCreate?.isError, JSON.stringify(recoveredCreate?.structuredContent)).toBeUndefined();
        expect(recoveredCreate?.structuredContent).toMatchObject({
          operation: "create",
          worktreePath: recoveredWorktree,
          safePath: recoveredWorktree,
          headRef: "feature/strict-actions",
          remoteObject: { safePath: recoveredWorktree },
        });
        expect(recoveredCreate?.content?.[0]?.text).toBe("Prepared monitor worktree for PR #7.");
        expect(await worktreeAddCount(7)).toBe(1);
        const replayedCreate = await restartedTools?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput(createInput(7)));
        expect(replayedCreate?.structuredContent).toEqual(recoveredCreate?.structuredContent);
        expect(replayedCreate?.content).toEqual(recoveredCreate?.content);
        expect(await worktreeAddCount(7)).toBe(1);

        // Non-exact worktree evidence must never be accepted as the intent's effect.
        await seedPlanBinding(ctx.stateDir, "run-create-8", "plan-create-8");
        strandNextOutcome("injected crash after worktree add before outcome completion");
        const lostAmbiguous = await (await monitorTools())?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput(createInput(8)));
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        expect(lostAmbiguous?.isError).toBe(true);
        expect(await worktreeAddCount(8)).toBe(1);

        await writeFile(dirtyState, " M src/changed.ts\n", "utf8");
        const ambiguousCreate = await (await monitorTools())?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput(createInput(8)));
        expect(ambiguousCreate?.isError).toBe(true);
        expect(ambiguousCreate?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
        expect(ambiguousCreate?.structuredContent?.error).toBe(
          "Pending create intent has ambiguous non-exact worktree evidence",
        );
        expect(await worktreeAddCount(8)).toBe(1);
      } finally {
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
    it("fails closed on conflicting, non-directory, and absent quarantine evidence for a stranded intent", async () => {
      const workspaceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-monitor-quarantine-recovery-")));
      const repositoryRoot = path.join(workspaceRoot, "gajae-code");
      const expectedHeadSha = "0123456789abcdef0123456789abcdef01234567";
      const monitorRepositoryRoot = path.join(
        workspaceRoot,
        "gajae-code-pr-monitor-pr-worktrees",
        "Yeachan-Heo--gajae-code",
      );
      const binDir = path.join(workspaceRoot, "fake-bin");
      const originalPath = process.env.PATH;
      const originalComplete = ActionReceiptAuthority.prototype.completeMutationOutcome;
      try {
        await mkdir(repositoryRoot, { recursive: true });
        await mkdir(monitorRepositoryRoot, { recursive: true });
        await mkdir(binDir, { recursive: true });
        await writeFile(path.join(binDir, "npm"), MONITOR_CLAIM_FAKE, { mode: 0o755 });
        await writeFile(
          path.join(binDir, "gh"),
          `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") {
  console.log(JSON.stringify({ login: "twoimo" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: Number(args[2]),
    url: "https://github.com/Yeachan-Heo/gajae-code/pull/" + args[2],
    state: "OPEN",
    author: { login: "twoimo" },
    headRepository: { id: "repo-node-id", name: "gajae-code", nameWithOwner: "Yeachan-Heo/gajae-code" },
    baseRepository: { nameWithOwner: "Yeachan-Heo/gajae-code" },
    baseRefName: "main",
    baseRefOid: "1111111111111111111111111111111111111111",
    headRefName: "feature/strict-actions",
    headRefOid: ${JSON.stringify(expectedHeadSha)},
    reviewRequests: [],
    reviews: [],
    comments: [],
    latestReviews: [],
    statusCheckRollup: [],
  }));
} else {
  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
    nodes: [], pageInfo: { hasNextPage: false, endCursor: null }
  } } } } }));
}
`,
          { mode: 0o755 },
        );
        await writeFile(
          path.join(binDir, "git"),
          `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) {
  console.log(args.at(-1) === "origin"
    ? "git@github.com:Yeachan-Heo/gajae-code.git"
    : "https://github.com/Yeachan-Heo/gajae-code.git");
}
`,
          { mode: 0o755 },
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

        const ctx = makeCtx();
        ctx.workspaceRoot = workspaceRoot;
        ctx.config.workspaceRoot = workspaceRoot;
        ctx.stateDir = path.join(workspaceRoot, "state");
        ctx.config.stateDir = ctx.stateDir;
        ctx.registry = [{ projectId: "repository", name: "gajae-code", root: repositoryRoot, aliases: [] }];
        type MonitorTools = Record<string, {
          handler?: (input: unknown) => Promise<{
            isError?: boolean;
            content?: Array<{ text?: string }>;
            structuredContent?: Record<string, unknown>;
          }>;
        }> | undefined;
        const monitorTools = async (): Promise<MonitorTools> => {
          const server = await createDeferredMonitorServerForTests({ ...ctx, registry: [...ctx.registry] });
          return (server as unknown as { _registeredTools?: MonitorTools })._registeredTools;
        };
        const quarantineInput = (prNumber: number) => ({
          runId: `run-strand-${prNumber}`,
          actionPlanId: `plan-strand-${prNumber}`,
          idempotencyKey: `idem-strand-${prNumber}`,
          eventId: `event-strand-${prNumber}`,
          repository: "Yeachan-Heo/gajae-code",
          author: "twoimo",
          prNumber,
          expectedHeadSha,
          operation: "quarantine",
        });
        const quarantineDirs = async (prNumber: number): Promise<string[]> =>
          (await readdir(monitorRepositoryRoot))
            .filter((name) => name.startsWith(`pr-${prNumber}-${expectedHeadSha}.quarantine-`));

        // Strand a quarantine intent after the rename already moved the worktree.
        const strand = async (prNumber: number): Promise<{ source: string; destination: string }> => {
          const source = path.join(monitorRepositoryRoot, `pr-${prNumber}-${expectedHeadSha}`);
          await mkdir(source, { recursive: true });
          await seedPlanBinding(ctx.stateDir, `run-strand-${prNumber}`, `plan-strand-${prNumber}`);
          let strandOutcome = true;
          ActionReceiptAuthority.prototype.completeMutationOutcome = async function (...args) {
            if (strandOutcome) {
              strandOutcome = false;
              throw new Error("injected crash after quarantine rename before outcome completion");
            }
            return originalComplete.apply(this, args);
          };
          const lost = await (await monitorTools())?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput(quarantineInput(prNumber)));
          ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
          expect(lost?.isError, `strand pr-${prNumber}`).toBe(true);
          await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
          const moved = await quarantineDirs(prNumber);
          expect(moved, `strand pr-${prNumber}`).toHaveLength(1);
          return { source, destination: path.join(monitorRepositoryRoot, String(moved[0])) };
        };

        const conflicting = await strand(11);
        await mkdir(conflicting.source, { recursive: true });
        const conflictingResult = await (await monitorTools())?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput(quarantineInput(11)));
        expect(conflictingResult?.isError).toBe(true);
        expect(conflictingResult?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
        expect(conflictingResult?.structuredContent?.error).toBe(
          "Pending quarantine intent has conflicting source and destination evidence",
        );
        expect((await lstat(conflicting.source)).isDirectory()).toBe(true);
        expect(await quarantineDirs(11)).toHaveLength(1);

        const nonDirectory = await strand(12);
        await rm(nonDirectory.destination, { recursive: true, force: true });
        await writeFile(nonDirectory.destination, "not a worktree", "utf8");
        const nonDirectoryResult = await (await monitorTools())?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput(quarantineInput(12)));
        expect(nonDirectoryResult?.isError).toBe(true);
        expect(nonDirectoryResult?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
        expect(nonDirectoryResult?.structuredContent?.error).toBe(
          "Pending quarantine intent destination is not an exact directory",
        );
        expect((await lstat(nonDirectory.destination)).isFile()).toBe(true);

        const absent = await strand(13);
        await rm(absent.destination, { recursive: true, force: true });
        const absentResult = await (await monitorTools())?.github_pr_monitor_prepare?.handler?.(authorizedMonitorInput(quarantineInput(13)));
        expect(absentResult?.isError).toBe(true);
        expect(absentResult?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
        expect(absentResult?.structuredContent?.error).toBe(
          "Pending quarantine intent has no exact applied or not-applied evidence",
        );
        expect(await quarantineDirs(13)).toHaveLength(0);
        await expect(lstat(absent.source)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
    it("uses exact claim stdin and durably binds claim continuity across a fresh server instance through record, corruption, reconcile, and replay", async () => {
      const workspaceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-claim-lifecycle-")));
      const repositoryRoot = path.join(workspaceRoot, "gajae-code");
      const stateDir = path.join(workspaceRoot, "state");
      const binDir = path.join(workspaceRoot, "fake-bin");
      const ipcLog = path.join(workspaceRoot, "monitor-ipc.jsonl");
      const ghLog = path.join(workspaceRoot, "gh-invocations.jsonl");
      const originalPath = process.env.PATH;
      const expectedHeadSha = "0123456789abcdef0123456789abcdef01234567";
      try {
        await mkdir(repositoryRoot);
        await mkdir(binDir);
        await writeFile(
          path.join(binDir, "npm"),
          `#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const args = process.argv.slice(2);
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
};
const digest = (value) => crypto.createHash("sha256").update(canonical(value)).digest("hex");
const authorizationKeys = ["protocolVersion", "schemaVersion", "ownerId", "leaseKey", "fence", "logicalIdentity", "operationKey", "operationHeadSha", "effectIdentity", "effectKey", "effectKind", "targetDigest", "policyDigest", "bindingDigest"];
let payload = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { payload += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(ipcLog)}, JSON.stringify({ args, payload }) + "\\n");
  const command = args[args.indexOf("--") + 1];
  const input = JSON.parse(payload || "{}");
  if (command === "recover") {
    process.stdout.write(JSON.stringify(input.stage === "reconcile"
      ? {
          ok: true, command, ...input, committed: true, claimStatus: "reconciled",
          sideEffectId: "effect-recovered", committedAt: "2026-07-27T12:05:00.000Z"
        }
      : { ok: true, command, ...input, committed: false }) + "\\n");
  } else if (command === "lease-renew") {
    const serverTime = "2026-07-27T12:00:00.000Z";
    process.stdout.write(JSON.stringify({
      ok: true,
      command,
      protocolVersion: 1,
      schemaVersion: 4,
      requestDigest: digest(input),
      result: {
        protocolVersion: 1,
        schemaVersion: 4,
        leaseKey: input.leaseKey,
        ownerId: input.ownerId,
        runId: input.runId,
        fence: input.fence,
        serverTime,
        expiresAt: "2026-07-27T12:00:30.000Z"
      }
    }) + "\\n");
  } else if (command === "claim-action") {
    process.stdout.write(JSON.stringify({
      ...Object.fromEntries(authorizationKeys.flatMap((key) => input[key] === undefined ? [] : [[key, input[key]]])),
      command,
      ok: true,
      claimId: "claim-" + input.idempotencyKey,
      claimedAt: "2026-07-27T12:00:00.000Z",
      payloadDigest: digest(input),
      runId: input.runId,
      coordinationId: "bootstrap",
      actionPlanId: input.actionPlanId,
      idempotencyKey: input.idempotencyKey
    }) + "\\n");
  } else if (command === "record-side-effect") {
    process.stdout.write(JSON.stringify({
      protocolVersion: 1, schemaVersion: 4,
      ok: true, command, runId: "run-claim-lifecycle", coordinationId: "bootstrap",
      actionPlanId: input.actionPlanId, idempotencyKey: input.idempotencyKey,
      claimId: input.claimId, claimPayloadDigest: input.payloadDigest,
      requestDigest: digest(input), result: { recorded: true, id: input.id }
    }) + "\\n");
  } else if (command === "reconcile") {
    const receipt = input.evidence[0].structuredContent;
    process.stdout.write(JSON.stringify({
      protocolVersion: 1, schemaVersion: 4,
      ok: true, command, runId: receipt.runId, coordinationId: "bootstrap",
      actionPlanId: receipt.actionPlanId, idempotencyKey: receipt.idempotencyKey,
      requestDigest: digest(input), result: { reconciled: 1 }
    }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ ok: true, command, result: {} }) + "\\n");
  }
});
`,
          { mode: 0o755 },
        );
        await writeFile(
          path.join(binDir, "gh"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(workspaceRoot, "gh-invocations.jsonl"))}, JSON.stringify(args) + "\\n");
const commentsPath = ${JSON.stringify(path.join(workspaceRoot, "comments.json"))};
const threadRepliesPath = commentsPath + ".threads";
const comments = fs.existsSync(commentsPath) ? JSON.parse(fs.readFileSync(commentsPath, "utf8")) : [];
if (args[0] === "api" && args[1] === "user") {
  console.log(JSON.stringify({ login: "twoimo" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 7,
    url: "https://github.com/Yeachan-Heo/gajae-code/pull/7",
    state: "OPEN",
    author: { login: "twoimo" },
    headRepository: { id: "repo-node-id", name: "gajae-code", nameWithOwner: "Yeachan-Heo/gajae-code" },
    baseRepository: { nameWithOwner: "Yeachan-Heo/gajae-code" },
    baseRefName: "main",
    baseRefOid: "1111111111111111111111111111111111111111",
    headRefName: "feature/claim-lifecycle",
    headRefOid: ${JSON.stringify(expectedHeadSha)},
    reviewRequests: [],
    reviews: [],
    comments: [],
    latestReviews: [],
    statusCheckRollup: [],
  }));
} else if (args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("addPullRequestReviewThreadReply"))) {
  const threadId = args.find((arg) => arg.startsWith("threadId="))?.slice("threadId=".length);
  const body = args.find((arg) => arg.startsWith("body="))?.slice("body=".length);
  const replies = fs.existsSync(threadRepliesPath) ? JSON.parse(fs.readFileSync(threadRepliesPath, "utf8")) : [];
  replies.push({ id: "reply-" + (replies.length + 42), threadId, body, url: "https://github.com/Yeachan-Heo/gajae-code/pull/7#discussion_r" + (replies.length + 42), author: { login: "twoimo", __typename: "User" } });
  fs.writeFileSync(threadRepliesPath, JSON.stringify(replies));
  console.log(JSON.stringify({
    data: {
      addPullRequestReviewThreadReply: {
        comment: {
          id: "reply-42",
          body,
          url: "https://github.com/Yeachan-Heo/gajae-code/pull/7#discussion_r42",
          author: { login: "twoimo", __typename: "User" },
          pullRequestReviewThread: { id: threadId },
        },
      },
    },
  }));
} else if (args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("node(id:$id)"))) {
  const threadId = args.find((arg) => arg.startsWith("id="))?.slice("id=".length);
  const replies = fs.existsSync(threadRepliesPath) ? JSON.parse(fs.readFileSync(threadRepliesPath, "utf8")) : [];
  console.log(JSON.stringify({
    data: {
      node: {
        id: threadId,
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: replies.filter((reply) => reply.threadId === threadId),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }));
} else if (args[0] === "api" && args[1] === "graphql") {
  const replies = fs.existsSync(threadRepliesPath) ? JSON.parse(fs.readFileSync(threadRepliesPath, "utf8")) : [];
  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
    nodes: [{
      id: "THREAD_CURRENT",
      isResolved: false,
      isOutdated: false,
      comments: { nodes: replies.filter((reply) => reply.threadId === "THREAD_CURRENT"), pageInfo: { hasNextPage: false, endCursor: null } },
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  } } } } }));
} else if (args.includes("--paginate")) {
  console.log(JSON.stringify(comments));
} else if (args[1]?.endsWith("/comments")) {
  const bodyArg = args.find((arg) => arg.startsWith("body="));
  const created = {
    id: comments.length + 42,
    html_url: "https://github.com/Yeachan-Heo/gajae-code/pull/7#issuecomment-" + (comments.length + 42),
    body: bodyArg?.slice(5),
    user: { login: "twoimo" }
  };
  comments.push(created);
  fs.writeFileSync(commentsPath, JSON.stringify(comments));
  console.log(JSON.stringify(created));
} else {
  console.log(JSON.stringify({}));
}
`,
          { mode: 0o755 },
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

        const ctx = makeCtx();
        ctx.workspaceRoot = workspaceRoot;
        ctx.config.workspaceRoot = workspaceRoot;
        ctx.stateDir = stateDir;
        ctx.config.stateDir = stateDir;
        ctx.registry = [{ projectId: "repository", name: "gajae-code", root: repositoryRoot, aliases: [] }];

        const mutateInput = {
          runId: "run-claim-lifecycle",
          actionPlanId: "plan-claim-lifecycle",
          idempotencyKey: "idem-claim-lifecycle",
          eventId: "event-claim-lifecycle",
          repository: "Yeachan-Heo/gajae-code",
          author: "twoimo",
          prNumber: 7,
          expectedHeadSha,
          operation: "post_reply",
          body: "Bounded reply",
          threadId: "THREAD_CURRENT",
        };
        const authorizedMutateInput = authorizedMonitorInput(mutateInput);
        const claimInput = {
          runId: mutateInput.runId,
          actionPlanId: mutateInput.actionPlanId,
          idempotencyKey: mutateInput.idempotencyKey,
          repository: mutateInput.repository,
          prNumber: mutateInput.prNumber,
          headSha: expectedHeadSha,
          phase: "mutate",
          operation: mutateInput.operation,
          operationFields: { body: mutateInput.body, threadId: mutateInput.threadId },
          ...monitorAuthorization(mutateInput, "post_reply"),
        };
        const claimPayload = JSON.stringify(claimInput);
        const payloadDigest = createHash("sha256").update(canonicalTestJson(claimInput)).digest("hex");

        const planReceiptId = createHash("sha256").update("plan-binding").digest("hex");
        const planReceiptInput = {
          runId: mutateInput.runId,
          actionPlanId: "bootstrap",
          repository: mutateInput.repository,
          author: mutateInput.author,
        };
        const planReceiptResponse = {
          tool: "github_pr_monitor_read",
          toolCall: { toolName: "github_pr_monitor_read", input: planReceiptInput },
          structuredContent: {
            receiptId: planReceiptId,
            repository: mutateInput.repository,
            author: mutateInput.author,
          },
        };
        const authority = new ActionReceiptAuthority(stateDir);
        await authority.issue({
          receiptId: planReceiptId,
          kind: "monitor-read",
          response: planReceiptResponse,
          input: planReceiptInput,
          issuedAt: Date.now(),
          metadata: { runId: mutateInput.runId, actionPlanId: "bootstrap" },
        });
        await authority.transitionExact(
          planReceiptId,
          "monitor-read",
          planReceiptResponse,
          ["issued"],
          "consumed",
          {
            monitorActionPlanId: mutateInput.actionPlanId,
            coordinationId: "bootstrap",
            requestDigest: createHash("sha256").update("plan-request").digest("hex"),
          },
        );
        const firstServer = await createDeferredMonitorServerForTests(ctx);
        const firstTools = (firstServer as unknown as {
          _registeredTools?: Record<string, {
            handler?: (input: unknown) => Promise<{
              isError?: boolean;
              content?: Array<{ text?: string }>;
              structuredContent?: Record<string, unknown>;
            }>;
          }>;
        })._registeredTools;
        const mutation = await firstTools?.github_pr_monitor_mutate?.handler?.(authorizedMutateInput);
        expect(mutation?.isError, JSON.stringify(mutation?.structuredContent)).toBeUndefined();
        expect(mutation?.structuredContent).toMatchObject({
          claimId: "claim-idem-claim-lifecycle",
          claimedAt: "2026-07-27T12:00:00.000Z",
          payloadDigest,
        });

        const proof = mutation?.structuredContent?.chatgpt2codexToolCall as Record<string, unknown>;
        const actionResponse = {
          ok: true,
          protocolVersion: 1,
          schemaVersion: 4,
          requestDigest: createHash("sha256").update(canonicalTestJson(authorizedMutateInput)).digest("hex"),
          tool: "github_pr_monitor_mutate",
          toolCall: { ...proof, toolName: "github_pr_monitor_mutate", input: authorizedMutateInput },
          text: mutation?.content?.[0]?.text,
          imageMarkdownList: [],
          structuredContent: mutation?.structuredContent,
        };
        const receiptId = String(mutation?.structuredContent?.receiptId);
        const issuedStore = readAuthorityDocuments(stateDir);
        expect(issuedStore.receipts).toHaveLength(2);
        const issuedAction = issuedStore.receipts.find((receipt) => receipt.receiptId === receiptId);
        expect(issuedAction).toMatchObject({
          receiptId,
          kind: "monitor-action",
          repository: "Yeachan-Heo/gajae-code",
          author: "twoimo",
          response: actionResponse,
          inputDigest: createHash("sha256").update(JSON.stringify(authorizedMutateInput)).digest("hex"),
          phase: "issued",
          consumedAt: null,
          metadata: {
            claim: {
              ok: true,
              claimId: "claim-idem-claim-lifecycle",
              claimedAt: "2026-07-27T12:00:00.000Z",
              payloadDigest,
            },
          },
        });
        const issuedRecord = issuedAction as { issuedAt: number; expiresAt: number };
        expect(issuedRecord.expiresAt - issuedRecord.issuedAt).toBe(10 * 60 * 1000);
        expect(issuedStore.mutationOutcomes).toHaveLength(1);
        expect(issuedStore.mutationOutcomes[0]).toMatchObject({
          outcomeKey: expect.stringMatching(/^[0-9a-f]{64}$/u),
          state: "completed",
          receiptId,
          response: actionResponse,
          binding: {
            runId: mutateInput.runId,
            coordinationId: "bootstrap",
            actionPlanId: mutateInput.actionPlanId,
            idempotencyKey: mutateInput.idempotencyKey,
            claimId: "claim-idem-claim-lifecycle",
            claimPayloadDigest: payloadDigest,
            repository: mutateInput.repository,
            author: mutateInput.author,
            prNumber: mutateInput.prNumber,
            expectedHeadSha,
            eventId: mutateInput.eventId,
            phase: "mutate",
            operation: "post_reply",
            operationFields: { body: mutateInput.body },
            input: authorizedMutateInput,
          },
        });

        const pendingRecordInput = {
          id: receiptId,
          kind: mutateInput.operation,
          idempotencyKey: mutateInput.idempotencyKey,
          actionPlanId: mutateInput.actionPlanId,
          expectedHead: expectedHeadSha,
          claimId: "claim-idem-claim-lifecycle",
          payloadDigest,
          payload: { receiptId },
          ...monitorAuthorization(mutateInput, "post_reply"),
        };
        await authority.transitionExact(
          receiptId,
          "monitor-action",
          actionResponse,
          ["issued"],
          "record-pending",
          {
            recovery: {
              stage: "record",
              runId: mutateInput.runId,
              coordinationId: "bootstrap",
              requestDigest: createHash("sha256").update(canonicalTestJson(pendingRecordInput)).digest("hex"),
              actionPlanId: mutateInput.actionPlanId,
              idempotencyKey: mutateInput.idempotencyKey,
              claimId: "claim-idem-claim-lifecycle",
              claimPayloadDigest: payloadDigest,
            },
          },
        );

        const restartedServer = await createDeferredMonitorServerForTests({ ...ctx, registry: [...ctx.registry] });
        const restartedTools = (restartedServer as unknown as {
          _registeredTools?: Record<string, {
            handler?: (input: unknown) => Promise<{
              isError?: boolean;
              structuredContent?: Record<string, unknown>;
            }>;
          }>;
        })._registeredTools;
        const stateBase = {
          runId: mutateInput.runId,
          actionPlanId: mutateInput.actionPlanId,
          idempotencyKey: mutateInput.idempotencyKey,
          eventId: mutateInput.eventId,
        };
        const recorded = await restartedTools?.github_pr_monitor_state?.handler?.({
          ...stateBase,
          command: "record-side-effect",
          input: { receipt: actionResponse },
        });
        expect(recorded?.isError, JSON.stringify(recorded?.structuredContent)).toBeUndefined();

        const recordedDocument = withActionReceiptDatabase(stateDir, (database) =>
          String(database.prepare("SELECT document FROM receipts WHERE receipt_id = ?").get(receiptId)?.document ?? ""));
        const recordedStore = readAuthorityDocuments(stateDir);
        expect(recordedStore.receipts.find((receipt) => receipt.receiptId === receiptId)).toMatchObject({ receiptId, phase: "recorded", consumedAt: null });
        const ipcAfterRecord = (await readFile(ipcLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
          args: string[];
          payload: string;
        });
        const claimRecovery = ipcAfterRecord.find(({ args, payload }) =>
          args.includes("recover") && JSON.parse(payload).stage === "claim");
        expect(JSON.parse(claimRecovery?.payload ?? "{}")).toEqual({
          stage: "claim",
          runId: mutateInput.runId,
          coordinationId: "bootstrap",
          requestDigest: payloadDigest,
          actionPlanId: mutateInput.actionPlanId,
          idempotencyKey: mutateInput.idempotencyKey,
        });
        const claimInvocation = ipcAfterRecord.find(({ args }) => args.includes("claim-action"));
        expect(claimInvocation).toEqual({
          args: [
            "run", "--silent", "monitor", "--", "claim-action", "--db",
            "/Users/twoimo/Library/Application Support/GajaeCodePRMonitor/.gajae-pr-monitor.sqlite",
          ],
          payload: claimPayload,
        });
        const recordInvocation = ipcAfterRecord.find(({ args }) => args.includes("record-side-effect"));
        expect(JSON.parse(recordInvocation?.payload ?? "{}")).toEqual({
          id: receiptId,
          kind: "post_reply",
          idempotencyKey: mutateInput.idempotencyKey,
          actionPlanId: mutateInput.actionPlanId,
          expectedHead: expectedHeadSha,
          claimId: "claim-idem-claim-lifecycle",
          payloadDigest,
          payload: { receiptId },
          ...monitorAuthorization(mutateInput, "post_reply"),
        });

        const recordReplay = await restartedTools?.github_pr_monitor_state?.handler?.({
          ...stateBase,
          command: "record-side-effect",
          input: { receipt: actionResponse },
        });
        expect(recordReplay?.isError).toBe(true);
        expect(recordReplay?.structuredContent?.error).toMatch(/replayed|lifecycle|exact/);

        const corruptReceipt = JSON.parse(recordedDocument) as { response: { text: string } };
        corruptReceipt.response.text = "corrupt";
        withActionReceiptDatabase(stateDir, (database) => {
          database.prepare("UPDATE receipts SET document = ? WHERE receipt_id = ?")
            .run(JSON.stringify(corruptReceipt), receiptId);
        });
        const corruptDenied = await restartedTools?.github_pr_monitor_state?.handler?.({
          ...stateBase,
          command: "reconcile",
          input: { receipt: actionResponse },
        });
        expect(corruptDenied?.isError).toBe(true);
        expect(corruptDenied?.structuredContent?.error).toMatch(/corrupt|binding|exact/i);

        withActionReceiptDatabase(stateDir, (database) => {
          database.prepare("UPDATE receipts SET document = ? WHERE receipt_id = ?")
            .run(recordedDocument, receiptId);
        });
        const reconcileInput = { evidence: [actionResponse] };
        const reconcileRecovery = {
          stage: "reconcile",
          runId: mutateInput.runId,
          coordinationId: "bootstrap",
          requestDigest: createHash("sha256").update(canonicalTestJson(reconcileInput)).digest("hex"),
          actionPlanId: mutateInput.actionPlanId,
          idempotencyKey: mutateInput.idempotencyKey,
          claimId: "claim-idem-claim-lifecycle",
          claimPayloadDigest: payloadDigest,
        };
        await authority.transitionExact(
          receiptId,
          "monitor-action",
          actionResponse,
          ["recorded"],
          "reconcile-pending",
          { recovery: reconcileRecovery },
        );
        const reconciled = await restartedTools?.github_pr_monitor_state?.handler?.({
          ...stateBase,
          command: "reconcile",
          input: { receipt: actionResponse },
        });
        expect(reconciled?.isError).toBeUndefined();
        const consumedStore = readAuthorityDocuments(stateDir);
        expect(consumedStore.receipts.find((receipt) => receipt.receiptId === receiptId)).toMatchObject({
          receiptId,
          phase: "consumed",
          consumedAt: expect.any(Number),
        });

        const reconcileReplay = await restartedTools?.github_pr_monitor_state?.handler?.({
          ...stateBase,
          command: "reconcile",
          input: { receipt: actionResponse },
        });
        expect(reconcileReplay?.isError).toBe(true);
        expect(reconcileReplay?.structuredContent?.error).toMatch(/replayed|lifecycle|exact/);
        const finalIpc = (await readFile(ipcLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
          args: string[];
          payload: string;
        });
        expect(finalIpc).toHaveLength(7);
        const reconcileInvocation = finalIpc.filter(({ args, payload }) =>
          args.includes("recover") && JSON.parse(payload).stage === "reconcile").at(-1);
        expect(JSON.parse(reconcileInvocation?.payload ?? "{}")).toEqual(reconcileRecovery);

        const recoveredMutation = await restartedTools?.github_pr_monitor_mutate?.handler?.(authorizedMonitorInput(mutateInput));
        expect(recoveredMutation?.isError).toBeUndefined();
        expect(recoveredMutation?.structuredContent).toEqual(mutation?.structuredContent);

        const commentMutationCount = async (): Promise<number> =>
          (await readFile(ghLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[])
            .filter((args) => args[1] === "graphql"
              && args.some((arg) => arg.includes("addPullRequestReviewThreadReply"))
              && args.some((arg) => arg.includes("<!-- gjc:auto-response:v1:"))).length;
        expect(await commentMutationCount()).toBe(1);

        const mismatched = await restartedTools?.github_pr_monitor_mutate?.handler?.(authorizedMonitorInput({
          ...mutateInput,
          eventId: "event-claim-lifecycle-mismatch",
        }));
        expect(mismatched?.isError).toBe(true);
        expect(mismatched?.structuredContent?.error).toMatch(/different exact durable outcome|exact durable/i);
        expect(await commentMutationCount(mutateInput.idempotencyKey)).toBe(1);

        const crashBoundaryInput = {
          ...mutateInput,
          idempotencyKey: "idem-crash-boundary",
          eventId: "event-crash-boundary",
        };
        const originalComplete = ActionReceiptAuthority.prototype.completeMutationOutcome;
        let injectAfterOutcome = true;
        ActionReceiptAuthority.prototype.completeMutationOutcome = async function (...args) {
          await originalComplete.apply(this, args);
          if (injectAfterOutcome) {
            injectAfterOutcome = false;
            throw new Error("injected failure after durable outcome before ordinary receipt");
          }
        };
        const crashBoundaryFailure = await restartedTools?.github_pr_monitor_mutate?.handler?.(authorizedMonitorInput(crashBoundaryInput));
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        expect(crashBoundaryFailure?.isError).toBe(true);
        const crashBoundaryRecovered = await restartedTools?.github_pr_monitor_mutate?.handler?.(authorizedMonitorInput(crashBoundaryInput));
        expect(crashBoundaryRecovered?.isError).toBeUndefined();
        expect(await commentMutationCount(crashBoundaryInput.idempotencyKey)).toBe(1);
        const effectBeforeOutcomeInput = {
          ...mutateInput,
          idempotencyKey: "idem-effect-before-outcome",
          eventId: "event-effect-before-outcome",
        };
        let injectBeforeOutcome = true;
        ActionReceiptAuthority.prototype.completeMutationOutcome = async function (...args) {
          if (injectBeforeOutcome) {
            injectBeforeOutcome = false;
            throw new Error("injected crash immediately after external effect before outcome completion");
          }
          return originalComplete.apply(this, args);
        };
        const lostResponse = await restartedTools?.github_pr_monitor_mutate?.handler?.(authorizedMonitorInput(effectBeforeOutcomeInput));
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        expect(lostResponse?.isError).toBe(true);

        const effectRestart = await createDeferredMonitorServerForTests({ ...ctx, registry: [...ctx.registry] });
        const effectRestartTools = (effectRestart as unknown as {
          _registeredTools?: Record<string, {
            handler?: (input: unknown) => Promise<{
              isError?: boolean;
              content?: Array<{ text?: string }>;
              structuredContent?: Record<string, unknown>;
            }>;
          }>;
        })._registeredTools;
        const recoveredEffect = await effectRestartTools?.github_pr_monitor_mutate?.handler?.(authorizedMonitorInput(effectBeforeOutcomeInput));
        const replayedEffect = await effectRestartTools?.github_pr_monitor_mutate?.handler?.(authorizedMonitorInput(effectBeforeOutcomeInput));
        expect(recoveredEffect?.isError).toBeUndefined();
        expect(replayedEffect?.structuredContent).toEqual(recoveredEffect?.structuredContent);
        expect(replayedEffect?.content).toEqual(recoveredEffect?.content);
        expect(await commentMutationCount(effectBeforeOutcomeInput.idempotencyKey)).toBe(1);

        const receiptFailureInput = {
          ...mutateInput,
          idempotencyKey: "idem-receipt-write-failure",
          eventId: "event-receipt-write-failure",
        };
        const originalMaterialize = ActionReceiptAuthority.prototype.materializeMutationOutcome;
        let injectReceiptWriteFailure = true;
        ActionReceiptAuthority.prototype.materializeMutationOutcome = async function (binding) {
          if (injectReceiptWriteFailure) {
            injectReceiptWriteFailure = false;
            throw new Error("injected ordinary receipt write failure");
          }
          return originalMaterialize.call(this, binding);
        };
        const receiptWriteFailure = await restartedTools?.github_pr_monitor_mutate?.handler?.(authorizedMonitorInput(receiptFailureInput));
        ActionReceiptAuthority.prototype.materializeMutationOutcome = originalMaterialize;
        expect(receiptWriteFailure?.isError).toBe(true);
        const receiptWriteRecovered = await restartedTools?.github_pr_monitor_mutate?.handler?.(authorizedMonitorInput(receiptFailureInput));
        expect(receiptWriteRecovered?.isError).toBeUndefined();
        expect(await commentMutationCount(receiptFailureInput.idempotencyKey)).toBe(1);

        const durableStore = readAuthorityDocuments(stateDir) as {
          mutationOutcomes: Array<{ binding: Parameters<ActionReceiptAuthority["mutationOutcomeStatus"]>[0] }>;
        };
        const exactBinding = durableStore.mutationOutcomes.find((outcome) =>
          outcome.binding.idempotencyKey === mutateInput.idempotencyKey)!.binding;
        for (const mismatch of [
          { ...exactBinding, runId: "run-mismatch" },
          { ...exactBinding, actionPlanId: "plan-mismatch" },
          { ...exactBinding, idempotencyKey: "idem-mismatch" },
          { ...exactBinding, claimId: "claim-mismatch" },
          { ...exactBinding, claimPayloadDigest: "f".repeat(64) },
        ]) {
          await expect(authority.mutationOutcomeStatus(
            mismatch,
            "applied",
          )).rejects.toThrow(/different exact durable outcome|no exact durable Action outcome/i);
        }
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    }, 15_000);
});

describe.skipIf(!RUN_DEFERRED_MONITOR_TESTS)("deferred monitor IPC and receipt authority", () => {
    it("rolls back a failed receipt transition without rewriting the prior durable row", async () => {
      const stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-receipt-write-failure-")));
      const receiptId = createHash("sha256").update("write-failure").digest("hex");
      const input = { projectId: "project", commandId: "verify" };
      const verificationIdentity = {
        projectId: input.projectId,
        commandId: input.commandId,
        riskTier: "verify" as const,
        args: [],
        headSha: "1".repeat(40),
        treeSha: "2".repeat(40),
      };
      const response = {
        tool: "command_run",
        toolCall: { toolName: "command_run", input },
        structuredContent: { receiptId, ...verificationIdentity },
      };
      const authority = new ActionReceiptAuthority(stateDir);
      try {
        await authority.issue({
          receiptId,
          kind: "verification",
          response,
          input,
          issuedAt: Date.now(),
          metadata: verificationIdentity,
        });
        withActionReceiptDatabase(stateDir, (database) => database.exec(`
          CREATE TRIGGER reject_receipt_update
          BEFORE UPDATE ON receipts
          BEGIN
            SELECT RAISE(ABORT, 'injected receipt update failure');
          END;
        `));
        await expect(authority.transitionExact(
          receiptId,
          "verification",
          response,
          ["issued"],
          "consumed",
        )).rejects.toThrow(/injected receipt update failure/i);
        withActionReceiptDatabase(stateDir, (database) => database.exec("DROP TRIGGER reject_receipt_update"));
        await expect(authority.exact(receiptId, "verification", response, ["issued"])).resolves.toMatchObject({
          receiptId,
          phase: "issued",
        });
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    });

    it("recovers indexed outcomes beyond 256 entries through a fresh authority instance", async () => {
      const stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-outcome-retention-")));
      try {
        const authority = new ActionReceiptAuthority(stateDir);
        const bindings = Array.from({ length: 257 }, (_, index) => durableOutcomeBinding(index));
        const outcomeKeys: string[] = [];
        for (const binding of bindings) outcomeKeys.push(await authority.beginMutationOutcome(binding));
        const firstStatus = await authority.mutationOutcomeStatus(bindings[0]!, "claimed");
        if (!firstStatus || firstStatus.state !== "intent") throw new Error("Expected the first durable intent");
        const lastBinding = bindings[256]!;
        const lastStatus = await authority.mutationOutcomeStatus(lastBinding, "claimed");
        if (!lastStatus || lastStatus.state !== "intent") throw new Error("Expected the 257th durable intent");
        const lastReceiptId = createHash("sha256").update("retention-last-receipt").digest("hex");
        const lastResponse = {
          ok: true,
          tool: "github_pr_monitor_mutate",
          toolCall: { toolName: "github_pr_monitor_mutate", input: lastBinding.input },
          text: "retained response",
          imageMarkdownList: [],
          structuredContent: {
            receiptId: lastReceiptId,
            runId: lastBinding.runId,
            actionPlanId: lastBinding.actionPlanId,
            idempotencyKey: lastBinding.idempotencyKey,
            claimId: lastBinding.claimId,
            payloadDigest: lastBinding.claimPayloadDigest,
            repository: lastBinding.repository,
            author: lastBinding.author,
            prNumber: lastBinding.prNumber,
            expectedHeadSha: lastBinding.expectedHeadSha,
            eventId: lastBinding.eventId,
            operation: lastBinding.operation,
            ...lastBinding.authorization,
          },
        };
        await authority.completeMutationOutcome(outcomeKeys[256]!, lastBinding, {
          response: lastResponse,
          receiptId: lastReceiptId,
          issuedAt: lastStatus.startedAt,
          metadata: {},
        });

        expect(withActionReceiptDatabase(stateDir, (database) =>
          Number(database.prepare("SELECT COUNT(*) AS count FROM mutation_outcomes").get()?.count ?? 0)))
          .toBe(257);
        const reopened = new ActionReceiptAuthority(stateDir);
        await expect(reopened.mutationOutcomeStatus(bindings[0]!, "claimed")).resolves.toEqual({
          state: "intent",
          outcomeKey: outcomeKeys[0],
          startedAt: firstStatus.startedAt,
        });
        await expect(reopened.mutationOutcomeStatus(lastBinding, "claimed")).resolves.toEqual({
          state: "completed",
          response: lastResponse,
          receiptId: lastReceiptId,
        });
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    }, 120_000);

    it("stores large bounded outcomes independently without a lifetime cache ceiling", async () => {
      const stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-outcome-bytes-")));
      try {
        const authority = new ActionReceiptAuthority(stateDir);
        const bindings = Array.from({ length: 12 }, (_, index) =>
          durableOutcomeBinding(index, { body: "b".repeat(300_000) }));
        const outcomeKeys: string[] = [];
        for (const binding of bindings) outcomeKeys.push(await authority.beginMutationOutcome(binding));
        expect(withActionReceiptDatabase(stateDir, (database) =>
          Number(database.prepare("SELECT COUNT(*) AS count FROM mutation_outcomes").get()?.count ?? 0)))
          .toBe(bindings.length);
        const reopened = new ActionReceiptAuthority(stateDir);
        await expect(reopened.mutationOutcomeStatus(bindings[0]!, "claimed")).resolves.toMatchObject({
          state: "intent",
          outcomeKey: outcomeKeys[0],
        });
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    }, 120_000);

    it("rejects reused claim and idempotency identities through transactional unique indexes", async () => {
      const stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-outcome-index-")));
      try {
        const authority = new ActionReceiptAuthority(stateDir);
        const owner = durableOutcomeBinding(0);
        await authority.beginMutationOutcome(owner);
        for (let index = 1; index <= 256; index += 1) {
          await authority.beginMutationOutcome(durableOutcomeBinding(index));
        }
        for (const conflicting of [
          durableOutcomeBinding(900, { idempotencyKey: owner.idempotencyKey }),
          durableOutcomeBinding(901, { claimId: owner.claimId }),
        ]) {
          await expect(new ActionReceiptAuthority(stateDir).beginMutationOutcome(conflicting))
            .rejects.toThrow(/already bound to a different exact durable outcome/i);
          await expect(new ActionReceiptAuthority(stateDir).mutationOutcomeStatus(conflicting, "claimed"))
            .rejects.toThrow(/already bound to a different exact durable outcome/i);
        }
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    }, 120_000);

    it("admits only one concurrent foreign binding for a shared durable identity", async () => {
      const stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-identity-race-")));
      try {
        const first = durableOutcomeBinding(1, { claimId: "shared-claim" });
        const second = durableOutcomeBinding(2, { claimId: "shared-claim" });
        const results = await Promise.allSettled([
          new ActionReceiptAuthority(stateDir).beginMutationOutcome(first),
          new ActionReceiptAuthority(stateDir).beginMutationOutcome(second),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect(withActionReceiptDatabase(stateDir, (database) =>
          Number(database.prepare("SELECT COUNT(*) AS count FROM mutation_outcomes WHERE claim_id = ?")
            .get("shared-claim")?.count ?? 0))).toBe(1);
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    });

    it("fails closed when indexed row columns or durable outcome JSON are tampered with", async () => {
      const stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-outcome-tamper-")));
      try {
        const authority = new ActionReceiptAuthority(stateDir);
        const binding = durableOutcomeBinding(0);
        const outcomeKey = await authority.beginMutationOutcome(binding);
        const pristine = withActionReceiptDatabase(stateDir, (database) =>
          String(database.prepare("SELECT document FROM mutation_outcomes WHERE outcome_key = ?")
            .get(outcomeKey)?.document ?? ""));
        const tampered = JSON.parse(pristine) as { binding: { eventId: string } };
        tampered.binding.eventId = "foreign-event";
        withActionReceiptDatabase(stateDir, (database) => {
          database.prepare("UPDATE mutation_outcomes SET document = ? WHERE outcome_key = ?")
            .run(JSON.stringify(tampered), outcomeKey);
        });
        await expect(new ActionReceiptAuthority(stateDir).mutationOutcomeStatus(binding, "claimed"))
          .rejects.toThrow(/corrupt exact binding|inconsistent claim or effect binding/i);

        withActionReceiptDatabase(stateDir, (database) => {
          database.prepare("UPDATE mutation_outcomes SET document = ?, claim_id = ? WHERE outcome_key = ?")
            .run(pristine, "foreign-claim", outcomeKey);
        });
        await expect(new ActionReceiptAuthority(stateDir).mutationOutcomeStatus(binding, "claimed"))
          .rejects.toThrow(/indexed identity and state/i);
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    });

    it("atomically backfills evidence digests when opening the prior SQLite schema", async () => {
      const stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-evidence-backfill-")));
      try {
        const binding = durableOutcomeBinding(70);
        const authority = new ActionReceiptAuthority(stateDir);
        const outcomeKey = await authority.beginMutationOutcome(binding);
        withActionReceiptDatabase(stateDir, (database) => {
          database.exec("BEGIN IMMEDIATE");
          try {
            database.prepare("DELETE FROM metadata WHERE key = 'intent_evidence_digest_migrated'").run();
            database.exec("ALTER TABLE mutation_outcomes DROP COLUMN intent_evidence_digest");
            database.exec("COMMIT");
          } catch (error: unknown) {
            database.exec("ROLLBACK");
            throw error;
          }
        });

        await expect(new ActionReceiptAuthority(stateDir).mutationOutcomeStatus(binding, "claimed"))
          .resolves.toMatchObject({ state: "intent", outcomeKey });
        withActionReceiptDatabase(stateDir, (database) => {
          const columns = database.prepare("PRAGMA table_info(mutation_outcomes)").all();
          expect(columns.some((column) => column.name === "intent_evidence_digest")).toBe(true);
          const row = database.prepare(`
            SELECT intent_evidence_digest FROM mutation_outcomes WHERE outcome_key = ?
          `).get(outcomeKey);
          expect(row?.intent_evidence_digest).toBe(createHash("sha256").update("{}").digest("hex"));
          expect(database.prepare("SELECT value FROM metadata WHERE key = 'intent_evidence_digest_migrated'").get()?.value)
            .toBe("1");
        });
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    });

    it("fails closed when reviewer pre-apply evidence is changed without its indexed digest", async () => {
      const stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-evidence-tamper-")));
      try {
        const binding = durableReviewerBinding(71);
        const authority = new ActionReceiptAuthority(stateDir);
        const outcomeKey = await authority.beginMutationOutcome(binding, { reviewerRequestedBeforeIntent: false });
        const pristine = withActionReceiptDatabase(stateDir, (database) =>
          String(database.prepare("SELECT document FROM mutation_outcomes WHERE outcome_key = ?")
            .get(outcomeKey)?.document ?? ""));
        const tampered = JSON.parse(pristine) as {
          intentEvidence: { reviewerRequestedBeforeIntent: boolean };
        };
        tampered.intentEvidence.reviewerRequestedBeforeIntent = true;
        withActionReceiptDatabase(stateDir, (database) => {
          database.prepare("UPDATE mutation_outcomes SET document = ? WHERE outcome_key = ?")
            .run(JSON.stringify(tampered), outcomeKey);
        });

        await expect(new ActionReceiptAuthority(stateDir).mutationOutcomeStatus(binding, "claimed"))
          .rejects.toThrow(/pre-apply evidence/i);
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    });
    it("denies legacy receipt state without promoting it into live SQLite tables", async () => {
      const stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-legacy-denial-")));
      try {
        const body = { version: 4, updatedAt: Date.now(), receipts: [], mutationOutcomes: [] };
        await writeFile(
          path.join(stateDir, "action-receipts.json"),
          JSON.stringify({ ...body, integrity: testDigest(body) }),
          "utf8",
        );
        const authority = new ActionReceiptAuthority(stateDir);
        await expect(authority.issue({
          receiptId: createHash("sha256").update("legacy-denial").digest("hex"),
          kind: "verification",
          response: {},
          input: {},
          issuedAt: Date.now(),
          metadata: {},
        })).rejects.toThrow(/diagnostics-only.*promoted/i);
        expect(withActionReceiptDatabase(stateDir, (database) => ({
          receipts: Number(database.prepare("SELECT COUNT(*) AS count FROM receipts").get()?.count ?? 0),
          mutationOutcomes: Number(database.prepare("SELECT COUNT(*) AS count FROM mutation_outcomes").get()?.count ?? 0),
        }))).toEqual({ receipts: 0, mutationOutcomes: 0 });
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    });

    it("denies completed rerequests without exact pre-apply evidence", async () => {
      const stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-rerequest-evidence-")));
      try {
        const binding = durableReviewerBinding(72);
        const authority = new ActionReceiptAuthority(stateDir);
        const outcomeKey = await authority.beginMutationOutcome(binding, { reviewerRequestedBeforeIntent: false });
        const pristine = withActionReceiptDatabase(stateDir, (database) =>
          String(database.prepare("SELECT document FROM mutation_outcomes WHERE outcome_key = ?")
            .get(outcomeKey)?.document ?? ""));
        const tampered = JSON.parse(pristine) as Record<string, unknown>;
        const receiptId = createHash("sha256").update("rerequest-missing-evidence").digest("hex");
        const startedAt = Number(tampered.startedAt);
        const response = {
          ok: true,
          tool: "github_pr_monitor_mutate",
          toolCall: { toolName: "github_pr_monitor_mutate", input: binding.input },
          text: "completed",
          imageMarkdownList: [],
          structuredContent: {
            receiptId,
            runId: binding.runId,
            actionPlanId: binding.actionPlanId,
            idempotencyKey: binding.idempotencyKey,
            claimId: binding.claimId,
            payloadDigest: binding.claimPayloadDigest,
            repository: binding.repository,
            author: binding.author,
            prNumber: binding.prNumber,
            expectedHeadSha: binding.expectedHeadSha,
            eventId: binding.eventId,
            operation: binding.operation,
            ...binding.authorization,
          },
        };
        const completed = {
          ...tampered,
          state: "completed",
          intentEvidence: {},
          response,
          receiptId,
          issuedAt: startedAt,
          completedAt: startedAt,
          metadata: {},
        };
        withActionReceiptDatabase(stateDir, (database) => {
          database.prepare(`
            UPDATE mutation_outcomes
            SET state = 'completed', completed_at = ?, intent_evidence_digest = ?, document = ?
            WHERE outcome_key = ?
          `).run(startedAt, testDigest({}), JSON.stringify(completed), outcomeKey);
        });
        await expect(new ActionReceiptAuthority(stateDir).mutationOutcomeStatus(binding, "claimed"))
          .rejects.toThrow(/pre-apply evidence/i);
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    });

    it("refuses an oversized outcome without reserving either unique identity", async () => {
      const stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-outcome-oversize-")));
      try {
        const oversized = durableOutcomeBinding(0, { body: "x".repeat(1_500_000) });
        const authority = new ActionReceiptAuthority(stateDir);
        await expect(authority.beginMutationOutcome(oversized))
          .rejects.toThrow(/exceeds the bounded shard size/i);
        expect(withActionReceiptDatabase(stateDir, (database) =>
          Number(database.prepare("SELECT COUNT(*) AS count FROM mutation_outcomes").get()?.count ?? 0)))
          .toBe(0);

        const reusable = durableOutcomeBinding(0, {
          claimId: oversized.claimId,
          idempotencyKey: oversized.idempotencyKey,
        });
        const reusedKey = await new ActionReceiptAuthority(stateDir).beginMutationOutcome(reusable);
        expect(reusedKey).toMatch(/^[0-9a-f]{64}$/u);
        await expect(new ActionReceiptAuthority(stateDir).mutationOutcomeStatus(reusable, "claimed"))
          .resolves.toMatchObject({ state: "intent", outcomeKey: reusedKey });
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    }, 120_000);
});
