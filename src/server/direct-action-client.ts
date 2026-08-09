import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolContext } from "../types.js";
import { createMonitorServer } from "./mcp-server.js";
import { toolCallProof } from "./tool-proof.js";

export const DIRECT_MONITOR_TOOLS = [
  "github_pr_monitor_read",
  "github_pr_monitor_state",
  "github_pr_monitor_prepare",
  "github_pr_monitor_execute",
  "github_pr_monitor_mutate",
] as const;

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

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(message);
  return value as Record<string, unknown>;
}

const SUCCESSFUL_STRUCTURED_COMMON_KEYS = [
  "chatgpt2codexToolCall", "protocolVersion", "schemaVersion", "requestDigest", "receiptId",
  "namespace", "tool", "operation", "ok", "runId", "actionPlanId",
] as const;
const SUCCESSFUL_STRUCTURED_AUTHORIZATION_KEYS = [
  "ownerId", "leaseKey", "fence", "logicalIdentity", "operationKey", "operationHeadSha",
  "effectIdentity", "effectKey", "effectKind", "targetDigest", "policyDigest", "bindingDigest",
] as const;
const SUCCESSFUL_STRUCTURED_KEYS: Record<DirectMonitorTool, readonly string[]> = {
  github_pr_monitor_read: [
    ...SUCCESSFUL_STRUCTURED_COMMON_KEYS,
    "repository", "author", "prs", "observedAt",
  ],
  github_pr_monitor_state: [
    ...SUCCESSFUL_STRUCTURED_COMMON_KEYS,
    "command", "stdout",
  ],
  github_pr_monitor_prepare: [
    ...SUCCESSFUL_STRUCTURED_COMMON_KEYS,
    ...SUCCESSFUL_STRUCTURED_AUTHORIZATION_KEYS,
    "idempotencyKey", "eventId", "repository", "author", "prNumber", "expectedHeadSha",
    "oldHeadSha", "newHeadSha", "claimId", "claimedAt", "payloadDigest",
    "headRef", "worktreePath", "quarantinedPath", "safePath", "alreadyAbsent", "remoteObject", "timestamp",
  ],
  github_pr_monitor_execute: [
    ...SUCCESSFUL_STRUCTURED_COMMON_KEYS,
    ...SUCCESSFUL_STRUCTURED_AUTHORIZATION_KEYS,
    "idempotencyKey", "eventId", "repository", "author", "prNumber", "expectedHeadSha",
    "oldHeadSha", "newHeadSha", "claimId", "claimedAt", "payloadDigest",
    "worktreePath", "headRef", "ociImageDigest", "taskDigest", "changedPaths",
    "artifactDir", "bundleSha256", "baseTreeSha", "projectId", "commandId", "riskTier",
    "args", "headSha", "treeSha", "remoteObject", "timestamp",
  ],
  github_pr_monitor_mutate: [
    ...SUCCESSFUL_STRUCTURED_COMMON_KEYS,
    ...SUCCESSFUL_STRUCTURED_AUTHORIZATION_KEYS,
    "idempotencyKey", "eventId", "repository", "author", "prNumber", "expectedHeadSha",
    "oldHeadSha", "newHeadSha", "claimId", "claimedAt", "payloadDigest",
    "replyMarker", "remoteObject", "timestamp",
  ],
};
const SUCCESSFUL_MUTATE_OPERATION_FIELDS: Record<string, { allowed: readonly string[]; required: readonly string[] }> = {
  post_reply: { allowed: ["threadId", "triggerId"], required: ["threadId"] },
  resolve_thread: { allowed: ["threadId", "triggerId", "replyReceiptId"], required: ["threadId", "triggerId", "replyReceiptId"] },
  rerequest_reviewer: { allowed: [], required: [] },
  push_prepared_worktree: { allowed: [], required: [] },
};

