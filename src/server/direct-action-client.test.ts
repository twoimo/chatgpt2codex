import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, createMonitorServer } from "./mcp-server.js";
import type { ToolContext } from "../types.js";
import { makeToolCallProof, monitorRequestDigest } from "./github-pr-monitor-contract.js";
import { actionRequestDigest, actionResponseFromMcpResult, createDirectActionClient } from "./direct-action-client.js";

const RECEIPT_ID = "a".repeat(64);
const INPUT = { runId: "run-1", actionPlanId: "plan-1" };

function readResult(input: typeof INPUT = INPUT, overrides: Record<string, unknown> = {}) {
  const actor = { login: "twoimo", actorType: "User" };
  const repository = { id: "repo-id", nameWithOwner: "yeachan-heo/gajae-code" };
  const headRepository = { id: "head-repo-id", name: "gajae-code", nameWithOwner: "yeachan-heo/gajae-code" };
  const discovery = {
    authored: { issueCount: 1, fetchedCount: 1, pageCount: 1, complete: true },
    requestedReviewer: { issueCount: 0, fetchedCount: 0, pageCount: 1, complete: true },
    uniqueCandidateCount: 1,
    snapshotAttemptCount: 1,
    snapshotCount: 1,
    races: { prClosed: 0, authoredRoleLost: 0, reviewerRequestLost: 0 },
    complete: true,
  };
  const snapshot = {
    number: 7,
    url: "https://github.com/yeachan-heo/gajae-code/pull/7",
    state: "OPEN",
    author: actor,
    roles: ["authored"],
    baseRepository: repository,
    headRepository,
    baseRefName: "main",
    headRefName: "feature/test",
    baseRefOid: "1".repeat(40),
    headRefOid: "0".repeat(40),
    reviewRequests: [],
    reviews: [],
    comments: [],
    latestReviews: [],
    reviewThreads: [],
    statusCheckRollup: [],
    ciSummary: { total: 0, success: 0, failure: 0, pending: 0, cancelled: 0, neutral: 0, unknown: 0 },
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
    discovery,
    prs: [snapshot],
    observedAt: "2026-08-10T00:00:00.000Z",
    chatgpt2codexToolCall: makeToolCallProof(input, true),
    ...overrides,
  };
}

function mcpSuccess(input = INPUT, overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: "Read authenticated-account open PR state." }],
    structuredContent: readResult(input, overrides),
  };
}

function validMcpRead(input: typeof INPUT) {
  return {
    content: [{ type: "text", text: "Read authenticated-account open PR state." }],
    structuredContent: {
      monitorPayloadVersion: 1,
      protocolVersion: 1,
      schemaVersion: 4,
      requestDigest: monitorRequestDigest(input),
      receiptId: RECEIPT_ID,
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_read",
      operation: "read",
      ok: true,
      runId: input.runId,
      actionPlanId: input.actionPlanId,
      account: { login: "twoimo" },
      discovery: {
        authored: { issueCount: 0, fetchedCount: 0, pageCount: 1, complete: true },
        requestedReviewer: { issueCount: 0, fetchedCount: 0, pageCount: 1, complete: true },
        uniqueCandidateCount: 0,
        snapshotAttemptCount: 0,
        snapshotCount: 0,
        races: { prClosed: 0, authoredRoleLost: 0, reviewerRequestLost: 0 },
        complete: true,
      },
      prs: [],
      observedAt: "2026-08-10T00:00:00.000Z",
      chatgpt2codexToolCall: makeToolCallProof(input, true),
    },
  };
}

