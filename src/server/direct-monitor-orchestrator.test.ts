import { describe, expect, it } from "vitest";
import { actionRequestDigest, type DirectActionClient, type DirectMonitorTool } from "./direct-action-client.js";
import { executeMonitorActionPlan, parseMonitorActionPlan, restrictiveOciArgs } from "./direct-monitor-orchestrator.js";
import { toolCallProof } from "./tool-proof.js";

const RECEIPT_ID = "a".repeat(64);

function success(tool: DirectMonitorTool, input: Record<string, unknown>): Record<string, unknown> {
  const bindings = tool === "github_pr_monitor_state"
    ? { runId: input.runId, actionPlanId: input.actionPlanId, command: input.command, operation: input.command }
    : tool === "github_pr_monitor_read"
      ? { runId: input.runId, actionPlanId: input.actionPlanId, repository: input.repository, author: input.author, operation: "read" }
      : {
          runId: input.runId,
          actionPlanId: input.actionPlanId,
          idempotencyKey: input.idempotencyKey,
          eventId: input.eventId,
          repository: input.repository,
          author: input.author,
          prNumber: input.prNumber,
          expectedHeadSha: input.expectedHeadSha,
          operation: input.operation,
          ...(input.operation === "post_reply" ? { threadId: input.threadId } : {}),
        };
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
      ...bindings,
      namespace: "ChatGPT_To_Codex",
      tool,
      ok: true,
      receiptId: RECEIPT_ID,
      chatgpt2codexToolCall: toolCallProof(tool, true),
      ...(tool === "github_pr_monitor_prepare" ? { worktreePath: "/tmp/prepared-worktree" } : {}),
      ...(tool === "github_pr_monitor_execute" ? { newHeadSha: "1".repeat(40) } : {}),
    },
  };
}

function plan(steps: unknown[]) {
  return {
    version: 1,
    actionPlanId: "plan_ready",
    target: { repository: "Yeachan-Heo/gajae-code", author: "twoimo" },
    prSet: "authoritative",
    readReceiptFingerprint: "a".repeat(64),
    status: "ready",
    steps,
    next: [],
  };
}

function client(calls: Array<{ tool: DirectMonitorTool; input: Record<string, unknown> }>): DirectActionClient {
  return {
    async call(tool, input) {
      calls.push({ tool, input });
      return success(tool, input);
    },
    async close() {},
  };
}

