import { describe, expect, it } from "vitest";
import { actionResponseFromMcpResult } from "./direct-action-client.js";

describe("direct action client", () => {
  it("materializes the exact successful Action response shape", () => {
    const input = { runId: "run-1", actionPlanId: "plan-1" };
    const response = actionResponseFromMcpResult("github_pr_monitor_read", input, {
      content: [{ type: "text", text: "Read authored open PR state." }],
      structuredContent: { receiptId: "receipt-1", ok: true },
    });

    expect(response).toMatchObject({
      ok: true,
      tool: "github_pr_monitor_read",
      text: "Read authored open PR state.",
      imageMarkdownList: [],
      toolCall: {
        namespace: "ChatGPT_To_Codex",
        toolName: "github_pr_monitor_read",
        input,
        ok: true,
      },
      structuredContent: { receiptId: "receipt-1", ok: true },
    });
    expect(response).not.toHaveProperty("isError");
  });

  it("preserves a failed MCP result as a failed Action response", () => {
    const response = actionResponseFromMcpResult("github_pr_monitor_state", {}, {
      isError: true,
      content: [{ type: "text", text: "blocked" }],
      structuredContent: { code: "APPROVAL_REQUIRED" },
    });

    expect(response).toMatchObject({
      ok: false,
      isError: true,
      tool: "github_pr_monitor_state",
      text: "blocked",
      toolCall: { namespace: "ChatGPT_To_Codex", ok: false },
      structuredContent: { code: "APPROVAL_REQUIRED" },
    });
  });
});
