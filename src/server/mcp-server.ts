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
/**
 * Construct the dedicated GitHub PR write MCP surface. This mode owns a
 * fresh v5 authority and never registers the read or legacy monitor tools.
 */
export async function createMonitorWriteServer(ctx: ToolContext): Promise<McpServer> {
  if (process.platform !== "darwin") throw new Error("github-pr-monitor-write requires supported macOS Secure Enclave hardware");
  const rollout = process.env.CHATGPT2CODEX_MONITOR_ROLLOUT?.trim().toLowerCase() || "off";
  const requireAttestation = process.env.CHATGPT2CODEX_REQUIRE_WRITE_ATTESTATION === "1" || process.env.CHATGPT2CODEX_WRITE_MANIFEST !== undefined;
  if (requireAttestation) {
    const { loadWriteDeploymentManifest } = await import("./github-pr-write-manifest.js");
    await loadWriteDeploymentManifest();
  }
  const server = new McpServer({
    name: "chatgpt2codex-github-pr-monitor-write",
    version: "0.1.1",
  });
  const [{ registerGithubPrMonitorWriteTools }, { GithubPrWriteAuthority }] = await Promise.all([
    import("./github-pr-monitor-write.js"),
    import("./github-pr-write-authority.js"),
  ]);
  const authority = await GithubPrWriteAuthority.open(ctx.stateDir);
  if (requireAttestation && rollout !== "off") authority.assertRolloutStage(rollout as "shadow" | "prepare" | "enabled");
  registerGithubPrMonitorWriteTools(server, ctx, authority);
  const originalClose = server.close.bind(server);
  server.close = async () => {
    authority.close();
    await originalClose();
  };
  return server;
}
export const createGithubPrWriteServer = createMonitorWriteServer;
