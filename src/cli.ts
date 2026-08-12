#!/usr/bin/env node
/**
 * chatgpt2codex CLI entrypoint.
 *
 * Minimal hand-rolled argv parsing (no commander dependency) for the three
 * MVP subcommands defined in PRD §5:
 *
 *   chatgpt2codex serve  --workspace <path>
 *   chatgpt2codex init   --workspace <path>
 *   chatgpt2codex doctor
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Config, LeasePreset, ProjectRegistryEntry, ToolContext } from "./types.js";
import type { AutoActionKind } from "./control/auto.js";

const execFileAsync = promisify(execFile);
const MAX_DIRECT_ACTION_INPUT_BYTES = 256 * 1024;
const ACTIONS_MODE_ENV = "CHATGPT2CODEX_ACTIONS_MODE";
type ActionsMode = "general" | "github-pr-monitor" | "github-pr-monitor-write";

function configuredActionsMode(): ActionsMode {
  const raw = process.env[ACTIONS_MODE_ENV];
  if (raw === undefined) return "general";
  const mode = raw.trim().toLowerCase();
  if (mode === "" || mode === "general") return "general";
  if (mode === "github-pr-monitor") return "github-pr-monitor";
  if (mode === "github-pr-monitor-write") return "github-pr-monitor-write";
  throw new Error(`${ACTIONS_MODE_ENV} must be either "general", "github-pr-monitor", or "github-pr-monitor-write".`);
}

interface ParsedArgs {
  command: string | undefined;
  flags: Record<string, string | boolean>;
  /** Non-flag arguments after the command, e.g. `control approve <actionId>`. */
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  return { command, flags, positional };
}

/** Default state dir per PRD §10: `~/.local/share/chatgpt2codex/`. */
function defaultStateDir(): string {
  return path.join(os.homedir(), ".local", "share", "chatgpt2codex");
}

function defaultConfig(workspaceRoot: string, stateDir: string): Config {
  return {
    workspaceRoot,
    stateDir,
    maxReadBytes: 10 * 1024 * 1024,
    maxPatchBytes: 10 * 1024 * 1024,
    defaultCommandTimeoutSec: 30,
    defaultLeaseTtlMs: 30 * 60 * 1000,
  };
}

function buildReadOnlyMonitorContext(workspace: string): ToolContext {
  const workspaceRoot = path.resolve(workspace);
  const stateDir = defaultStateDir();

  return {
    workspaceRoot,
    stateDir,
    registry: [],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => null,
      setSession: async () => undefined,
    },
    config: defaultConfig(workspaceRoot, stateDir),
  };
}

async function buildToolContext(workspace: string): Promise<ToolContext> {
  const [{ scanWorkspace }, { Store }, { Ledger }] = await Promise.all([
    import("./workspace/registry.js"),
    import("./state/store.js"),
    import("./state/ledger.js"),
  ]);
  const workspaceRoot = path.resolve(workspace);
  const stateDir = defaultStateDir();

  const store = new Store(stateDir);
  const ledger = new Ledger(stateDir);

  const registry = await scanWorkspace(workspaceRoot);
  await store.saveProjects(registry);

  const config = defaultConfig(workspaceRoot, stateDir);

  return {
    workspaceRoot,
    stateDir,
    registry,
    ledger: { append: (event) => ledger.append(event) },
    store: {
      loadProjects: () => store.loadProjects(),
      saveProjects: (p) => store.saveProjects(p),
      getSession: () => store.getSession(),
      setSession: (s) => store.setSession(s),
    },
    config,
  };
}

function parseLeasePreset(value: string | boolean | undefined): LeasePreset {
  if (
    value === "read-only" ||
    value === "tests-only" ||
    value === "full-write" ||
    value === "image-only" ||
    value === "control"
  ) {
    return value;
  }
  return "full-write";
}

