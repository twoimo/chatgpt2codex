import path from "node:path";
import { isDirectMonitorTool, successfulDirectActionResponse, type DirectActionClient, type DirectMonitorTool } from "./direct-action-client.js";

const NAMESPACE = "ChatGPT_To_Codex";
const SAFE_ID = /^[A-Za-z0-9_=-]{1,300}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const OCI_CHANGED_PATH = /^packages\/[A-Za-z0-9._-]+\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const TEST_ARGV = ["bun", "test"] as const;
const ACTION_RESPONSE_SELECTORS = new Set(["structuredContent.worktreePath", "structuredContent.newHeadSha"]);
const MONITOR_ROLLOUTS: readonly MonitorRollout[] = ["off", "shadow", "prepare", "enabled"];
const OCI_TMPFS = [
  "--tmpfs=/tmp:rw,noexec,nosuid,size=256m,mode=1777",
  "--tmpfs=/workspace:rw,exec,nosuid,size=2g,mode=1777",
] as const;

export function restrictiveOciArgs(
  imageDigest: string,
  workspacePath: string,
  argv: readonly string[],
  changedPaths: readonly string[],
): string[] {
  if (!IMAGE_DIGEST.test(imageDigest)) throw new Error("OCI image must be pinned by sha256 digest");
  if (
    !path.isAbsolute(workspacePath)
    || path.resolve(workspacePath) !== workspacePath
    || workspacePath.trim() !== workspacePath
    || /[\u0000-\u001f\u007f,]/u.test(workspacePath)
  ) {
    throw new Error("OCI workspace must be an absolute clean path");
  }
  if (argv.length !== TEST_ARGV.length || argv.some((value, index) => value !== TEST_ARGV[index])) {
    throw new Error("OCI test argv must be exactly bun test");
  }
  if (changedPaths.length < 1 || changedPaths.length > 10 || new Set(changedPaths).size !== changedPaths.length) {
    throw new Error("OCI changed paths must contain 1-10 unique paths");
  }
  for (const changedPath of changedPaths) {
    if (
      !OCI_CHANGED_PATH.test(changedPath)
      || path.posix.normalize(changedPath) !== changedPath
      || changedPath.includes("\\")
      || /[\u0000-\u001f\u007f,]/u.test(changedPath)
    ) {
      throw new Error("OCI changed paths must be normalized packages/... paths");
    }
  }
  return [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=512",
    "--memory=4g",
    "--cpus=2",
    "--user=65532:65532",
    ...OCI_TMPFS,
    `--env=MONITOR_CHANGED_PATHS=${changedPaths.join(",")}`,
    `--mount=type=bind,src=${workspacePath},dst=/input,readonly`,
    imageDigest,
    ...argv,
  ];
}

export type MonitorRollout = "off" | "shadow" | "prepare" | "enabled";

export interface MonitorPlanStep {
  id: string;
  namespace: typeof NAMESPACE;
  tool: DirectMonitorTool;
  input: Readonly<Record<string, unknown>>;
  sideEffect?: Readonly<Record<string, unknown>>;
  onlyAfterFailureOf?: string;
}

export interface MonitorActionPlan {
  version: 1;
  actionPlanId: string;
  target: Readonly<{ repository: "Yeachan-Heo/gajae-code"; author: "twoimo" }>;
  prSet: "unknown" | "authoritative";
  readReceiptFingerprint?: string;
  status: string;
  steps: MonitorPlanStep[];
}

export interface PlanExecutionOptions {
  rollout: MonitorRollout;
  runId: string;
  readReceiptFingerprint?: string;
  signal?: AbortSignal;
}

