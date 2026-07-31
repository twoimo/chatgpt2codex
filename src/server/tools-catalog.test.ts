import { afterEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "./mcp-server.js";
import { ActionReceiptAuthority } from "./action-receipts.js";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";

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

function durableOutcomeBinding(
  index: number,
  overrides: { idempotencyKey?: string; claimId?: string; body?: string } = {},
) {
  const idempotencyKey = overrides.idempotencyKey ?? `idem-retention-${index}`;
  const body = overrides.body ?? `reply-${index}`;
  const claim = {
    runId: `run-retention-${index}`,
    actionPlanId: `plan-retention-${index}`,
    idempotencyKey,
    repository: "Yeachan-Heo/gajae-code" as const,
    prNumber: 7,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    phase: "mutate" as const,
    operation: "post_reply" as const,
    operationFields: { body },
  };
  const input = {
    runId: claim.runId,
    actionPlanId: claim.actionPlanId,
    idempotencyKey,
    eventId: `event-retention-${index}`,
    repository: claim.repository,
    author: "twoimo" as const,
    prNumber: claim.prNumber,
    expectedHeadSha: claim.headSha,
    operation: claim.operation,
    body,
  };
  return {
    runId: claim.runId,
    coordinationId: `coordination-retention-${index}`,
    actionPlanId: claim.actionPlanId,
    idempotencyKey,
    claimId: overrides.claimId ?? `claim-retention-${index}`,
    claimPayloadDigest: createHash("sha256").update(canonicalTestJson(claim)).digest("hex"),
    repository: claim.repository,
    author: "twoimo" as const,
    prNumber: claim.prNumber,
    expectedHeadSha: claim.headSha,
    eventId: input.eventId,
    phase: claim.phase,
    operation: claim.operation,
    operationFields: claim.operationFields,
    input,
  };
}

function durableReviewerBinding(index: number, reviewer = `reviewer-${index}`) {
  const idempotencyKey = `idem-reviewer-retention-${index}`;
  const claim = {
    runId: `run-reviewer-retention-${index}`,
    actionPlanId: `plan-reviewer-retention-${index}`,
    idempotencyKey,
    repository: "Yeachan-Heo/gajae-code" as const,
    prNumber: 7,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    phase: "mutate" as const,
    operation: "rerequest_reviewer" as const,
    operationFields: { reviewer },
  };
  const input = {
    runId: claim.runId,
    actionPlanId: claim.actionPlanId,
    idempotencyKey,
    eventId: `event-reviewer-retention-${index}`,
    repository: claim.repository,
    author: "twoimo" as const,
    prNumber: claim.prNumber,
    expectedHeadSha: claim.headSha,
    operation: claim.operation,
    reviewer,
  };
  return {
    runId: claim.runId,
    coordinationId: `coordination-reviewer-retention-${index}`,
    actionPlanId: claim.actionPlanId,
    idempotencyKey,
    claimId: `claim-reviewer-retention-${index}`,
    claimPayloadDigest: createHash("sha256").update(canonicalTestJson(claim)).digest("hex"),
    repository: claim.repository,
    author: "twoimo" as const,
    prNumber: claim.prNumber,
    expectedHeadSha: claim.headSha,
    eventId: input.eventId,
    phase: claim.phase,
    operation: claim.operation,
    operationFields: claim.operationFields,
    input,
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
  console.log(JSON.stringify({
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
    afterEach(() => {
      delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
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
      const tools = (server as unknown as { _registeredTools?: Record<string, { annotations?: Record<string, unknown>; inputSchema?: { shape?: Record<string, unknown> } }> })._registeredTools;
      expect(tools?.github_pr_monitor_read?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tools?.github_pr_monitor_prepare?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      expect(tools?.github_pr_monitor_prepare?.inputSchema?.shape?.operation).toBeDefined();
      expect(tools?.github_pr_monitor_prepare?.inputSchema?.shape?.expectedHeadSha).toBeDefined();
      expect(tools?.github_pr_monitor_prepare?.inputSchema?.shape?.headRef).toBeDefined();
      expect(tools?.github_pr_monitor_prepare?.inputSchema?.shape?.repository).toBeDefined();
      expect(tools?.github_pr_monitor_state?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      expect(tools?.github_pr_monitor_state?.inputSchema?.shape?.command).toBeDefined();
      expect(tools?.github_pr_monitor_state?.inputSchema?.shape?.input).toBeDefined();
      expect(tools?.github_pr_monitor_mutate?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tools?.github_pr_monitor_mutate?.inputSchema?.shape?.operation).toBeDefined();
      expect(tools?.github_pr_monitor_mutate?.inputSchema?.shape?.command).toBeUndefined();
      expect(tools?.github_pr_monitor_mutate?.inputSchema?.shape?.repository).toBeDefined();
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
    headRefName: "feature/strict-actions",
    headRefOid: "0123456789abcdef0123456789abcdef01234567"
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
    ? "git@github.com:twoimo/gajae-code.git"
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
        const result = await tools?.github_pr_monitor_prepare?.handler?.({
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
        });

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
    headRefName: "feature/strict-actions",
    headRefOid: ${JSON.stringify(expectedHeadSha)}
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
    ? "git@github.com:twoimo/gajae-code.git"
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
          return tools?.github_pr_monitor_prepare?.handler?.({
            runId: `run-quarantine-${prNumber}`,
            actionPlanId: `plan-quarantine-${prNumber}`,
            idempotencyKey: `idem-quarantine-${prNumber}`,
            eventId: `event-quarantine-${prNumber}`,
            repository: "Yeachan-Heo/gajae-code",
            author: "twoimo",
            prNumber,
            expectedHeadSha,
            operation: "quarantine",
          });
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
        const recoveredMoved = await restartedTools?.github_pr_monitor_prepare?.handler?.({
          runId: "run-quarantine-7",
          actionPlanId: "plan-quarantine-7",
          idempotencyKey: "idem-quarantine-7",
          eventId: "event-quarantine-7",
          repository: "Yeachan-Heo/gajae-code",
          author: "twoimo",
          prNumber: 7,
          expectedHeadSha,
          operation: "quarantine",
        });
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
        const lostPrepareResponse = await tools?.github_pr_monitor_prepare?.handler?.(crashInput);
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
        const recoveredPrepare = await crashRestartTools?.github_pr_monitor_prepare?.handler?.(crashInput);
        const replayedPrepare = await crashRestartTools?.github_pr_monitor_prepare?.handler?.(crashInput);
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
    headRefName: "feature/strict-actions",
    headRefOid: ${JSON.stringify(expectedHeadSha)}
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
    ? "git@github.com:twoimo/gajae-code.git"
    : "https://github.com/Yeachan-Heo/gajae-code.git");
} else if (args.includes("--show-toplevel")) {
  console.log(cwd);
} else if (args.includes("status")) {
  console.log(fs.readFileSync(${JSON.stringify(dirtyState)}, "utf8"));
} else if (args.includes("cat-file")) {
  process.exit(0);
} else if (args.at(-1) === "HEAD") {
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
        const lostCreate = await (await monitorTools())?.github_pr_monitor_prepare?.handler?.(createInput(7));
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        expect(lostCreate?.isError).toBe(true);
        expect((await lstat(recoveredWorktree)).isDirectory()).toBe(true);
        expect(await worktreeAddCount(7)).toBe(1);

        const restartedTools = await monitorTools();
        const recoveredCreate = await restartedTools?.github_pr_monitor_prepare?.handler?.(createInput(7));
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
        const replayedCreate = await restartedTools?.github_pr_monitor_prepare?.handler?.(createInput(7));
        expect(replayedCreate?.structuredContent).toEqual(recoveredCreate?.structuredContent);
        expect(replayedCreate?.content).toEqual(recoveredCreate?.content);
        expect(await worktreeAddCount(7)).toBe(1);

        // Non-exact worktree evidence must never be accepted as the intent's effect.
        await seedPlanBinding(ctx.stateDir, "run-create-8", "plan-create-8");
        strandNextOutcome("injected crash after worktree add before outcome completion");
        const lostAmbiguous = await (await monitorTools())?.github_pr_monitor_prepare?.handler?.(createInput(8));
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        expect(lostAmbiguous?.isError).toBe(true);
        expect(await worktreeAddCount(8)).toBe(1);

        await writeFile(dirtyState, " M src/changed.ts\n", "utf8");
        const ambiguousCreate = await (await monitorTools())?.github_pr_monitor_prepare?.handler?.(createInput(8));
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
    headRefName: "feature/strict-actions",
    headRefOid: ${JSON.stringify(expectedHeadSha)}
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
    ? "git@github.com:twoimo/gajae-code.git"
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
          const lost = await (await monitorTools())?.github_pr_monitor_prepare?.handler?.(quarantineInput(prNumber));
          ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
          expect(lost?.isError, `strand pr-${prNumber}`).toBe(true);
          await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
          const moved = await quarantineDirs(prNumber);
          expect(moved, `strand pr-${prNumber}`).toHaveLength(1);
          return { source, destination: path.join(monitorRepositoryRoot, String(moved[0])) };
        };

        const conflicting = await strand(11);
        await mkdir(conflicting.source, { recursive: true });
        const conflictingResult = await (await monitorTools())
          ?.github_pr_monitor_prepare?.handler?.(quarantineInput(11));
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
        const nonDirectoryResult = await (await monitorTools())
          ?.github_pr_monitor_prepare?.handler?.(quarantineInput(12));
        expect(nonDirectoryResult?.isError).toBe(true);
        expect(nonDirectoryResult?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
        expect(nonDirectoryResult?.structuredContent?.error).toBe(
          "Pending quarantine intent destination is not an exact directory",
        );
        expect((await lstat(nonDirectory.destination)).isFile()).toBe(true);

        const absent = await strand(13);
        await rm(absent.destination, { recursive: true, force: true });
        const absentResult = await (await monitorTools())
          ?.github_pr_monitor_prepare?.handler?.(quarantineInput(13));
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
      const remoteHeadSha = "0123456789abcdef0123456789abcdef01234567";
      const testedHeadSha = "1111111111111111111111111111111111111111";
      const testedTreeSha = "2222222222222222222222222222222222222222";
      const changedHeadSha = "3333333333333333333333333333333333333333";
      const changedTreeSha = "4444444444444444444444444444444444444444";
      const projectId = `pr-7-${remoteHeadSha}`;
      const monitorRoot = path.join(
        workspaceRoot,
        "gajae-code-pr-monitor-pr-worktrees",
        "Yeachan-Heo--gajae-code",
        projectId,
      );
      const binDir = path.join(workspaceRoot, "fake-bin");
      const headState = path.join(workspaceRoot, "head-state");
      const treeState = path.join(workspaceRoot, "tree-state");
      const remoteHeadState = path.join(workspaceRoot, "remote-head-state");
      const pushLog = path.join(workspaceRoot, "push-invocations.jsonl");
      const originalPath = process.env.PATH;
      const originalDateNow = Date.now;
      const originalComplete = ActionReceiptAuthority.prototype.completeMutationOutcome;

      try {
        await mkdir(repositoryRoot, { recursive: true });
        await mkdir(monitorRoot, { recursive: true });
        await mkdir(binDir, { recursive: true });
        await writeFile(headState, testedHeadSha, "utf8");
        await writeFile(treeState, testedTreeSha, "utf8");
        await writeFile(remoteHeadState, remoteHeadSha, "utf8");
        await writeFile(
          path.join(monitorRoot, "package.json"),
          JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"", inspect: "node -e \"process.exit(0)\"" } }),
          "utf8",
        );
        await writeFile(
          path.join(binDir, "gh"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") {
  console.log(JSON.stringify({ login: "twoimo" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 7,
    url: "https://github.com/Yeachan-Heo/gajae-code/pull/7",
    state: "OPEN",
    author: { login: "twoimo" },
    headRefName: "feature/strict-actions",
    headRefOid: fs.readFileSync(${JSON.stringify(remoteHeadState)}, "utf8").trim()
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
if (args.includes("get-url")) {
  console.log(args.at(-1) === "origin"
    ? "git@github.com:twoimo/gajae-code.git"
    : "https://github.com/Yeachan-Heo/gajae-code.git");
} else if (args.includes("--show-toplevel")) {
  console.log(cwd);
} else if (args.at(-1) === "HEAD^{tree}") {
  console.log(fs.readFileSync(${JSON.stringify(treeState)}, "utf8").trim());
} else if (args.at(-1) === "HEAD") {
  console.log(fs.readFileSync(${JSON.stringify(headState)}, "utf8").trim());
} else if (args.includes("push")) {
  fs.appendFileSync(${JSON.stringify(pushLog)}, JSON.stringify(args) + "\\n");
  fs.writeFileSync(${JSON.stringify(remoteHeadState)}, fs.readFileSync(${JSON.stringify(headState)}, "utf8"));
}
`,
          { mode: 0o755 },
        );
        await writeFile(
          path.join(binDir, "npm"),
          MONITOR_CLAIM_FAKE,
          { mode: 0o755 },
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

        const ctx = makeCtx();
        ctx.workspaceRoot = workspaceRoot;
        ctx.config.workspaceRoot = workspaceRoot;
        ctx.stateDir = path.join(workspaceRoot, "state");
        ctx.config.stateDir = ctx.stateDir;
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

        async function issueVerificationReceipt(command: Record<string, unknown> = commandInput): Promise<Record<string, unknown>> {
          const commandResult = await tools?.command_run?.handler?.(command);
          expect(commandResult?.isError).toBeUndefined();
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
          return tools?.github_pr_monitor_mutate?.handler?.({
            ...pushInput,
            idempotencyKey: `${pushInput.idempotencyKey}-${attempt}`,
            eventId: `${pushInput.eventId}-${attempt}`,
            verificationReceipt: receipt,
          });
        }

        const nonVerificationReceipt = await issueVerificationReceipt({ projectId, commandId: "npm:inspect" });
        expect(nonVerificationReceipt.structuredContent).toMatchObject({ riskTier: "read" });
        const nonVerificationPush = await pushWith(nonVerificationReceipt);
        expect(nonVerificationPush?.isError).toBe(true);
        expect(nonVerificationPush?.structuredContent?.error).toContain("verify-tier");
        const staleReceipt = await issueVerificationReceipt();
        const issuedAt = (staleReceipt.structuredContent as Record<string, unknown>).issuedAt as number;
        Date.now = () => issuedAt + 11 * 60 * 1000;
        const staleResult = await pushWith(staleReceipt);
        expect(staleResult?.isError).toBe(true);
        expect(staleResult?.structuredContent?.error).toContain("fresh");
        Date.now = originalDateNow;

        const verificationReceipt = await issueVerificationReceipt();
        expect(verificationReceipt.structuredContent).toMatchObject({
          headSha: testedHeadSha,
          treeSha: testedTreeSha,
          riskTier: "verify",
          args: [],
          issuedAt: expect.any(Number),
        });
        for (const [label, statePath, changed, restored] of [
          ["HEAD", headState, changedHeadSha, testedHeadSha],
          ["tree", treeState, changedTreeSha, testedTreeSha],
        ] as const) {
          await writeFile(statePath, changed, "utf8");
          const changedResult = await pushWith(verificationReceipt);
          expect(changedResult?.isError, label).toBe(true);
          expect(changedResult?.structuredContent?.error, label).toMatch(
            /exact prepared monitor worktree path|HEAD or tree changed/,
          );
          await writeFile(statePath, restored, "utf8");
        }

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
        await writeFile(headState, changedHeadSha, "utf8");
        await writeFile(treeState, changedTreeSha, "utf8");
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
        await writeFile(headState, testedHeadSha, "utf8");
        await writeFile(treeState, testedTreeSha, "utf8");

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
        expect(reboundIdentity?.structuredContent?.error).toContain("verify-tier");
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
        const recoveryReceipt = await issueVerificationReceipt();
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
        const ambiguousReceipt = await issueVerificationReceipt();
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
  } else if (command === "claim-action") {
    process.stdout.write(JSON.stringify({
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
      ok: true, command, runId: "run-claim-lifecycle", coordinationId: "bootstrap",
      actionPlanId: input.actionPlanId, idempotencyKey: input.idempotencyKey,
      claimId: input.claimId, claimPayloadDigest: input.payloadDigest,
      requestDigest: digest(input), result: { recorded: true, id: input.id }
    }) + "\\n");
  } else if (command === "reconcile") {
    const receipt = input.evidence[0].structuredContent;
    process.stdout.write(JSON.stringify({
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
const comments = fs.existsSync(commentsPath) ? JSON.parse(fs.readFileSync(commentsPath, "utf8")) : [];
if (args[0] === "api" && args[1] === "user") {
  console.log(JSON.stringify({ login: "twoimo" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 7,
    url: "https://github.com/Yeachan-Heo/gajae-code/pull/7",
    state: "OPEN",
    author: { login: "twoimo" },
    headRefName: "feature/claim-lifecycle",
    headRefOid: ${JSON.stringify(expectedHeadSha)}
  }));
} else if (args[0] === "api" && args[1] === "graphql") {
  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
    nodes: [], pageInfo: { hasNextPage: false, endCursor: null }
  } } } } }));
} else if (args.includes("--paginate")) {
  console.log(JSON.stringify(comments));
} else if (args[1]?.endsWith("/comments")) {
  const bodyArg = args.find((arg) => arg.startsWith("body="));
  const created = {
    id: comments.length + 42,
    html_url: "https://github.com/Yeachan-Heo/gajae-code/pull/7#issuecomment-" + (comments.length + 42),
    body: bodyArg?.slice(5)
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
        };
        const claimInput = {
          runId: mutateInput.runId,
          actionPlanId: mutateInput.actionPlanId,
          idempotencyKey: mutateInput.idempotencyKey,
          repository: mutateInput.repository,
          prNumber: mutateInput.prNumber,
          headSha: expectedHeadSha,
          phase: "mutate",
          operation: mutateInput.operation,
          operationFields: { body: mutateInput.body },
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
        const mutation = await firstTools?.github_pr_monitor_mutate?.handler?.(mutateInput);
        expect(mutation?.isError).toBeUndefined();
        expect(mutation?.structuredContent).toMatchObject({
          claimId: "claim-idem-claim-lifecycle",
          claimedAt: "2026-07-27T12:00:00.000Z",
          payloadDigest,
        });

        const proof = mutation?.structuredContent?.chatgpt2codexToolCall as Record<string, unknown>;
        const actionResponse = {
          ok: true,
          tool: "github_pr_monitor_mutate",
          toolCall: { ...proof, toolName: "github_pr_monitor_mutate", input: mutateInput },
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
          inputDigest: createHash("sha256").update(JSON.stringify(mutateInput)).digest("hex"),
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
            input: mutateInput,
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
        expect(recorded?.isError).toBeUndefined();

        const recordedDocument = withActionReceiptDatabase(stateDir, (database) =>
          String(database.prepare("SELECT document FROM receipts WHERE receipt_id = ?").get(receiptId)?.document ?? ""));
        const recordedStore = readAuthorityDocuments(stateDir);
        expect(recordedStore.receipts.find((receipt) => receipt.receiptId === receiptId)).toMatchObject({ receiptId, phase: "recorded", consumedAt: null });
        const ipcAfterRecord = (await readFile(ipcLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
          args: string[];
          payload: string;
        });
        expect(JSON.parse(ipcAfterRecord[0]?.payload ?? "{}")).toEqual({
          stage: "claim",
          runId: mutateInput.runId,
          coordinationId: "bootstrap",
          requestDigest: payloadDigest,
          actionPlanId: mutateInput.actionPlanId,
          idempotencyKey: mutateInput.idempotencyKey,
        });
        expect(ipcAfterRecord[1]).toEqual({
          args: [
            "run", "--silent", "monitor", "--", "claim-action", "--db",
            "/Users/twoimo/Library/Application Support/GajaeCodePRMonitor/.gajae-pr-monitor.sqlite",
          ],
          payload: claimPayload,
        });
        expect(JSON.parse(ipcAfterRecord[3]?.payload ?? "{}")).toEqual({
          id: receiptId,
          kind: "post_reply",
          idempotencyKey: mutateInput.idempotencyKey,
          actionPlanId: mutateInput.actionPlanId,
          expectedHead: expectedHeadSha,
          claimId: "claim-idem-claim-lifecycle",
          payloadDigest,
          payload: { receiptId },
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
        expect(finalIpc).toHaveLength(5);
        expect(JSON.parse(finalIpc[4]?.payload ?? "{}")).toEqual(reconcileRecovery);

        const recoveredMutation = await restartedTools?.github_pr_monitor_mutate?.handler?.(mutateInput);
        expect(recoveredMutation?.isError).toBeUndefined();
        expect(recoveredMutation?.structuredContent).toEqual(mutation?.structuredContent);

        const commentMutationCount = async (idempotencyKey: string): Promise<number> =>
          (await readFile(ghLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[])
            .filter((args) => args[1]?.endsWith("/comments")
              && !args.includes("--paginate")
              && args.some((arg) => arg.includes(idempotencyKey))).length;
        expect(await commentMutationCount(mutateInput.idempotencyKey)).toBe(1);

        const mismatched = await restartedTools?.github_pr_monitor_mutate?.handler?.({
          ...mutateInput,
          eventId: "event-claim-lifecycle-mismatch",
        });
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
        const crashBoundaryFailure = await restartedTools?.github_pr_monitor_mutate?.handler?.(crashBoundaryInput);
        ActionReceiptAuthority.prototype.completeMutationOutcome = originalComplete;
        expect(crashBoundaryFailure?.isError).toBe(true);
        const crashBoundaryRecovered = await restartedTools?.github_pr_monitor_mutate?.handler?.(crashBoundaryInput);
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
        const lostResponse = await restartedTools?.github_pr_monitor_mutate?.handler?.(effectBeforeOutcomeInput);
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
        const recoveredEffect = await effectRestartTools?.github_pr_monitor_mutate?.handler?.(effectBeforeOutcomeInput);
        const replayedEffect = await effectRestartTools?.github_pr_monitor_mutate?.handler?.(effectBeforeOutcomeInput);
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
        const receiptWriteFailure = await restartedTools?.github_pr_monitor_mutate?.handler?.(receiptFailureInput);
        ActionReceiptAuthority.prototype.materializeMutationOutcome = originalMaterialize;
        expect(receiptWriteFailure?.isError).toBe(true);
        const receiptWriteRecovered = await restartedTools?.github_pr_monitor_mutate?.handler?.(receiptFailureInput);
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
else if (mode === "mismatch") process.stdout.write(JSON.stringify({ command: "terminal-report", proof: "ChatGPT_To_Codex", ok: true, runId: "run-bounds", actionPlanId: "foreign-plan", status: {} }) + "\\n");
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
