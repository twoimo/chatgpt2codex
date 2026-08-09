import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstatSync, readdirSync } from "node:fs";
import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
interface SqliteStatement {
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  all(...parameters: unknown[]): Record<string, unknown>[];
  run(...parameters: unknown[]): { changes: number | bigint };
}

interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface DatabaseSyncConstructor {
  new (location: string, options?: { timeout?: number }): DatabaseSync;
}

const sqliteModuleId = `node:${"sqlite"}`;
const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
  DatabaseSync: DatabaseSyncConstructor;
};
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";

const REPOSITORY = "Yeachan-Heo/gajae-code";
const AUTHOR = "twoimo";
const RECEIPT_TTL_MS = 10 * 60 * 1000;
const MAX_RECEIPTS = 256;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_OUTCOME_BYTES = 1024 * 1024;
const OUTCOME_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const STORE_FILE = "action-receipts.json";
const OUTCOME_DIR = "action-mutation-outcomes";
const INDEX_DIR = "action-mutation-index";
const DATABASE_FILE = "action-receipts.sqlite";
const DATABASE_TIMEOUT_MS = 5_000;

export const ACTION_RECEIPT_TTL_MS = RECEIPT_TTL_MS;

export type ActionReceiptKind = "verification" | "monitor-read" | "monitor-action";
export type ActionReceiptPhase =
  | "issued"
  | "ingest-pending"
  | "ingested"
  | "plan-pending"
  | "record-pending"
  | "recorded"
  | "reconcile-pending"
  | "consumed";

const ReceiptSchema = z.object({
  receiptId: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(["verification", "monitor-read", "monitor-action"]),
  repository: z.literal(REPOSITORY),
  author: z.literal(AUTHOR),
  response: z.record(z.string(), z.unknown()),
  inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  phase: z.enum(["issued", "ingest-pending", "ingested", "plan-pending", "record-pending", "recorded", "reconcile-pending", "consumed"]),
  consumedAt: z.number().int().nonnegative().nullable(),
  metadata: z.record(z.string(), z.unknown()),
}).strict();
const AuthorizationBindingSchema = z.object({
  protocolVersion: z.literal(1),
  schemaVersion: z.literal(4),
  ownerId: z.string().min(1),
  leaseKey: z.string().min(1),
  fence: z.number().int().positive(),
  logicalIdentity: z.string().regex(/^[0-9a-f]{64}$/),
  operationKey: z.string().regex(/^[0-9a-f]{64}$/),
  operationHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  effectIdentity: z.string().regex(/^[0-9a-f]{64}$/),
  effectKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  effectKind: z.enum(["prepare_create", "prepare_quarantine", "post_reply", "resolve_thread", "rerequest_reviewer", "commit", "normal_push"]).optional(),
  targetDigest: z.string().regex(/^[0-9a-f]{64}$/),
  policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  bindingDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict().superRefine((binding, ctx) => {
  if ((binding.effectKey === undefined) !== (binding.effectKind === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "effectKey and effectKind must be provided together" });
  }
});


const MutationBindingSchema = z.object({
  runId: z.string().min(1),
  coordinationId: z.string().min(1),
  actionPlanId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  claimId: z.string().min(1),
  claimPayloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  repository: z.literal(REPOSITORY),
  author: z.literal(AUTHOR),
  prNumber: z.number().int().positive(),
  expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  eventId: z.string().min(1),
  phase: z.enum(["prepare", "execute", "mutate"]),
  operation: z.enum(["create", "quarantine", "post_reply", "resolve_thread", "rerequest_reviewer", "push_prepared_worktree", "apply_suggestions"]),
  operationFields: z.record(z.string(), z.unknown()),
  input: z.record(z.string(), z.unknown()),
  authorization: AuthorizationBindingSchema,
}).strict();

const MutationOutcomeSchema = z.object({
  outcomeKey: z.string().regex(/^[0-9a-f]{64}$/),
  binding: MutationBindingSchema,
  state: z.enum(["intent", "completed"]),
  startedAt: z.number().int().nonnegative(),
  intentEvidence: z.record(z.string(), z.unknown()).default({}),
  response: z.record(z.string(), z.unknown()).nullable(),
  receiptId: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  issuedAt: z.number().int().nonnegative().nullable(),
  completedAt: z.number().int().nonnegative().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
}).strict();

export type StoredActionReceipt = z.infer<typeof ReceiptSchema>;
export type MutationOutcomeBinding = z.infer<typeof MutationBindingSchema>;
const MUTATION_OPERATION_FIELD_RULES: Record<string, { allowed: readonly string[]; required: readonly string[] }> = {
  create: { allowed: ["headRef"], required: ["headRef"] },
  quarantine: { allowed: [], required: [] },
  post_reply: { allowed: ["body", "threadId", "triggerId"], required: ["body", "threadId"] },
  resolve_thread: { allowed: ["threadId", "triggerId", "replyReceiptId"], required: ["threadId", "triggerId", "replyReceiptId"] },
  rerequest_reviewer: { allowed: ["reviewer"], required: ["reviewer"] },
  push_prepared_worktree: { allowed: ["worktreePath", "headRef", "verification"], required: ["worktreePath", "headRef", "verification"] },
  apply_suggestions: { allowed: ["worktreePath", "headRef", "ociImageDigest", "suggestions"], required: ["worktreePath", "headRef", "ociImageDigest", "suggestions"] },
};

function validateMutationOperationFields(binding: MutationOutcomeBinding): void {
  const rule = MUTATION_OPERATION_FIELD_RULES[binding.operation];
  if (!rule) throw approvalRequired("Action outcome contains an unsupported mutation operation");
  const actual = Object.keys(binding.operationFields);
  const unexpected = actual.filter((key) => !rule.allowed.includes(key));
  const missing = rule.required.filter((key) => binding.operationFields[key] === undefined);
  if (unexpected.length > 0 || missing.length > 0) {
    throw approvalRequired("Action outcome contains operation fields outside its exact operation allowlist");
  }
  for (const key of rule.allowed) {
    if (Object.hasOwn(binding.input, key) && !Object.hasOwn(binding.operationFields, key)) {
      throw approvalRequired("Action outcome omitted an operation-specific input binding");
    }
    if (Object.hasOwn(binding.input, key)
      && Object.hasOwn(binding.operationFields, key)
      && canonicalJson(binding.input[key]) !== canonicalJson(binding.operationFields[key])) {
      throw approvalRequired("Action outcome altered an operation-specific input binding");
    }
  }
  if (binding.operation === "push_prepared_worktree" && Object.hasOwn(binding.input, "remoteUrl")) {
    throw approvalRequired("Push mutation input contains an unowned remoteUrl");
  }
}
type StoredMutationOutcome = z.infer<typeof MutationOutcomeSchema>;

export interface CompletedMutationOutcome {
  response: Record<string, unknown>;
  receiptId: string;
}

export type MutationOutcomeStatus =
  | { state: "intent"; outcomeKey: string; startedAt: number; intentEvidence?: Record<string, unknown> }
  | ({ state: "completed" } & CompletedMutationOutcome);

export interface CompleteMutationOutcome {
  response: Record<string, unknown>;
  receiptId: string;
  issuedAt: number;
  metadata: Record<string, unknown>;
}

export interface IssueActionReceipt {
  receiptId: string;
  kind: ActionReceiptKind;
  response: Record<string, unknown>;
  input: Record<string, unknown>;
  issuedAt: number;
  metadata: Record<string, unknown>;
}


const locks = new Map<string, Promise<void>>();

function approvalRequired(message: string): DomainError {
  return new DomainError(ErrorCode.APPROVAL_REQUIRED, message);
}

function digest(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw approvalRequired("Action receipt binding is not JSON-serializable");
  return createHash("sha256").update(serialized).digest("hex");
}

function intentEvidenceDigest(outcome: StoredMutationOutcome): string {
  return digest(outcome.intentEvidence);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw approvalRequired("Action outcome binding only accepts finite numbers");
      return JSON.stringify(value);
    case "string": return JSON.stringify(value);
    case "undefined": throw approvalRequired("Action outcome binding cannot contain undefined");
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
    default: throw approvalRequired(`Action outcome binding cannot contain ${typeof value}`);
  }
}

