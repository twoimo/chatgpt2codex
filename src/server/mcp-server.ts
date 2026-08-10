import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";

/**
 * Construct and configure the MCP server (stdio transport) with all tools
 * registered against ctx. Returns the server instance ready to `connect()`.
 */
export async function createServer(ctx: ToolContext): Promise<McpServer> {
  const server = new McpServer({
    name: "chatgpt2codex",
    version: "0.1.1",
  });
  const { registerTools } = await import("./tools.js");

  registerTools(server, ctx, { includeDeferredMonitorTools: false });

  return server;
}

/**
 * Construct the monitor-only MCP surface with only the dynamic
 * github_pr_monitor_read tool. State, mutation, receipt, and OCI authorities
 * remain deferred and are not registered on this surface.
 */
export async function createMonitorServer(ctx: ToolContext): Promise<McpServer> {
  const server = new McpServer({
    name: "chatgpt2codex-direct-monitor",
    version: "0.1.1",
  });
  const { registerTools } = await import("./tools.js");

  registerTools(server, ctx, { monitorOnly: true, includeDeferredMonitorTools: false });

  return server;
}