describe("direct monitor orchestrator", () => {
  it("executes an externally planned reply and binds record/reconcile to the exact response", async () => {
    const calls: Array<{ tool: DirectMonitorTool; input: Record<string, unknown> }> = [];
    const reply = {
      id: "pr_17_reply",
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_mutate",
      expected: { ok: true, receipt: "ActionToolResponse" },
      input: {
        runId: "$runId",
        actionPlanId: "$actionPlanId",
        idempotencyKey: "reply_key",
        eventId: "$eventId",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 17,
        expectedHeadSha: "0".repeat(40),
        threadId: "thread-17",
        operation: "post_reply",
        body: "Bounded policy response",
      },
      sideEffect: { idempotencyKey: "reply_key" },
    };
    const stateStep = (id: string, command: string) => ({
      id,
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_state",
      expected: { ok: true, receipt: "ActionToolResponse" },
      input: {
        runId: "$runId",
        actionPlanId: "$actionPlanId",
        idempotencyKey: "reply_key",
        eventId: "$eventId",
        command,
        input: JSON.stringify({ receipt: "$pr_17_reply.ActionToolResponse" }),
      },
    });

    const result = await executeMonitorActionPlan(client(calls), plan([
      reply,
      stateStep("pr_17_reply_record", "record-side-effect"),
      stateStep("pr_17_reply_reconcile", "reconcile"),
    ]), {
      rollout: "enabled",
      runId: "run_test",
      readReceiptFingerprint: "a".repeat(64),
    });

    expect(result.status).toBe("completed");
    expect(calls.map(({ tool }) => tool)).toEqual([
      "github_pr_monitor_mutate",
      "github_pr_monitor_state",
      "github_pr_monitor_state",
    ]);
    expect(calls[1]?.input).toMatchObject({
      command: "record-side-effect",
      input: { receipt: calls[0] ? success(calls[0].tool, calls[0].input) : undefined },
    });
  });
  it("executes a bounded externally planned suggestion step instead of denying it as unsupported", async () => {
    const calls: Array<{ tool: DirectMonitorTool; input: Record<string, unknown> }> = [];
    const result = await executeMonitorActionPlan(client(calls), plan([{
      id: "apply_suggestions",
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_execute",
      expected: { ok: true, receipt: "ActionToolResponse" },
      input: {
        runId: "$runId",
        actionPlanId: "$actionPlanId",
        idempotencyKey: "execute-key",
        eventId: "$eventId",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 17,
        expectedHeadSha: "0".repeat(40),
        operation: "apply_suggestions",
        worktreePath: "/tmp/prepared-worktree",
        headRef: "feature/test",
        ociImageDigest: `sha256:${"a".repeat(64)}`,
        suggestions: [{
          threadId: "thread",
          commentId: "comment",
          reviewer: "reviewer",
          path: "packages/fixture/value.ts",
          startLine: 1,
          line: 1,
          expectedOriginal: "old",
          replacement: "new",
          sourceDigest: "b".repeat(64),
        }],
      },
    }]), {
      rollout: "enabled",
      runId: "run_test",
      readReceiptFingerprint: "a".repeat(64),
    });
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("github_pr_monitor_execute");
    expect(calls[0]?.input.suggestions).toMatchObject([{
      expectedOriginal: "old",
      reviewer: "reviewer",
    }]);
  });

  it("rejects externally authored unsupported mutation operations", async () => {
    const calls: Array<{ tool: DirectMonitorTool; input: Record<string, unknown> }> = [];
    const effect = {
      id: "external_step",
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_mutate",
      expected: { ok: true, receipt: "ActionToolResponse" },
      input: {
        runId: "$runId",
        actionPlanId: "$actionPlanId",
        idempotencyKey: "external_key",
        eventId: "$eventId",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 17,
        expectedHeadSha: "0".repeat(40),
        operation: "externally_authorized_operation",
        externallyBoundPayload: { exact: true },
      },
      sideEffect: { idempotencyKey: "external_key" },
    };
    await expect(executeMonitorActionPlan(client(calls), plan([effect]), {
      rollout: "enabled",
      runId: "run_test",
      readReceiptFingerprint: "a".repeat(64),
    })).rejects.toThrow("unsupported mutation operation");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("github_pr_monitor_mutate");
  });

  it("binds only the whole Action response and the two explicit response selectors", async () => {
    const calls: Array<{ tool: DirectMonitorTool; input: Record<string, unknown> }> = [];
    const step = (id: string, tool: DirectMonitorTool, input: Record<string, unknown>) => ({
      id,
      namespace: "ChatGPT_To_Codex",
      tool,
      expected: { ok: true, receipt: "ActionToolResponse" },
      input,
    });
    const result = await executeMonitorActionPlan(client(calls), plan([
      step("prepare", "github_pr_monitor_prepare", {
        runId: "$runId",
        actionPlanId: "$actionPlanId",
        idempotencyKey: "prepare-key",
        eventId: "$eventId",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 17,
        expectedHeadSha: "0".repeat(40),
        operation: "external-prepare",
      }),
      step("execute", "github_pr_monitor_execute", {
        runId: "$runId",
        actionPlanId: "$actionPlanId",
        idempotencyKey: "execute-key",
        eventId: "$eventId",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 17,
        expectedHeadSha: "0".repeat(40),
        operation: "external-execute",
        worktreePath: "$prepare.ActionToolResponse.structuredContent.worktreePath",
      }),
      step("record", "github_pr_monitor_state", {
        runId: "$runId",
        actionPlanId: "$actionPlanId",
        idempotencyKey: "$eventId-$eventVersion-record",
        eventId: "$eventId",
        command: "record-side-effect",
        input: JSON.stringify({
          receipt: "$execute.ActionToolResponse",
          newHeadSha: "$execute.ActionToolResponse.structuredContent.newHeadSha",
        }),
      }),
    ]), { rollout: "enabled", runId: "run_test", readReceiptFingerprint: "a".repeat(64) });

    expect(result.status).toBe("completed");
    expect(calls[1]?.input.worktreePath).toBe("/tmp/prepared-worktree");
    expect(calls[2]?.input.input).toEqual({
      receipt: calls[1] ? success(calls[1].tool, calls[1].input) : undefined,
      newHeadSha: "1".repeat(40),
    });
    expect(calls[2]?.input.idempotencyKey).toBe("direct_record-1-record");
  });

  it("rejects arbitrary nested and prototype Action response selectors", async () => {
    for (const selector of [
      "structuredContent.receiptId",
      "structuredContent.__proto__",
      "structuredContent.prototype",
      "structuredContent.constructor",
    ]) {
      const calls: Array<{ tool: DirectMonitorTool; input: Record<string, unknown> }> = [];
      await expect(executeMonitorActionPlan(client(calls), plan([
        {
          id: "read",
          namespace: "ChatGPT_To_Codex",
          tool: "github_pr_monitor_read",
          expected: { ok: true, receipt: "ActionToolResponse" },
          input: { runId: "$runId", actionPlanId: "$actionPlanId", repository: "Yeachan-Heo/gajae-code", author: "twoimo" },
        },
        {
          id: "state",
          namespace: "ChatGPT_To_Codex",
          tool: "github_pr_monitor_state",
          expected: { ok: true, receipt: "ActionToolResponse" },
          input: {
            runId: "$runId",
            actionPlanId: "$actionPlanId",
            idempotencyKey: "state-key",
            eventId: "$eventId",
            command: "ingest",
            input: JSON.stringify({ selected: `$read.ActionToolResponse.${selector}` }),
          },
        },
      ]), { rollout: "enabled", runId: "run_test", readReceiptFingerprint: "a".repeat(64) })).rejects.toThrow("unsupported Action response selector");
      expect(calls).toHaveLength(1);
    }
  });

  it("routes rollout stages and honors cancellation without interpreting step policy", async () => {
    const read = {
      id: "read",
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_read",
      expected: { ok: true, receipt: "ActionToolResponse" },
      input: { runId: "$runId", actionPlanId: "$actionPlanId", repository: "Yeachan-Heo/gajae-code", author: "twoimo" },
    };
    const mutate = {
      id: "mutate",
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_mutate",
      expected: { ok: true, receipt: "ActionToolResponse" },
      input: {},
    };
    const shadowCalls: Array<{ tool: DirectMonitorTool; input: Record<string, unknown> }> = [];
    await expect(executeMonitorActionPlan(client(shadowCalls), plan([read, mutate]), {
      rollout: "shadow",
      runId: "run_test",
      readReceiptFingerprint: "a".repeat(64),
    })).resolves.toMatchObject({ status: "blocked", reason: "rollout_shadow" });
    expect(shadowCalls.map(({ tool }) => tool)).toEqual(["github_pr_monitor_read"]);

    const offCalls: Array<{ tool: DirectMonitorTool; input: Record<string, unknown> }> = [];
    await expect(executeMonitorActionPlan(client(offCalls), plan([read]), {
      rollout: "off",
      runId: "run_test",
    })).resolves.toEqual({ status: "not_executed", reason: "rollout_off", effects: [] });
    expect(offCalls).toEqual([]);

    const controller = new AbortController();
    controller.abort();
    const cancelledCalls: Array<{ tool: DirectMonitorTool; input: Record<string, unknown> }> = [];
    await expect(executeMonitorActionPlan(client(cancelledCalls), plan([read]), {
      rollout: "enabled",
      runId: "run_test",
      readReceiptFingerprint: "a".repeat(64),
      signal: controller.signal,
    })).resolves.toEqual({ status: "blocked", reason: "cancelled", effects: [] });
    expect(cancelledCalls).toEqual([]);
  });

  it("rejects malformed plans and invalid OCI constructor inputs", () => {
    expect(() => parseMonitorActionPlan(plan([{
      id: "bad",
      namespace: "ChatGPT_To_Codex",
      tool: "local_shell_run",
      expected: { ok: true, receipt: "ActionToolResponse" },
      input: {},
    }]))).toThrow("non-dedicated tool");
    expect(() => parseMonitorActionPlan(plan([{
      id: "blocked",
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_read",
      expected: { ok: true, receipt: "ActionToolResponse" },
      input: {},
      blocksTier: 3,
    }]))).toThrow("unsupported fields");
    expect(() => parseMonitorActionPlan(plan([{
      id: "malformed",
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_read",
      expected: { ok: true, receipt: "nested.path" },
      input: {},
    }]))).toThrow("expected response is invalid");
    expect(() => parseMonitorActionPlan(plan([
      {
        id: "duplicate",
        namespace: "ChatGPT_To_Codex",
        tool: "github_pr_monitor_read",
        expected: { ok: true, receipt: "ActionToolResponse" },
        input: {},
      },
      {
        id: "duplicate",
        namespace: "ChatGPT_To_Codex",
        tool: "github_pr_monitor_state",
        expected: { ok: true, receipt: "ActionToolResponse" },
        input: {},
      },
    ]))).toThrow("duplicated");
    expect(() => restrictiveOciArgs("latest", "/tmp/work", ["bun", "test"], ["packages/coding-agent/src/index.ts"])).toThrow("pinned");
    expect(() => restrictiveOciArgs(`sha256:${"a".repeat(64)}`, "/tmp/work", ["npm", "test"], ["packages/coding-agent/src/index.ts"])).toThrow("exactly bun test");
    expect(() => restrictiveOciArgs(`sha256:${"a".repeat(64)}`, "/tmp/work", ["bun", "test"], ["../escape.ts"])).toThrow("changed paths");
    expect(() => restrictiveOciArgs(`sha256:${"a".repeat(64)}`, "tmp/work", ["bun", "test"], ["packages/coding-agent/src/index.ts"])).toThrow("absolute clean path");
    expect(() => restrictiveOciArgs(`sha256:${"a".repeat(64)}`, "/tmp/work", ["bun", "test"], ["packages/coding-agent/src/index.ts", "packages/coding-agent/src/index.ts"])).toThrow("unique paths");
  });

  it("builds the fixed restrictive OCI argv with read-only input, writable tmpfs, and no network", () => {
    const args = restrictiveOciArgs(
      `sha256:${"a".repeat(64)}`,
      "/tmp/work",
      ["bun", "test"],
      ["packages/coding-agent/src/index.ts"],
    );
    expect(args).toEqual([
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
      "--tmpfs=/tmp:rw,noexec,nosuid,size=256m,mode=1777",
      "--tmpfs=/workspace:rw,exec,nosuid,size=2g,mode=1777",
      "--env=MONITOR_CHANGED_PATHS=packages/coding-agent/src/index.ts",
      "--mount=type=bind,src=/tmp/work,dst=/input,readonly",
      `sha256:${"a".repeat(64)}`,
      "bun",
      "test",
    ]);
  });
});
