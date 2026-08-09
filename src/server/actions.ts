import { createHash } from "node:crypto";
import type { Express, Request, Response } from "express";
import { promises as fs } from "node:fs";
import { verifyOwnerToken } from "../auth/owner-token.js";
import type { ToolContext } from "../types.js";
import { createE2eScreenshotShare, readE2eScreenshotShare } from "../e2e/screenshot-share.js";
import { CONTROL_TOOL_NAMES, isControlChatGptExposed } from "../control/policy.js";
import { createServer as createMcpServer } from "./mcp-server.js";
import { TOOL_AVAILABILITY_GATE, toolCallProof } from "./tool-proof.js";
import { normalizeObjectSchema, safeParseAsync, getParseErrorMessage } from "@modelcontextprotocol/sdk/server/zod-compat.js";

interface CallToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<CallToolResultLike>;
  inputSchema?: unknown;
}

interface ActionRoute {
  path: string;
  tool: string;
  operationId: string;
  summary: string;
  description: string;
  schema: string;
}
type ActionsMode = "general" | "github-pr-monitor";

const ACTIONS_MODE_ENV = "CHATGPT2CODEX_ACTIONS_MODE";
const GITHUB_PR_MONITOR_TOOL_NAMES = new Set([
  "github_pr_monitor_read",
  "github_pr_monitor_prepare",
  "github_pr_monitor_execute",
  "github_pr_monitor_mutate",
  "github_pr_monitor_state",
]);

function configuredActionsMode(): ActionsMode {
  const raw = process.env[ACTIONS_MODE_ENV];
  if (raw === undefined) return "general";
  const mode = raw.trim().toLowerCase();
  if (mode === "general" || mode === "github-pr-monitor") return mode;
  throw new Error(`${ACTIONS_MODE_ENV} must be either "general" or "github-pr-monitor".`);
}

const ACTION_ROUTES: ActionRoute[] = [
  {
    path: "/actions/agent-guide",
    tool: "agent_guide",
    operationId: "agent_guide",
    summary: "Get the chatgpt2codex workflow guide",
    description:
      "Call this first so the GPT knows the available chatgpt2codex tools and the ChatGPT image-save workflow. Do not proceed with local coding unless this or another chatgpt2codex action returns ok=true in the current turn.",
    schema: "EmptyInput",
  },
  {
    path: "/actions/goal-intake",
    tool: "goal_intake",
    operationId: "goal_intake",
    summary: "Start a broad local coding goal",
    description:
      "Call this immediately for /goal, deep research, vague large implementation, or 'proceed quickly' prompts. This uses the local chatgpt2codex bridge, not OpenAI Codex quota. It returns within seconds with the next tool calls so ChatGPT does not spend ~30 seconds thinking and then stop. If this action is unavailable, stop and say no local coding occurred.",
    schema: "GoalIntakeInput",
  },
  {
    path: "/actions/goal-loop",
    tool: "goal_loop",
    operationId: "goal_loop",
    summary: "Run or continue a local coding loop",
    description:
      "Use this for Codex-style autonomous work through ChatGPT Actions when Codex quota is unavailable. It keeps the loop state local, returns the next concrete action batch quickly, and tells ChatGPT to call it again after each inspect/edit/verify batch until done or blocked.",
    schema: "GoalLoopInput",
  },
  {
    path: "/actions/project-select",
    tool: "project_select",
    operationId: "project_select",
    summary: "Select the active local project",
    description:
      "Selects and leases the project. GPT Actions default to preset=full-write when preset is omitted, so source edits can be applied directly through chatgpt2codex instead of returning copy/paste scripts. Use preset=image-only only for image-only saves.",
    schema: "ProjectSelectInput",
  },
  {
    path: "/actions/workspace-list-projects",
    tool: "workspace_list_projects",
    operationId: "workspace_list_projects",
    summary: "List local workspace projects",
    description: "List projects registered under the local chatgpt2codex workspace.",
    schema: "WorkspaceListProjectsInput",
  },
  {
    path: "/actions/workspace-refresh-index",
    tool: "workspace_refresh_index",
    operationId: "workspace_refresh_index",
    summary: "Refresh the local project index",
    description: "Rescan the local workspace root and refresh chatgpt2codex's project registry.",
    schema: "WorkspaceRefreshIndexInput",
  },
  {
    path: "/actions/workspace-get-project",
    tool: "workspace_get_project",
    operationId: "workspace_get_project",
    summary: "Get local project metadata",
    description: "Resolve a project by project id or local path inside the configured workspace.",
    schema: "WorkspaceGetProjectInput",
  },
  {
    path: "/actions/project-status",
    tool: "project_status",
    operationId: "project_status",
    summary: "Get project status",
    description: "Read branch, dirty files, rule files, commands, and Code Brain availability for a project.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/project-rules",
    tool: "project_rules",
    operationId: "project_rules",
    summary: "Read project rules",
    description: "Read local AGENTS/CLAUDE project rules through chatgpt2codex, with secret redaction.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/code-search",
    tool: "code_search",
    operationId: "code_search",
    summary: "Search project code",
    description: "Search project source code through the local chatgpt2codex runtime.",
    schema: "CodeSearchInput",
  },
  {
    path: "/actions/code-context-pack",
    tool: "code_context_pack",
    operationId: "code_context_pack",
    summary: "Build project code context",
    description: "Build a compact search/read context pack for implementation work.",
    schema: "CodeContextPackInput",
  },
  {
    path: "/actions/file-read-slice",
    tool: "file_read_slice",
    operationId: "file_read_slice",
    summary: "Read project file slice",
    description: "Read a line range from a project file with hash anchors for safe patching.",
    schema: "FileReadSliceInput",
  },
  {
    path: "/actions/file-apply-patch",
    tool: "file_apply_patch",
    operationId: "file_apply_patch",
    summary: "Apply a project file patch",
    description: "Apply a Codex-style patch directly to the selected local project. Requires project_select preset=full-write; do not return shell scripts for the user to paste.",
    schema: "FileApplyPatchInput",
  },
  {
    path: "/actions/file-create",
    tool: "file_create",
    operationId: "file_create",
    summary: "Create a project file",
    description: "Create or overwrite a project-confined file directly through chatgpt2codex. Requires project_select preset=full-write.",
    schema: "FileCreateInput",
  },
  {
    path: "/actions/command-list",
    tool: "command_list",
    operationId: "command_list",
    summary: "List project commands",
    description: "List allowlisted project commands discovered by chatgpt2codex.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/command-run",
    tool: "command_run",
    operationId: "command_run",
    summary: "Run allowlisted project command",
    description: "Run an allowlisted project command through chatgpt2codex.",
    schema: "CommandRunInput",
  },
  {
    path: "/actions/local-shell-run",
    tool: "local_shell_run",
    operationId: "local_shell_run",
    summary: "Run local project shell",
    description: "Run a guarded local shell command inside the project through chatgpt2codex. Network/destructive intents remain approval-gated by the tool.",
    schema: "LocalShellRunInput",
  },
  {
    path: "/actions/e2e-start-server",
    tool: "e2e_start_server",
    operationId: "e2e_start_server",
    summary: "Start a local dev server for E2E",
    description:
      "Start a long-running project dev/server command in the background, optionally wait for a URL, and return pid/log path. Use before browser/app E2E screenshots.",
    schema: "E2eStartServerInput",
  },
  {
    path: "/actions/e2e-open-target",
    tool: "e2e_open_target",
    operationId: "e2e_open_target",
    summary: "Open a URL or local app for E2E",
    description: "Open a URL, installed app name, or allowed local app path on the Mac before E2E screenshot capture.",
    schema: "E2eOpenTargetInput",
  },
  {
    path: "/actions/e2e-run-command",
    tool: "e2e_run_command",
    operationId: "e2e_run_command",
    summary: "Run E2E command and capture proof",
    description:
      "Run a guarded project E2E/test command and capture a macOS screenshot by default so the user can inspect visual proof.",
    schema: "E2eRunCommandInput",
  },
  {
    path: "/actions/e2e-test-and-show-screenshot",
    tool: "e2e_test_and_show_screenshot",
    operationId: "e2e_test_and_show_screenshot",
    summary: "E2E test and show screenshot inline",
    description:
      "Call this one-shot action when the user says 'e2e 테스트하고 스크린샷 보여줘', 'run e2e and show me the screenshot', or similar. It uses the active project by default, detects web vs desktop-app projects such as Tauri, runs only discovered local package scripts, opens the built desktop app for Tauri projects, captures multiple top/middle/bottom desktop app-window screenshots for desktop apps or browser-region screenshots for web apps, and returns imageMarkdown/imageMarkdownList. If the local check fails, inspect logs, make normal code fixes with separate coding tools, rerun E2E, and only then render the final passing screenshot set inline.",
    schema: "E2eTestAndShowScreenshotInput",
  },
  {
    path: "/actions/e2e-screenshot",
    tool: "e2e_screenshot",
    operationId: "e2e_screenshot",
    summary: "Capture an E2E screenshot",
    description:
      "Capture a macOS screenshot into the selected project under .chatgpt2codex/e2e/screenshots and return the file path so the user can inspect it.",
    schema: "E2eScreenshotInput",
  },
  {
    path: "/actions/e2e-open-url-screenshot",
    tool: "e2e_open_url_screenshot",
    operationId: "e2e_open_url_screenshot",
    summary: "Open a URL and capture an E2E screenshot",
    description: "Open a URL, wait briefly, capture the browser page region, and return inline image markdown for visual E2E proof.",
    schema: "E2eOpenUrlScreenshotInput",
  },
  {
    path: "/actions/repo-status",
    tool: "repo_status",
    operationId: "repo_status",
    summary: "Read repository status",
    description: "Read local git branch, dirty files, staged files, upstream, and sync state.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/repo-diff-summary",
    tool: "repo_diff_summary",
    operationId: "repo_diff_summary",
    summary: "Summarize repository diff",
    description: "Summarize the local working diff with secret redaction.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/show-changes",
    tool: "show_changes",
    operationId: "show_changes",
    summary: "Show project changes",
    description: "Return the current redacted working diff for review.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/checkpoint-list",
    tool: "checkpoint_list",
    operationId: "checkpoint_list",
    summary: "List project checkpoints",
    description: "List recent mutation checkpoints captured by chatgpt2codex.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/checkpoint-show",
    tool: "checkpoint_show",
    operationId: "checkpoint_show",
    summary: "Show project checkpoint",
    description: "Show the redacted diff stored in a chatgpt2codex checkpoint.",
    schema: "CheckpointShowInput",
  },
  {
    path: "/actions/checkpoint-restore",
    tool: "checkpoint_restore",
    operationId: "checkpoint_restore",
    summary: "Restore project checkpoint",
    description: "Reverse-apply a checkpoint diff through chatgpt2codex. Requires a write lease.",
    schema: "CheckpointShowInput",
  },
  {
    path: "/actions/git-commit",
    tool: "git_commit",
    operationId: "git_commit",
    summary: "Commit project changes",
    description: "Stage and commit project changes through chatgpt2codex after inspecting status/diff.",
    schema: "GitCommitInput",
  },
  {
    path: "/actions/git-push",
    tool: "git_push",
    operationId: "git_push",
    summary: "Push project branch",
    description: "Push the current project branch through chatgpt2codex when the user explicitly requested pushing.",
    schema: "GitPushInput",
  },
  {
    path: "/actions/save-chatgpt-image",
    tool: "save_chatgpt_image",
    operationId: "save_chatgpt_image",
    summary: "Save a finished ChatGPT image from URL, clipboard, download, or path",
    description:
      "Device-agnostic import when a ChatGPT Share/Copy Link or content URL is available. Also supports local Mac clipboard/download/path sources. This is the correct Custom GPT path for phone-generated images after the user provides the image URL.",
    schema: "SaveChatGptImageInput",
  },
  {
    path: "/actions/import-chatgpt-image-url",
    tool: "save_chatgpt_image_from_url",
    operationId: "save_chatgpt_image_from_url",
    summary: "Import a ChatGPT image URL",
    description:
      "Device-agnostic import for ChatGPT image URLs, including chatgpt.com/s/m_... share pages and backend estuary content URLs. Use for phone-generated images or any device where chatgpt2codex cannot inspect local Chrome.",
    schema: "ImportChatGptImageUrlInput",
  },
  {
    path: "/actions/github-pr-monitor-read",
    tool: "github_pr_monitor_read",
    operationId: "github_pr_monitor_read",
    summary: "Read fixed-repository authored PR state",
    description: "Read open Yeachan-Heo/gajae-code PR state for the fixed author twoimo.",
    schema: "GithubPrMonitorReadInput",
  },
  {
    path: "/actions/github-pr-monitor-prepare",
    tool: "github_pr_monitor_prepare",
    operationId: "github_pr_monitor_prepare",
    summary: "Prepare a fixed-repository PR worktree",
    description: "Create or quarantine the bounded monitor worktree for an authored Yeachan-Heo/gajae-code PR.",
    schema: "GithubPrMonitorPrepareInput",
  },
  {
    path: "/actions/github-pr-monitor-execute",
    tool: "github_pr_monitor_execute",
    operationId: "github_pr_monitor_execute",
    summary: "Apply and verify exact PR suggestions",
    description: "Apply exact externally planned suggestions in the prepared worktree, commit with trusted git plumbing, and verify the commit with bun test in pinned OCI.",
    schema: "GithubPrMonitorExecuteInput",
  },
  {
    path: "/actions/github-pr-monitor-mutate",
    tool: "github_pr_monitor_mutate",
    operationId: "github_pr_monitor_mutate",
    summary: "Apply a bounded authored PR response",
    description: "Post a reply, resolve a thread, re-request a reviewer, or push a verified prepared worktree for the fixed repository and author.",
    schema: "GithubPrMonitorMutateInput",
  },
  {
    path: "/actions/github-pr-monitor-state",
    tool: "github_pr_monitor_state",
    operationId: "github_pr_monitor_state",
    summary: "Run a bounded PR-monitor state command",
    description: "Run one fixed monitor state command. The input property is a JSON object encoded as a string and is decoded before MCP dispatch.",
    schema: "GithubPrMonitorStateInput",
  },
];