async function applyStartupProjectSelection(ctx: ToolContext, flags: Record<string, string | boolean>): Promise<void> {
  const [{ findProject }, { makeLease }] = await Promise.all([
    import("./workspace/registry.js"),
    import("./workspace/project-select.js"),
  ]);
  const activeProject = typeof flags["active-project"] === "string" ? flags["active-project"] : undefined;
  const activeProjectRoot =
    typeof flags["active-project-root"] === "string" ? path.resolve(flags["active-project-root"]) : undefined;
  if (!activeProject && !activeProjectRoot) return;

  const entries = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
  let entry: ProjectRegistryEntry | undefined;
  if (activeProjectRoot) {
    entry = entries.find((candidate) => path.resolve(candidate.root) === activeProjectRoot);
  } else if (activeProject) {
    const result = findProject(entries, { projectId: activeProject, name: activeProject });
    if (result.ok) entry = result.entry;
  }

  if (!entry) {
    throw new Error(
      `Startup active project not found: ${activeProjectRoot ?? activeProject}. ` +
        `Make sure --workspace points at that project folder or its workspace root.`,
    );
  }

  const preset = parseLeasePreset(flags["active-project-preset"]);
  const lease = makeLease(entry, preset);
  await ctx.store.setSession({ activeProjectId: entry.projectId, mode: "read", lease });
  await ctx.ledger.append({
    type: "project.selected",
    projectId: entry.projectId,
    reason: "startup active project",
    preset,
  });
}
async function cmdServeStdio(flags: Record<string, string | boolean>, actionsMode: ActionsMode): Promise<void> {
  const [{ StdioServerTransport }, { isControlEnabled }, { startExecutor }, { createServer, createMonitorServer, createMonitorWriteServer }] =
    await Promise.all([
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("./control/policy.js"),
      import("./control/executor.js"),
      import("./server/mcp-server.js"),
    ]);
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const monitorMode = actionsMode === "github-pr-monitor";
  const writeMode = actionsMode === "github-pr-monitor-write";
  const ctx = monitorMode || writeMode ? buildReadOnlyMonitorContext(workspace) : await buildToolContext(workspace);
  if (!monitorMode && !writeMode) {
    await applyStartupProjectSelection(ctx, flags);
    if (isControlEnabled()) startExecutor(ctx);
  }
  const server = monitorMode
    ? await createMonitorServer(ctx)
    : writeMode
      ? await createMonitorWriteServer(ctx)
      : await createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await ctx.ledger.append({ type: "workspace.opened", workspaceRoot: ctx.workspaceRoot });
  console.error(`chatgpt2codex serve: listening on stdio (workspace=${ctx.workspaceRoot})`);
}

/**
 * HTTP mode (PRD §4 Transport Gateway, §5 CLI): `chatgpt2codex serve --http
 * [--port 7979] [--public-url <origin>]`. Exposes the SAME registerTools(ctx)
 * catalog as stdio mode over a Streamable HTTP `/mcp` endpoint, gated by
 * OAuth 2.1 (see src/server/http.ts, src/auth/oauth-provider.ts).
 */
async function cmdServeHttp(
  flags: Record<string, string | boolean>,
  actionsMode: ActionsMode,
): Promise<void> {
  const [{ hasOwnerToken }, { createHttpServer, defaultHttpServerConfig }] = await Promise.all([
    import("./auth/owner-token.js"),
    import("./server/http.js"),
  ]);
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const monitorMode = actionsMode === "github-pr-monitor";
  const writeMode = actionsMode === "github-pr-monitor-write";
  const ctx = monitorMode || writeMode ? buildReadOnlyMonitorContext(workspace) : await buildToolContext(workspace);

  if (!(await hasOwnerToken(ctx.stateDir))) {
    console.error(
      "chatgpt2codex serve --http: no owner token found. Run `chatgpt2codex init` first to generate one.",
    );
    process.exitCode = 1;
    return;
  }

  const port = typeof flags.port === "string" ? Number.parseInt(flags.port, 10) : 7979;
  const host = typeof flags.host === "string" ? flags.host : "127.0.0.1";
  const publicUrl =
    typeof flags["public-url"] === "string" ? (flags["public-url"] as string) : `http://${host}:${port}`;
  ctx.config.publicUrl = publicUrl;
  const idleShutdownMinutes =
    typeof flags["idle-shutdown-minutes"] === "string" ? Number.parseFloat(flags["idle-shutdown-minutes"]) : 0;
  const idleShutdownMs =
    Number.isFinite(idleShutdownMinutes) && idleShutdownMinutes > 0 ? idleShutdownMinutes * 60 * 1000 : undefined;
  if (!monitorMode) {
    const [{ isControlEnabled }, { startExecutor }] = await Promise.all([
      import("./control/policy.js"),
      import("./control/executor.js"),
    ]);
    await applyStartupProjectSelection(ctx, flags);
    if (isControlEnabled()) startExecutor(ctx);
  }

  let httpServer: { close(callback?: () => void): unknown } | undefined;
  let closeHttpServer: () => void = () => undefined;
  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const finish = () => {
      closeHttpServer();
      process.exit(exitCode);
    };
    if (httpServer) httpServer.close(finish);
    else finish();
  };

  const httpConfig = defaultHttpServerConfig({
    host,
    port,
    publicUrl,
    idleShutdownMs,
    onIdleTimeout: () => {
      console.error("chatgpt2codex serve --http: idle timeout reached; stopping.");
      shutdown(0);
    },
  });
  const running = createHttpServer(ctx, httpConfig);
  const { app } = running;
  closeHttpServer = running.close;

  httpServer = app.listen(port, host, () => {
    console.error(`chatgpt2codex serve --http: listening on http://${host}:${port}/mcp`);
    console.error(`chatgpt2codex serve --http: public URL ${publicUrl}/mcp`);
    console.error(`chatgpt2codex serve --http: workspace=${ctx.workspaceRoot}`);
    if (idleShutdownMs !== undefined) {
      console.error(`chatgpt2codex serve --http: idle shutdown after ${idleShutdownMinutes} minute(s) without sessions`);
    }
  });

  if (!monitorMode) {
    await ctx.ledger.append({ type: "workspace.opened", workspaceRoot: ctx.workspaceRoot, transport: "http" });
  }

  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));

  // Keep the process alive; httpServer.listen already does this, but guard
  // against callers awaiting cmdServeHttp() expecting it to resolve only
  // once the server is asked to stop.
  await new Promise<void>(() => {});
}

