import { createHash } from "node:crypto";
import { z } from "zod";
import { ErrorCode } from "../types.js";

/**
 * The reviewer/actor fragments below are deliberately limited to fields in the
 * public GitHub GraphQL schema checked on 2026-08-10 (github/graphql-schema,
 * PullRequestReviewRequests and Actor interfaces).  This fixture is kept here
 * so production never needs schema introspection or a live schema download.
 */
export const GITHUB_GRAPHQL_ACTOR_FIXTURE = Object.freeze([
  "User", "Bot", "Mannequin", "Organization", "EnterpriseUserAccount",
  "EnterpriseTeam", "Team",
] as const);
export const GITHUB_REVIEWER_TYPE_POLICY = Object.freeze({
  User: "User", Bot: null, EnterpriseTeam: null, Mannequin: null, Team: null,
} as const);
export const GITHUB_ACTOR_TYPE_MAP = Object.freeze({
  User: "User", Bot: "Bot", Mannequin: "Mannequin", Organization: "Organization", EnterpriseUserAccount: "EnterpriseUserAccount",
} as const);

export const SAFE_ID_PATTERN = /^[A-Za-z0-9_=-]{1,300}$/;
export const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const OID_PATTERN = /^[0-9a-fA-F]{40}$/;
export const CURSOR_PATTERN = /^[^\u0000-\u001f\u007f]{1,300}$/u;
export const SEARCH_PAGE_SIZE = 100;
export const MAX_SEARCH_PAGES = 10;
export const MAX_SEARCH_ISSUES = 1000;
export const MAX_UNIQUE_CANDIDATES = 1000;
export const MAX_REVIEW_REQUEST_PAGES = 5;
export const MAX_REVIEW_REQUESTS = 500;
export const MAX_FEEDBACK_PAGES = 5;
export const MAX_FEEDBACK = 500;
export const MAX_THREAD_PAGES = 5;
export const MAX_THREADS = 500;
export const MAX_CHILD_COMMENTS = 500;
export const MAX_CHILD_QUERY_CALLS = 2500;
export const MAX_CHECKS = 500;
export const MAX_PR_BYTES = 64 * 1024;
export const MAX_PAYLOAD_BYTES = 192 * 1024;
export const MAX_WIRE_BYTES = 256 * 1024;
export const MAX_TEXT_BYTES = 4 * 1024;
export const MAX_COMMAND_STDOUT_BYTES = 256 * 1024;
export const MAX_COMMAND_STDERR_BYTES = 64 * 1024;
export const MAX_QUERY_BYTES = 64 * 1024;
export const COMMAND_TIMEOUT_MS = 15_000;
export const READ_DEADLINE_MS = 120_000;
export const SNAPSHOT_WORKERS = 4;
export const MONITOR_PAYLOAD_VERSION = 1 as const;
export const MONITOR_PROTOCOL_VERSION = 1 as const;
export const MONITOR_SCHEMA_VERSION = 4 as const;
export const GITHUB_PR_MONITOR_INVALID_INPUT_REQUEST_DIGEST = sha256Hex("invalid-input");

export type GithubPrMonitorRole = "authored" | "requested_reviewer";
export type ActorType = "User" | "Bot" | "Mannequin" | "Organization" | "EnterpriseUserAccount" | "Deleted" | "Unknown";
export interface GithubPrMonitorReadInput { runId: string; actionPlanId: string }
export interface Actor { login: string | null; actorType: ActorType }
export interface RepositoryIdentity { id: string; nameWithOwner: string }
export interface HeadRepositoryIdentity extends RepositoryIdentity { name: string }
export interface Feedback {
  id: string;
  author: Actor;
  feedbackIdentity: string;
  authorAssociation?: string;
  state?: string;
  path?: string;
  line?: number;
  startLine?: number;
  outdated?: boolean;
  commitOid?: string;
}
export interface ReviewThread { id: string; isResolved: boolean; isOutdated: boolean; comments: { nodes: Feedback[] } }
export interface CheckSummary { status: string; conclusion: string | null }
export interface CiSummary { total: number; success: number; failure: number; pending: number; cancelled: number; neutral: number; unknown: number }
export interface GithubPrSnapshot {
  number: number;
  url: string;
  state: "OPEN";
  author: Actor;
  roles: GithubPrMonitorRole[];
  baseRepository: RepositoryIdentity;
  headRepository: HeadRepositoryIdentity;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  reviewRequests: Actor[];
  reviews: Feedback[];
  comments: Feedback[];
  latestReviews: Feedback[];
  reviewThreads: ReviewThread[];
  statusCheckRollup: CheckSummary[];
  ciSummary: CiSummary;
}
export interface DiscoveryRole { issueCount: number; fetchedCount: number; pageCount: number; complete: boolean }
export interface DiscoveryRaces { prClosed: number; authoredRoleLost: number; reviewerRequestLost: number }
export interface Discovery {
  authored: DiscoveryRole;
  requestedReviewer: DiscoveryRole;
  uniqueCandidateCount: number;
  snapshotAttemptCount: number;
  snapshotCount: number;
  races: DiscoveryRaces;
  complete: boolean;
}
export interface GithubPrMonitorReadResult {
  monitorPayloadVersion: 1; protocolVersion: 1; schemaVersion: 4;
  requestDigest: string; receiptId: string; namespace: "ChatGPT_To_Codex";
  tool: "github_pr_monitor_read"; operation: "read"; ok: true;
  runId: string; actionPlanId: string; account: { login: string };
  discovery: Discovery; prs: GithubPrSnapshot[]; observedAt: string;
  chatgpt2codexToolCall: ToolCallProof;
}
export interface GithubPrMonitorErrorResult {
  monitorPayloadVersion: 1; protocolVersion: 1; schemaVersion: 4;
  requestDigest: string; namespace: "ChatGPT_To_Codex";
  tool: "github_pr_monitor_read"; operation: "read"; ok: false;
  runId?: string; actionPlanId?: string; code: MonitorErrorCode; error: string;
  chatgpt2codexToolCall: ToolCallProof;
}
export type MonitorErrorCode =
  | "GITHUB_MONITOR_INVALID_INPUT" | "GITHUB_MONITOR_AUTH" | "GITHUB_MONITOR_UNAVAILABLE"
  | "GITHUB_MONITOR_DISCOVERY_INVALID" | "GITHUB_MONITOR_DISCOVERY_LIMIT"
  | "GITHUB_MONITOR_SNAPSHOT_INVALID" | "GITHUB_MONITOR_TIMEOUT"
  | "GITHUB_MONITOR_OUTPUT_LIMIT" | "GITHUB_MONITOR_ABORTED";