const OPENAPI_ACTION_TOOL_NAMES = new Set([
  "agent_guide",
  "goal_intake",
  "goal_loop",
  "project_select",
  "workspace_list_projects",
  "project_status",
  "project_rules",
  "code_search",
  "file_read_slice",
  "file_apply_patch",
  "file_create",
  "command_run",
  "local_shell_run",
  "e2e_start_server",
  "e2e_run_command",
  "e2e_test_and_show_screenshot",
  "e2e_screenshot",
  "e2e_open_url_screenshot",
  "repo_status",
  "repo_diff_summary",
  "github_pr_monitor_read",
  "github_pr_monitor_prepare",
  "github_pr_monitor_execute",
  "github_pr_monitor_mutate",
  "github_pr_monitor_state",
  "save_chatgpt_image",
  "save_chatgpt_image_from_url",
]);
const GITHUB_PR_AUTHORIZATION_BASE_FIELDS = [
  "protocolVersion", "schemaVersion", "ownerId", "leaseKey", "fence", "logicalIdentity", "operationKey",
  "operationHeadSha", "effectIdentity", "targetDigest", "policyDigest", "bindingDigest",
] as const;
const GITHUB_PR_AUTHORIZATION_EFFECT_FIELDS = ["effectKey", "effectKind"] as const;
const GITHUB_PR_AUTHORIZATION_FIELDS = [...GITHUB_PR_AUTHORIZATION_BASE_FIELDS, ...GITHUB_PR_AUTHORIZATION_EFFECT_FIELDS] as const;
const GITHUB_PR_AUTHORIZATION_REQUIRED = new Set<string>(GITHUB_PR_AUTHORIZATION_BASE_FIELDS);
const GITHUB_PR_MUTATION_COMMON_FIELDS = [
  "runId", "actionPlanId", "idempotencyKey", "eventId", "repository", "author", "prNumber", "expectedHeadSha", "operation",
  ...GITHUB_PR_AUTHORIZATION_FIELDS,
] as const;
const GITHUB_PR_MUTATE_OPERATION_FIELDS: Record<string, { allowed: readonly string[]; required: readonly string[] }> = {
  post_reply: { allowed: ["body", "threadId", "triggerId"], required: ["body", "threadId"] },
  resolve_thread: { allowed: ["threadId", "triggerId", "replyReceiptId"], required: ["threadId", "triggerId", "replyReceiptId"] },
  rerequest_reviewer: { allowed: ["reviewer"], required: ["reviewer"] },
  push_prepared_worktree: { allowed: ["worktreePath", "headRef", "verificationReceipt"], required: ["worktreePath", "headRef", "verificationReceipt"] },
};