async function cmdServe(flags: Record<string, string | boolean>): Promise<void> {
  const actionsMode = configuredActionsMode();
  if (flags.http) {
    await cmdServeHttp(flags, actionsMode);
    return;
  }
  await cmdServeStdio(flags, actionsMode);
}

async function cmdInit(flags: Record<string, string | boolean>): Promise<void> {
  const [{ scanWorkspace }, { Store }, { Ledger }, { generateOwnerToken, hasOwnerToken, storeOwnerToken }] =
    await Promise.all([
      import("./workspace/registry.js"),
      import("./state/store.js"),
      import("./state/ledger.js"),
      import("./auth/owner-token.js"),
    ]);
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const workspaceRoot = path.resolve(workspace);
  const stateDir = defaultStateDir();

  const store = new Store(stateDir);
  const ledger = new Ledger(stateDir);

  const registry = await scanWorkspace(workspaceRoot);
  await store.saveProjects(registry);
  await store.setSession({ activeProjectId: null, mode: "observe", lease: null });
  await ledger.append({ type: "workspace.opened", workspaceRoot });

  console.error(
    `chatgpt2codex init: initialized state dir ${stateDir} with ${registry.length} project(s) from ${workspaceRoot}`,
  );

  // PRD §11 SR-04: owner secret lives only as a hash on disk; the plaintext
  // is generated here and shown to the operator exactly once. Re-running
  // `init` rotates it unless --keep-owner-token is passed.
  const alreadyHasToken = await hasOwnerToken(stateDir);
  if (alreadyHasToken && !flags["rotate-owner-token"]) {
    console.error(
      "chatgpt2codex init: owner token already set (pass --rotate-owner-token to generate a new one).",
    );
  } else {
    const ownerToken = generateOwnerToken();
    await storeOwnerToken(stateDir, ownerToken);
    console.error("");
    console.error("chatgpt2codex init: generated a new HTTP owner token (shown once, never logged again):");
    console.error("");
    console.error(`  ${ownerToken}`);
    console.error("");
    console.error(
      "Store this securely (e.g. a password manager). It is required to approve the OAuth /authorize prompt when a ChatGPT/MCP client connects over `chatgpt2codex serve --http`.",
    );
  }
}

async function readStdin(maxBytes = Number.POSITIVE_INFINITY): Promise<string> {
  return await new Promise((resolve, reject) => {
    let value = "";
    let bytes = 0;
    let oversized = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (bytes + chunkBytes > maxBytes) {
        oversized = true;
        return;
      }
      bytes += chunkBytes;
      value += chunk;
    });
    process.stdin.on("end", () => {
      if (oversized) reject(new Error("direct-action stdin exceeds the bounded input limit"));
      else resolve(value);
    });
    process.stdin.on("error", reject);
  });
}

