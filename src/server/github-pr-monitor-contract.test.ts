import { describe, expect, it } from "vitest";
import {
  GITHUB_PR_MONITOR_ERROR_KEYS,
  GITHUB_PR_MONITOR_ERROR_KEYS_WITH_IDS,
  GITHUB_PR_MONITOR_INPUT_KEYS,
  GITHUB_PR_MONITOR_INVALID_INPUT_REQUEST_DIGEST,
  GITHUB_PR_MONITOR_OPENAPI,
  GithubPrMonitorErrorResultSchema,
  GithubPrMonitorReadInputJsonSchema,
  GithubPrMonitorReadInputSchema,
  GithubPrMonitorReadResultSchema,
  canonicalJson,
  canonicalRepository,
  compareLogin,
  isSafeId,
  makeToolCallProof,
  monitorRequestDigest,
  parseGithubPrMonitorReadInput,
  safeErrorMessage,
  validateMonitorError,
  validateMonitorSuccess,
} from "./github-pr-monitor-contract.js";

type MonitorInput = { runId: string; actionPlanId: string };

const CONTRACT_INPUT: MonitorInput = { runId: "run-1", actionPlanId: "plan-1" };

function validDiscovery() {
  return {
    authored: { issueCount: 0, fetchedCount: 0, pageCount: 1, complete: true },
    requestedReviewer: { issueCount: 0, fetchedCount: 0, pageCount: 1, complete: true },
    uniqueCandidateCount: 0,
    snapshotAttemptCount: 0,
    snapshotCount: 0,
    races: { prClosed: 0, authoredRoleLost: 0, reviewerRequestLost: 0 },
    complete: true,
  };
}

function validSuccessFixture(
  discovery: ReturnType<typeof validDiscovery> = validDiscovery(),
  prs: unknown[] = [],
) {
  return {
    monitorPayloadVersion: 1,
    protocolVersion: 1,
    schemaVersion: 4,
    requestDigest: monitorRequestDigest(CONTRACT_INPUT),
    receiptId: "a".repeat(64),
    namespace: "ChatGPT_To_Codex",
    tool: "github_pr_monitor_read",
    operation: "read",
    ok: true,
    runId: CONTRACT_INPUT.runId,
    actionPlanId: CONTRACT_INPUT.actionPlanId,
    account: { login: "alice" },
    discovery,
    prs,
    observedAt: "2026-08-10T00:00:00.000Z",
    chatgpt2codexToolCall: makeToolCallProof(CONTRACT_INPUT, true),
  };
}