const GITHUB_PR_ACTION_FIELDS: Record<string, { allowed: ReadonlySet<string>; required: ReadonlySet<string> }> = {
  github_pr_monitor_read: {
    allowed: new Set(["runId", "actionPlanId", "repository", "author", "prNumber"]),
    required: new Set(["runId", "actionPlanId", "repository", "author"]),
  },
  github_pr_monitor_prepare: {
    allowed: new Set([...GITHUB_PR_MUTATION_COMMON_FIELDS, "headRef"]),
    required: new Set([...GITHUB_PR_MUTATION_COMMON_FIELDS.filter((field) => !GITHUB_PR_AUTHORIZATION_EFFECT_FIELDS.includes(field as "effectKey" | "effectKind"))]),
  },
  github_pr_monitor_execute: {
    allowed: new Set([...GITHUB_PR_MUTATION_COMMON_FIELDS, "worktreePath", "headRef", "ociImageDigest", "suggestions"]),
    required: new Set([...GITHUB_PR_MUTATION_COMMON_FIELDS, "worktreePath", "headRef", "ociImageDigest", "suggestions"]),
  },
  github_pr_monitor_mutate: {
    allowed: new Set([...GITHUB_PR_MUTATION_COMMON_FIELDS, "body", "threadId", "triggerId", "replyReceiptId", "reviewer", "worktreePath", "headRef", "verificationReceipt"]),
    required: new Set(GITHUB_PR_MUTATION_COMMON_FIELDS),
  },
  github_pr_monitor_state: {
    allowed: new Set(["runId", "actionPlanId", "idempotencyKey", "eventId", "command", "input"]),
    required: new Set(["runId", "actionPlanId", "idempotencyKey", "eventId", "command"]),
  },
};

function openApiActionRoutes(mode: ActionsMode): ActionRoute[] {
  return ACTION_ROUTES.filter(
    (route) =>
      OPENAPI_ACTION_TOOL_NAMES.has(route.tool) &&
      (mode === "general" || GITHUB_PR_MONITOR_TOOL_NAMES.has(route.tool)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function actionCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("Action input contains a non-finite number");
      return JSON.stringify(value);
    case "string": return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(actionCanonicalJson).join(",")}]`;
      return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
        `${JSON.stringify(key)}:${actionCanonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
    default: throw new Error(`Action input contains unsupported ${typeof value}`);
  }
}

function actionRequestDigest(input: unknown): string {
  return createHash("sha256").update(actionCanonicalJson(input), "utf8").digest("hex");
}
function actionProofExact(value: unknown, tool: string, ok: boolean): boolean {
  if (!isRecord(value)) return false;
  const expected = toolCallProof(tool, ok);
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}
function actionToolCallExact(value: unknown, tool: string, ok: boolean, input: Record<string, unknown>): boolean {
  if (!isRecord(value)) return false;
  const expectedProof = toolCallProof(tool, ok);
  const expectedKeys = [...Object.keys(expectedProof), "toolName", "input"].sort();
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && Object.entries(expectedProof).every(([key, expectedValue]) => value[key] === expectedValue)
    && value.toolName === tool
    && (() => {
      try { return actionCanonicalJson(value.input) === actionCanonicalJson(input); } catch { return false; }
    })();
}

function actionInput(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return {};
  return isRecord(body.input) ? body.input : body;
}

function actionInputForRoute(route: ActionRoute, body: unknown): Record<string, unknown> {
  const input = { ...actionInput(body) };
  if (route.tool === "project_select" && input.preset === undefined) {
    input.preset = "full-write";
  }
  return input;
}

function genericToolInput(body: unknown): { toolName: string; input: Record<string, unknown> } {
  const raw =
    isRecord(body) && isRecord(body.input) && typeof body.input.toolName === "string"
      ? body.input
      : isRecord(body)
        ? body
        : {};
  const toolName = typeof raw.toolName === "string" ? raw.toolName.trim() : "";
  let input: Record<string, unknown> = {};
  if (isRecord(raw.input)) {
    input = { ...raw.input };
  } else if (typeof raw.input === "string") {
    try {
      const parsed: unknown = JSON.parse(raw.input);
      if (isRecord(parsed)) input = { ...parsed };
    } catch {
      input = {};
    }
  }
  if (toolName === "project_select" && input.preset === undefined) {
    input.preset = "full-write";
  }
  return { toolName, input };
}
function invalidActionInput(toolName: string, detail: string): CallToolResultLike {
  const message = `Invalid arguments for tool ${toolName}: ${detail}`;
  return {
    isError: true,
    structuredContent: { code: "INVALID_INPUT", error: message },
    content: [{ type: "text", text: message }],
  };
}

function strictGithubPrActionInput(
  route: ActionRoute,
  body: unknown,
): { input: Record<string, unknown> } | { error: CallToolResultLike } | undefined {
  const fields = GITHUB_PR_ACTION_FIELDS[route.tool];
  if (!fields) return undefined;
  if (!isRecord(body)) return { error: invalidActionInput(route.tool, "request body must be an object") };

  const extra = Object.keys(body).filter((key) => !fields.allowed.has(key));
  if (extra.length > 0) return { error: invalidActionInput(route.tool, `unexpected field(s): ${extra.join(", ")}`) };

  const missing = [...fields.required].filter((key) => body[key] === undefined);
  if (missing.length > 0) return { error: invalidActionInput(route.tool, `missing required field(s): ${missing.join(", ")}`) };
  if (route.tool === "github_pr_monitor_mutate") {
    const operation = typeof body.operation === "string" ? body.operation : "";
    const operationFields = GITHUB_PR_MUTATE_OPERATION_FIELDS[operation];
    if (!operationFields) return { error: invalidActionInput(route.tool, "operation is not a supported fixed mutation") };
    const operationExtra = Object.keys(body).filter((key) =>
      !GITHUB_PR_MUTATION_COMMON_FIELDS.includes(key as (typeof GITHUB_PR_MUTATION_COMMON_FIELDS)[number])
      && !operationFields.allowed.includes(key),
    );
    if (operationExtra.length > 0) {
      return { error: invalidActionInput(route.tool, `unexpected field(s) for ${operation}: ${operationExtra.join(", ")}`) };
    }
  }
  if (route.tool !== "github_pr_monitor_read" && route.tool !== "github_pr_monitor_state") {
    if (body.protocolVersion !== 1 || body.schemaVersion !== 4) {
      return { error: invalidActionInput(route.tool, "protocolVersion=1 and schemaVersion=4 are required") };
    }
    const effectFields = GITHUB_PR_AUTHORIZATION_EFFECT_FIELDS.filter((field) => body[field] !== undefined);
    if (effectFields.length !== 0 && effectFields.length !== GITHUB_PR_AUTHORIZATION_EFFECT_FIELDS.length) {
      return { error: invalidActionInput(route.tool, "effectKey and effectKind must be provided together") };
    }
  }

  const input = { ...body };
  if (route.tool === "github_pr_monitor_state" && input.input !== undefined) {
    if (typeof input.input !== "string") {
      return { error: invalidActionInput(route.tool, "input must be a JSON object encoded as a string") };
    }
    if (Buffer.byteLength(input.input, "utf8") > 64 * 1024) {
      return { error: invalidActionInput(route.tool, "encoded input exceeds 64KiB") };
    }
    try {
      const decoded: unknown = JSON.parse(input.input);
      if (!isRecord(decoded)) {
        return { error: invalidActionInput(route.tool, "input must encode a JSON object") };
      }
      input.input = decoded;
    } catch {
      return { error: invalidActionInput(route.tool, "input must encode valid JSON") };
    }
    const evidenceError = validateMonitorEvidenceEnvelope(
      String(input.command),
      input.input as Record<string, unknown>,
    );
    if (evidenceError) return { error: invalidActionInput(route.tool, evidenceError) };
  }

  return { input };
}