async function cmdOwnerToken(flags: Record<string, string | boolean>): Promise<void> {
  const [{ generateOwnerToken, hasOwnerToken, storeOwnerToken }, { JsonOAuthStore }] = await Promise.all([
    import("./auth/owner-token.js"),
    import("./auth/oauth-store.js"),
  ]);
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const stateDir = defaultStateDir();

  if (flags.status) {
    console.log(JSON.stringify({ configured: await hasOwnerToken(stateDir), stateDir }));
    return;
  }

  if (flags["set-stdin"]) {
    const token = (await readStdin()).trim();
    await storeOwnerToken(stateDir, token);
    await new JsonOAuthStore(stateDir).clearAll();
    console.log(JSON.stringify({ configured: true, rotated: true, stateDir }));
    return;
  }

  if (flags.generate || flags.rotate) {
    const ownerToken = generateOwnerToken();
    await storeOwnerToken(stateDir, ownerToken);
    await new JsonOAuthStore(stateDir).clearAll();
    console.log(JSON.stringify({ configured: true, rotated: true, ownerToken, stateDir }));
    return;
  }

  console.error("usage: chatgpt2codex owner-token --status|--generate|--set-stdin [--workspace <path>]");
  console.error(`workspace: ${path.resolve(workspace)}`);
  process.exitCode = 1;
}
async function cmdDirectAction(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const {
    createDirectActionClient,
    createDirectWriteActionClient,
    isDirectMonitorTool,
    isDirectMonitorWriteTool,
  } = await import("./server/direct-action-client.js");
  const tool = positional[0];
  const writeMode = process.env.CHATGPT2CODEX_ACTIONS_MODE?.trim().toLowerCase() === "github-pr-monitor-write";
  const validTool = typeof tool === "string" && (
    writeMode ? isDirectMonitorWriteTool(tool) : isDirectMonitorTool(tool)
  );
  if (!tool || positional.length !== 1 || !validTool) {
    throw new Error(
      writeMode
        ? "usage: chatgpt2codex direct-action <github_pr_monitor_write_*> [--workspace <path>]"
        : "usage: chatgpt2codex direct-action <github_pr_monitor_read> [--workspace <path>]",
    );
  }

  const raw = (await readStdin(MAX_DIRECT_ACTION_INPUT_BYTES)).trim();
  if (!raw) throw new Error("direct-action requires one JSON object on stdin");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("direct-action stdin must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("direct-action stdin must be a JSON object");
  }

  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const ctx = buildReadOnlyMonitorContext(workspace);
  if (writeMode) {
    const client = await createDirectWriteActionClient(ctx);
    try {
      const response = await client.call(tool as Parameters<typeof client.call>[0], parsed as Record<string, unknown>);
      console.log(JSON.stringify(response));
      if (response.ok !== true) process.exitCode = 1;
    } finally {
      await client.close();
    }
    return;
  }
  const client = await createDirectActionClient(ctx);
  try {
    const response = await client.call(tool as Parameters<typeof client.call>[0], parsed as Record<string, unknown>);
    console.log(JSON.stringify(response));
    if (response.ok !== true) process.exitCode = 1;
  } finally {
    await client.close();
  }
}
async function cmdGithubPrWrite(argv: readonly string[]): Promise<void> {
  const { requestGithubPrWriteAdmin, isAdminSuccess } = await import("./server/github-pr-write-operator-client.js");
  if (process.env.CHATGPT2CODEX_ACTIONS_MODE?.trim().toLowerCase() !== "github-pr-monitor-write") {
    throw new Error("github-pr-write requires CHATGPT2CODEX_ACTIONS_MODE=github-pr-monitor-write");
  }
  const response = await requestGithubPrWriteAdmin(argv);
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("github-pr-write operator returned an invalid response");
  }
  console.log(JSON.stringify(response));
  if (!isAdminSuccess(response)) process.exitCode = 1;
}
async function cmdGithubPrWriteHost(flags: Record<string, string | boolean>): Promise<void> {
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const helperSocket = typeof flags["helper-socket"] === "string"
    ? flags["helper-socket"]
    : path.join(defaultStateDir(), ".operator-helper", "github-pr-write-helper.sock");
  const helperBinary = typeof flags["helper-binary"] === "string" ? flags["helper-binary"] : undefined;
  if (!helperBinary) throw new Error("github-pr-write-host requires --helper-binary");
  const { startGithubPrWriteAdminHost } = await import("./server/github-pr-write-admin-host.js");
  const host = await startGithubPrWriteAdminHost({
    stateDir: defaultStateDir(),
    helperSocketPath: helperSocket,
    helperBinaryPath: helperBinary,
  });
  let closing = false;
  const close = async (exitCode: number) => {
    if (closing) return;
    closing = true;
    await host.close();
    process.exitCode = exitCode;
  };
  process.once("SIGINT", () => { void close(130); });
  process.once("SIGTERM", () => { void close(143); });
  console.error(`github-pr-write admin host listening on ${host.socketPath} (workspace=${path.resolve(workspace)})`);
  await new Promise<void>(() => {});
}
async function cmdGithubPrFeedbackSupervisor(flags: Record<string, string | boolean>): Promise<void> {
  const workspace = typeof flags.workspace === "string"
    ? flags.workspace
    : path.join(os.homedir(), "workspace");
  const intervalSeconds = typeof flags["interval-seconds"] === "string"
    ? Number.parseInt(flags["interval-seconds"], 10)
    : 300;
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86_400) {
    throw new Error("github-pr-feedback-supervisor interval must be between 60 and 86400 seconds");
  }
  const { runGithubPrFeedbackSupervisor } = await import("./server/github-pr-feedback-supervisor.js");
  const supervisor = await runGithubPrFeedbackSupervisor({
    stateDir: defaultStateDir(),
    workspaceRoot: path.resolve(workspace),
    intervalMs: intervalSeconds * 1_000,
    once: flags.once === true,
    chatgptCdpUrl: typeof flags["chatgpt-cdp-url"] === "string" ? flags["chatgpt-cdp-url"] : undefined,
  });
  let closing = false;
  const close = async (exitCode: number) => {
    if (closing) return;
    closing = true;
    await supervisor.close();
    process.exitCode = exitCode;
  };
  process.once("SIGINT", () => { void close(130); });
  process.once("SIGTERM", () => { void close(143); });
  if (flags.once === true) return;
  console.error(`github-pr-feedback-supervisor listening (interval=${intervalSeconds}s, workspace=${path.resolve(workspace)})`);
  await new Promise<void>(() => {});
}
async function cmdDirectMonitorCycle(flags: Record<string, string | boolean>): Promise<void> {
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const [{ createDirectActionClient }, { runDirectMonitorCycle }] = await Promise.all([
    import("./server/direct-action-client.js"),
    import("./server/direct-monitor-cycle.js"),
  ]);
  const ctx = buildReadOnlyMonitorContext(workspace);
  const client = await createDirectActionClient(ctx);
  try {
    const result = await runDirectMonitorCycle(client);
    console.log(JSON.stringify(result));
  } finally {
    await client.close();
  }
}


