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

  registerTools(server, ctx);

  return server;
}

/**
 * Construct the fixed PR-monitor MCP surface without registering any of the
 * normal workspace, E2E, asset, or desktop-control tools.
 */
export async function createMonitorServer(ctx: ToolContext): Promise<McpServer> {
  const server = new McpServer({
    name: "chatgpt2codex-direct-monitor",
    version: "0.1.1",
  });
  const { registerTools } = await import("./tools.js");

  registerTools(server, ctx, { monitorOnly: true });

  return server;
}