function validateMonitorEvidenceEnvelope(command: string, input: Record<string, unknown>): string | undefined {
  const evidence = input.receipt;
  if (evidence === undefined) return undefined;
  if (!isRecord(evidence) || evidence.ok !== true || typeof evidence.tool !== "string") {
    return `${command} receipt must be a successful typed ActionToolResponse`;
  }
  const evidenceKeys = ["ok", "protocolVersion", "schemaVersion", "requestDigest", "tool", "toolCall", "text", "imageMarkdownList", "structuredContent"];
  if (Object.keys(evidence).some((key) => !evidenceKeys.includes(key))) {
    return `${command} receipt is not the exact v4 ActionToolResponse shape`;
  }
  const call = isRecord(evidence.toolCall) ? evidence.toolCall : undefined;
  const callInput = call && isRecord(call.input) ? call.input : undefined;
  const requestDigest = evidence.requestDigest;
  if (
    evidence.protocolVersion !== 1
    || evidence.schemaVersion !== 4
    || typeof requestDigest !== "string"
    || !/^[0-9a-f]{64}$/u.test(requestDigest)
    || !call
    || !callInput
    || !actionToolCallExact(call, evidence.tool, true, callInput)
    || requestDigest !== actionRequestDigest(callInput)
    || evidence.tool !== call.toolName
    || call.namespace !== "ChatGPT_To_Codex"
    || call.tool !== evidence.tool
    || call.ok !== true
    || typeof evidence.text !== "string"
    || !Array.isArray(evidence.imageMarkdownList)
    || evidence.imageMarkdownList.length !== 0
  ) {
    return `${command} receipt must carry the exact v4 ActionToolResponse input binding`;
  }
  const structured = evidence.structuredContent;
  if (!isRecord(structured)
    || structured.protocolVersion !== 1
    || structured.schemaVersion !== 4
    || structured.requestDigest !== requestDigest
    || structured.ok !== true
    || !actionProofExact(structured.chatgpt2codexToolCall, evidence.tool, true)
    || typeof structured.receiptId !== "string"
    || !/^[0-9a-f]{64}$/u.test(structured.receiptId)) {
    return `${command} receipt must carry protocolVersion=1, schemaVersion=4, and a bounded receiptId`;
  }
  let encodedStructured: string;
  try {
    encodedStructured = JSON.stringify(structured);
  } catch {
    return `${command} receipt is not JSON-serializable`;
  }
  if (Buffer.byteLength(encodedStructured, "utf8") > 256 * 1024) {
    return `${command} receipt exceeds its bounded 256KiB envelope`;
  }
  if (evidence.tool === "github_pr_monitor_read") {
    const requiredReadKeys = [
      "chatgpt2codexToolCall", "protocolVersion", "schemaVersion", "requestDigest", "namespace", "tool", "operation", "ok",
      "runId", "actionPlanId", "repository", "author", "prs", "observedAt", "receiptId",
    ];
    if (Object.keys(structured).some((key) => !requiredReadKeys.includes(key))
      || structured.namespace !== "ChatGPT_To_Codex"
      || structured.tool !== "github_pr_monitor_read"
      || structured.operation !== "read"
      || structured.repository !== "Yeachan-Heo/gajae-code"
      || structured.author !== "twoimo"
      || !Array.isArray(structured.prs)
      || structured.prs.length > 500) {
      return `${command} read receipt is not the exact fixed-repository envelope`;
    }
    for (const snapshotValue of structured.prs) {
      if (!isRecord(snapshotValue)) return `${command} read receipt contains an invalid PR snapshot`;
      const snapshotKeys = [
        "number", "url", "state", "author", "baseRepository", "headRepository", "baseRefName", "baseRefOid",
        "headRefName", "headRefOid", "reviewRequests", "reviews", "comments", "latestReviews", "statusCheckRollup", "reviewThreads",
      ];
      if (Object.keys(snapshotValue).some((key) => !snapshotKeys.includes(key))
        || Object.hasOwn(snapshotValue, "protocolVersion")
        || Object.hasOwn(snapshotValue, "schemaVersion")) {
        return `${command} read receipt contains an unapproved PR snapshot shape`;
      }
      const threads = snapshotValue.reviewThreads;
      if (!isRecord(threads) || Object.keys(threads).some((key) => key !== "nodes") || !Array.isArray(threads.nodes)) {
        return `${command} read receipt contains an invalid compact thread boundary`;
      }
      for (const threadValue of threads.nodes) {
        if (!isRecord(threadValue)) return `${command} read receipt contains an invalid compact thread`;
        if (Object.keys(threadValue).some((key) => !["id", "isResolved", "isOutdated", "comments"].includes(key))) {
          return `${command} read receipt contains an invalid compact thread shape`;
        }
        const comments = threadValue.comments;
        if (!isRecord(comments) || Object.keys(comments).some((key) => key !== "nodes") || !Array.isArray(comments.nodes)) {
          return `${command} read receipt contains an invalid compact comment boundary`;
        }
      }
    }
    return undefined;
  }
  if (evidence.tool !== "github_pr_monitor_prepare"
    && evidence.tool !== "github_pr_monitor_execute"
    && evidence.tool !== "github_pr_monitor_mutate") {
    return `${command} receipt has an unsupported monitor tool`;
  }
  return undefined;
}

function bearerToken(req: Request): string | undefined {
  const raw = req.header("authorization") ?? "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

async function requireOwnerBearer(ctx: ToolContext, req: Request, res: Response): Promise<boolean> {
  const token = bearerToken(req);
  if (!token || !(await verifyOwnerToken(ctx.stateDir, token))) {
    res.status(401).json({
      ok: false,
      error: "Missing or invalid Bearer token. Use the chatgpt2codex owner token as the GPT Action API key.",
    });
    return false;
  }
  return true;
}

async function callRegisteredTool(
  ctx: ToolContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<CallToolResultLike> {
  // Desktop-control tools are blocked on the generic action bridge (even for
  // the owner-bearer /actions/call-tool route, even if isControlEnabled() is
  // on) unless the owner has separately opted in to exposing them to ChatGPT
  // via CHATGPT2CODEX_CONTROL_CHATGPT (isControlChatGptExposed) — the
  // public-product default keeps this block in place, matching the
  // tools/list hide in src/server/tools.ts installChatGptToolListHandler.
  if (CONTROL_TOOL_NAMES.has(toolName) && !isControlChatGptExposed()) {
    const message = `Tool ${toolName} is not available through the chatgpt2codex action bridge.`;
    return {
      isError: true,
      structuredContent: { code: "PERMISSION_DENIED", error: message },
      content: [{ type: "text", text: message }],
    };
  }
  // project_select isn't itself a control tool (so it isn't caught by
  // CONTROL_TOOL_NAMES above), but preset="control" is the only way to grant
  // a control lease and clear the kill switch (see src/server/tools.ts
  // project_select handler / src/control/queue.ts clearKill). A remote
  // owner-bearer caller must never be able to resume a locally killed
  // control session or grant itself a control lease through the bridge, so
  // this is rejected at the single choke point both /actions/call-tool
  // (genericToolInput) and the per-route bridge (actionInputForRoute) call
  // through. The local/MCP zod path (registerTool project_select) is
  // untouched, so a local approver can still grant/resume control normally.
  if (toolName === "project_select" && input.preset === "control") {
    const message = "preset=control cannot be granted through the chatgpt2codex action bridge.";
    await ctx.ledger.append({ type: "control.bridge.rejected", preset: "control" }).catch(() => undefined);
    return {
      isError: true,
      structuredContent: { code: "PERMISSION_DENIED", error: message },
      content: [{ type: "text", text: message }],
    };
  }
  const server = await createMcpServer(ctx);
  const tools = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })._registeredTools;
  const registered = tools?.[toolName];
  const handler = registered?.handler;
  if (!handler) {
    return {
      isError: true,
      structuredContent: { code: "TOOL_NOT_FOUND", error: `Tool not found: ${toolName}` },
      content: [{ type: "text", text: `Tool not found: ${toolName}` }],
    };
  }
  // This bridge calls the raw registered handler directly, bypassing the
  // MCP SDK's normal tools/call path (McpServer#validateToolInput), which is
  // where every tool's zod inputSchema (ranges, enums, refine, min/max) is
  // actually enforced. Without re-running that validation here, a bridge
  // caller can send out-of-schema values — e.g. a windowPoint xRel/yRel
  // outside [0,1], or an invalid enum — straight into the tool handler.
  // Re-validate against the same registered schema before dispatching.
  if (registered?.inputSchema) {
    const objSchema = normalizeObjectSchema(registered.inputSchema as never);
    const schemaToParse = objSchema ?? registered.inputSchema;
    const parsed = await safeParseAsync(schemaToParse as never, input);
    if (!parsed.success) {
      const message = `Invalid arguments for tool ${toolName}: ${getParseErrorMessage((parsed as { error: unknown }).error)}`;
      return {
        isError: true,
        structuredContent: { code: "INVALID_INPUT", error: message },
        content: [{ type: "text", text: message }],
      };
    }
    return handler(parsed.data as Record<string, unknown>);
  }
  return handler(input);
}