function mutationOutcomeKey(binding: MutationOutcomeBinding): string {
  return createHash("sha256").update(canonicalJson(binding)).digest("hex");
}

function exactInputFromResponse(response: Record<string, unknown>): unknown {
  const toolCall = response.toolCall;
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return undefined;
  return (toolCall as Record<string, unknown>).input;
}
function validateMutationReceiptOperationFields(
  input: Record<string, unknown>,
  structured: Record<string, unknown>,
): void {
  if (input.operation !== structured.operation) {
    throw approvalRequired("Action receipt operation binding is inconsistent");
  }
  if (input.operation === "resolve_thread") {
    for (const key of ["threadId", "triggerId", "replyReceiptId"] as const) {
      if (typeof input[key] !== "string" || structured[key] !== input[key]) {
        throw approvalRequired("Resolve action receipt omitted an exact operation-specific provenance binding");
      }
    }
  } else if (input.operation === "post_reply") {
    if (typeof input.threadId !== "string" || structured.threadId !== input.threadId) {
      throw approvalRequired("Reply action receipt omitted an exact threadId provenance binding");
    }
    if (input.triggerId !== undefined && (typeof input.triggerId !== "string" || structured.triggerId !== input.triggerId)) {
      throw approvalRequired("Reply action receipt omitted an exact triggerId provenance binding");
    }
    if (input.triggerId === undefined && Object.hasOwn(structured, "triggerId")) {
      throw approvalRequired("Reply action receipt contains an unbound triggerId provenance field");
    }
  }
}