/**
 * `chatgpt2codex control <list|approve|approve-all|reject|kill|preflight|auto> [actionId]`
 *
 * The local-only human-approval surface for Option B desktop control
 * (src/control/queue.ts). This is the mechanism a local approver (today:
 * this CLI directly; eventually the macOS status-bar app via the same
 * runCli pattern it already uses) uses to move a queued click/type/key
 * request from `pending` to `approved`/`rejected`, kill the session
 * outright, or turn on a bounded auto-approve scope (src/control/auto.ts).
 * ChatGPT/MCP clients cannot reach any of this: there is no MCP tool or
 * HTTP route that calls approveAction, setKill, or setAuto.
 */
async function cmdControl(positional: string[], flags: Record<string, string | boolean> = {}): Promise<void> {
  const [
    { approveAction, isKilled, listActions, rejectAction, setKill, toSummary },
    { controlAllowlist, isAppAllowed, isControlEnabled, isSensitiveApp },
    { preflightPermissions },
    { clampMinutes, clearAuto, readAuto, setAuto },
  ] = await Promise.all([
    import("./control/queue.js"),
    import("./control/policy.js"),
    import("./control/mac-input.js"),
    import("./control/auto.js"),
  ]);
  const stateDir = defaultStateDir();
  const [sub, actionId] = positional;
  switch (sub) {
    case "list": {
      const actions = await listActions(stateDir);
      console.log(JSON.stringify(actions.map(toSummary), null, 2));
      return;
    }
    case "approve": {
      if (!actionId) {
        console.error("usage: chatgpt2codex control approve <actionId>");
        process.exitCode = 1;
        return;
      }
      const record = await approveAction(stateDir, actionId);
      console.log(JSON.stringify(toSummary(record), null, 2));
      return;
    }
    case "approve-all": {
      // Local human batch-approve: only pending actions targeting a
      // non-sensitive, allowlisted app are approved. Everything else is
      // reported back as skipped rather than silently approved, and a kill
      // mid-loop stops the whole batch immediately.
      const approved: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      if (await isKilled(stateDir)) {
        console.log(JSON.stringify({ approved, skipped, killed: true }, null, 2));
        return;
      }
      const allowlist = controlAllowlist();
      const pending = (await listActions(stateDir)).filter((a) => a.status === "pending");
      for (const action of pending) {
        if (await isKilled(stateDir)) break;
        if (isSensitiveApp(action.appName) || !isAppAllowed(action.appName, allowlist)) {
          skipped.push({ id: action.actionId, reason: "blocked-not-eligible" });
          continue;
        }
        try {
          await approveAction(stateDir, action.actionId);
          approved.push(action.actionId);
        } catch (err) {
          skipped.push({ id: action.actionId, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      console.log(JSON.stringify({ approved, skipped }, null, 2));
      return;
    }
    case "auto": {
      const mode = actionId;
      switch (mode) {
        case "on": {
          if (!isControlEnabled()) {
            console.error("Desktop control is not enabled (CHATGPT2CODEX_CONTROL); refusing to enable auto-approve.");
            process.exitCode = 1;
            return;
          }
          const apps =
            typeof flags.apps === "string"
              ? flags.apps
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0)
              : [];
          if (apps.length === 0) {
            console.error(
              "usage: chatgpt2codex control auto on --apps <a,b,...> [--minutes N] [--kinds click,type,key] [--max N]",
            );
            process.exitCode = 1;
            return;
          }
          const minutes = typeof flags.minutes === "string" ? Number(flags.minutes) : undefined;
          const kinds =
            typeof flags.kinds === "string"
              ? (flags.kinds
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter((entry): entry is AutoActionKind => entry === "click" || entry === "type" || entry === "key"))
              : undefined;
          const maxCountRaw = typeof flags.max === "string" ? Number(flags.max) : undefined;
          const maxCount = maxCountRaw !== undefined && !Number.isNaN(maxCountRaw) ? maxCountRaw : undefined;
          const scope = await setAuto(stateDir, {
            apps,
            minutes: clampMinutes(minutes),
            kinds: kinds && kinds.length > 0 ? kinds : undefined,
            maxCount,
          });
          if (scope.apps.length === 0) {
            console.error(
              "warning: none of the requested --apps are on the control allowlist (or all are sensitive apps); auto-approve is on but matches nothing.",
            );
          }
          console.log(JSON.stringify(scope, null, 2));
          return;
        }
        case "off": {
          await clearAuto(stateDir);
          console.log(JSON.stringify({ autoEnabled: false }));
          return;
        }
        case "status": {
          const scope = await readAuto(stateDir);
          if (!scope) {
            console.log(JSON.stringify({ autoEnabled: false }));
            return;
          }
          const now = Date.now();
          const active = now < scope.expiresAt;
          console.log(
            JSON.stringify({ autoEnabled: active, remainingMs: Math.max(0, scope.expiresAt - now), ...scope }, null, 2),
          );
          return;
        }
        default:
          console.error(
            "usage: chatgpt2codex control auto <on --apps a,b [--minutes N] [--kinds click,type,key] [--max N] | off | status>",
          );
          process.exitCode = 1;
          return;
      }
    }
    case "reject": {
      if (!actionId) {
        console.error("usage: chatgpt2codex control reject <actionId>");
        process.exitCode = 1;
        return;
      }
      const record = await rejectAction(stateDir, actionId, "rejected-by-local-approver");
      console.log(JSON.stringify(toSummary(record), null, 2));
      return;
    }
    case "kill": {
      await setKill(stateDir);
      console.log(JSON.stringify({ killed: true }));
      return;
    }
    case "preflight": {
      // Live Accessibility/Screen Recording trust check exposed for local
      // operators and doctor-style diagnosis (src/control/mac-input.ts
      // preflightPermissions). Reports a clear reason instead of a control
      // action failing silently partway through; never throws a raw
      // NOT_IMPLEMENTED stack trace off darwin, always structured JSON.
      try {
        const result = await preflightPermissions();
        console.log(JSON.stringify(result, null, 2));
        if (!result.accessibilityTrusted || !result.screenRecordingAllowed) {
          process.exitCode = 1;
        }
      } catch (err) {
        console.log(
          JSON.stringify(
            {
              accessibilityTrusted: false,
              screenRecordingAllowed: false,
              source: "unavailable",
              reason: err instanceof Error ? err.message : String(err),
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
      }
      return;
    }
    default:
      console.error("usage: chatgpt2codex control <list|approve|approve-all|reject|kill|preflight|auto> [actionId]");
      process.exitCode = 1;
  }
}

async function checkCommand(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
    return stdout.trim().split("\n")[0];
  } catch {
    return undefined;
  }
}

async function cmdDoctor(): Promise<void> {
  const [{ hasOwnerToken }, { checkIntakeAvailability }] = await Promise.all([
    import("./auth/owner-token.js"),
    import("./assets/image-intake.js"),
  ]);
  const nodeVersion = process.version;
  const rgVersion = await checkCommand("rg", ["--version"]);
  const gitVersion = await checkCommand("git", ["--version"]);
  const workspacePath = process.cwd();

  let toolCount = "unknown";
  try {
    // Import lazily so a broken registration path doesn't crash doctor.
    const { createServer } = await import("./server/mcp-server.js");
    const ctx = await buildToolContext(workspacePath);
    const server = await createServer(ctx);
    const serverAny = server as unknown as {
      _registeredTools?: Record<string, unknown>;
    };
    const registered = serverAny._registeredTools;
    toolCount = registered ? String(Object.keys(registered).length) : "unknown";
  } catch (err) {
    toolCount = `error: ${(err as Error).message}`;
  }

  const stateDir = defaultStateDir();
  const ownerTokenReady = await hasOwnerToken(stateDir);
  const intake = await checkIntakeAvailability();

  console.log(`node: ${nodeVersion}`);
  console.log(`ripgrep: ${rgVersion ?? "not found"}`);
  console.log(`git: ${gitVersion ?? "not found"}`);
  console.log(`workspace: ${workspacePath}`);
  console.log(`state dir: ${stateDir}`);
  console.log(`registered tools: ${toolCount}`);
  console.log(
    `http/oauth: owner token ${ownerTokenReady ? "configured" : "NOT SET — run `chatgpt2codex init` to generate one"}`,
  );
  console.log(`http default endpoint: http://127.0.0.1:7979/mcp (start via \`chatgpt2codex serve --http\`)`);
  console.log(
    `image intake: pngpaste ${intake.pngpasteAvailable ? "found" : "not found — clipboard image intake unavailable"}, ` +
      `~/Downloads ${intake.downloadsDirExists ? "found" : "NOT FOUND — download intake unavailable"}`,
  );
  console.log(
    "ChatGPT image app flow: open_chatgpt_images_app opens/prepares the first-party Images app; save_chatgpt_image imports from passed URL, copied URL, clipboard image, latest download, or path; " +
      "URL fetches remain SSRF-hardened (blocks loopback/private/link-local/metadata targets, re-validates redirects, 50MB/15s caps).",
  );
}

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "serve":
      await cmdServe(flags);
      break;
    case "init":
      await cmdInit(flags);
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "owner-token":
      await cmdOwnerToken(flags);
      break;
    case "control":
      await cmdControl(positional, flags);
      break;
    case "direct-action":
      await cmdDirectAction(positional, flags);
      break;
    case "github-pr-write-host":
      await cmdGithubPrWriteHost(flags);
      break;
    case "github-pr-feedback-supervisor":
      await cmdGithubPrFeedbackSupervisor(flags);
      break;
    case "github-pr-write":
      await cmdGithubPrWrite(process.argv.slice(2));
      break;
    case "github-pr-write-approve":
      throw new Error("github-pr-write-approve has been removed; approval by challenge ID is not supported");
    case "direct-monitor-cycle":
      await cmdDirectMonitorCycle(flags);
      break;
    default:
      console.error(
        "usage: chatgpt2codex <serve|init|doctor|owner-token|control|direct-action|github-pr-write|github-pr-feedback-supervisor|direct-monitor-cycle> [--workspace <path>] [--active-project-root <path>] [--stdio | --http [--port 7979] [--public-url <origin>]]",
      );
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