function resultText(result: CallToolResultLike): string {
  return (result.content ?? [])
    .map((item) => item.text)
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

function isScreenshotRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.path.includes(`${["", ".chatgpt2codex", "e2e", "screenshots", ""].join("/")}`) &&
    value.path.endsWith(".png")
  );
}

async function attachInlineScreenshotShares(
  ctx: ToolContext,
  publicOrigin: string,
  value: unknown,
): Promise<{ value: unknown; markdown: string[] }> {
  const markdown: string[] = [];
  async function visit(node: unknown): Promise<unknown> {
    if (Array.isArray(node)) {
      return Promise.all(node.map((item) => visit(item)));
    }
    if (!isRecord(node)) return node;

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = await visit(child);
    }
    if (isScreenshotRecord(out)) {
      const share = await createE2eScreenshotShare(ctx.stateDir, String(out.path), publicOrigin);
      out.inlineUrl = share.url;
      out.inlineMarkdown = share.markdown;
      out.inlineExpiresAt = share.expiresAt;
      out.markdown = share.markdown;
      markdown.push(share.markdown);
    }
    return out;
  }
  return { value: await visit(value), markdown };
}

async function actionResponse(
  ctx: ToolContext,
  publicOrigin: string,
  tool: string,
  toolCallInput: Record<string, unknown>,
  result: CallToolResultLike,
): Promise<Record<string, unknown>> {
  const enriched = await attachInlineScreenshotShares(ctx, publicOrigin, result.structuredContent ?? {});
  const text = resultText(result);
  const inlineText = enriched.markdown.length > 0 ? `${text}\n\n${enriched.markdown.join("\n")}` : text;
  const ok = result.isError !== true;
  const requestDigest = actionRequestDigest(toolCallInput);
  const monitor = GITHUB_PR_MONITOR_TOOL_NAMES.has(tool);
  const structuredContent = monitor
    ? {
        ...(isRecord(enriched.value) ? enriched.value : {}),
        protocolVersion: 1,
        schemaVersion: 4,
        requestDigest,
        chatgpt2codexToolCall: toolCallProof(tool, ok),
      }
    : enriched.value;
  return {
    ok,
    protocolVersion: 1,
    schemaVersion: 4,
    requestDigest,
    tool,
    toolCall: {
      ...toolCallProof(tool, ok),
      toolName: tool,
      input: structuredClone(toolCallInput),
    },
    text: inlineText,
    ...(monitor ? { imageMarkdownList: enriched.markdown } : {
      imageMarkdown: enriched.markdown[0],
      imageMarkdownList: enriched.markdown,
    }),
    structuredContent,
    ...(result.isError ? { isError: true } : {}),
  };
}

const CHATGPT_ACTION_DESCRIPTION_LIMIT = 300;

function chatGptActionDescription(description: string): string {
  if (description.length <= CHATGPT_ACTION_DESCRIPTION_LIMIT) return description;
  return `${description.slice(0, CHATGPT_ACTION_DESCRIPTION_LIMIT - 1).trimEnd()}…`;
}

