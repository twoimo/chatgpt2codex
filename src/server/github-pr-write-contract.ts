import { createHash, randomUUID } from "node:crypto";

export const GITHUB_PR_WRITE_PROTOCOL_VERSION = 5 as const;
export const GITHUB_PR_WRITE_SCHEMA_VERSION = 5 as const;
export const CAPABILITY_TTL_MS = 1_800_000 as const;
export const WRITE_SESSION_TTL_MS = 900_000 as const;
export const PREVIEW_TTL_MS = 300_000 as const;
export const CHALLENGE_TTL_MS = 120_000 as const;
export const APPROVAL_TTL_MS = 90_000 as const;
export const STATUS_POLL_TTL_MS = 600_000 as const;
export const CLOCK_SKEW_MS = 30_000 as const;

export const WRITE_TTL_MS = {
  capability: CAPABILITY_TTL_MS,
  session: WRITE_SESSION_TTL_MS,
  preview: PREVIEW_TTL_MS,
  challenge: CHALLENGE_TTL_MS,
  approval: APPROVAL_TTL_MS,
  statusHandle: STATUS_POLL_TTL_MS,
  skew: CLOCK_SKEW_MS,
} as const;

export type GithubCheckSummary = "passing" | "pending" | "failing" | "unknown";
const SUCCESS_CHECK_VALUES = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const FAILURE_CHECK_VALUES = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "STALE"]);
const PENDING_CHECK_VALUES = new Set(["EXPECTED", "QUEUED", "IN_PROGRESS", "PENDING", "REQUESTED", "WAITING"]);

/** Require explicit successful check evidence; transport completion alone is not success. */
export function summarizeGithubCheckRollup(value: unknown): GithubCheckSummary {
  if (!Array.isArray(value) || value.length === 0) return "unknown";
  for (const rawCheck of value) {
    if (!rawCheck || typeof rawCheck !== "object" || Array.isArray(rawCheck)) return "unknown";
    const check = rawCheck as Record<string, unknown>;
    const state = typeof check.state === "string" ? check.state.toUpperCase() : undefined;
    const conclusion = typeof check.conclusion === "string" ? check.conclusion.toUpperCase() : undefined;
    const status = typeof check.status === "string" ? check.status.toUpperCase() : undefined;
    const values = [state, conclusion, status].filter((item): item is string => item !== undefined);
    if (values.length === 0) return "unknown";
    if (values.some((item) => FAILURE_CHECK_VALUES.has(item))) return "failing";
    if (values.some((item) => PENDING_CHECK_VALUES.has(item))) return "pending";
    const explicitSuccess = SUCCESS_CHECK_VALUES.has(state ?? "") || SUCCESS_CHECK_VALUES.has(conclusion ?? "");
    if (!explicitSuccess) return "unknown";
  }
  return "passing";
}

export const WRITE_STAGES = ["off", "shadow", "prepare", "enabled"] as const;
export type WriteStage = (typeof WRITE_STAGES)[number];
export const WRITE_OPERATIONS = [
  "post_comment", "post_reply", "resolve_thread", "rerequest_reviewer",
  "approve", "merge", "apply_suggestions", "push_prepared_worktree",
] as const;
export const GITHUB_PR_WRITE_REPOSITORY = "Yeachan-Heo/gajae-code" as const;
export const GITHUB_PR_WRITE_FORK_REPOSITORY = "twoimo/gajae-code" as const;
export const GITHUB_PR_WRITE_ACCOUNT = "twoimo" as const;
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];

export const OPERATOR_PROFILE_ID = "p256-secure-enclave-private-key-usage-user-presence-x962-sha256-v1" as const;
export const OPERATOR_KEY_PROFILE = {
  curve: "P-256",
  keySize: 256,
  secureEnclave: true,
  accessibility: "WhenUnlockedThisDeviceOnly",
  accessControl: ["privateKeyUsage", "userPresence"] as const,
  algorithm: "ECDSA-SHA256-X9.62-DER",
  signatureEncoding: "DER",
} as const;