function successfulStructuredKeys(tool: DirectMonitorTool, input: Record<string, unknown>): readonly string[] {
  const base = SUCCESSFUL_STRUCTURED_KEYS[tool];
  if (tool !== "github_pr_monitor_mutate") return base;
  const operation = typeof input.operation === "string" ? input.operation : "";
  const fields = SUCCESSFUL_MUTATE_OPERATION_FIELDS[operation];
  if (!fields) throw new Error("MCP success has an unsupported mutation operation");
  const missing = fields.required.filter((key) => !Object.hasOwn(input, key));
  if (missing.length > 0) throw new Error(`MCP success omitted mutation fields: ${missing.join(",")}`);
  const present = fields.allowed.filter((key) => Object.hasOwn(input, key));
  return [...base, ...present];
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${context} contains unsupported fields: ${extras.join(",")}`);
}

function exactProof(value: unknown, tool: DirectMonitorTool, ok: boolean): Record<string, unknown> {
  const proof = record(value, "MCP structuredContent omitted tool-call proof");
  const expected = toolCallProof(tool, ok);
  exactKeys(proof, Object.keys(expected), "MCP tool-call proof");
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (proof[key] !== expectedValue) throw new Error("MCP tool-call proof does not bind the exact tool result");
  }
  return proof;
}

function materializedText(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("MCP result content must contain exactly one text item");
  const item = record(value[0], "MCP result content item is invalid");
  exactKeys(item, ["type", "text"], "MCP result content item");
  if (item.type !== "text" || typeof item.text !== "string" || item.text.length === 0) {
    throw new Error("MCP result content item is invalid");
  }
  return item.text;
}

function successfulStructuredContent(
  value: Record<string, unknown>,
  tool: DirectMonitorTool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  exactKeys(value, successfulStructuredKeys(tool, input), "MCP success structuredContent");
  exactProof(value.chatgpt2codexToolCall, tool, true);
  if (value.namespace !== "ChatGPT_To_Codex" || value.tool !== tool || value.ok !== true) {
    throw new Error("MCP success does not bind the exact tool namespace and status");
  }
  if (value.protocolVersion !== 1 || value.schemaVersion !== 4) {
    throw new Error("MCP success does not negotiate protocolVersion 1 and schemaVersion 4");
  }
  if (typeof value.receiptId !== "string" || !/^[0-9a-f]{64}$/u.test(value.receiptId)) {
    throw new Error("MCP success omitted an exact receipt binding");
  }
  if (typeof value.requestDigest !== "string" || value.requestDigest !== actionRequestDigest(input)) {
    throw new Error("MCP success does not bind the exact Action input digest");
  }
  const authorizationBindings = [
    "protocolVersion", "schemaVersion", "ownerId", "leaseKey", "fence", "logicalIdentity", "operationKey",
    "operationHeadSha", "effectIdentity", "effectKey", "effectKind", "targetDigest", "policyDigest", "bindingDigest",
  ].filter((key) => Object.hasOwn(input, key));
  const bindings = tool === "github_pr_monitor_read"
    ? ["runId", "actionPlanId", "repository", "author"]
    : tool === "github_pr_monitor_state"
      ? ["runId", "actionPlanId", "command"]
      : [
          "runId", "actionPlanId", "idempotencyKey", "eventId", "repository", "author", "prNumber",
          "expectedHeadSha", "operation", ...authorizationBindings,
          ...(tool === "github_pr_monitor_mutate" && input.operation === "resolve_thread"
            ? ["threadId", "triggerId", "replyReceiptId"]
            : tool === "github_pr_monitor_mutate" && input.operation === "post_reply"
              ? ["threadId", ...(Object.hasOwn(input, "triggerId") ? ["triggerId"] : [])]
              : []),
        ];
  for (const key of bindings) {
    if (!Object.hasOwn(input, key) || !Object.hasOwn(value, key) || !isDeepStrictEqual(value[key], input[key])) {
      throw new Error(`MCP success receipt does not bind the exact ${key}`);
    }
  }
  if (tool === "github_pr_monitor_state" && value.operation !== input.command) {
    throw new Error("MCP success receipt does not bind the exact state operation");
  }
  if (tool === "github_pr_monitor_read" && value.operation !== "read") {
    throw new Error("MCP success receipt does not bind the exact read operation");
  }
  if (tool === "github_pr_monitor_mutate") {
    const marker = value.replyMarker;
    if (input.operation === "post_reply") {
      const expectedMarker = `<!-- gjc:auto-response:v1:${String(value.effectIdentity)} -->`;
      if (Object.hasOwn(input, "effectIdentity") && (typeof marker !== "string" || marker !== expectedMarker)) {
        throw new Error("MCP success post_reply does not bind its exact marker/channel relation");
      }
      if (marker !== undefined && (typeof marker !== "string" || marker !== expectedMarker)) {
        throw new Error("MCP success post_reply marker/channel relation is invalid");
      }
    } else if (marker !== undefined) {
      throw new Error("MCP success carried a reply marker for a non-post_reply operation");
    }
  }
  return value;
}

function failedStructuredContent(
  value: Record<string, unknown>,
  tool: DirectMonitorTool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  exactKeys(
    value,
    ["chatgpt2codexToolCall", "protocolVersion", "schemaVersion", "requestDigest", "code", "error", "details"],
    "MCP error structuredContent",
  );
  exactProof(value.chatgpt2codexToolCall, tool, false);
  if (
    value.protocolVersion !== 1
    || value.schemaVersion !== 4
    || typeof value.requestDigest !== "string"
    || value.requestDigest !== actionRequestDigest(input)
    || typeof value.code !== "string"
    || value.code.length === 0
    || typeof value.error !== "string"
    || value.error.length === 0
  ) {
    throw new Error("MCP error omitted its exact v4 code, message, or input binding");
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
  const expectedProof = { ...toolCallProof(tool, true), toolName: tool, input };
  exactKeys(proof, Object.keys(expectedProof), `${tool} Action response toolCall proof`);
  for (const [key, expectedValue] of Object.entries(expectedProof)) {
    if (!isDeepStrictEqual(proof[key], expectedValue)) {
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
  const expectedProof = { ...toolCallProof(tool, false), toolName: tool, input };
  exactKeys(proof, Object.keys(expectedProof), `${tool} Action response toolCall proof`);
  for (const [key, expectedValue] of Object.entries(expectedProof)) {
    if (!isDeepStrictEqual(proof[key], expectedValue)) {
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
    || !Array.isArray(response.imageMarkdownList)
    || response.imageMarkdownList.length !== 0
  ) {
    throw new Error(`${tool} did not return an exact failed v4 ChatGPT_To_Codex Action response`);
  }
  failedStructuredContent(record(response.structuredContent, `${tool} Action response omitted structuredContent`), tool, input);
  return response as DirectActionResponse;
}

export function actionResponseFromMcpResult(
  tool: DirectMonitorTool,
  input: Record<string, unknown>,
  result: unknown,
): Record<string, unknown> {
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
      const result: unknown = await client.callTool({ name: tool, arguments: input });
      return actionResponseFromMcpResult(tool, input, result);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