function openApiSpec(publicOrigin: string, mode: ActionsMode): Record<string, unknown> {
  const paths: Record<string, unknown> = {
    "/actions/health": {
      get: {
        operationId: "action_health",
        summary: "Check chatgpt2codex action bridge health",
        security: [],
        responses: {
          "200": {
            description: "Health status",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/HealthResponse" } } },
          },
        },
      },
    },
    "/actions/call-tool": {
      post: {
        operationId: "call_tool",
        summary: "Call any chatgpt2codex MCP tool",
        description: chatGptActionDescription(
          "Full-power owner bridge for Custom GPTs. Use this when a dedicated action route is missing. It calls the named chatgpt2codex MCP tool on the local Mac; do not try to write /Users/... directly from ChatGPT's sandbox. For source edits: select project with preset=full-write, then call file_apply_patch or file_create through this route. The response toolCall object is the required proof that the local tool was actually callable.",
        ),
        security: [{ ownerBearer: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { "$ref": "#/components/schemas/CallToolInput" } } },
        },
        responses: {
          "200": {
            description: "Tool call result",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/ActionToolResponse" } } },
          },
          "401": {
            description: "Missing or invalid owner token",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    },
  };
  if (mode === "github-pr-monitor") {
    delete paths["/actions/call-tool"];
  }

  for (const route of openApiActionRoutes(mode)) {
    paths[route.path] = {
      post: {
        operationId: route.operationId,
        summary: route.summary,
        description: chatGptActionDescription(`ChatGPT_To_Codex tool: ${route.tool}. ${route.description}`),
        security: [{ ownerBearer: [] }],
        requestBody: {
          required: route.schema !== "EmptyInput",
          content: { "application/json": { schema: { "$ref": `#/components/schemas/${route.schema}` } } },
        },
        responses: {
          "200": {
            description: "Tool call result",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/ActionToolResponse" } } },
          },
          "401": {
            description: "Missing or invalid owner token",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title:
        mode === "github-pr-monitor"
          ? "chatgpt2codex GitHub PR Monitor Actions"
          : "chatgpt2codex Custom GPT Actions",
      version: "0.1.6",
      description:
        mode === "github-pr-monitor"
          ? "Monitor-only OpenAPI bridge for the deployed Custom GPT. It exposes only health plus the five dedicated github_pr_monitor_read, github_pr_monitor_prepare, github_pr_monitor_execute, github_pr_monitor_mutate, and github_pr_monitor_state operations. The monitor identity is fixed to repository Yeachan-Heo/gajae-code and author twoimo."
          : "OpenAPI bridge for Custom GPTs. This compact schema stays within 30 operations and exposes workspace_list_projects, project_select, code_search, file_read_slice, file_apply_patch, file_create, local_shell_run, and e2e_test_and_show_screenshot for source editing. Dedicated strict PR monitor actions github_pr_monitor_read, github_pr_monitor_prepare, github_pr_monitor_execute, github_pr_monitor_mutate, and github_pr_monitor_state dispatch through their registered MCP tools; they are fixed to Yeachan-Heo/gajae-code and authenticated author twoimo, and return toolCall.namespace=ChatGPT_To_Codex proof. Use goal_intake or goal_loop for broad work; use code_search followed by narrow file_read_slice calls. It exposes E2E server/app launch plus screenshot capture. ChatGPT's sandbox cannot write /Users/... directly; for images use save_chatgpt_image/save_chatgpt_image_from_url.",
      "x-chatgpt2codex-tool-proof": TOOL_AVAILABILITY_GATE,
      "x-chatgpt2codex-openapi-operation-count": Object.keys(paths).length,
      "x-chatgpt2codex-tool-names": openApiActionRoutes(mode).map((route) => route.tool),
    },
    servers: [{ url: publicOrigin }],
    paths,
    components: {
      securitySchemes: {
        ownerBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "chatgpt2codex-owner-token",
          description: "Use the chatgpt2codex owner token shown at init/setup time. Never commit it.",
        },
      },
      schemas: {
        EmptyInput: { type: "object", additionalProperties: false, properties: {} },
        CallToolInput: {
          type: "object",
          additionalProperties: false,
          required: ["toolName", "input"],
          properties: {
            toolName: {
              type: "string",
              description:
                "Registered chatgpt2codex MCP tool name, e.g. file_apply_patch, file_create, local_shell_run, repo_status, git_commit, git_push.",
            },
            input: {
              type: "string",
              description: "JSON object encoded as a string and passed to the named chatgpt2codex MCP tool. Example: {\"runId\":\"run-1\",\"actionPlanId\":\"bootstrap\"}.",
            },
          },
        },
        GoalIntakeInput: {
          type: "object",
          additionalProperties: false,
          required: ["goal"],
          properties: {
            goal: {
              type: "string",
              description:
                "The user's broad /goal, deep research, implementation, debugging, review, or planning request. Pass the full request text.",
            },
            projectId: { type: "string", description: "Optional known project id/name." },
            mode: { type: "string", enum: ["implement", "research", "debug", "review", "plan"] },
            urgency: { type: "string", enum: ["normal", "fast"] },
          },
        },
        GoalLoopInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            goal: {
              type: "string",
              description:
                "The user's full coding goal. Required on the first loop call unless loopId is provided.",
            },
            loopId: {
              type: "string",
              description: "Existing local loop id returned by a previous goal_loop call.",
            },
            projectId: { type: "string", description: "Optional known project id/name." },
            mode: { type: "string", enum: ["implement", "research", "debug", "review", "plan"] },
            maxTurns: { type: "integer", minimum: 1, maximum: 50, description: "Maximum ChatGPT action turns for this loop." },
            lastResult: {
              type: "string",
              description: "Short summary of the previous inspect/edit/verify batch before continuing.",
            },
          },
        },
        WorkspaceListProjectsInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
            includeDirty: { type: "boolean" },
            includeRecent: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        WorkspaceRefreshIndexInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            depth: { type: "integer", minimum: 1 },
            includeHidden: { type: "boolean" },
          },
        },
        WorkspaceGetProjectInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string" },
            path: { type: "string" },
          },
        },
        ProjectOnlyInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        ProjectSelectInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "reason"],
          properties: {
            projectId: { type: "string", description: "Project id or name, for example chatgpt2codex." },
            reason: { type: "string" },
            preset: {
              type: "string",
              enum: ["read-only", "tests-only", "full-write", "image-only"],
              description: "Defaults to full-write on the GPT Actions bridge when omitted.",
            },
            confirmSwitch: { type: "boolean" },
          },
        },
        CodeSearchInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "query"],
          properties: {
            projectId: { type: "string" },
            query: { type: "string" },
            mode: { type: "string", enum: ["text", "symbol", "semantic"] },
            maxResults: { type: "integer", minimum: 1, maximum: 200 },
          },
        },
        FileReadSliceInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "path"],
          properties: {
            projectId: { type: "string" },
            path: { type: "string" },
            start: { type: "integer", minimum: 1 },
            end: { type: "integer", minimum: 1 },
            offset: { type: "integer", minimum: 0 },
          },
        },
        FileApplyPatchInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "patch"],
          properties: {
            projectId: { type: "string" },
            patch: { type: "string", description: "Codex-style *** Begin Patch envelope." },
            preconditionHashes: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        FileCreateInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "path", "content"],
          properties: {
            projectId: { type: "string" },
            path: { type: "string" },
            content: { type: "string" },
            overwrite: { type: "boolean" },
          },
        },
        CommandRunInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "commandId"],
          properties: {
            projectId: { type: "string" },
            commandId: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                writesWorkspace: { type: "boolean" },
                needsNetwork: { type: "boolean" },
                expectedDurationSec: { type: "integer", minimum: 1 },
              },
            },
          },
        },
        LocalShellRunInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "command"],
          properties: {
            projectId: { type: "string" },
            command: { type: "string" },
            cwd: { type: "string" },
            timeoutSec: { type: "integer", minimum: 1, maximum: 900 },
            intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                reason: { type: "string" },
                writesWorkspace: { type: "boolean" },
                needsNetwork: { type: "boolean" },
                destructive: { type: "boolean" },
              },
            },
          },
        },
        E2eStartServerInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "command"],
          properties: {
            projectId: { type: "string" },
            command: { type: "string", description: "Dev/server command to run in the project, e.g. npm run dev -- --host 127.0.0.1." },
            cwd: { type: "string", description: "Optional project-relative working directory." },
            label: { type: "string" },
            waitUrl: { type: "string", description: "Optional URL to poll until ready." },
            waitTimeoutSec: { type: "integer", minimum: 1, maximum: 120 },
            intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                writesWorkspace: { type: "boolean" },
                needsNetwork: { type: "boolean" },
                destructive: { type: "boolean" },
              },
            },
          },
        },
        E2eOpenTargetInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string", description: "Required when appPath is project-relative or screenshot proof should be tied to a project." },
            url: { type: "string" },
            appName: { type: "string", description: "Installed macOS app name, e.g. Safari or ChatGPT." },
            appPath: { type: "string", description: "Absolute /Applications path or project-relative .app path." },
            args: { type: "array", items: { type: "string" } },
          },
        },
        E2eRunCommandInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "command"],
          properties: {
            projectId: { type: "string" },
            command: { type: "string", description: "E2E/test command to run in the project, e.g. npm run test:e2e." },
            cwd: { type: "string", description: "Optional project-relative working directory." },
            timeoutSec: { type: "integer", minimum: 1, maximum: 900 },
            label: { type: "string" },
            captureScreenshot: { type: "boolean", description: "Defaults to true. Set false only for non-visual E2E checks." },
            screenshotUrl: { type: "string", description: "Optional URL to open before the screenshot after the command exits." },
            screenshotWaitMs: { type: "integer", minimum: 0, maximum: 30000 },
            openAfterCapture: { type: "boolean" },
            intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                writesWorkspace: { type: "boolean" },
                needsNetwork: { type: "boolean" },
                destructive: { type: "boolean" },
              },
            },
          },
        },
        E2eTestAndShowScreenshotInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string", description: "Optional. If omitted, use the currently selected project." },
            instruction: {
              type: "string",
              description: "The user's natural-language request, e.g. e2e 테스트하고 스크린샷 보여줘.",
            },
            url: { type: "string", description: "Optional local localhost/127.0.0.1 page URL to open before screenshot capture." },
            cwd: { type: "string" },
            timeoutSec: { type: "integer", minimum: 1, maximum: 900 },
            screenshotWaitMs: { type: "integer", minimum: 0, maximum: 30000 },
            openAfterCapture: { type: "boolean" },
          },
        },
        E2eScreenshotInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: {
            projectId: { type: "string" },
            label: { type: "string" },
            waitMs: { type: "integer", minimum: 0, maximum: 30000 },
            openAfterCapture: { type: "boolean", description: "Open the screenshot on the Mac immediately after capture." },
          },
        },
        E2eOpenUrlScreenshotInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "url"],
          properties: {
            projectId: { type: "string" },
            url: { type: "string" },
            label: { type: "string" },
            waitMs: { type: "integer", minimum: 0, maximum: 30000 },
            openAfterCapture: { type: "boolean" },
          },
        },
        CheckpointShowInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "checkpointId"],
          properties: {
            projectId: { type: "string" },
            checkpointId: { type: "string" },
          },
        },
        GitCommitInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "message"],
          properties: {
            projectId: { type: "string" },
            message: { type: "string" },
            paths: { type: "array", items: { type: "string" } },
          },
        },
        GitPushInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: {
            projectId: { type: "string" },
            remote: { type: "string" },
            branch: { type: "string" },
          },
        },
        SaveChatGptImageInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string" },
            destPath: { type: "string" },
            url: { type: "string" },
            sourcePath: { type: "string" },
            source: { type: "string", enum: ["auto", "url", "clipboard", "download", "path"] },
            maxAgeSec: { type: "integer", minimum: 1, maximum: 86400 },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        ImportChatGptImageUrlInput: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: {
            url: { type: "string" },
            projectId: { type: "string" },
            destPath: { type: "string" },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        ListImagesInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        MonitorAuthorizationBindingV1: {
          type: "object",
          additionalProperties: false,
          required: [...GITHUB_PR_AUTHORIZATION_BASE_FIELDS],
          properties: {
            protocolVersion: { type: "integer", const: 1 },
            schemaVersion: { type: "integer", const: 4 },
            ownerId: { type: "string", minLength: 1, maxLength: 300 },
            leaseKey: { type: "string", minLength: 1, maxLength: 300 },
            fence: { type: "integer", minimum: 1 },
            logicalIdentity: { type: "string", pattern: "^[0-9a-f]{64}$" },
            operationKey: { type: "string", pattern: "^[0-9a-f]{64}$" },
            operationHeadSha: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
            effectIdentity: { type: "string", pattern: "^[0-9a-f]{64}$" },
            effectKey: { type: "string", pattern: "^[0-9a-f]{64}$" },
            effectKind: { type: "string", enum: ["prepare_create", "prepare_quarantine", "post_reply", "resolve_thread", "rerequest_reviewer", "commit", "normal_push"] },
            targetDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
            policyDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
            bindingDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
        },
        GithubPrMonitorReadInput: {
          type: "object",
          additionalProperties: false,
          required: ["runId", "actionPlanId", "repository", "author"],
          properties: {
            runId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            actionPlanId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            repository: { type: "string", const: "Yeachan-Heo/gajae-code" },
            author: { type: "string", const: "twoimo" },
            prNumber: { type: "integer", minimum: 1 },
          },
        },
        GithubPrMonitorPrepareInput: {
          type: "object",
          additionalProperties: false,
          required: ["runId", "actionPlanId", "idempotencyKey", "eventId", "repository", "author", "prNumber", "expectedHeadSha", "operation", ...GITHUB_PR_AUTHORIZATION_BASE_FIELDS],
          properties: {
            runId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            actionPlanId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            eventId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            repository: { type: "string", const: "Yeachan-Heo/gajae-code" },
            author: { type: "string", const: "twoimo" },
            prNumber: { type: "integer", minimum: 1 },
            expectedHeadSha: { type: "string", pattern: "^[0-9a-fA-F]{40}$", minLength: 40, maxLength: 40 },
            operation: { type: "string", enum: ["create", "quarantine"] },
            headRef: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$", maxLength: 241 },
            protocolVersion: { type: "integer", const: 1 }, schemaVersion: { type: "integer", const: 4 },
            ownerId: { type: "string", minLength: 1, maxLength: 300 }, leaseKey: { type: "string", minLength: 1, maxLength: 300 }, fence: { type: "integer", minimum: 1 },
            logicalIdentity: { type: "string", pattern: "^[0-9a-f]{64}$" }, operationKey: { type: "string", pattern: "^[0-9a-f]{64}$" }, operationHeadSha: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
            effectIdentity: { type: "string", pattern: "^[0-9a-f]{64}$" }, effectKey: { type: "string", pattern: "^[0-9a-f]{64}$" }, effectKind: { type: "string", enum: ["prepare_create", "prepare_quarantine", "post_reply", "resolve_thread", "rerequest_reviewer", "commit", "normal_push"] },
            targetDigest: { type: "string", pattern: "^[0-9a-f]{64}$" }, policyDigest: { type: "string", pattern: "^[0-9a-f]{64}$" }, bindingDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
        },
        GithubPrMonitorExecuteInput: {
          type: "object",
          additionalProperties: false,
          required: ["runId", "actionPlanId", "idempotencyKey", "eventId", "repository", "author", "prNumber", "expectedHeadSha", "operation", "worktreePath", "headRef", "ociImageDigest", "suggestions", ...GITHUB_PR_AUTHORIZATION_BASE_FIELDS, ...GITHUB_PR_AUTHORIZATION_EFFECT_FIELDS],
          properties: {
            runId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            actionPlanId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            eventId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            repository: { type: "string", const: "Yeachan-Heo/gajae-code" },
            author: { type: "string", const: "twoimo" },
            prNumber: { type: "integer", minimum: 1 },
            expectedHeadSha: { type: "string", pattern: "^[0-9a-fA-F]{40}$", minLength: 40, maxLength: 40 },
            operation: { type: "string", const: "apply_suggestions" },
            worktreePath: { type: "string", minLength: 1 },
            headRef: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$", maxLength: 241 },
            ociImageDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
            suggestions: {
              type: "array",
              minItems: 1,
              maxItems: 10,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["threadId", "commentId", "reviewer", "path", "startLine", "line", "expectedOriginal", "replacement", "sourceDigest"],
                properties: {
                  threadId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
                  commentId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
                  reviewer: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.\\[\\]-]{0,79}$", maxLength: 80 },
                  path: { type: "string", minLength: 1 },
                  startLine: { type: "integer", minimum: 1 },
                  line: { type: "integer", minimum: 1 },
                  expectedOriginal: { type: "string", minLength: 1, maxLength: 65536, pattern: "^[^\\u0000]*$" },
                  replacement: { type: "string", maxLength: 65536, pattern: "^[^\\u0000]*$" },
                  sourceDigest: { type: "string", pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 },
                },
              },
            },
            protocolVersion: { type: "integer", const: 1 }, schemaVersion: { type: "integer", const: 4 },
            ownerId: { type: "string", minLength: 1, maxLength: 300 }, leaseKey: { type: "string", minLength: 1, maxLength: 300 }, fence: { type: "integer", minimum: 1 },
            logicalIdentity: { type: "string", pattern: "^[0-9a-f]{64}$" }, operationKey: { type: "string", pattern: "^[0-9a-f]{64}$" }, operationHeadSha: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
            effectIdentity: { type: "string", pattern: "^[0-9a-f]{64}$" }, effectKey: { type: "string", pattern: "^[0-9a-f]{64}$" }, effectKind: { type: "string", enum: ["prepare_create", "prepare_quarantine", "post_reply", "resolve_thread", "rerequest_reviewer", "commit", "normal_push"] },
            targetDigest: { type: "string", pattern: "^[0-9a-f]{64}$" }, policyDigest: { type: "string", pattern: "^[0-9a-f]{64}$" }, bindingDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
        },
        GithubPrMonitorMutateInput: {
          type: "object",
          additionalProperties: false,
          required: ["runId", "actionPlanId", "idempotencyKey", "eventId", "repository", "author", "prNumber", "expectedHeadSha", "operation", ...GITHUB_PR_AUTHORIZATION_BASE_FIELDS, ...GITHUB_PR_AUTHORIZATION_EFFECT_FIELDS],
          properties: {
            runId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            actionPlanId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            eventId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            repository: { type: "string", const: "Yeachan-Heo/gajae-code" },
            author: { type: "string", const: "twoimo" },
            prNumber: { type: "integer", minimum: 1 },
            expectedHeadSha: { type: "string", pattern: "^[0-9a-fA-F]{40}$", minLength: 40, maxLength: 40 },
            operation: { type: "string", enum: ["post_reply", "resolve_thread", "rerequest_reviewer", "push_prepared_worktree"] },
            body: { type: "string", minLength: 1, maxLength: 6000 },
            threadId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            triggerId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            replyReceiptId: { type: "string", pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 },
            reviewer: { type: "string", pattern: "^[A-Za-z0-9-]{1,39}$", maxLength: 39 },
            worktreePath: { type: "string" },
            headRef: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$", maxLength: 241 },
            verificationReceipt: { "$ref": "#/components/schemas/ActionToolResponse" },
            protocolVersion: { type: "integer", const: 1 }, schemaVersion: { type: "integer", const: 4 },
            ownerId: { type: "string", minLength: 1, maxLength: 300 }, leaseKey: { type: "string", minLength: 1, maxLength: 300 }, fence: { type: "integer", minimum: 1 },
            logicalIdentity: { type: "string", pattern: "^[0-9a-f]{64}$" }, operationKey: { type: "string", pattern: "^[0-9a-f]{64}$" }, operationHeadSha: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
            effectIdentity: { type: "string", pattern: "^[0-9a-f]{64}$" }, effectKey: { type: "string", pattern: "^[0-9a-f]{64}$" }, effectKind: { type: "string", enum: ["prepare_create", "prepare_quarantine", "post_reply", "resolve_thread", "rerequest_reviewer", "commit", "normal_push"] },
            targetDigest: { type: "string", pattern: "^[0-9a-f]{64}$" }, policyDigest: { type: "string", pattern: "^[0-9a-f]{64}$" }, bindingDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
        },
        GithubPrMonitorStateInput: {
          type: "object",
          additionalProperties: false,
          required: ["runId", "actionPlanId", "idempotencyKey", "eventId", "command"],
          properties: {
            runId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            actionPlanId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            eventId: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,300}$", maxLength: 300 },
            command: { type: "string", enum: ["ingest", "plan-cycle", "record-side-effect", "reconcile", "terminal-report", "status"] },
            input: {
              type: "string",
              maxLength: 65536,
              description: "Optional JSON object encoded as a string. Decoded to the registered MCP tool's input object before dispatch.",
            },
          },
        },
        ActionToolResponse: {
          type: "object",
          required: ["ok", "protocolVersion", "schemaVersion", "requestDigest", "tool", "toolCall", "text", "imageMarkdownList", "structuredContent"],
          properties: {
            ok: { type: "boolean" },
            protocolVersion: { type: "integer", const: 1 },
            schemaVersion: { type: "integer", const: 4 },
            requestDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
            tool: { type: "string" },
            toolCall: { "$ref": "#/components/schemas/ToolCallProof" },
            text: { type: "string" },
            imageMarkdown: {
              type: "string",
              description:
                "When present, the assistant must paste this exact markdown image in the final answer so the screenshot renders inline. Do not only report the local path.",
            },
            imageMarkdownList: {
              type: "array",
              items: { type: "string" },
              description: "All inline screenshot markdown images returned by this action.",
            },
            structuredContent: { type: "object", additionalProperties: true },
            isError: { type: "boolean" },
          },
        },
        HealthResponse: {
          type: "object",
          required: ["ok", "name"],
          properties: {
            ok: { type: "boolean" },
            name: { type: "string" },
            actions: { type: "integer" },
            toolAvailabilityGate: { "$ref": "#/components/schemas/ToolAvailabilityGate" },
          },
        },
        ToolAvailabilityGate: {
          type: "object",
          additionalProperties: true,
          required: ["namespace", "app", "rule", "noResultMeans"],
          properties: {
            namespace: { type: "string" },
            app: { type: "string" },
            rule: { type: "string" },
            noResultMeans: { type: "string" },
            wrongSurfaceExamples: { type: "array", items: { type: "string" } },
          },
        },
        ToolCallProof: {
          type: "object",
          additionalProperties: true,
          required: ["namespace", "app", "tool", "ok", "currentTurnProof", "requiredBeforeCoding", "toolName", "input"],
          properties: {
            namespace: { type: "string" },
            app: { type: "string" },
            tool: { type: "string" },
            ok: { type: "boolean" },
            toolName: { type: "string" },
            input: { type: "object", additionalProperties: true },
            currentTurnProof: { type: "boolean" },
            requiredBeforeCoding: { type: "boolean" },
            proceedOnlyIfOk: { type: "boolean" },
            noToolResultMeansNoLocalWork: { type: "boolean" },
            instruction: { type: "string" },
          },
        },
        ErrorResponse: {
          type: "object",
          required: ["ok", "error"],
          properties: {
            ok: { type: "boolean" },
            error: { type: "string" },
          },
        },
      },
    },
  };
}

