import { randomUUID } from "node:crypto";
import type { DirectActionClient, DirectMonitorTool } from "./direct-action-client.js";

const REPOSITORY = "Yeachan-Heo/gajae-code";
const AUTHOR = "twoimo";

interface ActionResponse extends Record<string, unknown> {
  ok: boolean;
  tool: string;
  toolCall: Record<string, unknown>;
  structuredContent: Record<string, unknown>;
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "_")}`;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function successfulAction(value: Record<string, unknown>, tool: DirectMonitorTool): ActionResponse {
  const toolCall = record(value.toolCall, `${tool} omitted toolCall proof`);
  const structuredContent = record(value.structuredContent, `${tool} omitted structuredContent`);
  if (
    value.ok !== true ||
    value.tool !== tool ||
    toolCall.namespace !== "ChatGPT_To_Codex" ||
    toolCall.ok !== true ||
    structuredContent.ok !== true
  ) {
    throw new Error(`${tool} did not return an exact successful ChatGPT_To_Codex Action response`);
  }
  return value as ActionResponse;
}

function receipt(action: ActionResponse): Record<string, unknown> {
  const receiptId = action.structuredContent.receiptId;
  if (typeof receiptId !== "string" || !/^[0-9a-f]{64}$/u.test(receiptId)) {
    throw new Error(`${action.tool} returned an invalid receiptId`);
  }
  return { ok: true, namespace: action.toolCall.namespace, receiptId };
}

function parseStateStdout(action: ActionResponse): Record<string, unknown> {
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
): Promise<Record<string, unknown>> {
  const runId = identities.runId ?? id("direct_run");
  const actionPlanId = identities.actionPlanId ?? id("direct_plan");
  const readInput = { runId, actionPlanId, repository: REPOSITORY, author: AUTHOR };
  const read = successfulAction(await client.call("github_pr_monitor_read", readInput), "github_pr_monitor_read");
  const snapshots = read.structuredContent.prs;
  if (!Array.isArray(snapshots)) throw new Error("github_pr_monitor_read omitted prs");

  const state = async (command: "ingest" | "plan-cycle", input: Record<string, unknown>) =>
    successfulAction(
      await client.call("github_pr_monitor_state", {
        runId,
        actionPlanId,
        idempotencyKey: id(`direct_${command.replaceAll("-", "_")}`),
        eventId: id(`direct_event_${command.replaceAll("-", "_")}`),
        command,
        input,
      }),
      "github_pr_monitor_state",
    );

  const ingest = await state("ingest", { receipt: read });
  const planPrs = snapshots.map((value) => {
    const pr = record(value, "github_pr_monitor_read returned an invalid PR snapshot");
    return {
      number: pr.number,
      author: AUTHOR,
      headRef: pr.headRefName,
      headOid: pr.headRefOid,
      attempts: 0,
      tier: 1,
    };
  });
  const plan = await state("plan-cycle", { receipt: read, prs: planPrs });
  const planState = parseStateStdout(plan);
  const actionPlan = record(planState.result, "plan-cycle omitted result");

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
    },
    prs: snapshots.map(prSummary),
    actionPlan,
  };
}