function validateReceiptBinding(receipt: StoredActionReceipt): void {
  if (receipt.expiresAt !== receipt.issuedAt + RECEIPT_TTL_MS) {
    throw approvalRequired("Action receipt store contains an invalid expiry binding");
  }
  const responseInput = exactInputFromResponse(receipt.response);
  if (digest(responseInput) !== receipt.inputDigest) {
    throw approvalRequired("Action receipt store contains a corrupt input binding");
  }
  if ((receipt.phase === "consumed") !== (receipt.consumedAt !== null)
    || (receipt.consumedAt !== null && (receipt.consumedAt < receipt.issuedAt || receipt.consumedAt > receipt.expiresAt))) {
    throw approvalRequired("Action receipt store contains an invalid consumption binding");
  }
  const phasesByKind: Record<ActionReceiptKind, readonly ActionReceiptPhase[]> = {
    verification: ["issued", "record-pending", "recorded", "reconcile-pending", "consumed"],
    "monitor-read": ["issued", "ingest-pending", "ingested", "plan-pending", "consumed"],
    "monitor-action": ["issued", "record-pending", "recorded", "reconcile-pending", "consumed"],
  };
  const structured = receipt.response.structuredContent;
  const toolCall = receipt.response.toolCall;
  const structuredRecord = structured && typeof structured === "object" && !Array.isArray(structured)
    ? structured as Record<string, unknown> : undefined;
  const toolCallRecord = toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)
    ? toolCall as Record<string, unknown> : undefined;
  const inputRecord = responseInput && typeof responseInput === "object" && !Array.isArray(responseInput)
    ? responseInput as Record<string, unknown> : undefined;
  const expectedTools = receipt.kind === "verification"
    ? ["command_run", "github_pr_monitor_execute"]
    : receipt.kind === "monitor-read"
      ? ["github_pr_monitor_read"]
      : ["github_pr_monitor_prepare", "github_pr_monitor_mutate"];
  if (!phasesByKind[receipt.kind].includes(receipt.phase)
    || !structuredRecord
    || structuredRecord.receiptId !== receipt.receiptId
    || typeof receipt.response.tool !== "string"
    || !expectedTools.includes(receipt.response.tool)
    || toolCallRecord?.toolName !== receipt.response.tool) {
    throw approvalRequired("Action receipt store contains a corrupt response binding");
  }
  const executeVerification = receipt.kind === "verification" && receipt.response.tool === "github_pr_monitor_execute";
  if (receipt.kind !== "verification"
    && (structuredRecord.repository !== REPOSITORY
      || structuredRecord.author !== AUTHOR
      || inputRecord?.repository !== REPOSITORY
      || inputRecord?.author !== AUTHOR)) {
    throw approvalRequired("Action receipt store contains a foreign repository or author binding");
  }
  if (receipt.kind === "monitor-action" && receipt.response.tool === "github_pr_monitor_mutate") {
    if (!inputRecord || !structuredRecord) {
      throw approvalRequired("Monitor action receipt omitted its exact mutation input binding");
    }
    validateMutationReceiptOperationFields(inputRecord, structuredRecord);
  }
  if (receipt.kind === "verification") {
    const inputArgs = Array.isArray(inputRecord?.args) ? inputRecord.args : [];
    const exactArgs = executeVerification ? ["bun", "test"] : inputArgs;
    if ((!executeVerification && !["issued", "consumed"].includes(receipt.phase))
      || receipt.metadata.projectId !== (executeVerification ? inputRecord?.worktreePath && path.basename(String(inputRecord.worktreePath)) : inputRecord?.projectId)
      || receipt.metadata.projectId !== structuredRecord.projectId
      || receipt.metadata.commandId !== (executeVerification ? "github_pr_monitor_execute" : inputRecord?.commandId)
      || receipt.metadata.commandId !== structuredRecord.commandId
      || receipt.metadata.riskTier !== "verify"
      || structuredRecord.riskTier !== "verify"
      || !Array.isArray(receipt.metadata.args)
      || !Array.isArray(structuredRecord.args)
      || canonicalJson(receipt.metadata.args) !== canonicalJson(exactArgs)
      || canonicalJson(receipt.metadata.args) !== canonicalJson(structuredRecord.args)
      || receipt.metadata.headSha !== structuredRecord.headSha
      || receipt.metadata.treeSha !== structuredRecord.treeSha
      || typeof receipt.metadata.headSha !== "string"
      || typeof receipt.metadata.treeSha !== "string"
      || (executeVerification && (
        structuredRecord.exitCode !== 0
        || structuredRecord.operation !== "apply_suggestions"
        || structuredRecord.repository !== REPOSITORY
        || structuredRecord.author !== AUTHOR
        || inputRecord?.repository !== REPOSITORY
        || inputRecord?.author !== AUTHOR
        || receipt.metadata.artifactDir !== structuredRecord.artifactDir
        || receipt.metadata.bundleSha256 !== structuredRecord.bundleSha256
        || receipt.metadata.baseTreeSha !== structuredRecord.baseTreeSha
        || typeof structuredRecord.artifactDir !== "string"
        || typeof structuredRecord.bundleSha256 !== "string"
        || !/^[0-9a-f]{64}$/.test(structuredRecord.bundleSha256)
        || typeof structuredRecord.baseTreeSha !== "string"
        || !/^[0-9a-f]{40}$/.test(structuredRecord.baseTreeSha)
        || typeof structuredRecord.taskDigest !== "string"
        || !/^[0-9a-f]{64}$/.test(structuredRecord.taskDigest)
        || !Array.isArray(structuredRecord.changedPaths)
        || !structuredRecord.changedPaths.every((value) => typeof value === "string")
      ))) {
      throw approvalRequired("Verification receipt metadata is not bound to its exact command response");
    }
  }
}

