import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import { toolCallProof } from "./tool-proof.js";
import { GithubPrWriteAuthority } from "./github-pr-write-authority.js";
import { GITHUB_PR_WRITE_ACCOUNT, GITHUB_PR_WRITE_FORK_REPOSITORY, GITHUB_PR_WRITE_REPOSITORY, GithubPrWriteError, WRITE_OPERATIONS, digest, effectIdentityFor, type WriteStage } from "./github-pr-write-contract.js";
import { assertOperationAllowed, assertSafeBody, renderComment, type GithubEvidence, unattendedWriteEnabled } from "./github-pr-write-policy.js";
import { GithubPrWriteEffects, defaultGhCommand, type GhCommand } from "./github-pr-write-effects.js";
import { GithubPrWriteCodeEffects, defaultGitCommand, type GitCommand, type Suggestion } from "./github-pr-write-code-effects.js";

const operationSchema = z.enum(WRITE_OPERATIONS);
const evidenceSchema = z.object({ account: z.object({ login: z.string(), id: z.number().int(), nodeId: z.string(), actorType: z.enum(["User", "Bot", "Team", "App", "Unknown"]) }), author: z.object({ login: z.string(), id: z.number().int(), nodeId: z.string(), actorType: z.enum(["User", "Bot", "Team", "App", "Unknown"]) }), baseRepositoryId: z.number().int(), headRepositoryId: z.number().int(), repositoryId: z.number().int(), permission: z.enum(["NONE", "READ", "TRIAGE", "WRITE", "MAINTAIN", "ADMIN"]), canPush: z.boolean(), expectedHead: z.string() }).strict();
const boundedWriteObject = z.record(z.unknown()).refine((value) => {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= 32_000; } catch { return false; }
}, "write object exceeds its bound");
const previewSchema = z.object({ sessionId: z.string().min(1), operation: operationSchema, request: boundedWriteObject }).strict();
const requestSchema = z.object({ sessionId: z.string().min(1), previewId: z.string().min(1), approvalId: z.string().min(1), operation: operationSchema, request: boundedWriteObject, idempotencyKey: z.string().min(1).optional(), evidence: evidenceSchema }).strict();
const statusSchema = z.object({ effectId: z.string().min(1), sessionId: z.string().min(1).optional() }).strict();
const output = (value: Record<string, unknown>, text: string, isError = false) => ({ content: [{ type: "text", text }], structuredContent: value, isError });
const WRITE_ERROR_TEXT: Record<string, string> = {
  GITHUB_WRITE_INVALID_INPUT: "Write input is invalid.",
  GITHUB_WRITE_ATTESTATION: "Local Secure Enclave attestation is required.",
  GITHUB_WRITE_ATTESTATION_INVALID: "Local operator attestation is invalid.",
  GITHUB_WRITE_OPERATOR_REQUIRED: "A local operator is required.",
  GITHUB_WRITE_CAPABILITY_REQUIRED: "Write capability is unavailable.",
  GITHUB_WRITE_CAPABILITY_REVOKED: "Write capability has been revoked.",
  GITHUB_WRITE_PERMISSION_REQUIRED: "The connector lacks the required permission.",
  GITHUB_WRITE_PERMISSION_DENIED: "The current permission does not authorize this operation.",
  GITHUB_WRITE_ACTOR_UNAUTHORIZED: "The current actor is not authorized for this operation.",
  GITHUB_WRITE_SESSION_REQUIRED: "Write session is unavailable.",
  GITHUB_WRITE_SESSION_INVALID: "Write session is invalid.",
  GITHUB_WRITE_CONFLICT: "Write request conflicts with its preview.",
  GITHUB_WRITE_APPROVAL_REQUIRED: "Local approval is required.",
  GITHUB_WRITE_APPROVAL_INVALID: "Local approval is invalid.",
  GITHUB_WRITE_EXPIRED: "Write authority has expired.",
  GITHUB_WRITE_PREVIEW_EXPIRED: "Write preview has expired.",
  GITHUB_WRITE_ROLLOUT_BLOCKED: "Write rollout is blocked.",
  GITHUB_WRITE_MUTATION_DENIED: "The requested write operation is denied.",
  GITHUB_WRITE_BYPASS_DENIED: "Generic GitHub mutation bypass is denied.",
  GITHUB_WRITE_RECOVERY_REQUIRED: "Remote outcome is ambiguous; recovery is required.",
  GITHUB_WRITE_PREVIEW_LIMIT: "Write preview exceeds its bound.",
  GITHUB_WRITE_CLOCK_INVALID: "Write authority clock is invalid.",
  GITHUB_WRITE_LEGACY_STATE: "Legacy write state is unavailable.",
  GITHUB_WRITE_UNAVAILABLE: "Write mode is unavailable.",
};
const failure = (error: unknown) => {
  const e = error instanceof GithubPrWriteError
    ? error
    : new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT");
  const message = WRITE_ERROR_TEXT[e.code] ?? "Write mode is unavailable.";
  return output({ ok: false, protocolVersion: 5, schemaVersion: 5, error: { code: e.code, message } }, message, true);
};
function successEnvelope(
  tool: string,
  operation: typeof WRITE_OPERATIONS[number],
  session: { generation: number; bindingDigest: string },
  preview: { requestDigest: string },
  approvalId: string,
  effectId: string,
  receipt: unknown,
): Record<string, unknown> {
  return {
    ok: true,
    namespace: "ChatGPT_To_Codex",
    protocolVersion: 5,
    schemaVersion: 5,
    tool,
    operation,
    effectId,
    receiptId: digest(receipt),
    outcomeDigest: digest(receipt),
    sessionBindingDigest: session.bindingDigest,
    capabilityGeneration: session.generation,
    previewDigest: preview.requestDigest,
    approvalDigest: digest(approvalId),
    effect: { effectId, status: "completed", operation, receipt },
    chatgpt2codexToolCall: toolCallProof(tool, true),
  };
}
function writeStage(): WriteStage {
  const stage = process.env.CHATGPT2CODEX_MONITOR_ROLLOUT?.trim().toLowerCase();
  return stage === "enabled" || stage === "shadow" || stage === "prepare" || stage === "off" ? stage : "off";
}
function authorityOrThrow(authority: GithubPrWriteAuthority | undefined): GithubPrWriteAuthority { if (!authority) throw new GithubPrWriteError("GITHUB_WRITE_CAPABILITY_REQUIRED", "write authority is unavailable"); return authority; }
function assertTransportBoundSession(ctx: ToolContext, sessionId: string): void {
  if (ctx.remote && !ctx.writeSessionId) throw new GithubPrWriteError("GITHUB_WRITE_SESSION_REQUIRED", "remote transport has no host-bound write session");
  if (ctx.writeSessionId && ctx.writeSessionId !== sessionId) throw new GithubPrWriteError("GITHUB_WRITE_SESSION_INVALID", "write session is bound to a different transport");
}
function rejectCallerFields(value: Record<string, unknown>): void {
  for (const key of ["capabilityId", "generation", "signature", "confirm"]) {
    if (key in value) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT");
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      for (const item of nested) if (item && typeof item === "object" && !Array.isArray(item)) rejectCallerFields(item as Record<string, unknown>);
    } else if (nested && typeof nested === "object") {
      rejectCallerFields(nested as Record<string, unknown>);
    }
  }
}
function requiredString(value: Record<string, unknown>, key: string, maxLength = 512): string {
  const item = value[key];
  if (typeof item !== "string" || item.length === 0 || item.length > maxLength) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT");
  return item;
}
function assertOperationFields(operation: typeof WRITE_OPERATIONS[number], request: Record<string, unknown>): void {
  const allowed = operation === "post_comment"
    ? ["repository", "prNumber", "expectedHead", "baseRepository", "headRepository", "body"]
    : operation === "post_reply"
      ? ["repository", "prNumber", "expectedHead", "baseRepository", "headRepository", "body", "threadId", "replyReceiptId"]
      : operation === "resolve_thread"
        ? ["repository", "prNumber", "expectedHead", "baseRepository", "headRepository", "threadId", "replyReceiptId"]
        : operation === "rerequest_reviewer"
          ? ["repository", "prNumber", "expectedHead", "baseRepository", "headRepository", "reviewer"]
          : operation === "apply_suggestions"
            ? ["repository", "prNumber", "expectedHead", "baseRepository", "headRepository", "worktreePath", "suggestions", "message"]
            : ["repository", "prNumber", "expectedHead", "baseRepository", "headRepository", "worktreePath", "headRef", "verificationReceiptId", "verificationProofDigest", "noForce"];
  const allowedKeys = new Set(allowed);
  if (Object.keys(request).some((key) => !allowedKeys.has(key))) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT");
}
function assertHostTarget(request: Record<string, unknown>, evidence?: GithubEvidence, operation?: typeof WRITE_OPERATIONS[number]): void {
  const unattended = unattendedWriteEnabled();
  if (typeof request.repository !== "string" || (unattended ? !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(request.repository) : request.repository !== GITHUB_PR_WRITE_REPOSITORY)) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED");
  if (!Number.isSafeInteger(request.prNumber) || Number(request.prNumber) < 1 || typeof request.expectedHead !== "string" || !/^[0-9a-f]{40}$/iu.test(request.expectedHead)) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT");
  if (typeof request.baseRepository !== "string" || (unattended ? request.baseRepository !== request.repository : request.baseRepository !== GITHUB_PR_WRITE_REPOSITORY)) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED");
  if (typeof request.headRepository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(request.headRepository)) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED");
  const codeOperation = operation !== undefined && !["post_comment", "post_reply", "resolve_thread", "rerequest_reviewer"].includes(operation);
  if (codeOperation && !unattended && request.headRepository !== GITHUB_PR_WRITE_REPOSITORY && request.headRepository !== GITHUB_PR_WRITE_FORK_REPOSITORY) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED");
  if (codeOperation && unattended && request.headRepository !== request.baseRepository && !request.headRepository.toLowerCase().startsWith(`${GITHUB_PR_WRITE_ACCOUNT.toLowerCase()}/`)) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED");
  if (evidence && (evidence.account.login !== GITHUB_PR_WRITE_ACCOUNT || evidence.expectedHead !== request.expectedHead)) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED");
}
function reviewContext(input: z.infer<typeof requestSchema>) {
  const request = input.request;
  return {
    repository: requiredString(request, "repository"),
    prNumber: typeof request.prNumber === "number" ? request.prNumber : NaN,
    expectedHead: requiredString(request, "expectedHead"),
    actor: input.evidence.account.login,
    actorType: input.evidence.account.actorType,
    author: input.evidence.author.login,
    baseRepository: typeof request.baseRepository === "string" ? request.baseRepository : undefined,
    headRepository: typeof request.headRepository === "string" ? request.headRepository : undefined,
  };
}
function reviewEffect(input: z.infer<typeof requestSchema>, effectId: string) {
  const request = input.request;
  if (input.operation === "post_comment") {
    return { operation: input.operation, body: requiredString(request, "body", 6_000), effectIdentity: effectId } as const;
  }
  if (input.operation === "post_reply") {
    return {
      operation: input.operation,
      body: requiredString(request, "body", 6_000),
      effectIdentity: effectId,
      threadId: requiredString(request, "threadId"),
      replyReceiptId: requiredString(request, "replyReceiptId"),
    } as const;
  }
  if (input.operation === "resolve_thread") {
    return { operation: input.operation, threadId: requiredString(request, "threadId"), replyReceiptId: requiredString(request, "replyReceiptId") } as const;
  }
  if (input.operation === "rerequest_reviewer") return { operation: input.operation, reviewer: requiredString(request, "reviewer") } as const;
  throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED");
}
async function assertReviewerPreIntent(input: z.infer<typeof requestSchema>, gh: GhCommand): Promise<void> {
  if (input.operation !== "rerequest_reviewer") return;
  const reviewer = requiredString(input.request, "reviewer");
  const result = await gh(["api", `repos/${String(input.request.repository)}/pulls/${String(input.request.prNumber)}/requested_reviewers`, "--hostname", "github.com"], 15_000);
  if (result.timedOut || result.exitCode !== 0 || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout, "utf8") > 64 * 1024) {
    throw new GithubPrWriteError("GITHUB_WRITE_RECOVERY_REQUIRED", "reviewer pre-intent evidence is ambiguous");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { throw new GithubPrWriteError("GITHUB_WRITE_RECOVERY_REQUIRED", "reviewer pre-intent evidence is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new GithubPrWriteError("GITHUB_WRITE_RECOVERY_REQUIRED", "reviewer pre-intent evidence is invalid");
  const value = parsed as Record<string, unknown>;
  const users = value.users;
  const teams = value.teams;
  if (!Array.isArray(users) || !Array.isArray(teams)) throw new GithubPrWriteError("GITHUB_WRITE_RECOVERY_REQUIRED", "reviewer pre-intent evidence is incomplete");
  if (teams.length > 0 || users.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).login === reviewer)) {
    throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "reviewer is already requested");
  }
}
async function executeReviewEffect(input: z.infer<typeof requestSchema>, effectId: string, gh: GhCommand) {
  return new GithubPrWriteEffects(gh).execute(reviewContext(input), reviewEffect(input, effectId));
}
function suggestionList(value: unknown): Suggestion[] {
  if (!Array.isArray(value)) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT");
    const record = item as Record<string, unknown>;
    const pathValue = requiredString(record, "path");
    const startLine = typeof record.startLine === "number" ? record.startLine : NaN;
    const endLine = typeof record.endLine === "number" ? record.endLine : NaN;
    const expectedDigest = requiredString(record, "expectedDigest");
    const replacement = typeof record.replacement === "string" ? record.replacement : "";
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || !/^[0-9a-f]{64}$/iu.test(expectedDigest) || replacement.length > 12_000 || /\0|\r/u.test(replacement)) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT");
    return { path: pathValue, startLine, endLine, expectedDigest, replacement };
  });
}
function codeContext(input: z.infer<typeof requestSchema>, workspaceRoot: string) {
  const request = input.request;
  return {
    workspaceRoot,
    repository: requiredString(request, "repository"),
    prNumber: typeof request.prNumber === "number" ? request.prNumber : NaN,
    expectedHead: requiredString(request, "expectedHead"),
    baseRepository: requiredString(request, "baseRepository"),
    headRepository: requiredString(request, "headRepository"),
    headRef: typeof request.headRef === "string" ? request.headRef : undefined,
    evidence: input.evidence as GithubEvidence,
  };
}
async function executeCodeEffect(input: z.infer<typeof requestSchema>, effectId: string, workspaceRoot: string, git: GitCommand, gh: GhCommand) {
  const request = input.request;
  const worktreePath = requiredString(request, "worktreePath");
  const effects = new GithubPrWriteCodeEffects(git, gh);
  if (input.operation === "apply_suggestions") {
    return effects.execute(codeContext(input, workspaceRoot), {
      operation: input.operation,
      effectIdentity: effectId,
      worktreePath,
      suggestions: suggestionList(request.suggestions),
      ...(typeof request.message === "string" ? { message: request.message } : {}),
    });
  }
  if (input.operation === "push_prepared_worktree") {
    const headRef = requiredString(request, "headRef");
    if (request.noForce !== true) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT");
    return effects.execute(codeContext(input, workspaceRoot), {
      operation: "push_prepared_worktree",
      effectIdentity: effectId,
      worktreePath,
      headRef,
      verificationReceiptId: requiredString(request, "verificationReceiptId"),
      verificationProofDigest: requiredString(request, "verificationProofDigest"),
    });
  }
  throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED");
}
function validateRequestPayload(input: Pick<z.infer<typeof requestSchema>, "operation" | "request">): void {
  if (input.operation === "post_comment" || input.operation === "post_reply" || input.operation === "resolve_thread" || input.operation === "rerequest_reviewer") {
    const request = input.request;
    if (input.operation === "post_comment" || input.operation === "post_reply") assertSafeBody(requiredString(request, "body", 6_000));
    reviewEffect(input as z.infer<typeof requestSchema>, "validation-effect");
    return;
  }
  requiredString(input.request, "worktreePath");
  if (input.operation === "apply_suggestions") {
    suggestionList(input.request.suggestions);
    return;
  }
  requiredString(input.request, "headRef");
  requiredString(input.request, "verificationReceiptId");
  requiredString(input.request, "verificationProofDigest");
  if (input.request.noForce !== true) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT");
}
function add(server: McpServer, name: string, config: Record<string, unknown>, handler: (input: any) => Record<string, unknown> | Promise<Record<string, unknown>>): void {
  server.registerTool(name, config as never, (async (input: unknown) => {
    try { return await handler(input); } catch (error) { return failure(error); }
  }) as never);
}