export interface ToolCallProof { namespace: "ChatGPT_To_Codex"; toolName: "github_pr_monitor_read"; input?: GithubPrMonitorReadInput; ok: boolean }
export interface DirectMonitorCycleSummary {
  cyclePayloadVersion: 1; runId: string; actionPlanId: string; account: { login: string };
  discovery: Discovery;
  prs: Array<Pick<GithubPrSnapshot, "number" | "url" | "roles" | "baseRepository" | "headRepository" | "headRefName" | "headRefOid"> & {
    reviewCount: number; commentCount: number; threadCount: number; unresolvedThreadCount: number; ciSummary: CiSummary;
  }>;
  observedAt: string;
}

export const GithubPrMonitorReadInputSchema = z.object({
  runId: z.string().regex(SAFE_ID_PATTERN), actionPlanId: z.string().regex(SAFE_ID_PATTERN),
}).strict();
export const githubPrMonitorReadInputSchema = GithubPrMonitorReadInputSchema;
export const GITHUB_PR_MONITOR_READ_INPUT_SCHEMA = GithubPrMonitorReadInputSchema;
export const GithubPrMonitorReadInputJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["runId", "actionPlanId"],
  properties: {
    runId: { type: "string", pattern: SAFE_ID_PATTERN.source, maxLength: 300 },
    actionPlanId: { type: "string", pattern: SAFE_ID_PATTERN.source, maxLength: 300 },
  },
} as const;
export const GITHUB_PR_MONITOR_READ_INPUT_JSON_SCHEMA = GithubPrMonitorReadInputJsonSchema;

export function parseGithubPrMonitorReadInput(value: unknown): GithubPrMonitorReadInput {
  return GithubPrMonitorReadInputSchema.parse(value);
}
export function isSafeId(value: unknown): value is string { return typeof value === "string" && SAFE_ID_PATTERN.test(value); }
export function isSafeLogin(value: unknown): value is string { return typeof value === "string" && LOGIN_PATTERN.test(value); }
export function isSafeOid(value: unknown): value is string { return typeof value === "string" && OID_PATTERN.test(value); }
export function isSafeCursor(value: unknown): value is string { return typeof value === "string" && CURSOR_PATTERN.test(value); }