function validateMutationOutcome(outcome: StoredMutationOutcome): void {
  if (outcome.outcomeKey !== mutationOutcomeKey(outcome.binding)) {
    throw approvalRequired("Action outcome store contains a corrupt exact binding");
  }
  const binding = outcome.binding;
  validateMutationOperationFields(binding);
  const authorization = binding.authorization;
  const unsignedAuthorization = { ...authorization } as Record<string, unknown>;
  delete unsignedAuthorization.bindingDigest;
  const expectedClaimDigest = createHash("sha256").update(canonicalJson({
    runId: binding.runId,
    actionPlanId: binding.actionPlanId,
    idempotencyKey: binding.idempotencyKey,
    repository: binding.repository,
    prNumber: binding.prNumber,
    headSha: binding.expectedHeadSha,
    phase: binding.phase,
    operation: binding.operation,
    operationFields: binding.operationFields,
    ...authorization,
  })).digest("hex");
  const authorizationMatchesInput = Object.entries(authorization).every(([key, value]) =>
    canonicalJson(binding.input[key]) === canonicalJson(value));
  const completed = outcome.state === "completed";
  if (expectedClaimDigest !== binding.claimPayloadDigest
    || createHash("sha256").update(canonicalJson(unsignedAuthorization)).digest("hex") !== authorization.bindingDigest
    || !authorizationMatchesInput
    || authorization.operationHeadSha !== binding.expectedHeadSha
    || binding.input.runId !== binding.runId
    || binding.input.actionPlanId !== binding.actionPlanId
    || binding.input.idempotencyKey !== binding.idempotencyKey
    || binding.input.eventId !== binding.eventId
    || binding.input.repository !== binding.repository
    || binding.input.author !== binding.author
    || binding.input.prNumber !== binding.prNumber
    || String(binding.input.expectedHeadSha).toLowerCase() !== binding.expectedHeadSha
    || binding.input.operation !== binding.operation
    || (binding.phase === "prepare") !== ["create", "quarantine"].includes(binding.operation)
    || (binding.phase === "execute") !== (binding.operation === "apply_suggestions")) {
    throw approvalRequired("Action outcome store contains an inconsistent claim or effect binding");
  }
  const evidenceKeys = Object.keys(outcome.intentEvidence);
  if (binding.operation === "rerequest_reviewer") {
    const currentEvidence = evidenceKeys.length === 1
      && typeof outcome.intentEvidence.reviewerRequestedBeforeIntent === "boolean";
    if (!currentEvidence) {
      throw approvalRequired("Reviewer Action outcome omitted its exact pre-apply evidence");
    }
  } else if (evidenceKeys.length !== 0) {
    throw approvalRequired("Action outcome contains unexpected pre-apply evidence");
  }
  if (completed !== (outcome.response !== null)
    || completed !== (outcome.receiptId !== null)
    || completed !== (outcome.issuedAt !== null)
    || completed !== (outcome.completedAt !== null)
    || completed !== (outcome.metadata !== null)
    || (completed && outcome.issuedAt !== outcome.startedAt)
    || (completed && (outcome.completedAt as number) < outcome.startedAt)) {
    throw approvalRequired("Action outcome store contains an incomplete durable outcome");
  }
  if (!completed) return;
  const response = outcome.response as Record<string, unknown>;
  const structured = response.structuredContent;
  const structuredRecord = structured && typeof structured === "object" && !Array.isArray(structured)
    ? structured as Record<string, unknown> : undefined;
  const tool = binding.operation === "apply_suggestions"
    ? "github_pr_monitor_execute"
    : binding.phase === "prepare" ? "github_pr_monitor_prepare" : "github_pr_monitor_mutate";
  if (response.ok !== true
    || response.tool !== tool
    || canonicalJson(exactInputFromResponse(response)) !== canonicalJson(binding.input)
    || !structuredRecord
    || structuredRecord.receiptId !== outcome.receiptId
    || structuredRecord.runId !== binding.runId
    || structuredRecord.actionPlanId !== binding.actionPlanId
    || structuredRecord.idempotencyKey !== binding.idempotencyKey
    || structuredRecord.claimId !== binding.claimId
    || structuredRecord.payloadDigest !== binding.claimPayloadDigest
    || structuredRecord.repository !== REPOSITORY
    || structuredRecord.author !== AUTHOR
    || structuredRecord.prNumber !== binding.prNumber
    || String(structuredRecord.expectedHeadSha).toLowerCase() !== binding.expectedHeadSha
    || structuredRecord.eventId !== binding.eventId
    || structuredRecord.operation !== binding.operation
    || Object.entries(authorization).some(([key, value]) => canonicalJson(structuredRecord[key]) !== canonicalJson(value))) {
    throw approvalRequired("Action outcome store contains a corrupt response binding");
  }
}

function serializeBounded(value: unknown, message: string, maxBytes = MAX_OUTCOME_BYTES): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw approvalRequired(message);
  }
  return serialized;
}

function parseJsonDocument(raw: unknown, label: string, maxBytes = MAX_OUTCOME_BYTES): unknown {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw approvalRequired(`${label} is not a bounded JSON document`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw approvalRequired(`${label} contains malformed JSON`);
  }
}

function parseReceiptDocument(raw: unknown): StoredActionReceipt {
  const parsed = ReceiptSchema.safeParse(parseJsonDocument(raw, "Action receipt row"));
  if (!parsed.success) throw approvalRequired("Action receipt row failed validation");
  validateReceiptBinding(parsed.data);
  return parsed.data;
}

function parseOutcomeDocument(raw: unknown): StoredMutationOutcome {
  const parsed = MutationOutcomeSchema.safeParse(parseJsonDocument(raw, "Action outcome row"));
  if (!parsed.success) throw approvalRequired("Action outcome row failed validation");
  validateMutationOutcome(parsed.data);
  return parsed.data;
}

function sqliteFailure(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/busy|locked/i.test(message)) throw approvalRequired("Action receipt database acquisition timed out");
  throw approvalRequired(`Action receipt database operation failed: ${message}`);
}

async function exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let releaseLocal: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { releaseLocal = resolve; });
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    releaseLocal();
    if (locks.get(key) === current) locks.delete(key);
  }
}