function validErrorFixture() {
  return {
    monitorPayloadVersion: 1,
    protocolVersion: 1,
    schemaVersion: 4,
    requestDigest: monitorRequestDigest(CONTRACT_INPUT),
    namespace: "ChatGPT_To_Codex",
    tool: "github_pr_monitor_read",
    operation: "read",
    ok: false,
    runId: CONTRACT_INPUT.runId,
    actionPlanId: CONTRACT_INPUT.actionPlanId,
    code: "GITHUB_MONITOR_UNAVAILABLE",
    error: safeErrorMessage("GITHUB_MONITOR_UNAVAILABLE"),
    chatgpt2codexToolCall: makeToolCallProof(CONTRACT_INPUT, false),
  };
}
describe("github PR monitor contract", () => {
  it("accepts exactly runId and actionPlanId and rejects aliases or extra keys", () => {
    const input = { runId: "run-1", actionPlanId: "plan-1" };

    expect(parseGithubPrMonitorReadInput(input)).toEqual(input);
    expect(GithubPrMonitorReadInputSchema.safeParse(input).success).toBe(true);
    expect(GithubPrMonitorReadInputJsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["runId", "actionPlanId"],
    });
    expect(GITHUB_PR_MONITOR_INPUT_KEYS).toEqual(["runId", "actionPlanId"]);

    for (const alias of ["run_id", "action_plan_id", "planId", "actionPlan", "id"]) {
      expect(GithubPrMonitorReadInputSchema.safeParse({ ...input, [alias]: "alias" }).success).toBe(false);
    }
    expect(() => parseGithubPrMonitorReadInput({ runId: input.runId, actionPlanId: input.actionPlanId, extra: true })).toThrow();
    expect(() => parseGithubPrMonitorReadInput({ run_id: input.runId, actionPlanId: input.actionPlanId })).toThrow();
    expect(() => parseGithubPrMonitorReadInput({ runId: "bad value", actionPlanId: input.actionPlanId })).toThrow();
    expect(GITHUB_PR_MONITOR_OPENAPI.input).toEqual(GithubPrMonitorReadInputJsonSchema);
  });

  it("keeps canonical JSON, repository, and casefold ordering deterministic", () => {
    expect(canonicalJson({ z: 1, a: [true, { b: "x", a: null }] })).toBe('{"a":[true,{"a":null,"b":"x"}],"z":1}');
    expect(canonicalRepository("Acme/Repo")).toBe("acme/repo");
    expect(canonicalRepository("ACME/repo")).toBe("acme/repo");
    expect(compareLogin("ALICE", "alice")).toBeLessThan(0);
    expect(compareLogin("alice", "ALICE")).toBeGreaterThan(0);
    expect(isSafeId("run_=-1")).toBe(true);
    expect(isSafeId("run/1")).toBe(false);
  });

  it("exposes only stable, sanitized monitor errors", () => {
    expect(safeErrorMessage("GITHUB_MONITOR_AUTH")).toBe("GitHub authentication is unavailable.");
    expect(safeErrorMessage("GITHUB_MONITOR_UNAVAILABLE")).toBe("GitHub monitor is unavailable.");
    expect(GITHUB_PR_MONITOR_ERROR_KEYS).toEqual([
      "monitorPayloadVersion", "protocolVersion", "schemaVersion", "requestDigest", "namespace",
      "tool", "operation", "ok", "code", "error", "chatgpt2codexToolCall",
    ]);
    expect(safeErrorMessage("GITHUB_MONITOR_UNAVAILABLE")).not.toContain("token");
  });
  it("accepts bound safe IDs on execution errors and keeps IDs optional in OpenAPI", () => {
    const input = { runId: "run-1", actionPlanId: "plan-1" };
    const errorWithIds = {
      monitorPayloadVersion: 1,
      protocolVersion: 1,
      schemaVersion: 4,
      requestDigest: monitorRequestDigest(input),
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_read",
      operation: "read",
      ok: false,
      runId: input.runId,
      actionPlanId: input.actionPlanId,
      code: "GITHUB_MONITOR_UNAVAILABLE",
      error: safeErrorMessage("GITHUB_MONITOR_UNAVAILABLE"),
      chatgpt2codexToolCall: {
        namespace: "ChatGPT_To_Codex",
        toolName: "github_pr_monitor_read",
        input,
        ok: false,
      },
    } as const;

    expect(GithubPrMonitorErrorResultSchema.safeParse(errorWithIds).success).toBe(true);
    expect(validateMonitorError(errorWithIds)).toBe(true);
    expect(GITHUB_PR_MONITOR_ERROR_KEYS_WITH_IDS).toEqual([
      "monitorPayloadVersion", "protocolVersion", "schemaVersion", "requestDigest", "namespace",
      "tool", "operation", "ok", "runId", "actionPlanId", "code", "error", "chatgpt2codexToolCall",
    ]);

    const errorSchema = GITHUB_PR_MONITOR_OPENAPI.error as {
      required: readonly string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(errorSchema.required).not.toContain("runId");
    expect(errorSchema.required).not.toContain("actionPlanId");
    expect(errorSchema.properties.runId).toMatchObject({ type: "string", pattern: expect.any(String), maxLength: 300 });
    expect(errorSchema.properties.actionPlanId).toMatchObject({ type: "string", pattern: expect.any(String), maxLength: 300 });

    const invalidId = { ...errorWithIds, runId: "run/unsafe" };
    expect(GithubPrMonitorErrorResultSchema.safeParse(invalidId).success).toBe(false);
    expect(validateMonitorError(invalidId)).toBe(false);

    const mismatchedProof = {
      ...errorWithIds,
      chatgpt2codexToolCall: { ...errorWithIds.chatgpt2codexToolCall, input: { runId: "run-2", actionPlanId: input.actionPlanId } },
    };
    expect(GithubPrMonitorErrorResultSchema.safeParse(mismatchedProof).success).toBe(false);
  });

  it("rejects malformed success count and completeness invariants", () => {
    const mismatchedSnapshotCount = validSuccessFixture({
      ...validDiscovery(),
      uniqueCandidateCount: 1,
      snapshotAttemptCount: 1,
      snapshotCount: 1,
    });
    expect(GithubPrMonitorReadResultSchema.safeParse(mismatchedSnapshotCount).success).toBe(false);
    expect(validateMonitorSuccess(mismatchedSnapshotCount)).toBe(false);

    const mismatchedAttemptCount = validSuccessFixture({
      ...validDiscovery(),
      uniqueCandidateCount: 1,
      complete: false,
    });
    expect(GithubPrMonitorReadResultSchema.safeParse(mismatchedAttemptCount).success).toBe(false);

    const excessiveRaces = validSuccessFixture({
      ...validDiscovery(),
      uniqueCandidateCount: 1,
      snapshotAttemptCount: 1,
      races: { prClosed: 2, authoredRoleLost: 0, reviewerRequestLost: 0 },
      complete: false,
    });
    expect(GithubPrMonitorReadResultSchema.safeParse(excessiveRaces).success).toBe(false);

    const inconsistentComplete = validSuccessFixture({
      ...validDiscovery(),
      complete: false,
    });
    expect(GithubPrMonitorReadResultSchema.safeParse(inconsistentComplete).success).toBe(false);
  });

  it("binds execution and invalid-input error digests to their runtime inputs", () => {
    const executionError = validErrorFixture();
    expect(GithubPrMonitorErrorResultSchema.safeParse(executionError).success).toBe(true);
    expect(validateMonitorError(executionError)).toBe(true);

    const malformedExecutionDigest = {
      ...executionError,
      requestDigest: GITHUB_PR_MONITOR_INVALID_INPUT_REQUEST_DIGEST,
    };
    expect(GithubPrMonitorErrorResultSchema.safeParse(malformedExecutionDigest).success).toBe(false);
    expect(validateMonitorError(malformedExecutionDigest)).toBe(false);

    const { runId: _runId, actionPlanId: _actionPlanId, ...errorWithoutIds } = executionError;
    const invalidInputWithoutIds = {
      ...errorWithoutIds,
      code: "GITHUB_MONITOR_INVALID_INPUT",
      requestDigest: GITHUB_PR_MONITOR_INVALID_INPUT_REQUEST_DIGEST,
      chatgpt2codexToolCall: makeToolCallProof(undefined, false),
    };
    expect(GithubPrMonitorErrorResultSchema.safeParse(invalidInputWithoutIds).success).toBe(true);
    expect(validateMonitorError(invalidInputWithoutIds)).toBe(true);

    const invalidInputWithSafeIds = {
      ...executionError,
      code: "GITHUB_MONITOR_INVALID_INPUT",
      requestDigest: monitorRequestDigest(CONTRACT_INPUT),
    };
    expect(GithubPrMonitorErrorResultSchema.safeParse(invalidInputWithSafeIds).success).toBe(true);

    const invalidInputWithFixedDigest = {
      ...invalidInputWithSafeIds,
      requestDigest: GITHUB_PR_MONITOR_INVALID_INPUT_REQUEST_DIGEST,
    };
    expect(GithubPrMonitorErrorResultSchema.safeParse(invalidInputWithFixedDigest).success).toBe(false);

    const executionWithoutIds = {
      ...errorWithoutIds,
      requestDigest: GITHUB_PR_MONITOR_INVALID_INPUT_REQUEST_DIGEST,
      chatgpt2codexToolCall: makeToolCallProof(undefined, false),
    };
    expect(GithubPrMonitorErrorResultSchema.safeParse(executionWithoutIds).success).toBe(false);
  });
});
