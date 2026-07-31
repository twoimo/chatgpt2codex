import { describe, expect, it } from "vitest";
import type { DirectActionClient, DirectMonitorTool } from "./direct-action-client.js";
import { runDirectMonitorCycle } from "./direct-monitor-cycle.js";

const RECEIPT_ID = "a".repeat(64);

function action(tool: DirectMonitorTool, input: Record<string, unknown>, structuredContent: Record<string, unknown>) {
  return {
    ok: true,
    tool,
    toolCall: { namespace: "ChatGPT_To_Codex", ok: true, toolName: tool, input },
    text: "ok",
    imageMarkdownList: [],
    structuredContent: { ok: true, receiptId: RECEIPT_ID, ...structuredContent },
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
              reviews: [],
              comments: [],
              reviewThreads: { nodes: [] },
              statusCheckRollup: [],
            }],
          });
          return readResponse;
        }
        const command = input.command;
        const result = command === "plan-cycle"
          ? { status: "blocked_no_authorizable_effects", actionPlanId: "plan-result", steps: [] }
          : { ingested: 1 };
        return action(tool, input, {
          stdout: JSON.stringify({ ok: true, command, result }),
        });
      },
      async close() {},
    };

    const result = await runDirectMonitorCycle(client, { runId: "run-test", actionPlanId: "bootstrap-test" });

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
    ]);
    expect(calls[1]?.input).toMatchObject({ command: "ingest", input: { receipt: readResponse } });
    expect(calls[2]?.input).toMatchObject({
      command: "plan-cycle",
      input: {
        receipt: readResponse,
        prs: [{
          number: 17,
          author: "twoimo",
          headRef: "fix/example",
          headOid: "0123456789abcdef0123456789abcdef01234567",
          attempts: 0,
          tier: 1,
        }],
      },
    });
  });
});