export function registerGithubPrMonitorWriteTools(server: McpServer, ctx: ToolContext, authority?: GithubPrWriteAuthority): void {
  const gh = (ctx as ToolContext & { githubPrWriteGh?: GhCommand }).githubPrWriteGh ?? defaultGhCommand;
  const git = (ctx as ToolContext & { githubPrWriteGit?: GitCommand }).githubPrWriteGit ?? defaultGitCommand;
  add(server, "github_pr_monitor_write_preview", { title: "Preview GitHub PR write", inputSchema: previewSchema }, (raw) => {
    const input = previewSchema.parse(raw);
    const authorityValue = authorityOrThrow(authority);
    assertTransportBoundSession(ctx, input.sessionId);
    const previewSession = authorityValue.assertSession(input.sessionId);
    rejectCallerFields(input);
    rejectCallerFields(input.request);
    assertHostTarget(input.request, undefined, input.operation);
    assertOperationFields(input.operation, input.request);
    validateRequestPayload(input);
    const p = authorityValue.createPreview(input.sessionId, input.operation, input.request);
    const challenge = authorityValue.createChallenge(p.previewId);
    const previewBinding = { previewId: p.previewId, operation: p.operation, requestDigest: p.requestDigest, sessionId: p.sessionId };
    const previewIdentity = effectIdentityFor(previewBinding);
    const body = (input.operation === "post_comment" || input.operation === "post_reply") && typeof input.request.body === "string"
      ? renderComment(input.request.body, previewIdentity)
      : undefined;
    return output({
      ok: true,
      namespace: "ChatGPT_To_Codex",
      protocolVersion: 5,
      schemaVersion: 5,
      tool: "github_pr_monitor_write_preview",
      operation: p.operation,
      previewDigest: p.requestDigest,
      sessionBindingDigest: previewSession.bindingDigest,
      capabilityGeneration: previewSession.generation,
      preview: {
        previewId: p.previewId,
        challengeId: challenge.challengeId,
        operation: p.operation,
        requestDigest: p.requestDigest,
        operationDigest: digest({ operation: p.operation, request: input.request }),
        expiresAt: p.expiresAt,
        challengeExpiresAt: challenge.expiresAt,
        ...(body ? { renderedBody: body.body, bodyBytes: body.bytes, bodyDigest: body.contentDigest, marker: `<!-- gjc:auto-response:v2:${previewIdentity} -->` } : {}),
      },
    }, "Write preview created.");
  });
  const handleRequest = async (raw: unknown, fixedOperation?: typeof WRITE_OPERATIONS[number]) => {
    const input = (fixedOperation ? requestSchema.extend({ operation: z.literal(fixedOperation) }) : requestSchema).parse(raw);
    assertTransportBoundSession(ctx, input.sessionId);
    rejectCallerFields(input);
    rejectCallerFields(input.request);
    assertHostTarget(input.request, input.evidence as GithubEvidence, input.operation);
    assertOperationFields(input.operation, input.request);
    validateRequestPayload(input);
    const a = authorityOrThrow(authority);
    const stage = writeStage();
    assertOperationAllowed(input.operation, input.evidence as GithubEvidence, stage, (input.operation === "apply_suggestions" || input.operation === "push_prepared_worktree")
      ? { baseRepository: requiredString(input.request, "baseRepository"), headRepository: requiredString(input.request, "headRepository") }
      : undefined);
    const p = a.assertRequestAuthorized(input.sessionId, input.previewId, input.approvalId, input.operation, input.request);
    const boundSession = a.assertSession(input.sessionId);
    if (ctx.remote && input.idempotencyKey !== undefined) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "caller idempotency keys are not accepted on remote transports");
    const idempotencyKey = input.idempotencyKey ?? digest({ sessionId: input.sessionId, previewId: input.previewId, operation: input.operation, requestDigest: p.requestDigest });
    if (stage === "shadow") {
      return output({
        ok: true,
        namespace: "ChatGPT_To_Codex",
        protocolVersion: 5,
        schemaVersion: 5,
        tool: `github_pr_monitor_write_${input.operation}`,
        operation: input.operation,
        status: "shadow",
        previewDigest: p.requestDigest,
        sessionBindingDigest: boundSession.bindingDigest,
        capabilityGeneration: boundSession.generation,
      }, "Write request recorded in shadow mode; no effect was attempted.");
    }
    if (input.operation === "resolve_thread" && !a.hasOutcomeDigest(String(input.request.replyReceiptId), "post_reply")) {
      throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "thread resolution requires a recorded reply outcome");
    }
    if (input.operation === "push_prepared_worktree" && !a.hasOutcomeDigest(String(input.request.verificationReceiptId), "apply_suggestions", String(input.request.verificationProofDigest))) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED");
    await assertReviewerPreIntent(input, gh);
    const existingIntent = a.effectIntent(idempotencyKey);
    if (existingIntent && existingIntent.status !== "completed") throw new GithubPrWriteError("GITHUB_WRITE_RECOVERY_REQUIRED");
    const e = a.recordEffectIntent(p.previewId, idempotencyKey);
    if (e.status === "completed") return output({
      ...successEnvelope(`github_pr_monitor_write_${input.operation}`, input.operation, boundSession, p, input.approvalId, e.effectId, { status: "already_completed" }),
      effect: { effectId: e.effectId, status: e.status, operation: input.operation },
    }, "Write request already completed.");
    if (input.operation === "post_comment" || input.operation === "post_reply" || input.operation === "resolve_thread" || input.operation === "rerequest_reviewer") {
      try {
        const receipt = await executeReviewEffect(input, e.effectId, gh);
        a.recordEffectOutcome(e.effectId, receipt);
        return output(successEnvelope(`github_pr_monitor_write_${input.operation}`, input.operation, boundSession, p, input.approvalId, e.effectId, receipt), "Write request completed.");
      } catch (error) {
        if (error instanceof GithubPrWriteError && error.code === "GITHUB_WRITE_RECOVERY_REQUIRED") {
          a.markRecoveryRequired(e.effectId, error.message);
        }
        throw error;
      }
    }
    if (input.operation === "apply_suggestions" || input.operation === "push_prepared_worktree") {
      try {
        const receipt = await executeCodeEffect(input, e.effectId, ctx.workspaceRoot, git, gh);
        a.recordEffectOutcome(e.effectId, receipt);
        return output(successEnvelope(`github_pr_monitor_write_${input.operation}`, input.operation, boundSession, p, input.approvalId, e.effectId, receipt), "Write request completed.");
      } catch (error) {
        if (error instanceof GithubPrWriteError && error.code === "GITHUB_WRITE_RECOVERY_REQUIRED") {
          a.markRecoveryRequired(e.effectId, error.message);
        }
        throw error;
      }
    }
    throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED");
  };
  add(server, "github_pr_monitor_write_request", { title: "Request GitHub PR write", inputSchema: requestSchema }, handleRequest);
  add(server, "github_pr_monitor_write_status", { title: "Get GitHub PR write status", inputSchema: statusSchema }, (raw) => {
    const input = statusSchema.parse(raw);
    if (input.sessionId !== undefined) assertTransportBoundSession(ctx, input.sessionId);
    else if (ctx.remote) throw new GithubPrWriteError("GITHUB_WRITE_SESSION_REQUIRED");
    const writeAuthority = authorityOrThrow(authority);
    if (input.sessionId !== undefined) {
      writeAuthority.assertSession(input.sessionId);
      writeAuthority.assertEffectSession(input.effectId, input.sessionId);
    }
    const snapshot = writeAuthority.recover();
    const recovery = snapshot.recoveryRequiredEffectIds.includes(input.effectId);
    const pending = snapshot.pendingEffectIds.includes(input.effectId);
    const outcomeDigest = writeAuthority.outcomeDigest(input.effectId);
    return output({
      ok: true,
      namespace: "ChatGPT_To_Codex",
      protocolVersion: 5,
      schemaVersion: 5,
      tool: "github_pr_monitor_write_status",
      operation: "status",
      status: recovery ? "recovery_required" : pending ? "pending" : outcomeDigest ? "completed" : "unknown",
      effectId: input.effectId,
      ...(outcomeDigest ? { outcomeDigest } : {}),
    }, "Write status loaded.");
  });
  for (const operation of WRITE_OPERATIONS) {
    add(server, `github_pr_monitor_write_${operation}`, { title: `Request GitHub PR ${operation}`, inputSchema: requestSchema.extend({ operation: z.literal(operation) }) }, (raw) => handleRequest(raw, operation));
  }
}
export { previewSchema as GithubPrWritePreviewSchema, requestSchema as GithubPrWriteRequestSchema, statusSchema as GithubPrWriteStatusSchema };
