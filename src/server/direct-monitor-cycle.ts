import { createHash, randomUUID } from "node:crypto";
import { successfulDirectActionResponse, type DirectActionClient, type DirectActionResponse, type DirectMonitorTool } from "./direct-action-client.js";
import { executeMonitorActionPlan, type MonitorRollout } from "./direct-monitor-orchestrator.js";

const REPOSITORY = "Yeachan-Heo/gajae-code";
const AUTHOR = "twoimo";

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("read receipt contains a non-finite number");
      return JSON.stringify(value);
    case "string": return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
    default: throw new Error("read receipt contains unsupported data");
  }
}

function readReceiptFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "_")}`;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(message);
  return value as Record<string, unknown>;
}

function receipt(action: DirectActionResponse): Record<string, unknown> {
  const receiptId = action.structuredContent.receiptId;
  if (typeof receiptId !== "string" || !/^[0-9a-f]{64}$/u.test(receiptId)) {
    throw new Error(`${action.tool} returned an invalid receiptId`);
  }
  return { ok: true, namespace: action.toolCall.namespace, receiptId };
}

function parseStateStdout(action: DirectActionResponse): Record<string, unknown> {
  const stdout = action.structuredContent.stdout;
  if (typeof stdout !== "string") throw new Error("github_pr_monitor_state omitted stdout");
  const parsed: unknown = JSON.parse(stdout);
  return record(parsed, "github_pr_monitor_state returned invalid JSON stdout");
}

function checkSummary(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(value)) return counts;
  for (const item of value) {
    const check = record(item, "PR statusCheckRollup contains an invalid item");
    const key = String(check.conclusion ?? check.state ?? check.status ?? "UNKNOWN").toLowerCase();
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function prSummary(value: unknown): Record<string, unknown> {
  const pr = record(value, "github_pr_monitor_read returned an invalid PR snapshot");
  const threads = record(pr.reviewThreads, "PR snapshot omitted reviewThreads");
  return {
    number: pr.number,
    headRef: pr.headRefName,
    headOid: pr.headRefOid,
    reviews: Array.isArray(pr.reviews) ? pr.reviews.length : 0,
    comments: Array.isArray(pr.comments) ? pr.comments.length : 0,
    reviewThreads: Array.isArray(threads.nodes) ? threads.nodes.length : 0,
    unresolvedReviewThreads: Array.isArray(threads.nodes)
      ? threads.nodes.filter((item) => record(item, "reviewThreads contains an invalid item").isResolved === false).length
      : 0,
    checks: checkSummary(pr.statusCheckRollup),
  };
}

export async function runDirectMonitorCycle(
  client: DirectActionClient,
  identities: { runId?: string; actionPlanId?: string } = {},
  options: { rollout?: MonitorRollout } = {},
): Promise<Record<string, unknown>> {
  const runId = identities.runId ?? id("direct_run");
  const actionPlanId = identities.actionPlanId ?? id("direct_plan");
  const readInput = { runId, actionPlanId, repository: REPOSITORY, author: AUTHOR };
  const readResponse = await client.call("github_pr_monitor_read", readInput);
  if (readResponse.ok !== true) {
    const error = record(readResponse.structuredContent, "github_pr_monitor_read failure omitted structuredContent");
    throw new Error(`github_pr_monitor_read failed: ${String(error.code ?? "UNKNOWN")} ${String(error.error ?? "unknown error")}`);
  }
  const read = successfulDirectActionResponse(readResponse, "github_pr_monitor_read", readInput);
  const snapshots = read.structuredContent.prs;
  if (!Array.isArray(snapshots)) throw new Error("github_pr_monitor_read omitted prs");
  const rollout = options.rollout ?? "off";
  if (rollout === "off") {
    return {
      chromeRequired: false,
      runId,
      bootstrapActionPlanId: actionPlanId,
      read: receipt(read),
      ingest: { status: "not_executed", reason: "rollout_off" },
      plan: { status: "not_executed", rollout, execution: { status: "not_executed", reason: "rollout_off", effects: [] } },
      prs: snapshots.map(prSummary),
    };
  }

  const state = async (command: "status" | "ingest" | "plan-cycle", input: Record<string, unknown>) => {
    const stateInput = {
      runId,
      actionPlanId,
      idempotencyKey: id(`direct_${command.replaceAll("-", "_")}`),
      eventId: id(`direct_event_${command.replaceAll("-", "_")}`),
      command,
      input,
    };
    const response = await client.call("github_pr_monitor_state", stateInput);
    if (response.ok !== true) {
      const structured = record(response.structuredContent, "github_pr_monitor_state error omitted structuredContent");
      throw new Error(`github_pr_monitor_state ${command} failed: ${String(structured.code ?? "UNKNOWN")}: ${String(structured.error ?? response.text)}`);
    }
    return successfulDirectActionResponse(response, "github_pr_monitor_state", stateInput);
  };

  const status = await state("status", {});
  const statusState = parseStateStdout(status);
  const statusResult = record(statusState.result, "status omitted result");
  const database = record(statusResult.database, "status omitted database health");
  const rolloutModes = statusResult.rolloutModes;
  if (database.userVersion !== 4 || database.healthy !== true || !Array.isArray(rolloutModes) || !rolloutModes.includes(rollout)) {
    throw new Error("github_pr_monitor_state status failed v4 capability or database-health negotiation");
  }

  const ingest = await state("ingest", { receipt: read });
  const planPrs = snapshots.map((value) => {
    const pr = record(value, "github_pr_monitor_read returned an invalid PR snapshot");
    return {
      number: pr.number,
      author: AUTHOR,
      headRef: pr.headRefName,
      headOid: pr.headRefOid,
      baseRepository: record(pr.baseRepository, "PR snapshot omitted baseRepository").nameWithOwner,
      baseRef: pr.baseRefName,
      baseOid: pr.baseRefOid,
    };
  });
  const plan = await state("plan-cycle", {
    receipt: read,
    prs: planPrs,
  });
  const planState = parseStateStdout(plan);
  const actionPlan = record(planState.result, "plan-cycle omitted result");
  const execution = await executeMonitorActionPlan(client, actionPlan, {
    rollout,
    runId,
    readReceiptFingerprint: readReceiptFingerprint(read),
  });

  return {
    chromeRequired: false,
    runId,
    bootstrapActionPlanId: actionPlanId,
    read: receipt(read),
    ingest: receipt(ingest),
    plan: {
      ...receipt(plan),
      status: actionPlan.status,
      actionPlanId: actionPlan.actionPlanId,
      rollout,
      execution,
    },
    prs: snapshots.map(prSummary),
    actionPlan,
  };
}