describe("direct action client", () => {
  it("materializes the exact successful dynamic read Action response shape", () => {
    const response = actionResponseFromMcpResult("github_pr_monitor_read", INPUT, mcpSuccess());

    expect(response).toMatchObject({
      ok: true,
      protocolVersion: 1,
      schemaVersion: 4,
      requestDigest: actionRequestDigest(INPUT),
      tool: "github_pr_monitor_read",
      text: "Read authenticated-account open PR state.",
      imageMarkdownList: [],
      toolCall: {
        namespace: "ChatGPT_To_Codex",
        toolName: "github_pr_monitor_read",
        input: INPUT,
        ok: true,
      },
      structuredContent: {
        receiptId: RECEIPT_ID,
        runId: INPUT.runId,
        actionPlanId: INPUT.actionPlanId,
        tool: "github_pr_monitor_read",
        operation: "read",
        ok: true,
      },
    });
    expect(response).not.toHaveProperty("isError");
  });

  it("rejects a successful read envelope with unsupported fields", () => {
    expect(() => actionResponseFromMcpResult("github_pr_monitor_read", INPUT, mcpSuccess(INPUT, { hostileField: true })))
      .toThrow("MCP success is not a valid shared github_pr_monitor_read result");
  });

  it("preserves a failed dynamic read result as a failed Action response", () => {
    const error = {
      monitorPayloadVersion: 1,
      protocolVersion: 1,
      schemaVersion: 4,
      requestDigest: actionRequestDigest(INPUT),
      namespace: "ChatGPT_To_Codex",
      tool: "github_pr_monitor_read",
      operation: "read",
      ok: false,
      runId: INPUT.runId,
      actionPlanId: INPUT.actionPlanId,
      code: "GITHUB_MONITOR_UNAVAILABLE",
      error: "GitHub monitor is unavailable.",
      chatgpt2codexToolCall: makeToolCallProof(INPUT, false),
    };
    const response = actionResponseFromMcpResult("github_pr_monitor_read", INPUT, {
      isError: true,
      content: [{ type: "text", text: error.error }],
      structuredContent: error,
    });

    expect(response).toMatchObject({
      ok: false,
      isError: true,
      tool: "github_pr_monitor_read",
      text: "GitHub monitor is unavailable.",
      toolCall: { namespace: "ChatGPT_To_Codex", toolName: "github_pr_monitor_read", ok: false, input: INPUT },
      structuredContent: { code: "GITHUB_MONITOR_UNAVAILABLE", operation: "read", ok: false },
    });
  });

  it("rejects malformed MCP results before materializing an Action response", () => {
    const valid = mcpSuccess();
    const malformed: unknown[] = [
      null,
      { ...valid, result: valid.structuredContent },
      { structuredContent: valid.structuredContent },
      { ...valid, content: [] },
      { ...valid, content: [{ type: "image", text: "not text" }] },
      { ...valid, structuredContent: undefined },
      { ...valid, structuredContent: { ...valid.structuredContent, receiptId: undefined } },
    ];

    for (const value of malformed) {
      expect(() => actionResponseFromMcpResult("github_pr_monitor_read", INPUT, value)).toThrow();
    }
  });
  it("round-trips a valid read through the real InMemory MCP transport and keeps native InvalidParams", async () => {
    const ctx: ToolContext = {
      workspaceRoot: "/tmp",
      stateDir: "/tmp/chatgpt2codex-direct-action-client-test",
      registry: [],
      ledger: { append: async () => undefined },
      store: {
        loadProjects: async () => [],
        saveProjects: async () => undefined,
        getSession: async () => null,
        setSession: async () => undefined,
      },
      config: {
        workspaceRoot: "/tmp",
        stateDir: "/tmp/chatgpt2codex-direct-action-client-test",
        maxReadBytes: 1024,
        maxPatchBytes: 1024,
        defaultCommandTimeoutSec: 30,
        defaultLeaseTtlMs: 30 * 60 * 1000,
      },
    };
    const server = await createMonitorServer(ctx);
    const registeredTools = (server as unknown as {
      _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
    })._registeredTools;
    const readTool = registeredTools?.github_pr_monitor_read;
    if (!readTool?.handler) throw new Error("github_pr_monitor_read was not registered");
    readTool.handler = async (input) => validMcpRead(input as typeof INPUT);

    const client = new Client({ name: "unit-test-in-memory-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "github_pr_monitor_read",
        arguments: INPUT,
      })) as { isError?: boolean; content?: Array<{ type?: string; text?: string }>; structuredContent?: Record<string, unknown> };

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        namespace: "ChatGPT_To_Codex",
        tool: "github_pr_monitor_read",
        operation: "read",
        ok: true,
        runId: INPUT.runId,
        actionPlanId: INPUT.actionPlanId,
      });

      const malformed = (await client.callTool({
        name: "github_pr_monitor_read",
        arguments: { runId: INPUT.runId },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };

      expect(malformed.isError).toBe(true);
      expect(malformed.content?.[0]?.text).toContain("Input validation error: Invalid arguments for tool github_pr_monitor_read");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("enforces the dynamic read input at the registered MCP boundary", async () => {
    const ctx: ToolContext = {
      workspaceRoot: "/tmp",
      stateDir: "/tmp/chatgpt2codex-direct-action-client-test",
      registry: [],
      ledger: { append: async () => undefined },
      store: {
        loadProjects: async () => [],
        saveProjects: async () => undefined,
        getSession: async () => null,
        setSession: async () => undefined,
      },
      config: {
        workspaceRoot: "/tmp",
        stateDir: "/tmp/chatgpt2codex-direct-action-client-test",
        maxReadBytes: 1024,
        maxPatchBytes: 1024,
        defaultCommandTimeoutSec: 30,
        defaultLeaseTtlMs: 30 * 60 * 1000,
      },
    };
    const server = await createServer(ctx);
    try {
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }> }>;
      })._registeredTools;
      const result = await tools?.github_pr_monitor_read?.handler?.({ ...INPUT, repository: "attacker/example" });
      expect(result?.isError).toBe(true);
      expect(result?.structuredContent?.code).toBe("GITHUB_MONITOR_INVALID_INPUT");
    } finally {
      await server.close();
    }
  });
  it("bounds invalid direct input without echoing oversized secrets or unsafe proof input", async () => {
    const ctx: ToolContext = {
      workspaceRoot: "/tmp",
      stateDir: "/tmp/chatgpt2codex-direct-action-client-test",
      registry: [],
      ledger: { append: async () => undefined },
      store: {
        loadProjects: async () => [],
        saveProjects: async () => undefined,
        getSession: async () => null,
        setSession: async () => undefined,
      },
      config: {
        workspaceRoot: "/tmp",
        stateDir: "/tmp/chatgpt2codex-direct-action-client-test",
        maxReadBytes: 1024,
        maxPatchBytes: 1024,
        defaultCommandTimeoutSec: 30,
        defaultLeaseTtlMs: 30 * 60 * 1000,
      },
    };
    const secret = "PRIVATE_DIRECT_SECRET_".repeat(20_000);
    const input = { ...INPUT, secret, nested: { secret } };
    const client = await createDirectActionClient(ctx);
    try {
      const response = await client.call("github_pr_monitor_read", input);
      const serialized = JSON.stringify(response);
      expect(response).toMatchObject({
        ok: false,
        structuredContent: {
          code: "GITHUB_MONITOR_INVALID_INPUT",
          runId: INPUT.runId,
          actionPlanId: INPUT.actionPlanId,
          chatgpt2codexToolCall: { ok: false, input: INPUT },
        },
        toolCall: { input: INPUT },
      });
      expect(response.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(response.requestDigest).not.toBe(actionRequestDigest(input));
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("nested");
    } finally {
      await client.close();
    }
  });
});
