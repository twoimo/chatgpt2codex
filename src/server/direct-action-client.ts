import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolContext } from "../types.js";
import { createMonitorServer, createMonitorWriteServer } from "./mcp-server.js";
import {
  GithubPrMonitorErrorResultSchema,
  GithubPrMonitorReadResultSchema,
  MAX_TEXT_BYTES,
  MAX_WIRE_BYTES,
  makeToolCallProof,
  parseGithubPrMonitorReadInput,
  isSafeId,
  safeErrorMessage,
  validateMonitorError,
  validateMonitorSuccess,
} from "./github-pr-monitor-contract.js";

export const DIRECT_MONITOR_TOOLS = [
  "github_pr_monitor_read",
] as const;
export const DIRECT_MONITOR_WRITE_TOOLS = [
  "github_pr_monitor_write_preview",
  "github_pr_monitor_write_request",
  "github_pr_monitor_write_status",
  "github_pr_monitor_write_post_comment",
  "github_pr_monitor_write_post_reply",
  "github_pr_monitor_write_resolve_thread",
  "github_pr_monitor_write_rerequest_reviewer",
  "github_pr_monitor_write_approve",
  "github_pr_monitor_write_merge",
  "github_pr_monitor_write_apply_suggestions",
  "github_pr_monitor_write_push_prepared_worktree",
] as const;

export type DirectMonitorWriteTool = (typeof DIRECT_MONITOR_WRITE_TOOLS)[number];

export function isDirectMonitorWriteTool(value: string): value is DirectMonitorWriteTool {
  return (DIRECT_MONITOR_WRITE_TOOLS as readonly string[]).includes(value);
}

export type DirectMonitorTool = (typeof DIRECT_MONITOR_TOOLS)[number];

export interface DirectActionResponse extends Record<string, unknown> {
  ok: boolean;
  protocolVersion: 1;
  schemaVersion: 4;
  requestDigest: string;
  tool: DirectMonitorTool;
  toolCall: Record<string, unknown>;
  text: string;
  imageMarkdownList: unknown[];
  structuredContent: Record<string, unknown>;
}
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("Action input contains a non-finite number");
      return JSON.stringify(value);
    case "string": return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
    default: throw new Error(`Action input contains unsupported ${typeof value}`);
  }
}

export function actionRequestDigest(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}
const INVALID_INPUT_REQUEST_DIGEST = createHash("sha256").update("invalid-input", "utf8").digest("hex");

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(message);
  return value as Record<string, unknown>;
}


function exactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${context} contains unsupported fields: ${extras.join(",")}`);
}
function enforceWireCap(value: unknown, context: string): void {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new Error(`${context} is not serializable`); }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_WIRE_BYTES) {
    throw new Error(`${context} exceeds the bounded wire limit`);
  }
}

function materializedText(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("MCP result content must contain exactly one text item");
  const item = record(value[0], "MCP result content item is invalid");
  exactKeys(item, ["type", "text"], "MCP result content item");
  if (item.type !== "text" || typeof item.text !== "string" || item.text.length === 0
    || Buffer.byteLength(item.text, "utf8") > MAX_TEXT_BYTES) {
    throw new Error("MCP result content item is invalid");
  }
  return item.text;
}
function successfulStructuredContent(
  value: Record<string, unknown>,
  tool: DirectMonitorTool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (tool !== "github_pr_monitor_read"
    || !validateMonitorSuccess(value)
    || !GithubPrMonitorReadResultSchema.safeParse(value).success) {
    throw new Error("MCP success is not a valid shared github_pr_monitor_read result");
  }
  if (value.requestDigest !== actionRequestDigest(input)
    || value.runId !== input.runId
    || value.actionPlanId !== input.actionPlanId) {
    throw new Error("MCP success does not bind the exact read input");
  }
  const proof = record(value.chatgpt2codexToolCall, "MCP structuredContent omitted tool-call proof");
  if (proof.namespace !== "ChatGPT_To_Codex"
    || proof.toolName !== "github_pr_monitor_read"
    || proof.ok !== true
    || canonicalJson(proof.input) !== canonicalJson(input)) {
    throw new Error("MCP success does not bind the exact read tool-call proof");
  }
  return value;
}

function failedStructuredContent(
  value: Record<string, unknown>,
  tool: DirectMonitorTool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (tool !== "github_pr_monitor_read"
    || !validateMonitorError(value)
    || !GithubPrMonitorErrorResultSchema.safeParse(value).success) {
    throw new Error("MCP error is not a valid shared github_pr_monitor_read result");
  }
  if (value.requestDigest !== actionRequestDigest(input)
    || value.runId !== input.runId
    || value.actionPlanId !== input.actionPlanId) {
    throw new Error("MCP error does not bind the exact read input");
  }
  const proof = record(value.chatgpt2codexToolCall, "MCP structuredContent omitted tool-call proof");
  if (proof.namespace !== "ChatGPT_To_Codex"
    || proof.toolName !== "github_pr_monitor_read"
    || proof.ok !== false
    || canonicalJson(proof.input) !== canonicalJson(input)) {
    throw new Error("MCP error does not bind the exact read tool-call proof");
  }
  return value;
}

export function isDirectMonitorTool(value: string): value is DirectMonitorTool {
  return (DIRECT_MONITOR_TOOLS as readonly string[]).includes(value);
}

export function successfulDirectActionResponse(
  value: unknown,
  tool: DirectMonitorTool,
  input: Record<string, unknown>,
): DirectActionResponse {
  const response = record(value, `${tool} Action response must be an object`);
  exactKeys(
    response,
    ["ok", "protocolVersion", "schemaVersion", "requestDigest", "tool", "toolCall", "text", "imageMarkdownList", "structuredContent", "isError"],
    `${tool} Action response`,
  );
  const proof = record(response.toolCall, `${tool} Action response omitted toolCall proof`);
  const structured = successfulStructuredContent(
    record(response.structuredContent, `${tool} Action response omitted structuredContent`),
    tool,
    input,
  );
  const expectedProof = {
    ...record(structured.chatgpt2codexToolCall, `${tool} Action response omitted tool-call proof`),
    toolName: tool,
    input,
  };
  exactKeys(proof, Object.keys(expectedProof), `${tool} Action response toolCall proof`);
  for (const [key, expectedValue] of Object.entries(expectedProof)) {
    if (canonicalJson(proof[key]) !== canonicalJson(expectedValue)) {
      throw new Error(`${tool} Action response toolCall proof does not bind the exact call`);
    }
  }
  if (
    response.ok !== true
    || response.protocolVersion !== 1
    || response.schemaVersion !== 4
    || typeof response.requestDigest !== "string"
    || response.requestDigest !== actionRequestDigest(input)
    || response.tool !== tool
    || typeof response.text !== "string"
    || response.text.length === 0
    || Buffer.byteLength(String(response.text), "utf8") > MAX_TEXT_BYTES
    || !Array.isArray(response.imageMarkdownList)
    || response.imageMarkdownList.length !== 0
    || structured.namespace !== "ChatGPT_To_Codex"
    || structured.tool !== tool
    || structured.ok !== true
  ) {
    throw new Error(`${tool} did not return an exact successful v4 ChatGPT_To_Codex Action response`);
  }
  if (response.isError !== undefined && response.isError !== false) {
    throw new Error(`${tool} Action response must not mark a successful response as an error`);
  }
  enforceWireCap(response, `${tool} Action response`);
  return response as DirectActionResponse;
}
function failedDirectActionResponse(
  value: unknown,
  tool: DirectMonitorTool,
  input: Record<string, unknown>,
): DirectActionResponse {
  const response = record(value, `${tool} Action response must be an object`);
  exactKeys(
    response,
    ["ok", "protocolVersion", "schemaVersion", "requestDigest", "tool", "toolCall", "text", "imageMarkdownList", "structuredContent", "isError"],
    `${tool} Action response`,
  );
  const proof = record(response.toolCall, `${tool} Action response omitted toolCall proof`);
  const structured = record(response.structuredContent, `${tool} Action response omitted structuredContent`);
  const expectedProof = {
    ...record(structured.chatgpt2codexToolCall, `${tool} Action response omitted tool-call proof`),
    toolName: tool,
    input,
  };
  exactKeys(proof, Object.keys(expectedProof), `${tool} Action response toolCall proof`);
  for (const [key, expectedValue] of Object.entries(expectedProof)) {
    if (canonicalJson(proof[key]) !== canonicalJson(expectedValue)) {
      throw new Error(`${tool} Action response toolCall proof does not bind the exact call`);
    }
  }
  if (
    response.ok !== false
    || response.isError !== true
    || response.protocolVersion !== 1
    || response.schemaVersion !== 4
    || response.requestDigest !== actionRequestDigest(input)
    || response.tool !== tool
    || typeof response.text !== "string"
    || response.text.length === 0
    || Buffer.byteLength(String(response.text), "utf8") > MAX_TEXT_BYTES
    || !Array.isArray(response.imageMarkdownList)
    || response.imageMarkdownList.length !== 0
  ) {
    throw new Error(`${tool} did not return an exact failed v4 ChatGPT_To_Codex Action response`);
  }
  failedStructuredContent(record(response.structuredContent, `${tool} Action response omitted structuredContent`), tool, input);
  enforceWireCap(response, `${tool} Action response`);
  return response as DirectActionResponse;
}

export function actionResponseFromMcpResult(
  tool: DirectMonitorTool,
  input: Record<string, unknown>,
  result: unknown,
): Record<string, unknown> {
  if (tool === "github_pr_monitor_read") {
    try { parseGithubPrMonitorReadInput(input); } catch { throw new Error("Direct monitor input failed strict prevalidation"); }
  }
  const wire = record(result, "MCP result must be an object");
  exactKeys(wire, ["content", "structuredContent", "isError"], "MCP result");
  if (wire.isError !== undefined && typeof wire.isError !== "boolean") throw new Error("MCP result has a malformed error marker");
  const rawStructured = record(wire.structuredContent, "MCP result omitted structuredContent");
  const inferredError = wire.isError !== true
    && Object.hasOwn(rawStructured, "code")
    && Object.hasOwn(rawStructured, "error")
    && rawStructured.ok !== true;
  const ok = wire.isError !== true && !inferredError;
  const text = materializedText(wire.content);
  const structured = ok
    ? successfulStructuredContent(rawStructured, tool, input)
    : failedStructuredContent(rawStructured, tool, input);
  const proof = record(structured.chatgpt2codexToolCall, "MCP structuredContent omitted tool-call proof");
  const requestDigest = actionRequestDigest(input);
  const response: Record<string, unknown> = {
    ok,
    protocolVersion: 1,
    schemaVersion: 4,
    requestDigest,
    tool,
    toolCall: {
      ...structuredClone(proof),
      toolName: tool,
      input: structuredClone(input),
    },
    text,
    imageMarkdownList: [],
    structuredContent: structuredClone(structured),
    ...(ok ? {} : { isError: true }),
  };
  return ok ? successfulDirectActionResponse(response, tool, input) : failedDirectActionResponse(response, tool, input);
}

function safeInput(value: unknown): { runId: string; actionPlanId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const candidate = value as Record<string, unknown>;
    const runId = candidate.runId;
    const actionPlanId = candidate.actionPlanId;
    return isSafeId(runId) && isSafeId(actionPlanId) ? { runId, actionPlanId } : undefined;
  } catch {
    return undefined;
  }
}
function invalidDirectActionResponse(tool: DirectMonitorTool, input: Record<string, unknown>): DirectActionResponse {
  const safe = safeInput(input);
  const code = "GITHUB_MONITOR_INVALID_INPUT" as const;
  const error = safeErrorMessage(code);
  const requestDigest = safe ? actionRequestDigest(safe) : INVALID_INPUT_REQUEST_DIGEST;
  const structured: Record<string, unknown> = {
    monitorPayloadVersion: 1,
    protocolVersion: 1,
    schemaVersion: 4,
    requestDigest,
    namespace: "ChatGPT_To_Codex",
    tool,
    operation: "read",
    ok: false,
    ...(safe ? { runId: safe.runId, actionPlanId: safe.actionPlanId } : {}),
    code,
    error,
    chatgpt2codexToolCall: makeToolCallProof(safe, false),
  };
  const proof = record(structured.chatgpt2codexToolCall, "Direct invalid-input proof is invalid");
  const response: DirectActionResponse = {
    ok: false,
    protocolVersion: 1,
    schemaVersion: 4,
    requestDigest,
    tool,
    toolCall: { ...structuredClone(proof), toolName: tool },
    text: error,
    imageMarkdownList: [],
    structuredContent: structured,
    isError: true,
  };
  enforceWireCap(response, `${tool} Action response`);
  return response;
}
export interface DirectActionClient {
  call(tool: DirectMonitorTool, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function createDirectActionClient(ctx: ToolContext): Promise<DirectActionClient> {
  const server = await createMonitorServer(ctx);
  const client = new Client({ name: "chatgpt2codex-direct-monitor", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    async call(tool, input) {
      if (!isDirectMonitorTool(tool)) throw new Error("Direct monitor tool is not allowlisted");
      if (tool === "github_pr_monitor_read") {
        try { parseGithubPrMonitorReadInput(input); } catch { return invalidDirectActionResponse(tool, input); }
      }
      const result: unknown = await client.callTool({ name: tool, arguments: input });
      return actionResponseFromMcpResult(tool, input, result);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function safeWriteInput(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ["sessionId", "previewId", "approvalId", "idempotencyKey", "effectId"]) {
    if (isSafeId(input[key])) output[key] = input[key];
  }
  if (typeof input.operation === "string" && /^[a-z_]{1,64}$/u.test(input.operation)) output.operation = input.operation;
  return output;
}

function directWriteResponse(tool: DirectMonitorWriteTool, input: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  const result = record(raw, `${tool} MCP response is invalid`);
  const structured = record(result.structuredContent, `${tool} MCP response omitted structuredContent`);
  if (structured.protocolVersion !== 5 || structured.schemaVersion !== 5 || typeof structured.ok !== "boolean") {
    throw new Error(`${tool} MCP response is not a valid v5 write envelope`);
  }
  const text = materializedText(result.content);
  const response = {
    ok: result.isError !== true,
    protocolVersion: 5 as const,
    schemaVersion: 5 as const,
    requestDigest: actionRequestDigest(safeWriteInput(input)),
    tool,
    toolCall: { toolName: tool, input: safeWriteInput(input) },
    text,
    imageMarkdownList: [],
    structuredContent: structured,
    ...(result.isError === true ? { isError: true } : {}),
  };
  enforceWireCap(response, `${tool} direct response`);
  return response;
}

export interface DirectWriteActionClient {
  call(tool: DirectMonitorWriteTool, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function createDirectWriteActionClient(ctx: ToolContext): Promise<DirectWriteActionClient> {
  const server = await createMonitorWriteServer(ctx);
  const client = new Client({ name: "chatgpt2codex-direct-monitor-write", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    async call(tool, input) {
      if (!isDirectMonitorWriteTool(tool)) throw new Error("Direct monitor write tool is not allowlisted");
      const result = await client.callTool({ name: tool, arguments: input });
      return directWriteResponse(tool, input, result);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