export class ActionReceiptAuthority {
  private readonly stateDir: string;
  private readonly databasePath: string;
  private readonly legacyStorePath: string;

  constructor(stateDir: string) {
    this.stateDir = path.resolve(stateDir);
    this.databasePath = path.join(this.stateDir, DATABASE_FILE);
    this.legacyStorePath = path.join(this.stateDir, STORE_FILE);
  }

  async issue(input: IssueActionReceipt): Promise<void> {
    await this.transact((database, now) => {
      this.pruneReceipts(database, now);
      if (this.receipt(database, input.receiptId)) throw approvalRequired("Action receipt identifier was already issued");
      if (this.receiptCount(database, now) >= MAX_RECEIPTS) throw approvalRequired("Action receipt store is full of unexpired receipts");
      const receipt = ReceiptSchema.parse({
        receiptId: input.receiptId,
        kind: input.kind,
        repository: REPOSITORY,
        author: AUTHOR,
        response: structuredClone(input.response),
        inputDigest: digest(input.input),
        issuedAt: input.issuedAt,
        expiresAt: input.issuedAt + RECEIPT_TTL_MS,
        phase: "issued",
        consumedAt: null,
        metadata: structuredClone(input.metadata),
      });
      if (now < input.issuedAt) throw approvalRequired("Action receipt issue time is in the future");
      validateReceiptBinding(receipt);
      this.insertReceipt(database, receipt);
    });
  }

  async mutationOutcomeStatus(
    rawBinding: MutationOutcomeBinding,
    claimStatus: "claimed" | "applied" | "reconciled",
  ): Promise<MutationOutcomeStatus | undefined> {
    const binding = MutationBindingSchema.parse(structuredClone(rawBinding));
    return this.transact((database) => {
      const outcome = this.findMutationOutcome(database, binding);
      if (!outcome) {
        if (claimStatus !== "claimed") {
          throw approvalRequired("Applied or reconciled monitor claim has no exact durable Action outcome");
        }
        return undefined;
      }
      if (outcome.state === "intent") {
        const intentEvidence = structuredClone(outcome.intentEvidence);
        return {
          state: "intent",
          outcomeKey: outcome.outcomeKey,
          startedAt: outcome.startedAt,
          ...(Object.keys(intentEvidence).length > 0 ? { intentEvidence } : {}),
        };
      }
      if (!outcome.response || !outcome.receiptId) throw approvalRequired("Exact durable Action outcome is incomplete");
      return {
        state: "completed",
        response: structuredClone(outcome.response),
        receiptId: outcome.receiptId,
      };
    });
  }

  async beginMutationOutcome(
    rawBinding: MutationOutcomeBinding,
    rawIntentEvidence: Record<string, unknown> = {},
  ): Promise<string> {
    const binding = MutationBindingSchema.parse(structuredClone(rawBinding));
    const intentEvidence = structuredClone(rawIntentEvidence);
    const outcomeKey = mutationOutcomeKey(binding);
    await this.transact((database, now) => {
      this.pruneOutcomes(database, now);
      const existing = this.findMutationOutcome(database, binding);
      if (existing) {
        throw approvalRequired(existing.state === "completed"
          ? "Exact durable Action outcome already exists and must be recovered"
          : "Durable mutation intent exists without an exact successful Action outcome");
      }
      const outcome = MutationOutcomeSchema.parse({
        outcomeKey,
        binding,
        state: "intent",
        startedAt: now,
        intentEvidence,
        response: null,
        receiptId: null,
        issuedAt: null,
        completedAt: null,
        metadata: null,
      });
      validateMutationOutcome(outcome);
      const document = serializeBounded(outcome, "Action outcome exceeds the bounded shard size");
      const evidenceDigest = intentEvidenceDigest(outcome);
      try {
        database.prepare(`
          INSERT INTO mutation_outcomes
            (outcome_key, claim_id, idempotency_key, state, completed_at, intent_evidence_digest, document)
          VALUES (?, ?, ?, 'intent', NULL, ?, ?)
        `).run(outcome.outcomeKey, binding.claimId, binding.idempotencyKey, evidenceDigest, document);
      } catch (error: unknown) {
        if (/unique|constraint/i.test(error instanceof Error ? error.message : String(error))) {
          throw approvalRequired("Monitor mutation identity is already bound to a different exact durable outcome");
        }
        throw error;
      }
    });
    return outcomeKey;
  }

  async completeMutationOutcome(
    outcomeKey: string,
    rawBinding: MutationOutcomeBinding,
    completed: CompleteMutationOutcome,
  ): Promise<void> {
    const binding = MutationBindingSchema.parse(structuredClone(rawBinding));
    if (outcomeKey !== mutationOutcomeKey(binding)) {
      throw approvalRequired("Action outcome completion does not bind the exact durable intent");
    }
    await this.transact((database, now) => {
      const outcome = this.findMutationOutcome(database, binding);
      if (!outcome || outcome.outcomeKey !== outcomeKey || outcome.state !== "intent") {
        throw approvalRequired("Action outcome completion has no exact pending durable intent");
      }
      const next = MutationOutcomeSchema.parse({
        ...outcome,
        state: "completed",
        response: structuredClone(completed.response),
        receiptId: completed.receiptId,
        issuedAt: completed.issuedAt,
        completedAt: now,
        metadata: structuredClone(completed.metadata),
      });
      validateMutationOutcome(next);
      const changed = database.prepare(`
        UPDATE mutation_outcomes
        SET state = 'completed', completed_at = ?, document = ?
        WHERE outcome_key = ? AND state = 'intent'
      `).run(now, serializeBounded(next, "Action outcome exceeds the bounded shard size"), outcomeKey).changes;
      if (Number(changed) !== 1) throw approvalRequired("Action outcome completion lost its exact pending durable intent");
    });
  }

