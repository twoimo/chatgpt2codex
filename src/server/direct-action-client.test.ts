import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "./mcp-server.js";
import type { ToolContext } from "../types.js";
import { toolCallProof } from "./tool-proof.js";
import { actionRequestDigest, actionResponseFromMcpResult } from "./direct-action-client.js";

describe("direct action client", () => {
  it("materializes the exact successful Action response shape", () => {
    const input = {
      runId: "run-1",
      actionPlanId: "plan-1",
      repository: "Yeachan-Heo/gajae-code",
      author: "twoimo",
    };
    const response = actionResponseFromMcpResult("github_pr_monitor_read", input, {
      content: [{ type: "text", text: "Read authored open PR state." }],
      structuredContent: {
        protocolVersion: 1,
        schemaVersion: 4,
        requestDigest: actionRequestDigest(input),
        chatgpt2codexToolCall: toolCallProof("github_pr_monitor_read", true),
        receiptId: "a".repeat(64),
        namespace: "ChatGPT_To_Codex",
        tool: "github_pr_monitor_read",
        operation: "read",
        ok: true,
        ...input,
      },
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
      structuredContent: { receiptId: "a".repeat(64), ok: true },
    });
    expect(response).not.toHaveProperty("isError");
  });
  it("accepts the exact thread binding on successful post replies", () => {
    const input = {
      runId: "run-1",
      actionPlanId: "plan-1",
      repository: "Yeachan-Heo/gajae-code",
      author: "twoimo",
      prNumber: 7,
      expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
      operation: "post_reply",
      body: "Acknowledged.",
      threadId: "thread-1",
      idempotencyKey: "idempotency-1",
      eventId: "event-1",
    };
    const response = actionResponseFromMcpResult("github_pr_monitor_mutate", input, {
      content: [{ type: "text", text: "Posted." }],
      structuredContent: {
        protocolVersion: 1,
        schemaVersion: 4,
        requestDigest: actionRequestDigest(input),
        chatgpt2codexToolCall: toolCallProof("github_pr_monitor_mutate", true),
        receiptId: "a".repeat(64),
        namespace: "ChatGPT_To_Codex",
        tool: "github_pr_monitor_mutate",
        operation: "post_reply",
        ok: true,
        runId: input.runId,
        actionPlanId: input.actionPlanId,
        repository: input.repository,
        author: input.author,
        prNumber: input.prNumber,
        expectedHeadSha: input.expectedHeadSha,
        threadId: input.threadId,
        idempotencyKey: input.idempotencyKey,
        eventId: input.eventId,
      },
    });
    expect(response.structuredContent).toMatchObject({ threadId: "thread-1", operation: "post_reply" });
  });
  it("rejects unknown successful structuredContent fields at the direct boundary", () => {
    const input = {
      runId: "run-1",
      actionPlanId: "plan-1",
      repository: "Yeachan-Heo/gajae-code",
      author: "twoimo",
    };
    expect(() => actionResponseFromMcpResult("github_pr_monitor_read", input, {
      content: [{ type: "text", text: "Read authored open PR state." }],
      structuredContent: {
        protocolVersion: 1,
        schemaVersion: 4,
        requestDigest: actionRequestDigest(input),
        chatgpt2codexToolCall: toolCallProof("github_pr_monitor_read", true),
        receiptId: "a".repeat(64),
        namespace: "ChatGPT_To_Codex",
        tool: "github_pr_monitor_read",
        operation: "read",
        ok: true,
        ...input,
        hostileField: "must be rejected",
      },
    })).toThrow("unsupported fields: hostileField");
  });

  it("rejects duplicate feedback comment ids across review threads during local snapshot compaction", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-feedback-identity-"));
    const binDir = path.join(workspaceRoot, "bin");
    const stateDir = path.join(workspaceRoot, "state");
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const scriptPath = path.join(binDir, "gh");
    await mkdir(binDir, { recursive: true });
    await writeFile(scriptPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") {
  console.log(JSON.stringify({ login: "twoimo" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 7,
    url: "https://github.com/Yeachan-Heo/gajae-code/pull/7",
    state: "OPEN",
    author: { login: "twoimo" },
    baseRepository: { nameWithOwner: "Yeachan-Heo/gajae-code" },
    baseRefName: "main",
    baseRefOid: "1111111111111111111111111111111111111111",
    headRepository: { id: "repo-node-id", name: "gajae-code", nameWithOwner: "Yeachan-Heo/gajae-code" },
    headRefName: "feature/feedback-identity",
    headRefOid: ${JSON.stringify(headSha)},
    reviewRequests: [],
    reviews: [],
    comments: [],
    latestReviews: [],
    statusCheckRollup: [],
  }));
} else if (args[0] === "api" && args[1] === "graphql") {
  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
    nodes: [
      {
        id: "thread-1",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [{ id: "1", body: "first feedback", author: { login: "reviewer" } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
      {
        id: "thread-2",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [{ id: 1, body: "second feedback", author: { login: "reviewer" } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  } } } } }));
} else {
  process.exit(1);
}
`, "utf8");
    await chmod(scriptPath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    const ctx: ToolContext = {
      workspaceRoot,
      stateDir,
      registry: [],
      ledger: { append: async () => undefined },
      store: {
        loadProjects: async () => [],
        saveProjects: async () => undefined,
        getSession: async () => null,
        setSession: async () => undefined,
      },
      config: {
        workspaceRoot,
        stateDir,
        maxReadBytes: 1024,
        maxPatchBytes: 1024,
        defaultCommandTimeoutSec: 30,
        defaultLeaseTtlMs: 30 * 60 * 1000,
      },
    };
    const server = await createServer(ctx);
    try {
      const tools = (server as unknown as {
        _registeredTools?: Record<string, {
          handler?: (input: unknown) => Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }>;
        }>;
      })._registeredTools;
      const result = await tools?.github_pr_monitor_read?.handler?.({
        runId: "feedback-identity-run",
        actionPlanId: "feedback-identity-plan",
        repository: "Yeachan-Heo/gajae-code",
        author: "twoimo",
        prNumber: 7,
      });
      expect(result?.isError).toBe(true);
      expect(result?.structuredContent?.error).toContain("duplicate");
    } finally {
      await server.close();
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
  it("preserves a failed MCP result as a failed Action response", () => {
    const response = actionResponseFromMcpResult("github_pr_monitor_state", {}, {
      isError: true,
      content: [{ type: "text", text: "blocked" }],
      structuredContent: {
        protocolVersion: 1,
        schemaVersion: 4,
        requestDigest: actionRequestDigest({}),
        chatgpt2codexToolCall: toolCallProof("github_pr_monitor_state", false),
        code: "APPROVAL_REQUIRED",
        error: "blocked",
        details: {},
      },
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
