import { randomUUID } from "node:crypto";
import { successfulDirectActionResponse, type DirectActionClient } from "./direct-action-client.js";
import { directMonitorCycleSummary } from "./github-pr-monitor-read.js";
import {
  DirectMonitorCycleSummarySchema,
  GithubPrMonitorReadResultSchema,
  parseGithubPrMonitorReadInput,
  type DirectMonitorCycleSummary,
  type GithubPrMonitorReadResult,
} from "./github-pr-monitor-contract.js";

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "_")}`;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(message);
  return value as Record<string, unknown>;
}
function readInputFromIdentities(value: unknown): { runId: string; actionPlanId: string } {
  const identities = record(value, "direct monitor cycle identities must be an object");
  const keys = Object.keys(identities);
  if (keys.some((key) => key !== "runId" && key !== "actionPlanId")) throw new Error("direct monitor cycle identities contain unsupported fields");
  const hasRun = identities.runId !== undefined;
  const hasPlan = identities.actionPlanId !== undefined;
  if (hasRun !== hasPlan) throw new Error("direct monitor cycle identities require both runId and actionPlanId");
  const input = {
    runId: hasRun ? identities.runId : id("direct_run"),
    actionPlanId: hasPlan ? identities.actionPlanId : id("direct_plan"),
  };
  try {
    return parseGithubPrMonitorReadInput(input);
  } catch {
    throw new Error("direct monitor cycle identities are invalid");
  }
}

export async function runDirectMonitorCycle(
  client: DirectActionClient,
  identities: { runId?: string; actionPlanId?: string } = {},
): Promise<DirectMonitorCycleSummary> {
  const readInput = readInputFromIdentities(identities);
  const readResponse = await client.call("github_pr_monitor_read", readInput);
  if (readResponse.ok !== true) {
    const error = record(readResponse.structuredContent, "github_pr_monitor_read failure omitted structuredContent");
    throw new Error(`github_pr_monitor_read failed: ${String(error.code ?? "UNKNOWN")} ${String(error.error ?? "unknown error")}`);
  }
  const read = successfulDirectActionResponse(readResponse, "github_pr_monitor_read", readInput);
  const result = GithubPrMonitorReadResultSchema.parse(read.structuredContent) as GithubPrMonitorReadResult;
  return DirectMonitorCycleSummarySchema.parse(directMonitorCycleSummary(result));
}
