import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolContext } from "../types.js";
import { createServer } from "./mcp-server.js";
import { toolCallProof } from "./tool-proof.js";

export const DIRECT_MONITOR_TOOLS = [
  "github_pr_monitor_read",
  "github_pr_monitor_state",
  "github_pr_monitor_prepare",
  "github_pr_monitor_mutate",
] as const;

export type DirectMonitorTool = (typeof DIRECT_MONITOR_TOOLS)[number];

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function isDirectMonitorTool(value: string): value is DirectMonitorTool {
  return (DIRECT_MONITOR_TOOLS as readonly string[]).includes(value);
}

export function actionResponseFromMcpResult(
  tool: DirectMonitorTool,
  input: Record<string, unknown>,
  result: McpToolResult,
): Record<string, unknown> {
  const ok = result.isError !== true;
  const text = (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  return {
    ok,
    tool,
    toolCall: {
      ...toolCallProof(tool, ok),
      toolName: tool,
      input: structuredClone(input),
    },
    text,
    imageMarkdownList: [],
    structuredContent: structuredClone(result.structuredContent ?? {}),
    ...(result.isError ? { isError: true } : {}),
  };
}

export interface DirectActionClient {
  call(tool: DirectMonitorTool, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function createDirectActionClient(ctx: ToolContext): Promise<DirectActionClient> {
  const server = await createServer(ctx);
  const client = new Client({ name: "chatgpt2codex-direct-monitor", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    async call(tool, input) {
      const result = (await client.callTool({ name: tool, arguments: input })) as McpToolResult;
      return actionResponseFromMcpResult(tool, input, result);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
