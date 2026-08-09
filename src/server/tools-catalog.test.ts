import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
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

describe("tool catalog", () => {
  beforeEach(() => {
    process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = "enabled";
  });
  afterEach(() => {
    delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
  });
  it("keeps the one-shot E2E tool out of destructive/open-world routing", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { annotations?: Record<string, unknown>; inputSchema?: { shape?: Record<string, unknown> } }>;
      }
    )._registeredTools;
    const oneShot = tools?.e2e_test_and_show_screenshot;

    expect(oneShot?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(oneShot?.inputSchema?.shape?.serverCommand).toBeUndefined();
    expect(oneShot?.inputSchema?.shape?.testCommand).toBeUndefined();
    expect(oneShot?.inputSchema?.shape?.waitUrl).toBeUndefined();
  });

  it("declares the ChatGPT widget template for E2E screenshot tools", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { _meta?: Record<string, unknown> }>;
      }
    )._registeredTools;

    for (const name of ["e2e_test_and_show_screenshot", "e2e_screenshot", "e2e_open_url_screenshot", "e2e_run_command"]) {
      expect(tools?.[name]?._meta?.["openai/outputTemplate"], name).toBe("ui://widget/e2e-screenshots.html");
    }

    const resources = (
      server as unknown as {
        _registeredResources?: Record<
          string,
          {
            metadata?: { mimeType?: string; _meta?: Record<string, unknown> };
            readCallback?: (uri: URL) => Promise<{ contents: Array<{ mimeType?: string; text?: string }> }>;
          }
        >;
      }
    )._registeredResources;
    const widget = resources?.["ui://widget/e2e-screenshots.html"];
    expect(widget?.metadata?.mimeType).toBe("text/html+skybridge");
    expect(widget?.metadata?._meta?.["openai/widgetCSP"]).toBeDefined();

    const read = await widget?.readCallback?.(new URL("ui://widget/e2e-screenshots.html"));
    const content = read?.contents?.[0];
    expect(content?.mimeType).toBe("text/html+skybridge");
    expect(content?.text).toContain("chatgpt2codex/screenshots");
    expect(content?.text).toContain("openai:set_globals");
    expect(content?.text).toContain("dataUri");
  });

  it("exposes GPT Image 2 import routing and ChatGPT URL intake", async () => {
    const server = await createServer(makeCtx());
    const tools = (server as unknown as { _registeredTools?: Record<string, { description?: string; handler?: (input: unknown) => Promise<unknown> }> })
      ._registeredTools;

    expect(tools?.gpt_image_2_generate).toBeUndefined();
    expect(tools?.open_chatgpt_images_app?.description).toContain("ChatGPT Images app");
    expect(tools?.save_chatgpt_image?.description).toContain("Single app-friendly");
    expect(tools?.save_chatgpt_image_from_url?.description).toContain("ChatGPT-generated image");
    expect(tools?.save_chatgpt_image_from_url?.description).toContain("chatgpt.com/s/m_...");
    expect(tools?.save_chatgpt_screen_images).toBeUndefined();
    expect(tools?.generate_chatgpt_image).toBeUndefined();
    expect(tools?.chatgpt_image_loop).toBeUndefined();
    expect(tools?.list_pending_images).toBeUndefined();
    expect(tools?.save_image_from_pending).toBeUndefined();

    const guide = tools?.gpt_image_2_workflow;
    expect(guide?.description).toContain("import workflow");

    const result = (await guide?.handler?.({})) as {
      structuredContent?: {
        chatgpt2codexToolCall?: { namespace?: string; tool?: string; ok?: boolean };
        toolAvailabilityGate?: { namespace?: string };
        doThis?: string[];
        ifNativeImageGenerationUnavailable?: string[];
        notThis?: string[];
        saveTools?: string[];
      };
      content?: Array<{ text: string }>;
    };
    expect(result.structuredContent?.chatgpt2codexToolCall).toMatchObject({
      namespace: "ChatGPT_To_Codex",
      tool: "gpt_image_2_workflow",
      ok: true,
    });
    expect(result.structuredContent?.toolAvailabilityGate?.namespace).toBe("ChatGPT_To_Codex");
    expect(result.structuredContent?.doThis?.join(" ")).toContain("reselect ChatGPT To Codex");
    expect(result.structuredContent?.doThis?.join(" ")).toContain("Generate with ChatGPT's native image surface");
    expect(result.structuredContent?.doThis?.join(" ")).toContain("chatgpt.com/s/m_...");
    expect(result.structuredContent?.ifNativeImageGenerationUnavailable?.join(" ")).toContain("Share/Copy Link");
    expect(result.structuredContent?.notThis?.join(" ")).toContain("Do not call Codex");
    expect(result.structuredContent?.notThis?.join(" ")).toContain("python_user_visible");
    expect(result.structuredContent?.notThis?.join(" ")).toContain("automatic capture helpers");
    expect(result.structuredContent?.saveTools).toContain("open_chatgpt_images_app");
    expect(result.structuredContent?.saveTools).toContain("save_chatgpt_image");
    expect(result.structuredContent?.saveTools).toContain("save_chatgpt_image_from_url");
    expect(result.structuredContent?.saveTools).toContain("save_image_from_url");
    expect(result.content?.[0]?.text).toContain("native ChatGPT GPT Image 2 generation first");
  });

  it("keeps broad context-pack off the ChatGPT-visible tool list", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { description?: string }>;
      }
    )._registeredTools;

    expect(tools?.code_context_pack).toBeDefined();
    expect(tools?.code_context_pack?.description).toContain("ChatGPT should prefer code_search");

    const handler = (
      server.server as unknown as {
        _requestHandlers?: Map<
          string,
          (request: { method: string; params: Record<string, never> }) => Promise<{ tools: Array<{ name: string }> }>
        >;
      }
    )._requestHandlers?.get("tools/list");
    const listed = await handler?.({ method: "tools/list", params: {} });
    expect(listed?.tools.map((tool) => tool.name)).not.toContain("code_context_pack");
  });

  it("agent_guide exposes Codex-grade loop, tool surface, and safety model", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      }
    )._registeredTools;

    const result = (await tools?.agent_guide?.handler?.({})) as {
      structuredContent?: {
        codexGradeLoop?: string[];
        toolSurfaceMap?: Record<string, string[]>;
        securityModel?: string[];
        desktopControlModel?: string[];
      };
    };

    expect(result.structuredContent?.codexGradeLoop?.join(" ")).toContain("Discover");
    expect(result.structuredContent?.codexGradeLoop?.join(" ")).toContain("Verify");
    expect(result.structuredContent?.toolSurfaceMap?.modify).toEqual(
      expect.arrayContaining(["file_apply_patch", "file_create", "local_shell_run"]),
    );
    expect(result.structuredContent?.toolSurfaceMap?.verify).toEqual(
      expect.arrayContaining(["e2e_test_and_show_screenshot", "e2e_run_command"]),
    );
    expect(result.structuredContent?.securityModel?.join(" ")).toContain("current-turn ChatGPT_To_Codex tool proof");
    expect(result.structuredContent?.securityModel?.join(" ")).toContain("Prompt-injection posture");
    expect(result.structuredContent?.desktopControlModel?.join(" ")).toContain("kill switch");
    expect(result.structuredContent?.desktopControlModel?.join(" ")).toContain("sensitive apps");
  });
  describe("ChatGPT read-only exposure (CHATGPT2CODEX_CHATGPT_READ_ONLY)", () => {
    afterEach(() => {
      delete process.env.CHATGPT2CODEX_CHATGPT_READ_ONLY;
      delete process.env.CHATGPT2CODEX_CONTROL;
      delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
    });

    async function remoteToolsListNames(): Promise<string[]> {
      const server = await createServer({ ...makeCtx(), remote: true });
      const handler = (
        server.server as unknown as {
          _requestHandlers?: Map<
            string,
            (request: { method: string; params: Record<string, never> }) => Promise<{ tools: Array<{ name: string }> }>
          >;
        }
      )._requestHandlers?.get("tools/list");
      const listed = await handler?.({ method: "tools/list", params: {} });
      return listed?.tools.map((tool) => tool.name) ?? [];
    }

    it("keeps representative write tools in the default remote catalog", async () => {
      const names = await remoteToolsListNames();
      expect(names).toContain("file_apply_patch");
      expect(names).toContain("project_select");
    });

    it("lists only annotated read tools and rejects hidden write-tool calls", async () => {
      process.env.CHATGPT2CODEX_CHATGPT_READ_ONLY = "TrUe";
      const server = await createServer({ ...makeCtx(), remote: true });
      const tools = (
        server as unknown as {
          _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
        }
      )._registeredTools;
      const names = await remoteToolsListNames();

      expect(names).toContain("agent_guide");
      expect(names).toContain("project_status");
      expect(names).toContain("code_search");
      expect(names).not.toContain("file_apply_patch");
      expect(names).not.toContain("project_select");
      expect(names).not.toContain("computer_action_status");

      const denied = (await tools?.file_apply_patch?.handler?.({})) as {
        isError?: boolean;
        structuredContent?: { code?: string; error?: string };
      };
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        code: "PERMISSION_DENIED",
        error: expect.stringContaining("CHATGPT2CODEX_CHATGPT_READ_ONLY"),
      });

      const guide = (await tools?.agent_guide?.handler?.({})) as {
        isError?: boolean;
        structuredContent?: { toolAvailabilityGate?: unknown };
      };
      expect(guide.isError).not.toBe(true);
      expect(guide.structuredContent?.toolAvailabilityGate).toBeDefined();
    });
    it("keeps all control tools unavailable when control exposure and read-only mode are both enabled", async () => {
      process.env.CHATGPT2CODEX_CONTROL = "1";
      process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "true";
      process.env.CHATGPT2CODEX_CHATGPT_READ_ONLY = "on";
      const server = await createServer({ ...makeCtx(), remote: true });
      const tools = (
        server as unknown as {
          _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
        }
      )._registeredTools;
      const handler = (
        server.server as unknown as {
          _requestHandlers?: Map<
            string,
            (request: { method: string; params: Record<string, never> }) => Promise<{ tools: Array<{ name: string }> }>
          >;
        }
      )._requestHandlers?.get("tools/list");
      const listed = await handler?.({ method: "tools/list", params: {} });
      const names = listed?.tools.map((tool) => tool.name) ?? [];

      for (const name of CONTROL_TOOL_NAMES) {
        expect(names, name).not.toContain(name);
      }

      const denied = (await tools?.computer_action_status?.handler?.({})) as {
        isError?: boolean;
        structuredContent?: { code?: string; error?: string };
      };
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        code: "PERMISSION_DENIED",
        error: expect.stringContaining("CHATGPT2CODEX_CHATGPT_READ_ONLY"),
      });
    });

    it.each(["0", "false", "off", ""])("does not enable read-only filtering for falsey values (%s)", async (value) => {
      process.env.CHATGPT2CODEX_CHATGPT_READ_ONLY = value;
      const names = await remoteToolsListNames();
      expect(names).toContain("file_apply_patch");
    });
  });
  it("retains a valid registered monitor worktree through refresh and selection", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-monitor-worktree-"));
    const headSha = "a".repeat(40);
    const worktreeRoot = path.join(
      workspaceRoot,
      "gajae-code-pr-monitor-pr-worktrees",
      "Yeachan-Heo--gajae-code",
      `pr-42-${headSha}`,
    );
    const entry: ProjectRegistryEntry = {
      projectId: `pr-42-${headSha}`,
      name: `pr-42-${headSha}`,
      root: worktreeRoot,
      aliases: [`pr-42-${headSha}`, worktreeRoot],
      branch: "(detached)",
      dirty: false,
      hasAgentsMd: false,
      hasCodeBrain: false,
      packageHints: [],
      lastSeenAt: new Date().toISOString(),
    };
    const stale: ProjectRegistryEntry = {
      ...entry,
      projectId: "stale",
      name: "stale",
      root: path.join(workspaceRoot, "missing"),
      aliases: ["stale"],
    };
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const ctx = makeCtx();
    const saved: ProjectRegistryEntry[][] = [];
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [entry, stale];
    ctx.store = {
      loadProjects: async () => [],
      saveProjects: async (projects) => { saved.push(projects); },
      getSession: async () => null,
      setSession: async () => undefined,
    };

    try {
      await mkdir(repositoryRoot, { recursive: true });
      await writeFile(path.join(repositoryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await mkdir(worktreeRoot, { recursive: true });
      const canonicalWorktreeRoot = await realpath(worktreeRoot);
      await writeFile(path.join(worktreeRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;

      await tools?.workspace_refresh_index?.handler?.({});
      const listed = (await tools?.workspace_list_projects?.handler?.({
        query: canonicalWorktreeRoot,
        limit: 20,
      })) as {
        structuredContent?: { projects?: ProjectRegistryEntry[] };
      };
      const project = listed.structuredContent?.projects?.find(
        (candidate) => candidate.root === canonicalWorktreeRoot,
      );
      expect(project?.projectId).toBe(entry.projectId);
      expect(listed.structuredContent?.projects?.map((candidate) => candidate.projectId)).not.toContain(stale.projectId);

      const selected = (await tools?.project_select?.handler?.({
        projectId: project?.projectId,
        reason: "monitor review",
        preset: "full-write",
      })) as { isError?: boolean; structuredContent?: { lease?: { projectId?: string } } };
      expect(selected.isError).toBeUndefined();
      expect(selected.structuredContent?.lease?.projectId).toBe(entry.projectId);
      expect(saved.at(-1)?.map((project) => project.projectId)).toContain(entry.projectId);
      expect(saved.at(-1)?.map((project) => project.projectId)).not.toContain(stale.projectId);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
  it("excludes arbitrary nested registrations from saved and live refresh registries", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-refresh-"));
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const arbitraryRoot = path.join(workspaceRoot, "unrelated", "nested");
    const arbitrary: ProjectRegistryEntry = {
      projectId: "nested",
      name: "nested",
      root: arbitraryRoot,
      aliases: [arbitraryRoot],
      dirty: false,
      hasAgentsMd: false,
      hasCodeBrain: false,
      packageHints: [],
      lastSeenAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    const saved: ProjectRegistryEntry[][] = [];
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [arbitrary];
    ctx.store = {
      loadProjects: async () => [],
      saveProjects: async (projects) => { saved.push(projects); },
      getSession: async () => null,
      setSession: async () => undefined,
    };

    try {
      await mkdir(arbitraryRoot, { recursive: true });
      await writeFile(path.join(arbitraryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await mkdir(repositoryRoot, { recursive: true });
      await writeFile(path.join(repositoryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");

      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const refreshed = (await tools?.workspace_refresh_index?.handler?.({})) as { isError?: boolean };

      expect(refreshed.isError).toBeUndefined();
      expect(ctx.registry.map((project) => project.projectId)).not.toContain(arbitrary.projectId);
      expect(saved.at(-1)?.map((project) => project.projectId)).not.toContain(arbitrary.projectId);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects duplicate refresh identities without changing the live registry", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-refresh-"));
    const headSha = "b".repeat(40);
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const monitorRoot = path.join(
      workspaceRoot,
      "gajae-code-pr-monitor-pr-worktrees",
      "Yeachan-Heo--gajae-code",
      `pr-7-${headSha}`,
    );
    const monitor: ProjectRegistryEntry = {
      projectId: `pr-7-${headSha}`,
      name: `pr-7-${headSha}`,
      root: monitorRoot,
      aliases: [monitorRoot],
      branch: "(detached)",
      dirty: false,
      hasAgentsMd: false,
      hasCodeBrain: false,
      packageHints: [],
      lastSeenAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [monitor, { ...monitor, aliases: ["duplicate"] }];
    const before = structuredClone(ctx.registry);
    const saved: ProjectRegistryEntry[][] = [];
    ctx.store = {
      loadProjects: async () => [],
      saveProjects: async (projects) => { saved.push(projects); },
      getSession: async () => null,
      setSession: async () => undefined,
    };

    try {
      await mkdir(repositoryRoot, { recursive: true });
      await writeFile(path.join(repositoryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await mkdir(monitorRoot, { recursive: true });
      await writeFile(path.join(monitorRoot, ".git"), "gitdir: /nonexistent\n", "utf8");

      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const refreshed = (await tools?.workspace_refresh_index?.handler?.({})) as {
        isError?: boolean;
        structuredContent?: { code?: string };
      };

      expect(refreshed.isError).toBe(true);
      expect(refreshed.structuredContent?.code).toBe("AMBIGUOUS_PROJECT");
      expect(saved).toEqual([]);
      expect(ctx.registry).toEqual(before);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
  it("rejects persisted scanned-versus-retained ID collisions without publishing an empty live registry", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-refresh-"));
    const headSha = "c".repeat(40);
    const name = `pr-9-${headSha}`;
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const scannedRoot = path.join(workspaceRoot, name);
    const monitorRoot = path.join(
      workspaceRoot,
      "gajae-code-pr-monitor-pr-worktrees",
      "Yeachan-Heo--gajae-code",
      name,
    );
    const retained: ProjectRegistryEntry = {
      projectId: name,
      name,
      root: monitorRoot,
      aliases: [monitorRoot],
      dirty: false,
      hasAgentsMd: false,
      hasCodeBrain: false,
      packageHints: [],
      lastSeenAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [];
    const before = structuredClone(ctx.registry);
    const saved: ProjectRegistryEntry[][] = [];
    let loadCount = 0;
    ctx.store = {
      loadProjects: async () => {
        loadCount += 1;
        return [retained];
      },
      saveProjects: async (projects) => { saved.push(projects); },
      getSession: async () => null,
      setSession: async () => undefined,
    };

    try {
      for (const root of [repositoryRoot, scannedRoot, monitorRoot]) {
        await mkdir(root, { recursive: true });
        await writeFile(path.join(root, ".git"), "gitdir: /nonexistent\n", "utf8");
      }
      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const refreshed = (await tools?.workspace_refresh_index?.handler?.({})) as {
        isError?: boolean;
        structuredContent?: { code?: string };
      };

      expect(refreshed.isError).toBe(true);
      expect(refreshed.structuredContent?.code).toBe("AMBIGUOUS_PROJECT");
      expect(loadCount).toBe(1);
      expect(saved).toEqual([]);
      expect(ctx.registry).toEqual(before);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not publish persisted entries when saving an empty live registry refresh is rejected", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-refresh-"));
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const stale: ProjectRegistryEntry = {
      projectId: "stale",
      name: "stale",
      root: path.join(workspaceRoot, "missing"),
      aliases: ["stale"],
      dirty: false,
      hasAgentsMd: false,
      hasCodeBrain: false,
      packageHints: [],
      lastSeenAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [];
    const before = structuredClone(ctx.registry);
    let loadCount = 0;
    let saveAttempted = false;
    ctx.store = {
      loadProjects: async () => {
        loadCount += 1;
        return [stale];
      },
      saveProjects: async () => {
        saveAttempted = true;
        throw new Error("save rejected");
      },
      getSession: async () => null,
      setSession: async () => undefined,
    };

    try {
      await mkdir(repositoryRoot, { recursive: true });
      await writeFile(path.join(repositoryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");

      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const refreshed = (await tools?.workspace_refresh_index?.handler?.({})) as { isError?: boolean };

      expect(refreshed.isError).toBe(true);
      expect(loadCount).toBe(1);
      expect(saveAttempted).toBe(true);
      expect(ctx.registry).toEqual(before);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("uses canonical absolute paths as exact workspace-list queries", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-list-"));
    const root = path.join(workspaceRoot, "project");
    const otherRoot = path.join(workspaceRoot, "other");
    const symlinkRoot = path.join(workspaceRoot, "project-link");
    const entries: ProjectRegistryEntry[] = ["project", "other"].map((name, index) => ({
      projectId: name,
      name,
      root: index === 0 ? root : otherRoot,
      aliases: [root],
      dirty: false,
      hasAgentsMd: false,
      hasCodeBrain: false,
      packageHints: [],
      lastSeenAt: new Date().toISOString(),
    }));
    const ctx = makeCtx();
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = entries;

    try {
      await mkdir(root, { recursive: true });
      await mkdir(otherRoot, { recursive: true });
      await symlink(root, symlinkRoot);
      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const listed = (await tools?.workspace_list_projects?.handler?.({ query: symlinkRoot })) as {
        structuredContent?: { projects?: ProjectRegistryEntry[] };
      };

      expect(listed.structuredContent?.projects?.map((entry) => entry.projectId)).toEqual(["project"]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
  it("preserves saved and live registry state when retained monitor validation cannot access its marker", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-retained-"));
    const headSha = "d".repeat(40);
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const monitorRoot = path.join(workspaceRoot, "gajae-code-pr-monitor-pr-worktrees", "Yeachan-Heo--gajae-code", `pr-11-${headSha}`);
    const retained: ProjectRegistryEntry = {
      projectId: `pr-11-${headSha}`, name: `pr-11-${headSha}`, root: monitorRoot, aliases: [monitorRoot],
      dirty: false, hasAgentsMd: false, hasCodeBrain: false, packageHints: [], lastSeenAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    const saved: ProjectRegistryEntry[][] = [];
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [retained];
    const before = structuredClone(ctx.registry);
    ctx.store = {
      loadProjects: async () => [],
      saveProjects: async (projects) => { saved.push(projects); },
      getSession: async () => null,
      setSession: async () => undefined,
    };

    try {
      await mkdir(repositoryRoot, { recursive: true });
      await writeFile(path.join(repositoryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await mkdir(monitorRoot, { recursive: true });
      await writeFile(path.join(monitorRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await chmod(monitorRoot, 0);
      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const refreshed = (await tools?.workspace_refresh_index?.handler?.({})) as { isError?: boolean };

      expect(refreshed.isError).toBe(true);
      expect(saved).toEqual([]);
      expect(ctx.registry).toEqual(before);
    } finally {
      await chmod(monitorRoot, 0o700).catch(() => undefined);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects retained monitor symlinks instead of retaining their canonical target", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-retained-"));
    const headSha = "e".repeat(40);
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const targetRoot = path.join(workspaceRoot, "target");
    const monitorRoot = path.join(workspaceRoot, "gajae-code-pr-monitor-pr-worktrees", "Yeachan-Heo--gajae-code", `pr-12-${headSha}`);
    const retained: ProjectRegistryEntry = {
      projectId: `pr-12-${headSha}`, name: `pr-12-${headSha}`, root: monitorRoot, aliases: [monitorRoot],
      dirty: false, hasAgentsMd: false, hasCodeBrain: false, packageHints: [], lastSeenAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [retained];

    try {
      await mkdir(repositoryRoot, { recursive: true });
      await writeFile(path.join(repositoryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await mkdir(targetRoot, { recursive: true });
      await writeFile(path.join(targetRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await mkdir(path.dirname(monitorRoot), { recursive: true });
      await symlink(targetRoot, monitorRoot);
      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const refreshed = (await tools?.workspace_refresh_index?.handler?.({})) as { isError?: boolean };

      expect(refreshed.isError).toBeUndefined();
      expect(ctx.registry.map((entry) => entry.projectId)).not.toContain(retained.projectId);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  describe("ChatGPT confirm-model exposure (CHATGPT2CODEX_CONTROL_CHATGPT)", () => {
    beforeEach(() => {
      process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = "enabled";
    });
    afterEach(() => {
      delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
      delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
    });

    async function toolsListNames(): Promise<string[]> {
      const server = await createServer(makeCtx());
      const handler = (
        server.server as unknown as {
          _requestHandlers?: Map<
            string,
            (request: { method: string; params: Record<string, never> }) => Promise<{
              tools: Array<{ name: string; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }>;
            }>
          >;
        }
      )._requestHandlers?.get("tools/list");
      const listed = await handler?.({ method: "tools/list", params: {} });
      return listed?.tools.map((t) => t.name) ?? [];
    }

    it("hides the 4 control tools from tools/list by default (flag unset)", async () => {
      const names = await toolsListNames();
      for (const name of CONTROL_TOOL_NAMES) {
        expect(names, name).not.toContain(name);
      }
    });

    it.each(["0", "false", "off"])("hides the 4 control tools from tools/list when explicitly opted out (%s)", async (value) => {
      process.env.CHATGPT2CODEX_CONTROL_CHATGPT = value;
      const names = await toolsListNames();
      for (const name of CONTROL_TOOL_NAMES) {
        expect(names, name).not.toContain(name);
      }
    });

    it("exposes all 4 control tools in tools/list once CHATGPT2CODEX_CONTROL_CHATGPT=1, with oauth2 securitySchemes and Confirm/Deny-driving annotations", async () => {
      process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
      const server = await createServer(makeCtx());
      const handler = (
        server.server as unknown as {
          _requestHandlers?: Map<
            string,
            (request: { method: string; params: Record<string, never> }) => Promise<{
              tools: Array<{
                name: string;
                annotations?: Record<string, unknown>;
                securitySchemes?: Array<{ type?: string; scopes?: string[] }>;
                _meta?: Record<string, unknown>;
              }>;
            }>
          >;
        }
      )._requestHandlers?.get("tools/list");
      const listed = await handler?.({ method: "tools/list", params: {} });
      const byName = new Map((listed?.tools ?? []).map((t) => [t.name, t]));

      for (const name of CONTROL_TOOL_NAMES) {
        const tool = byName.get(name);
        expect(tool, name).toBeDefined();
        expect(tool?.securitySchemes, name).toMatchObject([{ type: "oauth2", scopes: ["chatgpt2codex"] }]);
        expect(tool?._meta?.["openai/visibility"], name).toBe("public");
      }

      // request_action / kill_switch / screenshot must drive ChatGPT's
      // client-side Confirm/Deny prompt (non-read-only, destructive);
      // action_status is a pure read and must not prompt.
      expect(byName.get("computer_request_action")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("computer_kill_switch")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("computer_screenshot")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("computer_action_status")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    });
    it("registers fixed-repository PR monitor tools with bounded mutation input", async () => {
      const server = await createServer(makeCtx());
      const tools = (server as unknown as { _registeredTools?: Record<string, { annotations?: Record<string, unknown>; inputSchema?: { shape?: Record<string, unknown>; safeParse?: (value: unknown) => { success: boolean } } }> })._registeredTools;
      expect(tools?.github_pr_monitor_read?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tools?.github_pr_monitor_prepare?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      expect(tools?.github_pr_monitor_prepare?.inputSchema?.shape?.operation).toBeDefined();
      expect(tools?.github_pr_monitor_prepare?.inputSchema?.shape?.expectedHeadSha).toBeDefined();
      expect(tools?.github_pr_monitor_prepare?.inputSchema?.shape?.headRef).toBeDefined();
      expect(tools?.github_pr_monitor_prepare?.inputSchema?.shape?.repository).toBeDefined();
      expect(tools?.github_pr_monitor_execute?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      expect(tools?.github_pr_monitor_execute?.inputSchema?.shape?.operation).toBeDefined();
      expect(tools?.github_pr_monitor_execute?.inputSchema?.shape?.ociImageDigest).toBeDefined();
      expect(tools?.github_pr_monitor_execute?.inputSchema?.shape?.suggestions).toBeDefined();
      expect(tools?.github_pr_monitor_execute?.inputSchema?.safeParse?.({
        runId: "run", actionPlanId: "plan", idempotencyKey: "idem", eventId: "event",
        repository: "Yeachan-Heo/gajae-code", author: "twoimo", prNumber: 1,
        expectedHeadSha: "0".repeat(40), operation: "apply_suggestions",
        worktreePath: "/tmp/worktree", headRef: "feature/test", ociImageDigest: `sha256:${"a".repeat(64)}`,
        suggestions: [{
          threadId: "thread", commentId: "comment", reviewer: "reviewer", path: "src/a.ts", startLine: 1, line: 1,
          expectedOriginal: "old", replacement: "unsafe\0replacement", sourceDigest: "b".repeat(64),
        }],
      }).success).toBe(false);
      expect(tools?.github_pr_monitor_state?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      expect(tools?.github_pr_monitor_state?.inputSchema?.shape?.command).toBeDefined();
      expect(tools?.github_pr_monitor_state?.inputSchema?.shape?.input).toBeDefined();
      expect(tools?.github_pr_monitor_mutate?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tools?.github_pr_monitor_mutate?.inputSchema?.shape?.operation).toBeDefined();
      expect(tools?.github_pr_monitor_mutate?.inputSchema?.shape?.command).toBeUndefined();
      expect(tools?.github_pr_monitor_mutate?.inputSchema?.shape?.repository).toBeDefined();
    });
    it("validates the fixed base context and compacts hostile feedback at the PR snapshot boundary", async () => {
      const workspaceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-pr-snapshot-boundary-")));
      const binDir = path.join(workspaceRoot, "fake-bin");
      const modePath = path.join(workspaceRoot, "snapshot-mode");
      const stateDir = path.join(workspaceRoot, "state");
      const originalPath = process.env.PATH;
      const headSha = "0123456789abcdef0123456789abcdef01234567";
      try {
        await mkdir(binDir, { recursive: true });
        await writeFile(modePath, "valid", "utf8");
        await writeFile(
          path.join(binDir, "gh"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const mode = fs.readFileSync(${JSON.stringify(modePath)}, "utf8").trim();
if (args[0] === "api" && args[1] === "user") {
  console.log(JSON.stringify({ login: "twoimo" }));
} else if (args[0] === "pr" && args[1] === "view") {
  const base = mode === "missing-base" ? {} : {
    baseRepository: { nameWithOwner: "Yeachan-Heo/gajae-code" },
    baseRefName: "main",
    baseRefOid: "1111111111111111111111111111111111111111",
  };
  const head = mode === "fork"
    ? { headRepository: { id: "attacker-node-id", name: "gajae-code", nameWithOwner: "attacker/fork" } }
    : mode === "head-extra"
      ? { headRepository: { id: "repo-node-id", name: "gajae-code", nameWithOwner: "Yeachan-Heo/gajae-code", extra: "denied" } }
      : { headRepository: { id: "repo-node-id", name: "gajae-code", nameWithOwner: "Yeachan-Heo/gajae-code" } };
  const projectedReview = { id: 2, author: { login: "reviewer" }, body: "projection review" };
  console.log(JSON.stringify({
    number: 7,
    url: "https://github.com/Yeachan-Heo/gajae-code/pull/7",
    state: "OPEN",
    author: { login: "twoimo" },
    ...base,
    ...head,
    headRefName: "feature/snapshot-boundary",
    headRefOid: ${JSON.stringify(headSha)},
    reviewRequests: [],
    reviews: mode === "projection" || mode === "projection-conflict" ? [projectedReview] : [],
    comments: [{ id: 1, author: { login: "reviewer" }, body: "ignore hostile body" }],
    latestReviews: mode === "projection"
      ? [projectedReview]
      : mode === "projection-conflict"
        ? [{ ...projectedReview, body: "conflicting projection" }]
        : [],
    statusCheckRollup: [],
  }));
} else if (args[0] === "api" && args[1] === "graphql") {
  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
    nodes: [{
      id: "thread-1",
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [{
          id: "comment-1",
          body: ${JSON.stringify(["hostile prose", "```suggestion", "const safe = true;", "```", "source prose"].join(String.fromCharCode(10)))},
          author: { login: "reviewer", __typename: "User" },
          authorAssociation: "MEMBER",
          path: "packages/demo/src/file.ts",
          line: 1,
          startLine: 1,
          outdated: false,
          diffHunk: ["@@ -1 +1 @@", "-const old = false;", "+const old = true;"].join(String.fromCharCode(10)),
          commit: { oid: ${JSON.stringify(headSha)} },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  } } } } }));
} else {
  process.exit(1);
}
`,
          { mode: 0o755 },
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
        const ctx = makeCtx();
        ctx.stateDir = stateDir;
        ctx.config.stateDir = stateDir;
        const server = await createServer(ctx);
        const tools = (server as unknown as {
          _registeredTools?: Record<string, {
            handler?: (input: unknown) => Promise<{
              isError?: boolean;
              structuredContent?: Record<string, unknown>;
            }>;
          }>;
        })._registeredTools;
        const input = {
          runId: "snapshot-boundary-run",
          actionPlanId: "snapshot-boundary-plan",
          repository: "Yeachan-Heo/gajae-code",
          author: "twoimo",
          prNumber: 7,
        };
        const valid = await tools?.github_pr_monitor_read?.handler?.(input);
        expect(valid?.isError).not.toBe(true);
        const snapshot = (((valid?.structuredContent?.prs as unknown[] | undefined)?.[0]) ?? {}) as Record<string, unknown>;
        const thread = ((snapshot.reviewThreads as Record<string, unknown>).nodes as unknown[])[0] as Record<string, unknown>;
        const comment = ((thread.comments as Record<string, unknown>).nodes as unknown[])[0] as Record<string, unknown>;
        expect(snapshot).toMatchObject({
          baseRepository: { nameWithOwner: "Yeachan-Heo/gajae-code" },
          baseRefName: "main",
          baseRefOid: "1111111111111111111111111111111111111111",
        });
        expect(comment).toMatchObject({
          id: "comment-1",
          author: { login: "reviewer", __typename: "User" },
          authorAssociation: "MEMBER",
          path: "packages/demo/src/file.ts",
          startLine: 1,
          line: 1,
          outdated: false,
          commit: { oid: headSha },
          replacement: "const safe = true;",
        });
        expect(comment.body).toBeUndefined();
        expect(comment.diffHunk).toBeUndefined();
        expect(JSON.stringify(snapshot)).not.toContain("ignore hostile body");
        expect(JSON.stringify(snapshot)).not.toContain("source-secret");
        await writeFile(modePath, "projection", "utf8");
        const projection = await tools?.github_pr_monitor_read?.handler?.({
          ...input,
          runId: "snapshot-projection-run",
          actionPlanId: "snapshot-projection-plan",
        });
        expect(projection?.isError).not.toBe(true);
        const projectionSnapshot = (((projection?.structuredContent?.prs as unknown[] | undefined)?.[0]) ?? {}) as Record<string, unknown>;
        expect(projectionSnapshot.reviews).toHaveLength(1);
        expect(projectionSnapshot.latestReviews).toHaveLength(1);

        await writeFile(modePath, "projection-conflict", "utf8");
        const conflictingProjection = await tools?.github_pr_monitor_read?.handler?.({
          ...input,
          runId: "snapshot-projection-conflict-run",
          actionPlanId: "snapshot-projection-conflict-plan",
        });
        expect(conflictingProjection?.isError).toBe(true);
        expect(conflictingProjection?.structuredContent?.error).toContain("duplicate");

        await writeFile(modePath, "head-extra", "utf8");
        const extraHeadRejected = await tools?.github_pr_monitor_read?.handler?.({
          ...input,
          runId: "snapshot-extra-head-rejected-run",
          actionPlanId: "snapshot-extra-head-rejected-plan",
        });
        expect(extraHeadRejected?.isError).toBe(true);
        expect(extraHeadRejected?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
        expect(extraHeadRejected?.structuredContent?.error).toContain("head repository");

        await writeFile(modePath, "fork", "utf8");
        const forkRejected = await tools?.github_pr_monitor_read?.handler?.({
          ...input,
          runId: "snapshot-fork-rejected-run",
          actionPlanId: "snapshot-fork-rejected-plan",
        });
        expect(forkRejected?.isError).toBe(true);
        expect(forkRejected?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
        expect(forkRejected?.structuredContent?.error).toContain("head repository");
        await writeFile(modePath, "missing-base", "utf8");
        const rejected = await tools?.github_pr_monitor_read?.handler?.({
          ...input,
          runId: "snapshot-boundary-rejected-run",
          actionPlanId: "snapshot-boundary-rejected-plan",
        });
        expect(rejected?.isError).toBe(true);
        expect(rejected?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
        expect(rejected?.structuredContent?.error).toContain("base");
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
    it.each([undefined, "invalid"])("fails closed for absent or unknown monitor rollout (%s)", async (rollout) => {
      if (rollout === undefined) delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
      else process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = rollout;
      const server = await createServer(makeCtx());
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
        const server = await createServer(ctx);
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
        const server = await createServer(ctx);
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
        const restarted = await createServer({ ...ctx, registry: [...ctx.registry] });
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

        const crashRestart = await createServer({ ...ctx, registry: [...ctx.registry] });
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
          const server = await createServer({ ...ctx, registry: [...ctx.registry] });
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
          const server = await createServer({ ...ctx, registry: [...ctx.registry] });
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
    it("binds verification to the exact fresh Action response and tested HEAD/tree, consumes it, then recovers a stranded push without pushing twice", async () => {
      const workspaceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-verification-receipt-")));
      const repositoryRoot = path.join(workspaceRoot, "gajae-code");
      const preparedRoot = path.join(workspaceRoot, "prepared");
      const stateDir = path.join(workspaceRoot, "state");
      const binDir = path.join(workspaceRoot, "fake-bin");
      const remoteHeadState = path.join(workspaceRoot, "remote-head-state");
      const pushLog = path.join(workspaceRoot, "push-invocations.jsonl");
      const stagingRefState = path.join(workspaceRoot, "staging-ref-state");
      const originalPath = process.env.PATH;
      const originalDateNow = Date.now;
      const originalComplete = ActionReceiptAuthority.prototype.completeMutationOutcome;

      try {
        await mkdir(repositoryRoot, { recursive: true });
        await fixtureGit(repositoryRoot, ["init", "--quiet"]);
        await fixtureGit(repositoryRoot, ["remote", "add", "origin", "git@github.com:Yeachan-Heo/gajae-code.git"]);
        await fixtureGit(repositoryRoot, ["remote", "add", "upstream", "https://github.com/Yeachan-Heo/gajae-code.git"]);
        await mkdir(path.join(preparedRoot, "packages", "fixture"), { recursive: true });
        await mkdir(binDir, { recursive: true });
        await fixtureGit(preparedRoot, ["init", "--quiet"]);
        await writeFile(path.join(preparedRoot, "packages", "fixture", "value.ts"), "old\n", "utf8");
        await writeFile(
          path.join(preparedRoot, "package.json"),
          JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"", inspect: "node -e \"process.exit(0)\"" } }),
          "utf8",
        );
        await fixtureGit(preparedRoot, ["add", "-A"]);
        await fixtureGit(preparedRoot, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base"]);
        await fixtureGit(preparedRoot, ["remote", "add", "origin", "git@github.com:Yeachan-Heo/gajae-code.git"]);
        await fixtureGit(preparedRoot, ["remote", "add", "upstream", "https://github.com/Yeachan-Heo/gajae-code.git"]);
        const remoteHeadSha = await fixtureGit(preparedRoot, ["rev-parse", "HEAD"]);
        const baseTreeSha = await fixtureGit(preparedRoot, ["rev-parse", "HEAD^{tree}"]);
        const projectId = `pr-7-${remoteHeadSha}`;
        const monitorRoot = path.join(
          workspaceRoot,
          "gajae-code-pr-monitor-pr-worktrees",
          "Yeachan-Heo--gajae-code",
          projectId,
        );
        await mkdir(path.dirname(monitorRoot), { recursive: true });
        await rename(preparedRoot, monitorRoot);

        const taskDigest = "c".repeat(64);
        const logicalIdentity = "d".repeat(64);
        const changedPaths = ["packages/fixture/value.ts"];
        const suggestions = [{
          threadId: "thread-7",
          commentId: "comment-7",
          reviewer: "reviewer-7",
          path: changedPaths[0],
          startLine: 1,
          line: 1,
          expectedOriginal: "old",
          replacement: "new",
          sourceDigest: createHash("sha256").update("old").digest("hex"),
        }];
        await writeFile(path.join(monitorRoot, changedPaths[0]), "new\n", "utf8");
        await fixtureGit(monitorRoot, ["add", "--", changedPaths[0]]);
        const testedTreeSha = await fixtureGit(monitorRoot, ["write-tree"]);
        const commitSeed = createHash("sha256").update(`${logicalIdentity}:${taskDigest}`, "utf8").digest();
        const commitDate = `@${946_684_800 + (commitSeed.readUInt32BE(0) % 946_080_000)} +0000`;
        const message = `Apply authorized PR suggestions\n\nGJC-Logical-Identity: ${logicalIdentity}\nGJC-Plan-Digest: ${taskDigest}`;
        const testedHeadSha = await fixtureGit(monitorRoot, ["commit-tree", testedTreeSha, "-p", remoteHeadSha, "-m", message], {
          GIT_AUTHOR_NAME: "gajae-code[bot]",
          GIT_AUTHOR_EMAIL: "gajae-code[bot]@users.noreply.github.com",
          GIT_AUTHOR_DATE: commitDate,
          GIT_COMMITTER_NAME: "gajae-code[bot]",
          GIT_COMMITTER_EMAIL: "gajae-code[bot]@users.noreply.github.com",
          GIT_COMMITTER_DATE: commitDate,
        });
        const changedHeadSha = await fixtureGit(monitorRoot, ["commit-tree", baseTreeSha, "-p", remoteHeadSha, "-m", "drift"], {
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.invalid",
          GIT_AUTHOR_DATE: "@1000000001 +0000",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.invalid",
          GIT_COMMITTER_DATE: "@1000000001 +0000",
        });
        const changedTreeSha = "4".repeat(40);
        await fixtureGit(monitorRoot, ["update-ref", "refs/heads/artifact", testedHeadSha]);
        const artifactDir = path.join(stateDir, "monitor-artifacts", "a".repeat(64));
        await mkdir(artifactDir, { recursive: true });
        const bundlePath = path.join(artifactDir, "result.bundle");
        await fixtureGit(monitorRoot, ["bundle", "create", bundlePath, "refs/heads/artifact", `^${remoteHeadSha}`]);
        const bundleSha256 = createHash("sha256").update(await readFile(bundlePath)).digest("hex");
        await writeFile(path.join(artifactDir, "manifest.json"), `${JSON.stringify({
          version: 1,
          headSha: testedHeadSha,
          treeSha: testedTreeSha,
          baseHeadSha: remoteHeadSha,
          changedPaths,
          taskDigest,
          logicalIdentity,
          bundleSha256,
        })}\n`, "utf8");
        await fixtureGit(monitorRoot, ["reset", "--hard", remoteHeadSha]);
        await writeFile(remoteHeadState, remoteHeadSha, "utf8");

        await writeFile(
          path.join(binDir, "gh"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const graphqlArg = args.find((arg) => arg.startsWith("query="));
if (args.includes("graphql")) {
  const query = graphqlArg ?? args.join(" ");
  if (query.includes("updateRefs")) {
    const target = query.match(/afterOid:"([0-9a-f]{40})"/);
    if (!target) process.exit(2);
    fs.writeFileSync(${JSON.stringify(remoteHeadState)}, target[1]);
    fs.rmSync(${JSON.stringify(stagingRefState)}, { force: true });
    console.log(JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }));
  } else if (query.includes("reviewThreads")) {
    console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: [], pageInfo: { hasNextPage: false, endCursor: null }
    } } } } }));
  } else {
    console.log(JSON.stringify({ data: { repository: { id: "repo-node-id" } } }));
  }
} else
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
    headRefOid: fs.readFileSync(${JSON.stringify(remoteHeadState)}, "utf8").trim(),
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
        const realGit = (await execFileAsync("/usr/bin/which", ["git"])).stdout.trim();
        await writeFile(
          path.join(binDir, "git"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("ls-remote") && args.includes("git@github.com:Yeachan-Heo/gajae-code.git")) {
  const ref = String(args.at(-1));
  if (ref.includes("gajae-code-monitor/")) {
    if (fs.existsSync(${JSON.stringify(stagingRefState)})) {
      console.log(String(fs.readFileSync(${JSON.stringify(stagingRefState)}, "utf8")).trim() + "\\t" + ref);
    }
  } else {
    console.log(String(fs.readFileSync(${JSON.stringify(remoteHeadState)}, "utf8")).trim() + "\\t" + ref);
  }
  process.exit(0);
}
if (args.includes("push") && args.includes("git@github.com:Yeachan-Heo/gajae-code.git")) {
  fs.appendFileSync(${JSON.stringify(pushLog)}, JSON.stringify(args) + "\\n");
  const refspec = String(args.at(-1));
  const [head, ref] = refspec.split(":");
  if (ref.includes("gajae-code-monitor/")) {
    fs.writeFileSync(${JSON.stringify(stagingRefState)}, head);
  } else {
    fs.writeFileSync(${JSON.stringify(remoteHeadState)}, head);
  }
  process.exit(0);
}
const result = spawnSync(${JSON.stringify("__REAL_GIT__")}.replace("__REAL_GIT__", ${JSON.stringify(realGit)}), args, { stdio: "inherit", env: process.env });
process.exit(result.status === null ? 1 : result.status);
`,
          { mode: 0o755 },
        );
        await writeFile(path.join(binDir, "npm"), MONITOR_CLAIM_FAKE, { mode: 0o755 });
        process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;


        const ctx = makeCtx();
        ctx.workspaceRoot = workspaceRoot;
        ctx.config.workspaceRoot = workspaceRoot;
        ctx.stateDir = stateDir;
        ctx.config.stateDir = stateDir;
        ctx.registry = [
          { projectId: "repository", name: "gajae-code", root: repositoryRoot, aliases: [] },
          { projectId, name: projectId, root: monitorRoot, aliases: [] },
        ];
        ctx.store.getSession = async () => ({
          activeProjectId: projectId,
          mode: "verify",
          lease: {
            projectId,
            leaseId: "lease-verification",
            projectRoot: monitorRoot,
            preset: "tests-only",
            issuedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
        });
        await seedPlanBinding(ctx.stateDir, "run-verification", "plan-verification");
        const server = await createServer(ctx);
        const tools = (server as unknown as {
          _registeredTools?: Record<string, {
            handler?: (input: unknown) => Promise<{
              isError?: boolean;
              content?: Array<{ type: string; text?: string }>;
              structuredContent?: Record<string, unknown>;
            }>;
          }>;
        })._registeredTools;
        const commandInput = { projectId, commandId: "npm:test" };
        const pushInput = {
          runId: "run-verification",
          actionPlanId: "plan-verification",
          idempotencyKey: "idem-verification",
          eventId: "event-verification",
          repository: "Yeachan-Heo/gajae-code",
          author: "twoimo",
          prNumber: 7,
          expectedHeadSha: remoteHeadSha,
          operation: "push_prepared_worktree",
          worktreePath: monitorRoot,
          headRef: "feature/strict-actions",
        };
        let executeReceiptSequence = 0;
        async function issueExecuteReceipt(): Promise<Record<string, unknown>> {
          executeReceiptSequence += 1;
          const issuedAt = Date.now();
          const input = {
            runId: pushInput.runId,
            actionPlanId: pushInput.actionPlanId,
            idempotencyKey: `execute-verification-${executeReceiptSequence}`,
            eventId: `execute-event-${executeReceiptSequence}`,
            repository: pushInput.repository,
            author: pushInput.author,
            prNumber: pushInput.prNumber,
            expectedHeadSha: pushInput.expectedHeadSha,
            operation: "apply_suggestions",
            worktreePath: pushInput.worktreePath,
            headRef: pushInput.headRef,
            ociImageDigest: `sha256:${"a".repeat(64)}`,
            suggestions,
          };
          const receiptId = createHash("sha256").update(`execute:${executeReceiptSequence}:${issuedAt}`).digest("hex");
          const structuredContent = {
            receiptId,
            namespace: "ChatGPT_To_Codex",
            tool: "github_pr_monitor_execute",
            operation: "apply_suggestions",
            ok: true,
            runId: input.runId,
            actionPlanId: input.actionPlanId,
            idempotencyKey: input.idempotencyKey,
            eventId: input.eventId,
            repository: input.repository,
            author: input.author,
            prNumber: input.prNumber,
            expectedHeadSha: input.expectedHeadSha,
            oldHeadSha: input.expectedHeadSha,
            newHeadSha: testedHeadSha,
            worktreePath: input.worktreePath,
            headRef: input.headRef,
            artifactDir,
            bundleSha256,
            baseTreeSha,
            taskDigest,
            logicalIdentity,
            changedPaths,
            projectId,
            commandId: "github_pr_monitor_execute",
            riskTier: "verify",
            args: ["bun", "test"],
            exitCode: 0,
            headSha: testedHeadSha,
            treeSha: testedTreeSha,
            remoteObject: { kind: "local_commit", worktreePath: input.worktreePath, headSha: testedHeadSha, treeSha: testedTreeSha },
            issuedAt,
            timestamp: new Date(issuedAt).toISOString(),
          };
          const response = {
            ok: true,
            tool: "github_pr_monitor_execute",
            toolCall: { namespace: "ChatGPT_To_Codex", ok: true, toolName: "github_pr_monitor_execute", input },
            text: "Applied and verified exact suggestions.",
            imageMarkdownList: [],
            structuredContent,
          };
          await new ActionReceiptAuthority(ctx.stateDir).issue({
            receiptId,
            kind: "verification",
            response,
            input,
            issuedAt,
            metadata: {
              projectId,
              commandId: "github_pr_monitor_execute",
              riskTier: "verify",
              args: ["bun", "test"],
              headSha: testedHeadSha,
              treeSha: testedTreeSha,
              artifactDir,
              bundleSha256,
              baseTreeSha,
            },
          });
          return response;
        }

        async function issueVerificationReceipt(command: Record<string, unknown> = commandInput): Promise<Record<string, unknown>> {
          const commandResult = await tools?.command_run?.handler?.(command);
          expect(commandResult?.isError, JSON.stringify(commandResult?.structuredContent)).toBeUndefined();
          const structured = commandResult?.structuredContent as Record<string, unknown>;
          const proof = structured.chatgpt2codexToolCall as Record<string, unknown>;
          return {
            ok: true,
            tool: "command_run",
            toolCall: { ...proof, toolName: "command_run", input: command },
            text: commandResult?.content?.[0]?.text,
            imageMarkdownList: [],
            structuredContent: structured,
          };
        }

        let mutationAttempt = 0;
        async function pushWith(receipt: Record<string, unknown>, replayAttempt?: number) {
          if (replayAttempt === undefined) mutationAttempt += 1;
          const attempt = replayAttempt ?? mutationAttempt;
          return tools?.github_pr_monitor_mutate?.handler?.(authorizedMonitorInput({
            ...pushInput,
            idempotencyKey: `${pushInput.idempotencyKey}-${attempt}`,
            eventId: `${pushInput.eventId}-${attempt}`,
            verificationReceipt: receipt,
          }));
        }

        const nonVerificationReceipt = await issueVerificationReceipt({ projectId, commandId: "npm:inspect" });
        expect(nonVerificationReceipt.structuredContent).toMatchObject({ riskTier: "read" });
        const nonVerificationPush = await pushWith(nonVerificationReceipt);
        expect(nonVerificationPush?.isError).toBe(true);
        expect(nonVerificationPush?.structuredContent?.error).toContain("github_pr_monitor_execute verification ActionToolResponse");
        const staleReceipt = await issueExecuteReceipt();
        const issuedAt = (staleReceipt.structuredContent as Record<string, unknown>).issuedAt as number;
        Date.now = () => issuedAt + 11 * 60 * 1000;
        const staleResult = await pushWith(staleReceipt);
        expect(staleResult?.isError).toBe(true);
        expect(staleResult?.structuredContent?.error).toContain("github_pr_monitor_execute verification ActionToolResponse");
        Date.now = originalDateNow;

        const verificationReceipt = await issueExecuteReceipt();
        expect(verificationReceipt.structuredContent).toMatchObject({
          headSha: testedHeadSha,
          treeSha: testedTreeSha,
          riskTier: "verify",
          args: ["bun", "test"],
          issuedAt: expect.any(Number),
        });
        await fixtureGit(monitorRoot, ["update-ref", "HEAD", changedHeadSha]);
        const changedHeadResult = await pushWith(verificationReceipt);
        expect(changedHeadResult?.isError, "HEAD").toBe(true);
        expect(changedHeadResult?.structuredContent?.error, "HEAD").toMatch(/HEAD|tree drift/);
        await fixtureGit(monitorRoot, ["update-ref", "HEAD", remoteHeadSha]);
        await writeFile(path.join(monitorRoot, changedPaths[0]), "dirty\n", "utf8");
        const changedTreeResult = await pushWith(verificationReceipt);
        expect(changedTreeResult?.isError, "tree").toBe(true);
        expect(changedTreeResult?.structuredContent?.error, "tree").toMatch(/HEAD|tree drift/);
        await fixtureGit(monitorRoot, ["checkout", "--", changedPaths[0]]);

        for (const [label, rewrite] of [
          ["outer.text", (receipt: Record<string, unknown>) => { receipt.text = "forged"; }],
          ["outer.extra", (receipt: Record<string, unknown>) => { receipt.extra = true; }],
          ["toolCall.input", (receipt: Record<string, unknown>) => {
            ((receipt.toolCall as Record<string, unknown>).input as Record<string, unknown>).commandId = "npm:foreign";
          }],
          ["project transplant", (receipt: Record<string, unknown>) => {
            ((receipt.toolCall as Record<string, unknown>).input as Record<string, unknown>).projectId = "foreign-project";
            (receipt.structuredContent as Record<string, unknown>).projectId = "foreign-project";
          }],
          ["structuredContent.stdoutSummary", (receipt: Record<string, unknown>) => {
            (receipt.structuredContent as Record<string, unknown>).stdoutSummary = "forged";
          }],
          ["structuredContent.treeSha", (receipt: Record<string, unknown>) => {
            (receipt.structuredContent as Record<string, unknown>).treeSha = changedTreeSha;
          }],
        ] as const) {
          const rewritten = structuredClone(verificationReceipt);
          rewrite(rewritten);
          const result = await pushWith(rewritten);
          expect(result?.isError, label).toBe(true);
          expect(result?.structuredContent?.code, label).toBe("APPROVAL_REQUIRED");
          expect(result?.structuredContent?.error, label).toContain("exact");
        }
        const verificationReceiptId = String(
          (verificationReceipt.structuredContent as Record<string, unknown>).receiptId,
        );
        const pristineVerificationDocument = withActionReceiptDatabase(ctx.stateDir, (database) =>
          String(database.prepare("SELECT document FROM receipts WHERE receipt_id = ?")
            .get(verificationReceiptId)?.document ?? ""));
        const tamperedVerificationDocument = JSON.parse(pristineVerificationDocument) as {
          metadata: { headSha: string; treeSha: string };
        };
        tamperedVerificationDocument.metadata.headSha = changedHeadSha;
        tamperedVerificationDocument.metadata.treeSha = changedTreeSha;
        withActionReceiptDatabase(ctx.stateDir, (database) => {
          database.prepare("UPDATE receipts SET document = ? WHERE receipt_id = ?")
            .run(JSON.stringify(tamperedVerificationDocument), verificationReceiptId);
        });
        const metadataTamperResult = await pushWith(verificationReceipt);
        expect(metadataTamperResult?.isError).toBe(true);
        expect(metadataTamperResult?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
        expect(metadataTamperResult?.structuredContent?.error).toContain(
          "metadata is not bound to its exact command response",
        );
        withActionReceiptDatabase(ctx.stateDir, (database) => {
          database.prepare("UPDATE receipts SET document = ? WHERE receipt_id = ?")
            .run(pristineVerificationDocument, verificationReceiptId);
        });

        const pushed = await pushWith(verificationReceipt);
        expect(pushed?.isError, JSON.stringify(pushed?.structuredContent)).toBeUndefined();
        const pushedAttempt = mutationAttempt;
        await writeFile(remoteHeadState, remoteHeadSha, "utf8");
        const replayed = await pushWith(verificationReceipt, pushedAttempt);
        expect(replayed?.isError, JSON.stringify(replayed?.structuredContent)).toBeUndefined();
        expect(replayed?.structuredContent).toMatchObject({
          operation: "push_prepared_worktree",
          oldHeadSha: remoteHeadSha,
          newHeadSha: testedHeadSha,
        });
        const reboundIdentity = await pushWith(verificationReceipt);
        expect(reboundIdentity?.isError, JSON.stringify(reboundIdentity?.structuredContent)).toBe(true);
        expect(reboundIdentity?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
        expect(reboundIdentity?.structuredContent?.error).toContain("github_pr_monitor_execute verification ActionToolResponse");
        const pushCount = async (): Promise<number> =>
          (await readFile(pushLog, "utf8").catch(() => ""))
            .split("\n")
            .filter((line) => line.trim()).length;
        const strandNextOutcome = (): void => {
          let strand = true;
          ActionReceiptAuthority.prototype.completeMutationOutcome = async function (...args) {
            if (strand) {
              strand = false;
              throw new Error("injected crash after the push landed before outcome completion");
            }
            return originalComplete.apply(this, args);
          };
        };

        // The push landed on the fixed remote, then the durable outcome was lost.
        expect(await readFile(remoteHeadState, "utf8")).toBe(remoteHeadSha);
        const recoveryReceipt = await issueExecuteReceipt();
        const beforeStrandedPush = await pushCount();
        strandNextOutcome();
        const lostPush = await pushWith(recoveryReceipt);
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        const strandedAttempt = mutationAttempt;
        expect(lostPush?.isError).toBe(true);
        expect(await pushCount()).toBe(beforeStrandedPush + 1);
        expect(await readFile(remoteHeadState, "utf8")).toBe(testedHeadSha);
        const delayedRecoveryNow = Number(
          (recoveryReceipt.structuredContent as Record<string, unknown>).issuedAt,
        ) + 11 * 60 * 1000;
        Date.now = () => delayedRecoveryNow;

        const recoveredPush = await pushWith(recoveryReceipt, strandedAttempt);
        Date.now = originalDateNow;
        expect(recoveredPush?.isError, JSON.stringify(recoveredPush?.structuredContent)).toBeUndefined();
        expect(recoveredPush?.structuredContent).toMatchObject({
          operation: "push_prepared_worktree",
          oldHeadSha: remoteHeadSha,
          newHeadSha: testedHeadSha,
          remoteObject: {
            headRefOid: testedHeadSha,
            headRefName: "feature/strict-actions",
          },
        });
        expect(await pushCount()).toBe(beforeStrandedPush + 1);
        const replayedRecoveredPush = await pushWith(recoveryReceipt, strandedAttempt);
        expect(replayedRecoveredPush?.structuredContent).toEqual(recoveredPush?.structuredContent);
        expect(replayedRecoveredPush?.content).toEqual(recoveredPush?.content);
        expect(await pushCount()).toBe(beforeStrandedPush + 1);

        // A remote head equal to neither the pushed local commit nor the
        // expected pre-push head is not evidence of this intent's push.
        await writeFile(remoteHeadState, remoteHeadSha, "utf8");
        const ambiguousReceipt = await issueExecuteReceipt();
        const beforeAmbiguousPush = await pushCount();
        strandNextOutcome();
        const lostAmbiguousPush = await pushWith(ambiguousReceipt);
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        const ambiguousAttempt = mutationAttempt;
        expect(lostAmbiguousPush?.isError).toBe(true);
        expect(await pushCount()).toBe(beforeAmbiguousPush + 1);

        await writeFile(remoteHeadState, "5555555555555555555555555555555555555555", "utf8");
        const ambiguousPush = await pushWith(ambiguousReceipt, ambiguousAttempt);
        expect(ambiguousPush?.isError).toBe(true);
        expect(ambiguousPush?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
        expect(ambiguousPush?.structuredContent?.error).toBe(
          "Pending push intent has ambiguous remote-head evidence",
        );
        expect(await pushCount()).toBe(beforeAmbiguousPush + 1);
      } finally {
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        Date.now = originalDateNow;
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
        const firstServer = await createServer(ctx);
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

        const restartedServer = await createServer({ ...ctx, registry: [...ctx.registry] });
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

        const effectRestart = await createServer({ ...ctx, registry: [...ctx.registry] });
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
    it("bounds monitor IPC and rejects malformed, multiple, oversized, and timed-out JSON output", async () => {
      const workspaceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "chatgpt2codex-monitor-bounds-")));
      const binDir = path.join(workspaceRoot, "bin");
      const modePath = path.join(workspaceRoot, "mode");
      const originalPath = process.env.PATH;
      try {
        await mkdir(binDir);
        await writeFile(
          path.join(binDir, "npm"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const mode = fs.readFileSync(${JSON.stringify(modePath)}, "utf8").trim();
if (mode === "malformed") process.stdout.write("{");
else if (mode === "multiple") process.stdout.write("{}\\n{}\\n");
else if (mode === "oversized") process.stdout.write("x".repeat(257 * 1024));
else if (mode === "timeout") { process.on("SIGTERM", () => {}); setInterval(() => {}, 60_000); }
else if (mode === "mismatch") process.stdout.write(JSON.stringify({ command: "terminal-report", proof: "ChatGPT_To_Codex", ok: true, protocolVersion: 1, schemaVersion: 4, requestDigest: ${JSON.stringify(createHash("sha256").update(canonicalTestJson({ runId: "run-bounds", actionPlanId: "plan-bounds" })).digest("hex"))}, runId: "run-bounds", actionPlanId: "foreign-plan", status: {} }) + "\\n");
`,
          { mode: 0o755 },
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
        const ctx = makeCtx();
        ctx.stateDir = path.join(workspaceRoot, "state");
        ctx.config.stateDir = ctx.stateDir;
        const server = await createServer(ctx);
        const tool = (server as unknown as {
          _registeredTools?: Record<string, {
            handler?: (input: unknown) => Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }>;
          }>;
        })._registeredTools?.github_pr_monitor_state;
        for (const [mode, expected] of [
          ["malformed", /exactly one JSON/],
          ["multiple", /exactly one JSON/],
          ["oversized", /stdout exceeded 256KiB.*reaped/],
          ["timeout", /timed out.*reaped/],
          ["mismatch", /did not exactly bind/],
        ] as const) {
          await writeFile(modePath, mode, "utf8");
          const result = await tool?.handler?.({
            runId: "run-bounds",
            actionPlanId: "plan-bounds",
            idempotencyKey: "idem-bounds",
            eventId: "event-bounds",
            command: "terminal-report",
            input: {},
          });
          expect(result?.isError, mode).toBe(true);
          expect(result?.structuredContent?.error, mode).toMatch(expected);
        }
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    }, 25_000);

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
