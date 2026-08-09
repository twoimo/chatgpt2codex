import { describe, expect, it } from "vitest";
import { actionRequestDigest, actionResponseFromMcpResult, type DirectActionClient, type DirectMonitorTool } from "./direct-action-client.js";
import { runDirectMonitorCycle } from "./direct-monitor-cycle.js";
import { toolCallProof } from "./tool-proof.js";

const RECEIPT_ID = "a".repeat(64);

function action(tool: DirectMonitorTool, input: Record<string, unknown>, structuredContent: Record<string, unknown>) {
  const inputBindings = tool === "github_pr_monitor_read"
    ? { runId: input.runId, actionPlanId: input.actionPlanId, repository: input.repository, author: input.author, operation: "read" }
    : { runId: input.runId, actionPlanId: input.actionPlanId, command: input.command, operation: input.command };
  const requestDigest = actionRequestDigest(input);
  return {
    ok: true,
    protocolVersion: 1,
    schemaVersion: 4,
    requestDigest,
    tool,
    toolCall: { ...toolCallProof(tool, true), toolName: tool, input },
    text: "ok",
    imageMarkdownList: [],
    structuredContent: {
      protocolVersion: 1,
      schemaVersion: 4,
      requestDigest,
      ...inputBindings,
      ...structuredContent,
      chatgpt2codexToolCall: toolCallProof(tool, true),
      namespace: "ChatGPT_To_Codex",
      tool,
      ok: true,
      receiptId: RECEIPT_ID,
    },
  };
}

describe("direct monitor cycle", () => {
  it("runs read, ingest, and plan-cycle without a browser", async () => {
    const calls: Array<{ tool: DirectMonitorTool; input: Record<string, unknown> }> = [];
    let readResponse: Record<string, unknown> | undefined;
    const client: DirectActionClient = {
      async call(tool, input) {
        calls.push({ tool, input });
        if (tool === "github_pr_monitor_read") {
          readResponse = action(tool, input, {
            prs: [{
              number: 17,
              headRefName: "fix/example",
              headRefOid: "0123456789abcdef0123456789abcdef01234567",
              headRepository: { nameWithOwner: "Yeachan-Heo/gajae-code" },
              baseRepository: { nameWithOwner: "Yeachan-Heo/gajae-code" },
              baseRefName: "main",
              baseRefOid: "1111111111111111111111111111111111111111",
              reviews: [],
              comments: [],
              reviewThreads: { nodes: [] },
              statusCheckRollup: [],
            }],
          });
          return readResponse;
        }
        const command = input.command;
        const result = command === "status"
          ? {
              rolloutModes: ["off", "shadow", "prepare", "enabled"],
              database: { userVersion: 4, healthy: true },
            }
          : command === "plan-cycle"
            ? {
                version: 1,
                target: { repository: "Yeachan-Heo/gajae-code", author: "twoimo" },
                prSet: "authoritative",
                status: "blocked_no_authorizable_effects",
                actionPlanId: "plan-result",
                steps: [],
                next: [],
              }
            : { ingested: 1 };
        return action(tool, input, {
          stdout: JSON.stringify({ ok: true, command, result }),
        });
      },
      async close() {},
    };

    const result = await runDirectMonitorCycle(
      client,
      { runId: "run-test", actionPlanId: "bootstrap-test" },
      { rollout: "shadow" },
    );

    expect(result).toMatchObject({
      chromeRequired: false,
      runId: "run-test",
      bootstrapActionPlanId: "bootstrap-test",
      plan: { ok: true, namespace: "ChatGPT_To_Codex", status: "blocked_no_authorizable_effects", actionPlanId: "plan-result" },
      prs: [{ number: 17, unresolvedReviewThreads: 0, checks: {} }],
    });
    expect(calls.map(({ tool }) => tool)).toEqual([
      "github_pr_monitor_read",
      "github_pr_monitor_state",
      "github_pr_monitor_state",
      "github_pr_monitor_state",
    ]);
    expect(calls[1]?.input).toMatchObject({ command: "status" });
    expect(calls[2]?.input).toMatchObject({ command: "ingest", input: { receipt: readResponse } });
    expect(calls[3]?.input).toMatchObject({
      command: "plan-cycle",
      input: {
        receipt: readResponse,
        prs: [{
          number: 17,
          author: "twoimo",
          headRef: "fix/example",
          headOid: "0123456789abcdef0123456789abcdef01234567",
        }],
      },
    });
    expect(calls[3]?.input).not.toHaveProperty("input.capability");
    expect(calls[3]?.input).not.toHaveProperty("input.prs.0.attempts");
    expect(calls[3]?.input).not.toHaveProperty("input.prs.0.tier");
    expect(result.plan).toMatchObject({
      rollout: "shadow",
      execution: { status: "not_executed", reason: "blocked_no_authorizable_effects", effects: [] },
    });
  });

  it("keeps rollout off read-only and skips all state transitions", async () => {
    const calls: DirectMonitorTool[] = [];
    const client: DirectActionClient = {
      async call(tool, input) {
        calls.push(tool);
        if (tool !== "github_pr_monitor_read") throw new Error(`unexpected state call: ${tool}`);
        return action(tool, input, { prs: [] });
      },
      async close() {},
    };

    const result = await runDirectMonitorCycle(client, { runId: "run-off", actionPlanId: "plan-off" });

    expect(calls).toEqual(["github_pr_monitor_read"]);
    expect(result).toMatchObject({
      ingest: { status: "not_executed", reason: "rollout_off" },
      plan: {
        status: "not_executed",
        rollout: "off",
        execution: { status: "not_executed", reason: "rollout_off", effects: [] },
      },
    });
  });
  it("rejects malformed Action responses before advancing the cycle", async () => {
    const calls: DirectMonitorTool[] = [];
    const client: DirectActionClient = {
      async call(tool, input) {
        calls.push(tool);
        const response = action(tool, input, { prs: [] });
        (response.toolCall as Record<string, unknown>).input = { ...input, repository: "other/repository" };
        return response;
      },
      async close() {},
    };

    await expect(runDirectMonitorCycle(client, { runId: "run-test", actionPlanId: "plan-test" }))
      .rejects.toThrow("does not bind the exact call");
    expect(calls).toEqual(["github_pr_monitor_read"]);
  });
});