  async materializeMutationOutcome(rawBinding: MutationOutcomeBinding): Promise<CompletedMutationOutcome> {
    const binding = MutationBindingSchema.parse(structuredClone(rawBinding));
    return this.transact((database, now) => {
      this.pruneReceipts(database, now);
      const outcome = this.findMutationOutcome(database, binding);
      if (!outcome || outcome.state !== "completed" || !outcome.response || !outcome.receiptId
        || outcome.issuedAt === null || !outcome.metadata) {
        throw approvalRequired("Exact durable Action outcome is not complete");
      }
      if (now < outcome.issuedAt) throw approvalRequired("Action outcome issue time is in the future");
      const existing = this.receipt(database, outcome.receiptId);
      if (existing) {
        if (existing.kind !== (binding.operation === "apply_suggestions" ? "verification" : "monitor-action")
          || canonicalJson(existing.response) !== canonicalJson(outcome.response)
          || existing.issuedAt !== outcome.issuedAt
          || Object.entries(outcome.metadata).some(([key, value]) =>
            canonicalJson(existing.metadata[key]) !== canonicalJson(value))) {
          throw approvalRequired("Durable Action outcome conflicts with its ordinary receipt");
        }
      } else {
        if (this.receiptCount(database, now) >= MAX_RECEIPTS) {
          throw approvalRequired("Action receipt store is full of unexpired receipts");
        }
        const receipt = ReceiptSchema.parse({
          receiptId: outcome.receiptId,
          kind: binding.operation === "apply_suggestions" ? "verification" : "monitor-action",
          repository: REPOSITORY,
          author: AUTHOR,
          response: structuredClone(outcome.response),
          inputDigest: digest(exactInputFromResponse(outcome.response)),
          issuedAt: outcome.issuedAt,
          expiresAt: outcome.issuedAt + RECEIPT_TTL_MS,
          phase: "issued",
          consumedAt: null,
          metadata: structuredClone(outcome.metadata),
        });
        validateReceiptBinding(receipt);
        this.insertReceipt(database, receipt);
      }
      return { response: structuredClone(outcome.response), receiptId: outcome.receiptId };
    });
  }

  async exactById(
    receiptId: string,
    kind: ActionReceiptKind,
    phases: readonly ActionReceiptPhase[],
  ): Promise<StoredActionReceipt> {
    if (!/^[0-9a-f]{64}$/.test(receiptId)) {
      throw approvalRequired("Action receipt identifier is invalid");
    }
    return this.transact((database, now) => {
      const receipt = this.receipt(database, receiptId);
      const expired = !receipt || receipt.expiresAt < now;
      if (
        !receipt
        || receipt.kind !== kind
        || expired
        || now < receipt.issuedAt
        || !phases.includes(receipt.phase)
      ) {
        throw approvalRequired("Action receipt is corrupt, stale, replayed, or not the exact issued response");
      }
      return structuredClone(receipt);
    });
  }

  async exact(
    receiptId: string,
    kind: ActionReceiptKind,
    response: unknown,
    phases: readonly ActionReceiptPhase[],
  ): Promise<StoredActionReceipt> {
    return this.transact((database, now) => structuredClone(
      this.requireExact(database, now, receiptId, kind, response, phases),
    ));
  }

  async transitionExact(
    receiptId: string,
    kind: ActionReceiptKind,
    response: unknown,
    from: readonly ActionReceiptPhase[],
    to: ActionReceiptPhase,
    metadata?: Record<string, unknown>,
  ): Promise<StoredActionReceipt> {
    return this.transact((database, now) => {
      const receipt = this.requireExact(database, now, receiptId, kind, response, from);
      receipt.phase = to;
      receipt.consumedAt = to === "consumed" ? now : null;
      if (metadata) receipt.metadata = { ...receipt.metadata, ...structuredClone(metadata) };
      validateReceiptBinding(receipt);
      database.prepare("UPDATE receipts SET expires_at = ?, recovery_until = ?, document = ? WHERE receipt_id = ?")
        .run(
          receipt.expiresAt,
          this.receiptRecoveryUntil(receipt),
          serializeBounded(receipt, "Action receipt store cannot be written inside its bounded size", MAX_STORE_BYTES),
          receipt.receiptId,
        );
      return structuredClone(receipt);
    });
  }

  async planBinding(runId: string, actionPlanId: string): Promise<{ coordinationId: string }> {
    return this.transact((database, now) => {
      const matches = this.receipts(database).filter((receipt) => {
        const recoveryUntil = this.receiptRecoveryUntil(receipt);
        return receipt.kind === "monitor-read"
          && receipt.phase === "consumed"
          && (receipt.expiresAt >= now || (recoveryUntil !== null && recoveryUntil >= now))
          && receipt.metadata.runId === runId
          && receipt.metadata.monitorActionPlanId === actionPlanId
          && typeof receipt.metadata.coordinationId === "string";
      });
      if (matches.length !== 1) {
        throw approvalRequired("Monitor action plan has no unique durable product coordination binding");
      }
      return { coordinationId: matches[0]!.metadata.coordinationId as string };
    });
  }