const ActorSchema = z.object({
  login: z.string().regex(LOGIN_PATTERN).nullable(),
  actorType: z.enum(["User", "Bot", "Mannequin", "Organization", "EnterpriseUserAccount", "Deleted", "Unknown"]),
}).strict().refine((actor) => actor.actorType === "Deleted" ? actor.login === null : actor.login !== null, { message: "Actor login/type mismatch" });
const BoundedIdSchema = z.string().min(1).max(300).refine((id) => !/[\u0000-\u001f\u007f]/.test(id), { message: "ID contains controls" });
const SafeFieldSchema = (max: number, min = 0) => z.string().min(min).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), { message: "Field contains controls" });
const RefSchema = SafeFieldSchema(241).refine((ref) => !ref.startsWith("-") && !ref.includes("..") && !ref.includes("//"), { message: "Invalid ref" });
const RepositorySchema = z.object({ id: BoundedIdSchema, nameWithOwner: SafeFieldSchema(140, 3) }).strict().refine((repository) => {
  try { return canonicalRepository(repository.nameWithOwner) === repository.nameWithOwner; } catch { return false; }
}, { message: "Invalid repository" });
const FeedbackSchema = z.object({
  id: BoundedIdSchema,
  author: ActorSchema,
  feedbackIdentity: z.string().regex(/^[0-9a-f]{64}$/),
  authorAssociation: SafeFieldSchema(128).optional(),
  state: SafeFieldSchema(128).optional(),
  path: SafeFieldSchema(240).optional(),
  line: z.number().int().positive().optional(),
  startLine: z.number().int().positive().optional(),
  outdated: z.boolean().optional(),
  commitOid: z.string().regex(OID_PATTERN).optional(),
}).strict();
const CiScalarSchema = z.string().max(128).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), { message: "CI scalar contains controls" });
const CheckSchema = z.object({ status: CiScalarSchema, conclusion: CiScalarSchema.nullable() }).strict();
const CiSummarySchema = z.object({
  total: z.number().int().nonnegative().max(MAX_CHECKS),
  success: z.number().int().nonnegative().max(MAX_CHECKS),
  failure: z.number().int().nonnegative().max(MAX_CHECKS),
  pending: z.number().int().nonnegative().max(MAX_CHECKS),
  cancelled: z.number().int().nonnegative().max(MAX_CHECKS),
  neutral: z.number().int().nonnegative().max(MAX_CHECKS),
  unknown: z.number().int().nonnegative().max(MAX_CHECKS),
}).strict().superRefine((summary, ctx) => {
  const buckets = summary.success + summary.failure + summary.pending + summary.cancelled + summary.neutral + summary.unknown;
  if (buckets !== summary.total) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CI summary buckets must equal total" });
});
const ThreadSchema = z.object({
  id: BoundedIdSchema,
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.object({ nodes: z.array(FeedbackSchema).max(MAX_CHILD_COMMENTS) }).strict(),
}).strict();
const DiscoveryRoleSchema = z.object({
  issueCount: z.number().int().nonnegative().max(MAX_SEARCH_ISSUES),
  fetchedCount: z.number().int().nonnegative().max(MAX_SEARCH_ISSUES),
  pageCount: z.number().int().positive().max(MAX_SEARCH_PAGES),
  complete: z.boolean(),
}).strict().superRefine((role, ctx) => {
  if (role.fetchedCount > role.issueCount) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Discovery fetched count exceeds issue count" });
  if (role.complete && role.fetchedCount !== role.issueCount) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Complete discovery must fetch issue count" });
});
const DiscoverySchema = z.object({
  authored: DiscoveryRoleSchema,
  requestedReviewer: DiscoveryRoleSchema,
  uniqueCandidateCount: z.number().int().nonnegative().max(MAX_UNIQUE_CANDIDATES),
  snapshotAttemptCount: z.number().int().nonnegative().max(MAX_UNIQUE_CANDIDATES),
  snapshotCount: z.number().int().nonnegative().max(MAX_UNIQUE_CANDIDATES),
  races: z.object({
    prClosed: z.number().int().nonnegative().max(MAX_UNIQUE_CANDIDATES),
    authoredRoleLost: z.number().int().nonnegative().max(MAX_UNIQUE_CANDIDATES),
    reviewerRequestLost: z.number().int().nonnegative().max(MAX_UNIQUE_CANDIDATES),
  }).strict(),
  complete: z.boolean(),
}).strict().superRefine((discovery, ctx) => {
  if (discovery.snapshotAttemptCount !== discovery.uniqueCandidateCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Snapshot attempts must equal unique candidates" });
  }
  if (discovery.snapshotCount > discovery.snapshotAttemptCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Snapshot count exceeds attempts" });
  }
  const races = discovery.races.prClosed + discovery.races.authoredRoleLost + discovery.races.reviewerRequestLost;
  if (races > discovery.snapshotAttemptCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Snapshot races exceed attempts" });
  }
  const completeEvidence = discovery.authored.complete
    && discovery.requestedReviewer.complete
    && races === 0
    && discovery.snapshotCount === discovery.snapshotAttemptCount;
  if (discovery.complete !== completeEvidence) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Discovery complete flag does not match evidence" });
  }
});
const HeadRepositorySchema = z.object({
  id: BoundedIdSchema,
  name: SafeFieldSchema(100, 1),
  nameWithOwner: SafeFieldSchema(140, 3),
}).strict().superRefine((head, ctx) => {
  try {
    const canonical = canonicalRepository(head.nameWithOwner);
    if (canonical !== head.nameWithOwner || canonical.split("/")[1] !== head.name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Head repository name mismatch" });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid head repository name" });
  }
});
const RolesSchema = z.array(z.enum(["authored", "requested_reviewer"])).min(1).max(2).superRefine((roles, ctx) => {
  if (new Set(roles).size !== roles.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate PR roles" });
  if (roles.includes("authored") && roles.includes("requested_reviewer") && roles.join(",") !== "authored,requested_reviewer") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid PR role order" });
  }
});
const PrSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().refine((url) => {
    try { return canonicalPullRequestUrl(url) === url; } catch { return false; }
  }, { message: "Invalid pull request URL" }),
  state: z.literal("OPEN"),
  author: ActorSchema,
  roles: RolesSchema,
  baseRepository: RepositorySchema,
  headRepository: HeadRepositorySchema,
  baseRefName: RefSchema,
  headRefName: RefSchema,
  baseRefOid: z.string().regex(OID_PATTERN),
  headRefOid: z.string().regex(OID_PATTERN),
  reviewRequests: z.array(ActorSchema).max(MAX_REVIEW_REQUESTS),
  reviews: z.array(FeedbackSchema).max(MAX_FEEDBACK),
  comments: z.array(FeedbackSchema).max(MAX_FEEDBACK),
  latestReviews: z.array(FeedbackSchema).max(MAX_FEEDBACK),
  reviewThreads: z.array(ThreadSchema).max(MAX_THREADS),
  statusCheckRollup: z.array(CheckSchema).max(MAX_CHECKS),
  ciSummary: CiSummarySchema,
}).strict().superRefine((pr, ctx) => {
  if (pr.url !== `https://github.com/${pr.baseRepository.nameWithOwner}/pull/${pr.number}`) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PR URL does not match its canonical repository and number" });
  }
});
const DirectCyclePrSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().refine((url) => {
    try { return canonicalPullRequestUrl(url) === url; } catch { return false; }
  }, { message: "Invalid pull request URL" }),
  roles: RolesSchema,
  baseRepository: RepositorySchema,
  headRepository: HeadRepositorySchema,
  headRefName: RefSchema,
  headRefOid: z.string().regex(OID_PATTERN),
  reviewCount: z.number().int().nonnegative().max(MAX_FEEDBACK),
  commentCount: z.number().int().nonnegative().max(MAX_FEEDBACK),
  threadCount: z.number().int().nonnegative().max(MAX_THREADS),
  unresolvedThreadCount: z.number().int().nonnegative().max(MAX_THREADS),
  ciSummary: CiSummarySchema,
}).strict().superRefine((pr, ctx) => {
  if (pr.unresolvedThreadCount > pr.threadCount) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unresolved thread count exceeds threads" });
});
export const DirectMonitorCycleSummarySchema = z.object({
  cyclePayloadVersion: z.literal(1),
  runId: z.string().regex(SAFE_ID_PATTERN),
  actionPlanId: z.string().regex(SAFE_ID_PATTERN),
  account: z.object({ login: z.string().regex(LOGIN_PATTERN) }).strict(),
  discovery: DiscoverySchema,
  prs: z.array(DirectCyclePrSchema).max(MAX_UNIQUE_CANDIDATES),
  observedAt: z.string().datetime({ offset: true }).refine((observedAt) => observedAt.endsWith("Z")),
}).strict();
const ProofSchema = z.object({
  namespace: z.literal("ChatGPT_To_Codex"),
  toolName: z.literal("github_pr_monitor_read"),
  input: GithubPrMonitorReadInputSchema.optional(),
  ok: z.boolean(),
}).strict();
const RequiredProofSchema = z.object({
  namespace: z.literal("ChatGPT_To_Codex"),
  toolName: z.literal("github_pr_monitor_read"),
  input: GithubPrMonitorReadInputSchema,
  ok: z.boolean(),
}).strict();
export const GithubPrMonitorActorSchema = ActorSchema;
export const GithubPrMonitorRepositorySchema = RepositorySchema;
export const GithubPrMonitorFeedbackSchema = FeedbackSchema;
export const GithubPrMonitorCheckSchema = CheckSchema;
export const GithubPrMonitorCiSummarySchema = CiSummarySchema;
export const GithubPrMonitorThreadSchema = ThreadSchema;
export const GithubPrMonitorDiscoveryRoleSchema = DiscoveryRoleSchema;
export const GithubPrMonitorDiscoverySchema = DiscoverySchema;
export const GithubPrMonitorPrSchema = PrSchema;
export const GithubPrMonitorToolCallProofSchema = RequiredProofSchema;
export const GithubPrMonitorReadResultSchema = z.object({
  monitorPayloadVersion: z.literal(1),
  protocolVersion: z.literal(1),
  schemaVersion: z.literal(4),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  receiptId: z.string().regex(/^[0-9a-f]{64}$/),
  namespace: z.literal("ChatGPT_To_Codex"),
  tool: z.literal("github_pr_monitor_read"),
  operation: z.literal("read"),
  ok: z.literal(true),
  runId: z.string().regex(SAFE_ID_PATTERN),
  actionPlanId: z.string().regex(SAFE_ID_PATTERN),
  account: z.object({ login: z.string().regex(LOGIN_PATTERN) }).strict(),
  discovery: DiscoverySchema,
  prs: z.array(PrSchema).max(MAX_UNIQUE_CANDIDATES),
  observedAt: z.string().datetime({ offset: true }).refine((observedAt) => observedAt.endsWith("Z")),
  chatgpt2codexToolCall: ProofSchema,
}).strict().superRefine((result, ctx) => {
  const proof = result.chatgpt2codexToolCall;
  if (proof.input === undefined || proof.input.runId !== result.runId || proof.input.actionPlanId !== result.actionPlanId || !proof.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Success proof must bind required read input" });
  }
  if (monitorRequestDigest({ runId: result.runId, actionPlanId: result.actionPlanId }) !== result.requestDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Request digest does not bind read input" });
  }
  if (result.discovery.snapshotCount !== result.prs.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Snapshot count must equal result PR count" });
  }
});
export const GithubPrMonitorErrorResultSchema = z.object({
  monitorPayloadVersion: z.literal(1),
  protocolVersion: z.literal(1),
  schemaVersion: z.literal(4),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  namespace: z.literal("ChatGPT_To_Codex"),
  tool: z.literal("github_pr_monitor_read"),
  operation: z.literal("read"),
  ok: z.literal(false),
  runId: z.string().regex(SAFE_ID_PATTERN).optional(),
  actionPlanId: z.string().regex(SAFE_ID_PATTERN).optional(),
  code: z.enum(["GITHUB_MONITOR_INVALID_INPUT", "GITHUB_MONITOR_AUTH", "GITHUB_MONITOR_UNAVAILABLE", "GITHUB_MONITOR_DISCOVERY_INVALID", "GITHUB_MONITOR_DISCOVERY_LIMIT", "GITHUB_MONITOR_SNAPSHOT_INVALID", "GITHUB_MONITOR_TIMEOUT", "GITHUB_MONITOR_OUTPUT_LIMIT", "GITHUB_MONITOR_ABORTED"]),
  error: z.string().max(512),
  chatgpt2codexToolCall: ProofSchema,
}).strict().superRefine((result, ctx) => {
  const hasRun = result.runId !== undefined;
  const hasPlan = result.actionPlanId !== undefined;
  const invalidInputCode = result.code === "GITHUB_MONITOR_INVALID_INPUT";
  if (hasRun !== hasPlan) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Error IDs must be supplied together" });
  }
  if (result.chatgpt2codexToolCall.ok !== false) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Error proof must be false" });
  }
  if (hasRun && result.chatgpt2codexToolCall.input === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Error proof must bind required read input" });
  }
  if (!hasRun && result.chatgpt2codexToolCall.input !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid-input proof cannot claim an unbound input" });
  }
  if (hasRun && result.chatgpt2codexToolCall.input !== undefined
    && (result.chatgpt2codexToolCall.input.runId !== result.runId || result.chatgpt2codexToolCall.input.actionPlanId !== result.actionPlanId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Error proof IDs do not match result IDs" });
  }
  if (hasRun) {
    if (monitorRequestDigest({ runId: result.runId!, actionPlanId: result.actionPlanId! }) !== result.requestDigest) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Request digest does not bind error input" });
    }
  } else if (invalidInputCode) {
    if (result.requestDigest !== GITHUB_PR_MONITOR_INVALID_INPUT_REQUEST_DIGEST) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid-input errors must use the fixed request digest" });
    }
  } else {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Execution errors must bind required read IDs" });
  }
});
export const GITHUB_PR_MONITOR_ERROR_CODES = Object.freeze([
  "GITHUB_MONITOR_INVALID_INPUT", "GITHUB_MONITOR_AUTH", "GITHUB_MONITOR_UNAVAILABLE",
  "GITHUB_MONITOR_DISCOVERY_INVALID", "GITHUB_MONITOR_DISCOVERY_LIMIT", "GITHUB_MONITOR_SNAPSHOT_INVALID",
  "GITHUB_MONITOR_TIMEOUT", "GITHUB_MONITOR_OUTPUT_LIMIT", "GITHUB_MONITOR_ABORTED",
] as const);
export const GITHUB_PR_MONITOR_INPUT_KEYS = Object.freeze(["runId", "actionPlanId"] as const);
export const GITHUB_PR_MONITOR_SUCCESS_KEYS = Object.freeze(["monitorPayloadVersion", "protocolVersion", "schemaVersion", "requestDigest", "receiptId", "namespace", "tool", "operation", "ok", "runId", "actionPlanId", "account", "discovery", "prs", "observedAt", "chatgpt2codexToolCall"] as const);
export const GITHUB_PR_MONITOR_ERROR_KEYS = Object.freeze(["monitorPayloadVersion", "protocolVersion", "schemaVersion", "requestDigest", "namespace", "tool", "operation", "ok", "code", "error", "chatgpt2codexToolCall"] as const);
export const GITHUB_PR_MONITOR_ERROR_KEYS_WITH_IDS = Object.freeze([...GITHUB_PR_MONITOR_ERROR_KEYS.slice(0, 8), "runId", "actionPlanId", ...GITHUB_PR_MONITOR_ERROR_KEYS.slice(8)] as const);
const REPOSITORY_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const PULL_REQUEST_URL = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/pull\/[1-9][0-9]*$/;
export function canonicalRepository(value: unknown): string {
  if (typeof value !== "string" || value.length > 140 || value.indexOf("/") !== value.lastIndexOf("/")) throw new Error("invalid repository");
  const parts = value.split("/");
  if (parts.length !== 2 || !REPOSITORY_OWNER.test(parts[0] ?? "") || !REPOSITORY_NAME.test(parts[1] ?? "")) throw new Error("invalid repository");
  if (parts.some((part) => part === "." || part === ".." || part.startsWith("-") || part.endsWith("-") || part.startsWith(".") || part.endsWith("."))) {
    throw new Error("invalid repository");
  }
  return `${parts[0]!.toLowerCase()}/${parts[1]!.toLowerCase()}`;
}
export function canonicalPullRequestUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 300 || !PULL_REQUEST_URL.test(value)) throw new Error("invalid pull request URL");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("invalid pull request URL");
  }
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/u);
  if (!match) throw new Error("invalid pull request URL");
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) throw new Error("invalid pull request URL");
  return `https://github.com/${canonicalRepository(`${match[1]}/${match[2]}`)}/pull/${number}`;
}
export const canonicalRepositoryName = canonicalRepository;
export const canonicalBaseRepository = canonicalRepository;
export const canonicalizeRepository = canonicalRepository;
export const canonicalRepoName = canonicalRepository;
export function compareCodeUnit(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function compareLogin(a: string, b: string): number { return compareCodeUnit(a.toLowerCase(), b.toLowerCase()) || compareCodeUnit(a, b); }
export function compareNormalizedId(a: { id: string }, b: { id: string }): number { return compareCodeUnit(a.id.toLowerCase(), b.id.toLowerCase()) || compareCodeUnit(a.id, b.id); }

export function ephemeralReceiptId(material: { tool: string; monitorPayloadVersion: number; requestDigest: string; observedAt: string; nonce: string; payload: unknown }): string {
  return sha256Hex(canonicalJson(material));
}
export const makeEphemeralReceiptId = ephemeralReceiptId;
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareCodeUnit).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("unsupported canonical JSON value");
}
export function sha256Hex(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function monitorRequestDigest(input: GithubPrMonitorReadInput): string { return sha256Hex(canonicalJson(input)); }
export const githubPrMonitorRequestDigest = monitorRequestDigest;

export const SEARCH_QUERY = `query SearchOpenPullRequests($q:String!,$first:Int!,$after:String) {
  search(type:ISSUE,query:$q,first:$first,after:$after) {
    issueCount pageInfo { hasNextPage endCursor }
    nodes { __typename ... on PullRequest { number repository { id nameWithOwner } } }
  }
}`;
export const REVIEW_REQUESTS_QUERY = `query PullRequestReviewRequests($owner:String!,$repo:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$repo) { id nameWithOwner pullRequest(number:$number) {
    author { login __typename }
    reviewRequests(first:100,after:$after) { nodes { requestedReviewer { __typename ... on User { login } } } pageInfo { hasNextPage endCursor } }
  }}
}`;
export const REVIEWS_QUERY = `query PullRequestReviews($owner:String!,$repo:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$repo) { id nameWithOwner pullRequest(number:$number) {
    author { login __typename }
    reviews(first:100,after:$after) { nodes { id body author { login __typename } authorAssociation state } pageInfo { hasNextPage endCursor } }
  }}
}`;
export const COMMENTS_QUERY = `query PullRequestComments($owner:String!,$repo:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$repo) { id nameWithOwner pullRequest(number:$number) {
    author { login __typename }
    comments(first:100,after:$after) { nodes { id body author { login __typename } authorAssociation } pageInfo { hasNextPage endCursor } }
  }}
}`;
/* Keep the owner/name argument spelling in the emitted query stable. */
export const LATEST_REVIEWS_QUERY = `query PullRequestLatestReviews($owner:String!,$repo:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$repo) { id nameWithOwner pullRequest(number:$number) {
    author { login __typename }
    latestReviews(first:100,after:$after) { nodes { id body author { login __typename } authorAssociation state } pageInfo { hasNextPage endCursor } }
  }}
}`;
export const REVIEW_THREADS_QUERY = `query PullRequestReviewThreads($owner:String!,$repo:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$repo) { id nameWithOwner pullRequest(number:$number) {
    reviewThreads(first:100,after:$after) { nodes { id isResolved isOutdated } pageInfo { hasNextPage endCursor } }
  }}
}`;
export const THREAD_COMMENTS_QUERY = `query PullRequestReviewThreadComments($threadId:ID!,$after:String) {
  node(id:$threadId) { __typename ... on PullRequestReviewThread { id isResolved isOutdated
    comments(first:100,after:$after) { nodes { id body author { login __typename } authorAssociation path line startLine outdated commit { oid } } pageInfo { hasNextPage endCursor } }
  }}
}`;
export const SEARCH_OPEN_PULL_REQUESTS_QUERY = SEARCH_QUERY;
export const PULL_REQUEST_REVIEW_REQUESTS_QUERY = REVIEW_REQUESTS_QUERY;
export const PULL_REQUEST_REVIEWS_QUERY = REVIEWS_QUERY;
export const PULL_REQUEST_COMMENTS_QUERY = COMMENTS_QUERY;
export const PULL_REQUEST_LATEST_REVIEWS_QUERY = LATEST_REVIEWS_QUERY;
export const PULL_REQUEST_REVIEW_THREADS_QUERY = REVIEW_THREADS_QUERY;
export const PULL_REQUEST_REVIEW_THREAD_COMMENTS_QUERY = THREAD_COMMENTS_QUERY;

export const GITHUB_PR_VIEW_FIELDS = "number,url,state,author,baseRefName,baseRefOid,headRepository,headRefName,headRefOid,statusCheckRollup";
export const GITHUB_PR_VIEW_ARGS = ["pr", "view"] as const;
export const MONITOR_SUCCESS_TEXT = "Read authenticated-account open PR state.";

const GITHUB_PR_MONITOR_ACTOR_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["login", "actorType"],
  properties: {
    login: { type: ["string", "null"], pattern: LOGIN_PATTERN.source },
    actorType: { type: "string", enum: ["User", "Bot", "Mannequin", "Organization", "EnterpriseUserAccount", "Deleted", "Unknown"] },
  },
};
const GITHUB_PR_MONITOR_REPOSITORY_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["id", "nameWithOwner"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 300 },
    nameWithOwner: { type: "string", minLength: 3, maxLength: 140, pattern: "^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9._-]{0,99}$" },
  },
};
const GITHUB_PR_MONITOR_FEEDBACK_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["id", "author", "feedbackIdentity"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 300 },
    author: GITHUB_PR_MONITOR_ACTOR_JSON_SCHEMA,
    feedbackIdentity: { type: "string", pattern: "^[0-9a-f]{64}$" },
    authorAssociation: { type: "string", maxLength: 128 }, state: { type: "string", maxLength: 128 }, path: { type: "string", maxLength: 240 },
    line: { type: "integer", minimum: 1 }, startLine: { type: "integer", minimum: 1 },
    outdated: { type: "boolean" }, commitOid: { type: "string", pattern: OID_PATTERN.source },
  },
} as const;
const GITHUB_PR_MONITOR_CHECK_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["status", "conclusion"],
  properties: { status: { type: "string", maxLength: 128 }, conclusion: { type: ["string", "null"], maxLength: 128 } },
};
const GITHUB_PR_MONITOR_CI_SUMMARY_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["total", "success", "failure", "pending", "cancelled", "neutral", "unknown"],
  properties: {
    total: { type: "integer", minimum: 0, maximum: MAX_CHECKS }, success: { type: "integer", minimum: 0, maximum: MAX_CHECKS },
    failure: { type: "integer", minimum: 0, maximum: MAX_CHECKS }, pending: { type: "integer", minimum: 0, maximum: MAX_CHECKS },
    cancelled: { type: "integer", minimum: 0, maximum: MAX_CHECKS }, neutral: { type: "integer", minimum: 0, maximum: MAX_CHECKS },
    unknown: { type: "integer", minimum: 0, maximum: MAX_CHECKS },
  },
};
const GITHUB_PR_MONITOR_THREAD_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["id", "isResolved", "isOutdated", "comments"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 300 }, isResolved: { type: "boolean" }, isOutdated: { type: "boolean" },
    comments: { type: "object", additionalProperties: false, required: ["nodes"], properties: { nodes: { type: "array", maxItems: MAX_CHILD_COMMENTS, items: GITHUB_PR_MONITOR_FEEDBACK_JSON_SCHEMA } } },
  },
};
const GITHUB_PR_MONITOR_DISCOVERY_ROLE_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["issueCount", "fetchedCount", "pageCount", "complete"],
  properties: {
    issueCount: { type: "integer", minimum: 0, maximum: MAX_SEARCH_ISSUES }, fetchedCount: { type: "integer", minimum: 0, maximum: MAX_SEARCH_ISSUES },
    pageCount: { type: "integer", minimum: 1, maximum: MAX_SEARCH_PAGES }, complete: { type: "boolean" },
  },
};
const GITHUB_PR_MONITOR_DISCOVERY_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["authored", "requestedReviewer", "uniqueCandidateCount", "snapshotAttemptCount", "snapshotCount", "races", "complete"],
  properties: {
    authored: GITHUB_PR_MONITOR_DISCOVERY_ROLE_JSON_SCHEMA, requestedReviewer: GITHUB_PR_MONITOR_DISCOVERY_ROLE_JSON_SCHEMA,
    uniqueCandidateCount: { type: "integer", minimum: 0, maximum: MAX_UNIQUE_CANDIDATES },
    snapshotAttemptCount: { type: "integer", minimum: 0, maximum: MAX_UNIQUE_CANDIDATES },
    snapshotCount: { type: "integer", minimum: 0, maximum: MAX_UNIQUE_CANDIDATES },
    races: {
      type: "object", additionalProperties: false, required: ["prClosed", "authoredRoleLost", "reviewerRequestLost"],
      properties: {
        prClosed: { type: "integer", minimum: 0, maximum: MAX_UNIQUE_CANDIDATES },
        authoredRoleLost: { type: "integer", minimum: 0, maximum: MAX_UNIQUE_CANDIDATES },
        reviewerRequestLost: { type: "integer", minimum: 0, maximum: MAX_UNIQUE_CANDIDATES },
      },
    },
    complete: { type: "boolean" },
  },
};
const GITHUB_PR_MONITOR_HEAD_REPOSITORY_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["id", "name", "nameWithOwner"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 300 },
    name: { type: "string", minLength: 1, maxLength: 100, pattern: REPOSITORY_NAME.source },
    nameWithOwner: { type: "string", minLength: 3, maxLength: 140, pattern: "^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9._-]{0,99}$" },
  },
};
const GITHUB_PR_MONITOR_PR_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["number", "url", "state", "author", "roles", "baseRepository", "headRepository", "baseRefName", "headRefName", "baseRefOid", "headRefOid", "reviewRequests", "reviews", "comments", "latestReviews", "reviewThreads", "statusCheckRollup", "ciSummary"],
  properties: {
    number: { type: "integer", minimum: 1, maximum: 2147483647 }, url: { type: "string", format: "uri", pattern: PULL_REQUEST_URL.source, maxLength: 300 }, state: { type: "string", const: "OPEN" }, author: GITHUB_PR_MONITOR_ACTOR_JSON_SCHEMA,
    roles: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["authored", "requested_reviewer"] } },
    baseRepository: GITHUB_PR_MONITOR_REPOSITORY_JSON_SCHEMA, headRepository: GITHUB_PR_MONITOR_HEAD_REPOSITORY_JSON_SCHEMA,
    baseRefName: { type: "string", maxLength: 241 }, headRefName: { type: "string", maxLength: 241 },
    baseRefOid: { type: "string", pattern: OID_PATTERN.source }, headRefOid: { type: "string", pattern: OID_PATTERN.source },
    reviewRequests: { type: "array", maxItems: MAX_REVIEW_REQUESTS, items: GITHUB_PR_MONITOR_ACTOR_JSON_SCHEMA },
    reviews: { type: "array", maxItems: MAX_FEEDBACK, items: GITHUB_PR_MONITOR_FEEDBACK_JSON_SCHEMA },
    comments: { type: "array", maxItems: MAX_FEEDBACK, items: GITHUB_PR_MONITOR_FEEDBACK_JSON_SCHEMA },
    latestReviews: { type: "array", maxItems: MAX_FEEDBACK, items: GITHUB_PR_MONITOR_FEEDBACK_JSON_SCHEMA },
    reviewThreads: { type: "array", maxItems: MAX_THREADS, items: GITHUB_PR_MONITOR_THREAD_JSON_SCHEMA },
    statusCheckRollup: { type: "array", maxItems: MAX_CHECKS, items: GITHUB_PR_MONITOR_CHECK_JSON_SCHEMA },
    ciSummary: GITHUB_PR_MONITOR_CI_SUMMARY_JSON_SCHEMA,
  },
};
const GITHUB_PR_MONITOR_PROOF_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["namespace", "toolName", "input", "ok"],
  properties: {
    namespace: { type: "string", const: "ChatGPT_To_Codex" }, toolName: { type: "string", const: "github_pr_monitor_read" },
    input: GithubPrMonitorReadInputJsonSchema, ok: { type: "boolean" },
  },
};
export const GITHUB_PR_MONITOR_OPENAPI = Object.freeze({
  input: GithubPrMonitorReadInputJsonSchema,
  success: {
    type: "object", additionalProperties: false, required: [...GITHUB_PR_MONITOR_SUCCESS_KEYS],
    properties: {
      monitorPayloadVersion: { type: "integer", const: 1 }, protocolVersion: { type: "integer", const: 1 }, schemaVersion: { type: "integer", const: 4 },
      requestDigest: { type: "string", pattern: "^[0-9a-f]{64}$" }, receiptId: { type: "string", pattern: "^[0-9a-f]{64}$" },
      namespace: { type: "string", const: "ChatGPT_To_Codex" }, tool: { type: "string", const: "github_pr_monitor_read" }, operation: { type: "string", const: "read" }, ok: { type: "boolean", const: true },
      runId: { type: "string", pattern: SAFE_ID_PATTERN.source }, actionPlanId: { type: "string", pattern: SAFE_ID_PATTERN.source },
      account: { type: "object", additionalProperties: false, required: ["login"], properties: { login: { type: "string", pattern: LOGIN_PATTERN.source } } },
      discovery: GITHUB_PR_MONITOR_DISCOVERY_JSON_SCHEMA, prs: { type: "array", maxItems: MAX_UNIQUE_CANDIDATES, items: GITHUB_PR_MONITOR_PR_JSON_SCHEMA },
      observedAt: { type: "string", format: "date-time" }, chatgpt2codexToolCall: GITHUB_PR_MONITOR_PROOF_JSON_SCHEMA,
    },
  },
  error: {
    type: "object", additionalProperties: false,
    required: ["monitorPayloadVersion", "protocolVersion", "schemaVersion", "requestDigest", "namespace", "tool", "operation", "ok", "code", "error", "chatgpt2codexToolCall"],
    properties: {
      monitorPayloadVersion: { type: "integer", const: 1 }, protocolVersion: { type: "integer", const: 1 }, schemaVersion: { type: "integer", const: 4 },
      requestDigest: { type: "string", pattern: "^[0-9a-f]{64}$" }, runId: { type: "string", pattern: SAFE_ID_PATTERN.source, maxLength: 300 }, actionPlanId: { type: "string", pattern: SAFE_ID_PATTERN.source, maxLength: 300 },
      namespace: { type: "string", const: "ChatGPT_To_Codex" }, tool: { type: "string", const: "github_pr_monitor_read" }, operation: { type: "string", const: "read" }, ok: { type: "boolean", const: false },
      code: { type: "string", enum: [...GITHUB_PR_MONITOR_ERROR_CODES] }, error: { type: "string", maxLength: 512 },
      chatgpt2codexToolCall: { ...GITHUB_PR_MONITOR_PROOF_JSON_SCHEMA, required: ["namespace", "toolName", "ok"], properties: { ...GITHUB_PR_MONITOR_PROOF_JSON_SCHEMA.properties, input: GithubPrMonitorReadInputJsonSchema } },
    },
  },
});
export const githubPrMonitorOpenApi = GITHUB_PR_MONITOR_OPENAPI;