function mcpSuccess(input: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: "Read authored open PR state." }],
    structuredContent: {
      requestDigest: actionRequestDigest(input),
      protocolVersion: 1,
      schemaVersion: 4,
      chatgpt2codexToolCall: toolCallProof("github_pr_monitor_read", true),
      receiptId: RECEIPT_ID,
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_read",
      operation: "read",
      ok: true,
      runId: input.runId,
      actionPlanId: input.actionPlanId,
      repository: input.repository,
      author: input.author,
      prs: [{ number: 17 }],
    },
  };
}

describe("direct Action MCP materialization", () => {
  it("clones an exact success without retaining input or receipt aliases", () => {
    const input = {
      runId: "run-1",
      actionPlanId: "plan-1",
      repository: "Yeachan-Heo/gajae-code",
      author: "twoimo",
      nested: { marker: "input" },
    };
    const wire = mcpSuccess(input);
    const response = actionResponseFromMcpResult("github_pr_monitor_read", input, wire);

    input.nested.marker = "changed";
    (wire.structuredContent.prs[0] as { number: number }).number = 99;
    expect(response).toMatchObject({
      ok: true,
      tool: "github_pr_monitor_read",
      toolCall: { input: { nested: { marker: "input" } } },
      structuredContent: { receiptId: RECEIPT_ID, prs: [{ number: 17 }] },
    });
    expect(response).not.toHaveProperty("isError");
  });

  it("materializes only an exact error marker and error receipt shape", () => {
    const wire = {
      isError: true,
      content: [{ type: "text", text: "blocked" }],
      structuredContent: {
        protocolVersion: 1,
        schemaVersion: 4,
        requestDigest: actionRequestDigest({}),
        chatgpt2codexToolCall: toolCallProof("github_pr_monitor_state", false),
        code: "APPROVAL_REQUIRED",
        error: "blocked",
        details: { reason: "external authority denied" },
      },
    };
    const response = actionResponseFromMcpResult("github_pr_monitor_state", {}, wire);

    (wire.structuredContent.details as { reason: string }).reason = "changed";
    expect(response).toMatchObject({
      ok: false,
      isError: true,
      tool: "github_pr_monitor_state",
      toolCall: { namespace: "ChatGPT_To_Codex", tool: "github_pr_monitor_state", ok: false },
      structuredContent: { code: "APPROVAL_REQUIRED", error: "blocked", details: { reason: "external authority denied" } },
    });
  });

  it("rejects malformed MCP successes, errors, top-level aliases, and missing fields", () => {
    const input = {
      runId: "run-1",
      actionPlanId: "plan-1",
      repository: "Yeachan-Heo/gajae-code",
      author: "twoimo",
    };
    const success = mcpSuccess(input);
    const malformed: unknown[] = [
      null,
      { ...success, result: success.structuredContent },
      { structuredContent: success.structuredContent },
      { ...success, content: [] },
      { ...success, content: [{ type: "image", text: "not text" }] },
      { ...success, structuredContent: undefined },
      { ...success, structuredContent: { ...success.structuredContent, receiptId: undefined } },
      { ...success, structuredContent: { ...success.structuredContent, namespace: "other" } },
      {
        isError: true,
        content: [{ type: "text", text: "blocked" }],
        structuredContent: {
          chatgpt2codexToolCall: toolCallProof("github_pr_monitor_read", true),
          code: "APPROVAL_REQUIRED",
          error: "blocked",
        },
      },
      {
        isError: true,
        content: [{ type: "text", text: "blocked" }],
        structuredContent: {
          chatgpt2codexToolCall: toolCallProof("github_pr_monitor_read", false),
          code: "APPROVAL_REQUIRED",
        },
      },
    ];
    expect(actionResponseFromMcpResult("github_pr_monitor_read", input, { ...success, isError: false }))
      .toEqual(actionResponseFromMcpResult("github_pr_monitor_read", input, success));

    for (const value of malformed) {
      expect(() => actionResponseFromMcpResult("github_pr_monitor_read", input, value)).toThrow();
    }
  });
});