  private async transact<T>(operation: (database: DatabaseSync, now: number) => T): Promise<T> {
    return exclusive(this.databasePath, async () => {
      await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
      await chmod(this.stateDir, DIR_MODE);
      const existing = await lstat(this.databasePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
        throw approvalRequired("Action receipt database is not a regular file");
      }
      const database = new DatabaseSync(this.databasePath, { timeout: DATABASE_TIMEOUT_MS });
      try {
        database.exec(`PRAGMA busy_timeout = ${DATABASE_TIMEOUT_MS}`);
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA synchronous = FULL");
        database.exec("PRAGMA foreign_keys = ON");
        database.exec("PRAGMA trusted_schema = OFF");
        database.exec(`
          CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS receipts (
            receipt_id TEXT PRIMARY KEY,
            expires_at INTEGER NOT NULL,
            recovery_until INTEGER,
            document TEXT NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS mutation_outcomes (
            outcome_key TEXT PRIMARY KEY,
            claim_id TEXT NOT NULL UNIQUE,
            idempotency_key TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK (state IN ('intent', 'completed')),
            completed_at INTEGER,
            intent_evidence_digest TEXT,
            document TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS mutation_outcomes_completed_at
            ON mutation_outcomes(completed_at) WHERE completed_at IS NOT NULL;
          CREATE INDEX IF NOT EXISTS receipts_expiry
            ON receipts(expires_at);
        `);
        this.rejectLegacyState(database);
        this.migrateIntentEvidenceDigest(database);
        await chmod(this.databasePath, FILE_MODE);
        database.exec("BEGIN IMMEDIATE");
        try {
          const now = Date.now();
          this.pruneReceipts(database, now);
          this.pruneOutcomes(database, now);
          const result = operation(database, now);
          database.exec("COMMIT");
          return result;
        } catch (error: unknown) {
          try { database.exec("ROLLBACK"); } catch { /* transaction already ended */ }
          throw error;
        }
      } catch (error: unknown) {
        sqliteFailure(error);
      } finally {
        database.close();
      }
    });
  }