export type WriteErrorCode =
  | "GITHUB_WRITE_INVALID_INPUT" | "GITHUB_WRITE_UNAVAILABLE"
  | "GITHUB_WRITE_ATTESTATION" | "GITHUB_WRITE_LEGACY_STATE"
  | "GITHUB_WRITE_CAPABILITY_REQUIRED" | "GITHUB_WRITE_SESSION_REQUIRED"
  | "GITHUB_WRITE_EXPIRED" | "GITHUB_WRITE_CONFLICT"
  | "GITHUB_WRITE_PREVIEW_LIMIT" | "GITHUB_WRITE_APPROVAL_REQUIRED"
  | "GITHUB_WRITE_RECOVERY_REQUIRED" | "GITHUB_WRITE_MUTATION_DENIED"
  | "GITHUB_WRITE_PERMISSION_REQUIRED" | "GITHUB_WRITE_OPERATOR_REQUIRED"
  | "GITHUB_WRITE_SESSION_INVALID" | "GITHUB_WRITE_APPROVAL_INVALID"
  | "GITHUB_WRITE_PREVIEW_EXPIRED" | "GITHUB_WRITE_CAPABILITY_REVOKED"
  | "GITHUB_WRITE_ATTESTATION_INVALID" | "GITHUB_WRITE_ROLLOUT_BLOCKED"
  | "GITHUB_WRITE_ACTOR_UNAUTHORIZED" | "GITHUB_WRITE_PERMISSION_DENIED"
  | "GITHUB_WRITE_BYPASS_DENIED" | "GITHUB_WRITE_CLOCK_INVALID";

export class GithubPrWriteError extends Error {
  readonly code: WriteErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: WriteErrorCode, message: string = code, details?: Record<string, unknown>) {
    super(message); this.name = "GithubPrWriteError"; this.code = code; this.details = details;
  }
}

/** UTC wall clock plus a monotonic elapsed clock for same-process expiry checks. */
export class AuthorityClock {
  private readonly wall: () => number;
  private readonly mono: () => number;
  private readonly wallAtStart: number;
  private readonly monoAtStart: number;
  private lastWall: number;
  constructor(
    wall: () => number = Date.now,
    mono: () => number = () => Number(process.hrtime.bigint() / 1_000_000n),
  ) {
    this.wall = wall;
    this.mono = mono;
    this.wallAtStart = wall();
    this.monoAtStart = mono();
    this.lastWall = this.wallAtStart;
  }
  /**
   * Return the single authority timestamp. UTC is persisted; a monotonic
   * projection is used while this process is alive to detect wall-clock
   * tampering/sleep jumps.
   */
  now(): number {
    const wall = this.wall();
    const projected = this.elapsedNow();
    if (!Number.isSafeInteger(wall) || !Number.isSafeInteger(projected) || Math.abs(wall - projected) > CLOCK_SKEW_MS) {
      throw new GithubPrWriteError("GITHUB_WRITE_CLOCK_INVALID", "authority clocks diverged");
    }
    if (wall < this.lastWall - CLOCK_SKEW_MS) {
      throw new GithubPrWriteError("GITHUB_WRITE_CLOCK_INVALID", "authority wall clock moved backwards");
    }
    this.lastWall = wall;
    return wall;
  }
  elapsedNow(): number {
    const elapsed = this.mono() - this.monoAtStart;
    return this.wallAtStart + elapsed;
  }
  isExpired(expiresAt: number, now = this.now()): boolean {
    return now >= expiresAt;
  }
  isFuture(value: number, now = this.now()): boolean {
    return value > now + CLOCK_SKEW_MS;
  }
  assertPersistedWindow(
    issuedAt: number,
    expiresAt: number,
    ttl: number,
    now = this.now(),
  ): void {
    if (
      !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      !Number.isSafeInteger(ttl) ||
      expiresAt !== issuedAt + ttl ||
      issuedAt > now + CLOCK_SKEW_MS ||
      expiresAt <= now
    ) {
      throw new GithubPrWriteError("GITHUB_WRITE_CLOCK_INVALID", "invalid persisted authority window");
    }
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function digest(value: unknown): string { return sha256(canonicalJson(value)); }
export function newEffectIdentity(): string { return randomUUID(); }
export function effectIdentityFor(binding: unknown): string {
  return `v5-${sha256(canonicalJson(binding)).slice(0, 48)}`;
}

export function assertFreshExpiry(
  expiresAt: number,
  now: number,
  ttl: number,
  issuedAt = expiresAt - ttl,
): void {
  if (
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(issuedAt) ||
    expiresAt !== issuedAt + ttl ||
    expiresAt <= now ||
    issuedAt > now + CLOCK_SKEW_MS
  ) {
    throw new GithubPrWriteError("GITHUB_WRITE_CLOCK_INVALID", "invalid or expired write authority timestamp");
  }
}

export function assertWriteStage(stage: unknown): asserts stage is WriteStage {
  if (!WRITE_STAGES.includes(stage as WriteStage)) throw new GithubPrWriteError("GITHUB_WRITE_UNAVAILABLE", "unknown rollout stage");
}

export function assertNoAuthorityFields(input: Record<string, unknown>, forbidden: readonly string[] = ["capabilityId", "generation", "approvalId", "signature", "confirm"]): void {
  for (const key of forbidden) if (key in input) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", `caller field is not authoritative: ${key}`);
}
