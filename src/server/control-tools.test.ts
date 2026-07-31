import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./mcp-server.js";
import type { Lease, ToolContext } from "../types.js";
import { enqueue } from "../control/queue.js";

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  }>;
}

function makeCtx(stateDir: string, projectRoot: string): { ctx: ToolContext; events: Array<Record<string, unknown>> } {
  const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }];
  let session: { activeProjectId: string | null; mode: string; lease: Lease | null } = {
    activeProjectId: null,
    mode: "observe",
    lease: null,
  };
  const events: Array<Record<string, unknown>> = [];
  const ctx: ToolContext = {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    registry,
    ledger: {
      append: async (event) => {
        events.push(event);
      },
    },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async (next) => {
        session = next as typeof session;
      },
    },
    config: {
      workspaceRoot: path.dirname(projectRoot),
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
  return { ctx, events };
}

async function registeredTools(ctx: ToolContext): Promise<Record<string, RegisteredToolLike>> {
  const server = await createServer(ctx);
  return (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })._registeredTools;
}

async function toolsListNames(ctx: ToolContext): Promise<string[]> {
  const server = await createServer(ctx);
  const handler = (
    server.server as unknown as {
      _requestHandlers?: Map<string, (request: { method: string; params: Record<string, never> }) => Promise<{ tools: Array<{ name: string }> }>>;
    }
  )._requestHandlers?.get("tools/list");
  const listed = await handler?.({ method: "tools/list", params: {} });
  return listed?.tools.map((t) => t.name) ?? [];
}

const CONTROL_NAMES = ["computer_screenshot", "computer_request_action", "computer_action_status", "computer_kill_switch"];