export function actorKey(actor: Actor): string { return `${actor.actorType}:${actor.login ?? ""}`; }
export function equalActor(a: Actor, b: Actor): boolean { return a.actorType === b.actorType && a.login === b.login; }
export function isMonitorErrorCode(value: unknown): value is MonitorErrorCode {
  return typeof value === "string" && value.startsWith("GITHUB_MONITOR_") && Object.values(ErrorCode).includes(value as ErrorCode);
}

export function safeErrorMessage(code: MonitorErrorCode): string {
  const messages: Record<MonitorErrorCode, string> = {
    GITHUB_MONITOR_INVALID_INPUT: "Invalid GitHub PR monitor input.",
    GITHUB_MONITOR_AUTH: "GitHub authentication is unavailable.",
    GITHUB_MONITOR_UNAVAILABLE: "GitHub monitor is unavailable.",
    GITHUB_MONITOR_DISCOVERY_INVALID: "GitHub PR discovery returned invalid data.",
    GITHUB_MONITOR_DISCOVERY_LIMIT: "GitHub PR discovery exceeded its bounded limit.",
    GITHUB_MONITOR_SNAPSHOT_INVALID: "GitHub PR snapshot returned invalid data.",
    GITHUB_MONITOR_TIMEOUT: "GitHub PR monitor timed out.",
    GITHUB_MONITOR_OUTPUT_LIMIT: "GitHub PR monitor output exceeded its bounded limit.",
    GITHUB_MONITOR_ABORTED: "GitHub PR monitor was aborted.",
  };
  return messages[code];
}

export function makeToolCallProof(input: GithubPrMonitorReadInput | undefined, ok: boolean): ToolCallProof {
  return input ? { namespace: "ChatGPT_To_Codex", toolName: "github_pr_monitor_read", input: structuredClone(input), ok } : { namespace: "ChatGPT_To_Codex", toolName: "github_pr_monitor_read", ok };
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
export function validateMonitorSuccess(value: unknown): value is GithubPrMonitorReadResult {
  return exactKeys(value, GITHUB_PR_MONITOR_SUCCESS_KEYS) && GithubPrMonitorReadResultSchema.safeParse(value).success;
}
export function validateMonitorError(value: unknown): value is GithubPrMonitorErrorResult {
  if (!exactKeys(value, GITHUB_PR_MONITOR_ERROR_KEYS) && !exactKeys(value, GITHUB_PR_MONITOR_ERROR_KEYS_WITH_IDS)) return false;
  const v = value as Record<string, unknown>;
  return GithubPrMonitorErrorResultSchema.safeParse(value).success
    && typeof v.error === "string" && Buffer.byteLength(v.error, "utf8") <= 512;
}