export function registerActionRoutes(app: Express, ctx: ToolContext, publicUrl: URL): void {
  const publicOrigin = publicUrl.origin;
  const mode = configuredActionsMode();
  const actionRoutes = mode === "github-pr-monitor"
    ? ACTION_ROUTES.filter((route) => GITHUB_PR_MONITOR_TOOL_NAMES.has(route.tool))
    : ACTION_ROUTES;
  const openApiRoutes = openApiActionRoutes(mode);

  if (mode === "github-pr-monitor") {
    const allowedRequests = new Set([
      "GET /actions/health",
      "GET /actions/openapi.json",
      ...actionRoutes.map((route) => `POST ${route.path}`),
    ]);
    app.use("/actions", (req, res, next) => {
      const path = req.originalUrl.split("?", 1)[0] ?? "";
      if (!allowedRequests.has(`${req.method.toUpperCase()} ${path}`)) {
        res.status(404).json({
          ok: false,
          error: "Action route is not available in github-pr-monitor mode.",
        });
        return;
      }
      next();
    });
  }
  app.get("/actions/health", (_req, res) => {
    res.json({
      ok: true,
      name: "chatgpt2codex-actions",
      actions: actionRoutes.length,
      openApiOperations: openApiRoutes.length + (mode === "general" ? 2 : 1),
      openApiToolNames: openApiRoutes.map((route) => route.tool),
      toolAvailabilityGate: TOOL_AVAILABILITY_GATE,
    });
  });

  app.get("/actions/openapi.json", (_req, res) => {
    res.json(openApiSpec(publicOrigin, mode));
  });

  if (mode === "general") {
    app.get("/actions/e2e-screenshot-inline/:token/:filename", async (req, res) => {
      const share = await readE2eScreenshotShare(ctx.stateDir, String(req.params.token ?? ""));
      if (!share) {
        res.status(404).type("text/plain").send("Screenshot link expired or not found.");
        return;
      }
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Length", String(share.bytes));
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.setHeader("Content-Disposition", `inline; filename="${String(req.params.filename ?? "e2e-screenshot.png").replace(/"/g, "")}"`);
      res.send(await fs.readFile(share.path));
    });
  }

  if (mode === "general") {
    app.post("/actions/call-tool", async (req, res) => {
      if (!(await requireOwnerBearer(ctx, req, res))) return;
      const { toolName, input } = genericToolInput(req.body);
      if (!toolName) {
        res.status(400).json({ ok: false, error: "Missing toolName" });
        return;
      }
      if (Object.hasOwn(GITHUB_PR_ACTION_FIELDS, toolName)) {
        res.status(400).json({
          ok: false,
          error: `Dedicated monitor tool ${toolName} must use its strict Action route`,
        });
        return;
      }
      const result = await callRegisteredTool(ctx, toolName, input);
      const response = await actionResponse(ctx, publicOrigin, toolName, { toolName, input }, result);
      response.toolCall = {
        ...(response.toolCall as Record<string, unknown>),
        toolName: "call_tool",
        input: { toolName, input },
      };
      response.requestDigest = actionRequestDigest({ toolName, input });
      res.json(response);
    });
  }

  for (const route of actionRoutes) {
    app.post(route.path, async (req, res) => {
      if (!(await requireOwnerBearer(ctx, req, res))) return;
      const strictInput = strictGithubPrActionInput(route, req.body);
      const routeInput = strictInput
        ? "error" in strictInput
          ? undefined
          : strictInput.input
        : actionInputForRoute(route, req.body);
      const result = strictInput && "error" in strictInput
        ? strictInput.error
        : await callRegisteredTool(ctx, route.tool, routeInput ?? {});
      const response = await actionResponse(ctx, publicOrigin, route.tool, routeInput ?? {}, result);
      if (routeInput) {
        response.toolCall = {
          ...(response.toolCall as Record<string, unknown>),
          toolName: route.tool,
          input: routeInput,
        };
      }
      res.json(response);
    });
  }
}