export interface PlanExecutionResult {
  status: "not_executed" | "completed" | "blocked";
  reason?: string;
  effects: Array<{ stepId: string; tool: DirectMonitorTool; receiptId: string }>;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(message);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${context} contains unsupported fields: ${extras.join(",")}`);
}

function actionReceipt(
  value: Record<string, unknown>,
  tool: DirectMonitorTool,
  input: Record<string, unknown>,
): string {
  const response = successfulDirectActionResponse(value, tool, input);
  return response.structuredContent.receiptId as string;
}
function expectedResponse(value: unknown, index: number): void {
  const expected = record(value, `action plan step ${index} expected response is invalid`);
  exactKeys(expected, ["ok", "receipt"], `action plan step ${index} expected response`);
  if (expected.ok !== true || expected.receipt !== "ActionToolResponse") {
    throw new Error("action plan step expected response is invalid");
  }
}

function rolloutIncludes(rollout: MonitorRollout, tool: DirectMonitorTool): boolean {
  if (rollout === "off") return false;
  if (tool === "github_pr_monitor_read" || tool === "github_pr_monitor_state") return true;
  if (tool === "github_pr_monitor_prepare") return rollout === "prepare" || rollout === "enabled";
  return rollout === "enabled";
}

export function parseMonitorActionPlan(value: unknown): MonitorActionPlan {
  const plan = record(value, "plan-cycle omitted an action plan");
  exactKeys(plan, ["version", "actionPlanId", "target", "prSet", "readReceiptFingerprint", "status", "steps", "next"], "action plan");
  if (plan.version !== 1 || typeof plan.actionPlanId !== "string" || !SAFE_ID.test(plan.actionPlanId)) {
    throw new Error("action plan identity is invalid");
  }
  const target = record(plan.target, "action plan target is invalid");
  exactKeys(target, ["repository", "author"], "action plan target");
  if (target.repository !== "Yeachan-Heo/gajae-code" || target.author !== "twoimo") {
    throw new Error("action plan target is invalid");
  }
  if (plan.prSet !== "unknown" && plan.prSet !== "authoritative") {
    throw new Error("action plan PR set is invalid");
  }
  if (plan.readReceiptFingerprint !== undefined && (typeof plan.readReceiptFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(plan.readReceiptFingerprint))) {
    throw new Error("action plan read receipt fingerprint is invalid");
  }
  if (typeof plan.status !== "string" || plan.status.length === 0) throw new Error("action plan status is invalid");
  if (!Array.isArray(plan.steps) || plan.steps.length > 100) throw new Error("action plan steps are invalid");
  const ids = new Set<string>();
  const steps = plan.steps.map((raw, index) => {
    const step = record(raw, `action plan step ${index} is invalid`);
    exactKeys(step, ["id", "namespace", "tool", "input", "expected", "sideEffect", "onlyAfterFailureOf"], `action plan step ${index}`);
    if (typeof step.id !== "string" || !SAFE_ID.test(step.id) || ids.has(step.id)) throw new Error("action plan step id is invalid or duplicated");
    if (step.namespace !== NAMESPACE || typeof step.tool !== "string" || !isDirectMonitorTool(step.tool)) {
      throw new Error("action plan requests a non-dedicated tool");
    }
    const input = record(step.input, "action plan step input is invalid");
    expectedResponse(step.expected, index);
    if (step.sideEffect !== undefined) record(step.sideEffect, "action plan side effect is invalid");
    if (step.onlyAfterFailureOf !== undefined && (typeof step.onlyAfterFailureOf !== "string" || !SAFE_ID.test(step.onlyAfterFailureOf))) {
      throw new Error("action plan failure dependency is invalid");
    }
    if (typeof step.onlyAfterFailureOf === "string" && !ids.has(step.onlyAfterFailureOf)) {
      throw new Error("action plan failure dependency must reference an earlier step");
    }
    ids.add(step.id);
    return {
      id: step.id,
      namespace: NAMESPACE,
      tool: step.tool,
      input,
      ...(step.sideEffect === undefined ? {} : { sideEffect: record(step.sideEffect, "action plan side effect is invalid") }),
      ...(step.onlyAfterFailureOf === undefined ? {} : { onlyAfterFailureOf: step.onlyAfterFailureOf as string }),
    } satisfies MonitorPlanStep;
  });
  return {
    version: 1,
    actionPlanId: plan.actionPlanId,
    target: { repository: "Yeachan-Heo/gajae-code", author: "twoimo" },
    prSet: plan.prSet as "unknown" | "authoritative",
    ...(plan.readReceiptFingerprint === undefined ? {} : { readReceiptFingerprint: plan.readReceiptFingerprint as string }),
    status: plan.status,
    steps,
  };
}

function replaceTemplateString(value: string, bindings: Record<string, string>): string {
  const output = value.replace(/\$([A-Za-z][A-Za-z0-9]*)/gu, (_template, name: string) => {
    const replacement = bindings[name];
    if (replacement === undefined) throw new Error("action plan contains an unresolved template");
    return replacement;
  });
  if (output.includes("$")) throw new Error("action plan contains an unresolved template");
  return output;
}

function bindValue(value: unknown, bindings: Record<string, string>, responses: Map<string, Record<string, unknown>>): unknown {
  if (typeof value === "string") {
    const receipt = value.match(/^\$([A-Za-z0-9_=-]+)\.ActionToolResponse(?:\.(.+))?$/u);
    if (receipt) {
      const response = responses.get(receipt[1] ?? "");
      if (!response) throw new Error("action plan references an unavailable Action response");
      const selector = receipt[2];
      if (!selector) return response;
      if (!ACTION_RESPONSE_SELECTORS.has(selector)) {
        throw new Error("action plan references an unsupported Action response selector");
      }
      const structuredContent = record(response.structuredContent, "action plan Action response selector is invalid");
      const selected = structuredContent[selector === "structuredContent.worktreePath" ? "worktreePath" : "newHeadSha"];
      if (selected === undefined) throw new Error("action plan references a missing Action response field");
      return selected;
    }
    return replaceTemplateString(value, bindings);
  }
  if (Array.isArray(value)) return value.map((item) => bindValue(item, bindings, responses));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, bindValue(item, bindings, responses)]));
}

function bindStepInput(
  step: MonitorPlanStep,
  runId: string,
  planId: string,
  responses: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  const eventId = `direct_${step.id}`.replaceAll("-", "_");
  const bindings = { runId, actionPlanId: planId, eventId, eventVersion: "1" };
  const rawInput: Record<string, unknown> = structuredClone({ ...step.input });
  if (step.tool === "github_pr_monitor_state" && typeof rawInput.input === "string") {
    try {
      rawInput.input = JSON.parse(rawInput.input);
    } catch {
      throw new Error("state step input is not valid JSON");
    }
  }
  return record(bindValue(rawInput, bindings, responses), "bound action input is invalid");
}

export async function executeMonitorActionPlan(
  client: DirectActionClient,
  rawPlan: unknown,
  options: PlanExecutionOptions,
): Promise<PlanExecutionResult> {
  const plan = parseMonitorActionPlan(rawPlan);
  if (!SAFE_ID.test(options.runId)) throw new Error("runId is invalid");
  if (!MONITOR_ROLLOUTS.includes(options.rollout)) throw new Error("rollout is invalid");
  if (plan.status !== "ready") return { status: "not_executed", reason: plan.status, effects: [] };
  if (options.rollout === "off") return { status: "not_executed", reason: "rollout_off", effects: [] };
  const executionReadReceiptFingerprint = options.readReceiptFingerprint;
  if (typeof executionReadReceiptFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(executionReadReceiptFingerprint)) {
    throw new Error("read receipt fingerprint is invalid");
  }
  if (plan.prSet !== "authoritative" || plan.readReceiptFingerprint === undefined) {
    return { status: "blocked", reason: "read_receipt_unbound", effects: [] };
  }
  if (plan.readReceiptFingerprint !== executionReadReceiptFingerprint) {
    return { status: "blocked", reason: "read_receipt_mismatch", effects: [] };
  }
  const responses = new Map<string, Record<string, unknown>>();
  const failed = new Set<string>();
  const failureDependencies = new Set(plan.steps.flatMap((step) => step.onlyAfterFailureOf ? [step.onlyAfterFailureOf] : []));
  const effects: PlanExecutionResult["effects"] = [];

  for (const step of plan.steps) {
    if (options.signal?.aborted) return { status: "blocked", reason: "cancelled", effects };
    if (step.onlyAfterFailureOf && !failed.has(step.onlyAfterFailureOf)) continue;
    const input = bindStepInput(step, options.runId, plan.actionPlanId, responses);
    if (!rolloutIncludes(options.rollout, step.tool)) {
      return { status: "blocked", reason: `rollout_${options.rollout}`, effects };
    }
    try {
      const response = await client.call(step.tool, input);
      const receiptId = actionReceipt(response, step.tool, input);
      responses.set(step.id, response);
      effects.push({ stepId: step.id, tool: step.tool, receiptId });
    } catch (error) {
      failed.add(step.id);
      if (!failureDependencies.has(step.id)) throw error;
    }
  }
  return { status: "completed", effects };
}