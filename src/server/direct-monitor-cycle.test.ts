import { describe, expect, it } from "vitest";
import { actionRequestDigest, actionResponseFromMcpResult, type DirectActionClient, type DirectMonitorTool } from "./direct-action-client.js";
import { runDirectMonitorCycle } from "./direct-monitor-cycle.js";
import { makeToolCallProof } from "./github-pr-monitor-contract.js";

const RECEIPT_ID = "a".repeat(64);
const INPUT = { runId: "run-test", actionPlanId: "plan-test" };

function readStructured(input = INPUT) {
  const actor = { login: "twoimo", actorType: "User" };
  const repository = { id: "repo-id", nameWithOwner: "yeachan-heo/gajae-code" };
  const headRepository = { id: "head-repo-id", name: "gajae-code", nameWithOwner: "yeachan-heo/gajae-code" };
  const snapshot = {
    number: 17,
    url: "https://github.com/yeachan-heo/gajae-code/pull/17",
    state: "OPEN",
    author: actor,
    roles: ["authored", "requested_reviewer"],
    baseRepository: repository,
    headRepository,
    baseRefName: "main",
    headRefName: "fix/example",
    baseRefOid: "1".repeat(40),
    headRefOid: "0".repeat(40),
    reviewRequests: [],
    reviews: [{
      id: "review-1",
      author: { login: "reviewer", actorType: "User" },
      feedbackIdentity: "1".repeat(64),
    }],
    comments: [{
      id: "comment-1",
      author: { login: "reviewer", actorType: "User" },
      feedbackIdentity: "2".repeat(64),
    }],
    latestReviews: [],
    reviewThreads: [{
      id: "thread-1",
      isResolved: false,
      isOutdated: false,
      comments: { nodes: [] },
    }],
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    ciSummary: { total: 1, success: 1, failure: 0, pending: 0, cancelled: 0, neutral: 0, unknown: 0 },
  };
  return {
    monitorPayloadVersion: 1,
    protocolVersion: 1,
    schemaVersion: 4,
    requestDigest: actionRequestDigest(input),
    receiptId: RECEIPT_ID,
    namespace: "ChatGPT_To_Codex",
    tool: "github_pr_monitor_read",
    operation: "read",
    ok: true,
    runId: input.runId,
    actionPlanId: input.actionPlanId,
    account: { login: "twoimo" },
    discovery: {
      authored: { issueCount: 1, fetchedCount: 1, pageCount: 1, complete: true },
      requestedReviewer: { issueCount: 1, fetchedCount: 1, pageCount: 1, complete: true },
      uniqueCandidateCount: 1,
      snapshotAttemptCount: 1,
      snapshotCount: 1,
      races: { prClosed: 0, authoredRoleLost: 0, reviewerRequestLost: 0 },
      complete: true,
    },
    prs: [snapshot],
    observedAt: "2026-08-10T00:00:00.000Z",
    chatgpt2codexToolCall: makeToolCallProof(input, true),
  };
}

function action(input = INPUT) {
  const structuredContent = readStructured(input);
  return actionResponseFromMcpResult("github_pr_monitor_read", input, {
    content: [{ type: "text", text: "Read authenticated-account open PR state." }],
    structuredContent,
  });
}

describe("direct monitor cycle", () => {
  it("runs one dynamic read and returns the exact cycle summary without a browser or state transitions", async () => {
    const calls: Array<{ tool: DirectMonitorTool; input: Record<string, unknown> }> = [];
    const client: DirectActionClient = {
      async call(tool, input) {
        calls.push({ tool, input });
        return action(input as typeof INPUT);
      },
      async close() {},
    };

    const result = await runDirectMonitorCycle(client, INPUT);

    expect(calls).toEqual([{ tool: "github_pr_monitor_read", input: INPUT }]);
    expect(result).toEqual({
      cyclePayloadVersion: 1,
      runId: INPUT.runId,
      actionPlanId: INPUT.actionPlanId,
      account: { login: "twoimo" },
      discovery: {
        authored: { issueCount: 1, fetchedCount: 1, pageCount: 1, complete: true },
        requestedReviewer: { issueCount: 1, fetchedCount: 1, pageCount: 1, complete: true },
        uniqueCandidateCount: 1,
        snapshotAttemptCount: 1,
        snapshotCount: 1,
        races: { prClosed: 0, authoredRoleLost: 0, reviewerRequestLost: 0 },
        complete: true,
      },
      prs: [{
        number: 17,
        url: "https://github.com/yeachan-heo/gajae-code/pull/17",
        roles: ["authored", "requested_reviewer"],
        baseRepository: { id: "repo-id", nameWithOwner: "yeachan-heo/gajae-code" },
        headRepository: { id: "head-repo-id", name: "gajae-code", nameWithOwner: "yeachan-heo/gajae-code" },
        headRefName: "fix/example",
        headRefOid: "0".repeat(40),
        reviewCount: 1,
        commentCount: 1,
        threadCount: 1,
        unresolvedThreadCount: 1,
        ciSummary: { total: 1, success: 1, failure: 0, pending: 0, cancelled: 0, neutral: 0, unknown: 0 },
      }],
      observedAt: "2026-08-10T00:00:00.000Z",
    });
  });

  it("generates safe identifiers when identities are omitted", async () => {
    const calls: Array<{ tool: DirectMonitorTool; input: Record<string, unknown> }> = [];
    const client: DirectActionClient = {
      async call(tool, input) {
        calls.push({ tool, input });
        return action(input as typeof INPUT);
      },
      async close() {},
    };

    const result = await runDirectMonitorCycle(client);

    expect(result.cyclePayloadVersion).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("github_pr_monitor_read");
    expect(calls[0]?.input.runId).toMatch(/^direct_run_/u);
    expect(calls[0]?.input.actionPlanId).toMatch(/^direct_plan_/u);
  });

  it("rejects a malformed Action response before advancing the cycle", async () => {
    const calls: DirectMonitorTool[] = [];
    const client: DirectActionClient = {
      async call(tool, input) {
        calls.push(tool);
        const response = action(input as typeof INPUT) as Record<string, unknown>;
        response.toolCall = { ...(response.toolCall as Record<string, unknown>), input: { ...input, extra: true } };
        return response;
      },
      async close() {},
    };

    await expect(runDirectMonitorCycle(client, INPUT)).rejects.toThrow("does not bind the exact call");
    expect(calls).toEqual(["github_pr_monitor_read"]);
  });

  it("stops on a failed shared dynamic read envelope", async () => {
    const client: DirectActionClient = {
      async call(_tool, input) {
        const error = {
          monitorPayloadVersion: 1,
          protocolVersion: 1,
          schemaVersion: 4,
          requestDigest: actionRequestDigest(input),
          namespace: "ChatGPT_To_Codex",
          tool: "github_pr_monitor_read",
          operation: "read",
          ok: false,
          runId: input.runId,
          actionPlanId: input.actionPlanId,
          code: "GITHUB_MONITOR_UNAVAILABLE",
          error: "GitHub monitor is unavailable.",
          chatgpt2codexToolCall: makeToolCallProof(input as typeof INPUT, false),
        };
        return actionResponseFromMcpResult("github_pr_monitor_read", input, {
          isError: true,
          content: [{ type: "text", text: error.error }],
          structuredContent: error,
        });
      },
      async close() {},
    };

    await expect(runDirectMonitorCycle(client, INPUT)).rejects.toThrow("GITHUB_MONITOR_UNAVAILABLE");
  });
});