  private migrateIntentEvidenceDigest(database: DatabaseSync): void {
    const migrated = database.prepare("SELECT value FROM metadata WHERE key = 'intent_evidence_digest_migrated'").get();
    if (migrated?.value === "1") return;
    database.exec("BEGIN IMMEDIATE");
    try {
      const rechecked = database.prepare("SELECT value FROM metadata WHERE key = 'intent_evidence_digest_migrated'").get();
      if (rechecked?.value !== "1") {
        const columns = database.prepare("PRAGMA table_info(mutation_outcomes)").all();
        if (!columns.some((column) => column.name === "intent_evidence_digest")) {
          database.exec("ALTER TABLE mutation_outcomes ADD COLUMN intent_evidence_digest TEXT");
        }
        const rows = database.prepare(`
          SELECT outcome_key, intent_evidence_digest, document FROM mutation_outcomes
        `).all();
        const update = database.prepare(`
          UPDATE mutation_outcomes SET intent_evidence_digest = ? WHERE outcome_key = ?
        `);
        for (const row of rows) {
          const outcome = parseOutcomeDocument(row.document);
          const expected = intentEvidenceDigest(outcome);
          if (row.intent_evidence_digest === null || row.intent_evidence_digest === undefined) {
            update.run(expected, outcome.outcomeKey);
          } else if (row.intent_evidence_digest !== expected) {
            throw approvalRequired("Action outcome row has a corrupt pre-apply evidence binding");
          }
        }
        database.prepare("INSERT INTO metadata(key, value) VALUES ('intent_evidence_digest_migrated', '1')").run();
      }
      database.exec("COMMIT");
    } catch (error: unknown) {
      try { database.exec("ROLLBACK"); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  private rejectLegacyState(database: DatabaseSync): void {
    const migrated = database.prepare("SELECT value FROM metadata WHERE key = 'legacy_migrated'").get();
    if (migrated || this.legacyArtifactsPresent()) {
      throw approvalRequired("Legacy Action receipt state is diagnostics-only and cannot be promoted into live v4 authority");
    }
  }

  private legacyArtifactsPresent(): boolean {
    const legacyPaths = [
      { target: this.legacyStorePath, directory: false },
      { target: path.join(this.stateDir, OUTCOME_DIR), directory: true },
      { target: path.join(this.stateDir, INDEX_DIR), directory: true },
    ] as const;
    for (const { target, directory } of legacyPaths) {
      try {
        const stat = lstatSync(target);
        if (!directory || !stat.isDirectory() || readdirSync(target).length > 0) return true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      }
    }
    return false;
  }

  private receipt(database: DatabaseSync, receiptId: string): StoredActionReceipt | undefined {
    const row = database.prepare(`
      SELECT receipt_id, expires_at, recovery_until, document
      FROM receipts WHERE receipt_id = ?
    `).get(receiptId);
    if (!row) return undefined;
    const receipt = parseReceiptDocument(row.document);
    const recoveryUntil = row.recovery_until === null ? null : Number(row.recovery_until);
    if (row.receipt_id !== receipt.receiptId
      || Number(row.expires_at) !== receipt.expiresAt
      || recoveryUntil !== this.receiptRecoveryUntil(receipt)) {
      throw approvalRequired("Action receipt row is not bound to its exact identity, expiry, and recovery window");
    }
    return receipt;
  }

  private receipts(database: DatabaseSync): StoredActionReceipt[] {
    return database.prepare("SELECT receipt_id, expires_at, recovery_until, document FROM receipts").all().map((row) => {
      const receipt = parseReceiptDocument(row.document);
      const recoveryUntil = row.recovery_until === null ? null : Number(row.recovery_until);
      if (row.receipt_id !== receipt.receiptId
        || Number(row.expires_at) !== receipt.expiresAt
        || recoveryUntil !== this.receiptRecoveryUntil(receipt)) {
        throw approvalRequired("Action receipt row is not bound to its exact identity, expiry, and recovery window");
      }
      return receipt;
    });
  }

  private receiptCount(database: DatabaseSync, now: number): number {
    const row = database.prepare("SELECT COUNT(*) AS count FROM receipts WHERE expires_at >= ?").get(now);
    return Number(row?.count ?? 0);
  }

  private insertReceipt(database: DatabaseSync, receipt: StoredActionReceipt): void {
    database.prepare("INSERT INTO receipts(receipt_id, expires_at, recovery_until, document) VALUES (?, ?, ?, ?)")
      .run(
        receipt.receiptId,
        receipt.expiresAt,
        this.receiptRecoveryUntil(receipt),
        serializeBounded(receipt, "Action receipt store cannot be written inside its bounded size", MAX_STORE_BYTES),
      );
  }

  private pruneReceipts(database: DatabaseSync, now: number): void {
    database.prepare(`
      DELETE FROM receipts
      WHERE expires_at < ? AND (recovery_until IS NULL OR recovery_until < ?)
    `).run(now, now);
  }

  private receiptRecoveryUntil(receipt: StoredActionReceipt): number | null {
    const recoverableVerification = receipt.kind === "verification"
      && receipt.metadata.pushBinding !== undefined;
    const recoverablePlan = receipt.kind === "monitor-read"
      && typeof receipt.metadata.monitorActionPlanId === "string"
      && typeof receipt.metadata.coordinationId === "string";
    return receipt.phase === "consumed"
      && receipt.consumedAt !== null
      && (recoverableVerification || recoverablePlan)
      ? receipt.consumedAt + OUTCOME_RETENTION_MS
      : null;
  }

  private pruneOutcomes(database: DatabaseSync, now: number): void {
    database.prepare("DELETE FROM mutation_outcomes WHERE completed_at IS NOT NULL AND completed_at + ? < ?")
      .run(OUTCOME_RETENTION_MS, now);
  }

  private outcomeBy(database: DatabaseSync, column: "outcome_key" | "claim_id" | "idempotency_key", value: string): StoredMutationOutcome | undefined {
    const row = database.prepare(`
      SELECT outcome_key, claim_id, idempotency_key, state, completed_at, intent_evidence_digest, document
      FROM mutation_outcomes WHERE ${column} = ?
    `).get(value);
    if (!row) return undefined;
    const outcome = parseOutcomeDocument(row.document);
    if (row.outcome_key !== outcome.outcomeKey
      || row.claim_id !== outcome.binding.claimId
      || row.idempotency_key !== outcome.binding.idempotencyKey
      || row.state !== outcome.state
      || row.intent_evidence_digest !== intentEvidenceDigest(outcome)
      || (row.completed_at === null ? null : Number(row.completed_at)) !== outcome.completedAt) {
      throw approvalRequired("Action outcome row is not bound to its exact indexed identity and state, including pre-apply evidence");
    }
    return outcome;
  }

  private findMutationOutcome(database: DatabaseSync, binding: MutationOutcomeBinding): StoredMutationOutcome | undefined {
    const outcomeKey = mutationOutcomeKey(binding);
    const exact = this.outcomeBy(database, "outcome_key", outcomeKey);
    const claim = this.outcomeBy(database, "claim_id", binding.claimId);
    const idempotency = this.outcomeBy(database, "idempotency_key", binding.idempotencyKey);
    for (const candidate of [claim, idempotency]) {
      if (candidate && candidate.outcomeKey !== outcomeKey) {
        throw approvalRequired("Monitor mutation identity is already bound to a different exact durable outcome");
      }
    }
    if (exact && canonicalJson(exact.binding) !== canonicalJson(binding)) {
      throw approvalRequired("Action outcome key collision does not preserve the exact binding");
    }
    return exact;
  }

  private requireExact(
    database: DatabaseSync,
    now: number,
    receiptId: string,
    kind: ActionReceiptKind,
    response: unknown,
    phases: readonly ActionReceiptPhase[],
  ): StoredActionReceipt {
    const receipt = this.receipt(database, receiptId);
    const recoveryUntil = receipt ? this.receiptRecoveryUntil(receipt) : null;
    const expired = !receipt || receipt.expiresAt < now;
    const acceptedExpired = Boolean(receipt
      && receipt.kind === "verification"
      && receipt.phase === "consumed"
      && receipt.metadata.pushBinding !== undefined
      && recoveryUntil !== null
      && recoveryUntil >= now);
    if (!receipt
      || receipt.kind !== kind
      || (expired && !acceptedExpired)
      || now < receipt.issuedAt
      || !phases.includes(receipt.phase)
      || digest(exactInputFromResponse(receipt.response)) !== receipt.inputDigest
      || JSON.stringify(receipt.response) !== JSON.stringify(response)) {
      throw approvalRequired("Action receipt is corrupt, stale, replayed, or not the exact issued response");
    }
    return receipt;
  }
}