describe("desktop-control tool gating", () => {
  let stateDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-tools-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-project-"));
    delete process.env.CHATGPT2CODEX_CONTROL;
    delete process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST;
  });

  afterEach(async () => {
    delete process.env.CHATGPT2CODEX_CONTROL;
    delete process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST;
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("registers all 4 control tools by default (no CHATGPT2CODEX_CONTROL set)", async () => {
    const { ctx } = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);
    for (const name of CONTROL_NAMES) {
      expect(tools[name], name).toBeDefined();
    }
  });

  it("registers all 4 control tools when CHATGPT2CODEX_CONTROL=1", async () => {
    process.env.CHATGPT2CODEX_CONTROL = "1";
    const { ctx } = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);
    for (const name of CONTROL_NAMES) {
      expect(tools[name], name).toBeDefined();
    }
  });

  it.each(["0", "false", "off", "OFF", "False"])(
    "registers no control tools when CHATGPT2CODEX_CONTROL=%s (explicit opt-out)",
    async (value) => {
      process.env.CHATGPT2CODEX_CONTROL = value;
      const { ctx } = makeCtx(stateDir, projectRoot);
      const tools = await registeredTools(ctx);
      for (const name of CONTROL_NAMES) {
        expect(tools[name], name).toBeUndefined();
      }
    },
  );

  it("never lists control tools in tools/list, even when the feature flag is on", async () => {
    process.env.CHATGPT2CODEX_CONTROL = "1";
    const { ctx } = makeCtx(stateDir, projectRoot);
    const names = await toolsListNames(ctx);
    for (const name of CONTROL_NAMES) {
      expect(names, name).not.toContain(name);
    }
    // Sanity: the list handler still returns other tools.
    expect(names).toContain("workspace_list_projects");
  });

  it("denies computer_request_action without any lease (PROJECT_NOT_SELECTED)", async () => {
    process.env.CHATGPT2CODEX_CONTROL = "1";
    const { ctx } = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);
    const result = await tools.computer_request_action?.handler?.({
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PROJECT_NOT_SELECTED");
  });

  it("denies computer_request_action when the active lease preset is not control (PERMISSION_DENIED)", async () => {
    process.env.CHATGPT2CODEX_CONTROL = "1";
    const { ctx } = makeCtx(stateDir, projectRoot);
    await ctx.store.setSession({
      activeProjectId: "proj",
      mode: "read",
      lease: { projectId: "proj", leaseId: "l1", projectRoot, preset: "read-only", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
    });
    const tools = await registeredTools(ctx);
    const result = await tools.computer_request_action?.handler?.({
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it("queues (never executes) a request with a valid control lease and an allowlisted app", async () => {
    process.env.CHATGPT2CODEX_CONTROL = "1";
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit";
    const { ctx } = makeCtx(stateDir, projectRoot);
    await ctx.store.setSession({
      activeProjectId: "proj",
      mode: "read",
      lease: { projectId: "proj", leaseId: "l1", projectRoot, preset: "control", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
    });
    const tools = await registeredTools(ctx);
    const result = await tools.computer_request_action?.handler?.({
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.status).toBe("pending");
    expect(result?.structuredContent?.actionId).toEqual(expect.stringMatching(/^ctl_/));
    // The only osascript on this path is resolveFrontmostApp (src/control/tools.ts:228),
    // issued for the allowlist check; the AX resolve below it is gated on `target.ax`,
    // which a windowPoint target never sets. That round-trip is ~110ms against an idle,
    // warm System Events daemon but queues behind other System Events work machine-wide;
    // latency therefore varies with daemon state and unrelated concurrent automation.
    // The 90s ceiling provides headroom above the measured range documented in
    // mac-input.test.ts: 39s against a cold daemon and 37-69s under concurrent load.
    // It only widens the clock; every assertion still runs.
  }, 90_000);

  it("blocks a request targeting a sensitive app even with a valid control lease", async () => {
    process.env.CHATGPT2CODEX_CONTROL = "1";
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "1Password 7";
    const { ctx, events } = makeCtx(stateDir, projectRoot);
    await ctx.store.setSession({
      activeProjectId: "proj",
      mode: "read",
      lease: { projectId: "proj", leaseId: "l1", projectRoot, preset: "control", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
    });
    const tools = await registeredTools(ctx);
    const result = await tools.computer_request_action?.handler?.({
      appName: "1Password 7",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("SENSITIVE_TARGET_BLOCKED");
    expect(events.some((e) => e.type === "control.action.blocked")).toBe(true);
    // Same single resolveFrontmostApp round-trip as the allowlisted sibling above: it
    // runs at src/control/tools.ts:228, *before* assertAllowedTarget at :230, so the
    // denylist does not fail fast — it pays the same System Events contention.
    // Same 90s ceiling, same reason.
  }, 90_000);

  it("kill switch rejects new requests and existing pending actions", async () => {
    process.env.CHATGPT2CODEX_CONTROL = "1";
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit";
    const { ctx } = makeCtx(stateDir, projectRoot);
    await ctx.store.setSession({
      activeProjectId: "proj",
      mode: "read",
      lease: { projectId: "proj", leaseId: "l1", projectRoot, preset: "control", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
    });
    const tools = await registeredTools(ctx);

    const pre = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.1, yRel: 0.1 } },
      reason: "pre-kill",
    });

    const killResult = await tools.computer_kill_switch?.handler?.({ reason: "test" });
    expect(killResult?.isError).toBeFalsy();
    expect(killResult?.structuredContent?.killed).toBe(true);

    const status = await tools.computer_action_status?.handler?.({ actionId: pre.actionId });
    expect((status?.structuredContent?.action as { status?: string } | undefined)?.status).toBe("rejected");

    const postKillRequest = await tools.computer_request_action?.handler?.({
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.1, yRel: 0.1 } },
      reason: "post-kill",
    });
    expect(postKillRequest?.isError).toBe(true);
    expect(postKillRequest?.structuredContent?.code).toBe("CONTROL_KILLED");
  });

  it("computer_action_status never leaks raw typed text, only a length+hash summary", async () => {
    process.env.CHATGPT2CODEX_CONTROL = "1";
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit";
    const { ctx } = makeCtx(stateDir, projectRoot);
    await ctx.store.setSession({
      activeProjectId: "proj",
      mode: "read",
      lease: { projectId: "proj", leaseId: "l1", projectRoot, preset: "control", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
    });
    const tools = await registeredTools(ctx);
    const requested = await tools.computer_request_action?.handler?.({
      appName: "TextEdit",
      kind: "type",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      text: "super-secret-value",
      reason: "test",
    });
    const actionId = requested?.structuredContent?.actionId as string;
    const status = await tools.computer_action_status?.handler?.({ actionId });
    expect(JSON.stringify(status?.structuredContent)).not.toContain("super-secret-value");
    expect((status?.structuredContent?.action as { textSummary?: { length: number } } | undefined)?.textSummary?.length).toBe(
      "super-secret-value".length,
    );
    // Same resolveFrontmostApp round-trip on the enqueue path as above.
  }, 90_000);

  it("computer_request_action builds a dry-run AX resolve preview with no side effect; the action stays pending", async () => {
    process.env.CHATGPT2CODEX_CONTROL = "1";
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "Chatgpt2CodexNoSuchApp";
    const { ctx } = makeCtx(stateDir, projectRoot);
    await ctx.store.setSession({
      activeProjectId: "proj",
      mode: "read",
      lease: { projectId: "proj", leaseId: "l1", projectRoot, preset: "control", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
    });
    const tools = await registeredTools(ctx);
    const result = await tools.computer_request_action?.handler?.({
      appName: "Chatgpt2CodexNoSuchApp",
      kind: "click",
      target: { ax: { role: "button", title: "Nonexistent" } },
      reason: "test",
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.status).toBe("pending");
    const resolved = result?.structuredContent?.resolved as { found?: boolean; source?: string } | undefined;
    expect(resolved?.found).toBe(false);
    expect(resolved?.source).toBe("system-events");

    // Nothing executed it (no executor running in this test): the action is
    // still exactly where enqueue() left it.
    const status = await tools.computer_action_status?.handler?.({ actionId: result?.structuredContent?.actionId as string });
    expect((status?.structuredContent?.action as { status?: string } | undefined)?.status).toBe("pending");
  }, 90_000);

  it("computer_request_action's registered schema rejects an AppleScript-injecting role before any handler/enqueue runs (osascript RCE guard)", async () => {
    // `role` is interpolated as a raw AppleScript element class in
    // src/control/mac-input.ts (clickAxElement/resolveAxElementViaSystemEvents)
    // rather than a quoted string literal, so an unconstrained value could
    // close the enclosing script clause and inject arbitrary AppleScript
    // (including `do shell script`). The zod schema is the first gate; this
    // proves a malicious role never even reaches the tool handler / enqueue.
    const { ctx } = makeCtx(stateDir, projectRoot);
    const server = await createServer(ctx);
    const tools = (
      server as unknown as {
        _registeredTools: Record<string, { inputSchema?: { safeParse: (v: unknown) => { success: boolean } } }>;
      }
    )._registeredTools;
    const schema = tools.computer_request_action?.inputSchema;
    expect(schema).toBeDefined();

    const maliciousRole = 'button" of front window\n      end tell\n      do shell script "touch /tmp/chatgpt2codex-pwned"';
    const rejected = schema?.safeParse({
      appName: "TextEdit",
      kind: "click",
      target: { ax: { role: maliciousRole, title: "x" } },
      reason: "test",
    });
    expect(rejected?.success).toBe(false);

    // A real AX role class name (letters + spaces only) must still parse.
    const accepted = schema?.safeParse({
      appName: "TextEdit",
      kind: "click",
      target: { ax: { role: "text field", title: "x" } },
      reason: "test",
    });
    expect(accepted?.success).toBe(true);
  });

  it("project_select accepts preset=control and grants a control-capable lease", async () => {
    process.env.CHATGPT2CODEX_CONTROL = "1";
    const { ctx, events } = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);
    const result = await tools.project_select?.handler?.({ projectId: "proj", reason: "control test", preset: "control" });
    expect(result?.isError).toBeFalsy();
    expect((result?.structuredContent?.lease as { preset?: string } | undefined)?.preset).toBe("control");
    expect(events.some((e) => e.type === "control.granted")).toBe(true);
  });
});
