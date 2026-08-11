import { createHash, randomUUID } from "node:crypto";

export const GITHUB_PR_WRITE_PROTOCOL_VERSION = 5 as const;
export const GITHUB_PR_WRITE_SCHEMA_VERSION = 5 as const;
export const WRITE_TTL_MS = {
  capability: 30 * 60_000,
  session: 15 * 60_000,
  preview: 5 * 60_000,
  challenge: 2 * 60_000,
  approval: 90_000,
  statusHandle: 10 * 60_000,
  skew: 30_000,
} as const;

export const WRITE_STAGES = ["off", "shadow", "prepare", "enabled"] as const;
export type WriteStage = (typeof WRITE_STAGES)[number];
export const WRITE_OPERATIONS = [
  "post_comment", "post_reply", "resolve_thread", "request_reviewer",
  "prepare_suggestions", "commit", "push",
] as const;
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];

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
  | "GITHUB_WRITE_RECOVERY_REQUIRED" | "GITHUB_WRITE_MUTATION_DENIED";

export class GithubPrWriteError extends Error {
  readonly code: WriteErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: WriteErrorCode, message = code, details?: Record<string, unknown>) {
    super(message); this.name = "GithubPrWriteError"; this.code = code; this.details = details;
  }
}

/** UTC wall clock plus a monotonic elapsed clock for same-process expiry checks. */
export class AuthorityClock {
  private readonly wall: () => number;
  private readonly mono: () => number;
  private readonly wallAtStart: number;
  private readonly monoAtStart: number;
  constructor(wall: () => number = Date.now, mono: () => number = () => Number(process.hrtime.bigint() / 1_000_000n)) {
    this.wall = wall; this.mono = mono; this.wallAtStart = wall(); this.monoAtStart = mono();
  }
  now(): number { return this.wall(); }
  elapsedNow(): number { return this.wallAtStart + (this.mono() - this.monoAtStart); }
  isExpired(expiresAt: number, now = this.now()): boolean { return now >= expiresAt; }
  isFuture(value: number, now = this.now()): boolean { return value > now + WRITE_TTL_MS.skew; }
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

export function assertFreshExpiry(expiresAt: number, now: number, ttl: number): void {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + ttl + WRITE_TTL_MS.skew) {
    throw new GithubPrWriteError("GITHUB_WRITE_EXPIRED", "invalid or expired write authority timestamp");
  }
}

export function assertWriteStage(stage: unknown): asserts stage is WriteStage {
  if (!WRITE_STAGES.includes(stage as WriteStage)) throw new GithubPrWriteError("GITHUB_WRITE_UNAVAILABLE", "unknown rollout stage");
}

export function assertNoAuthorityFields(input: Record<string, unknown>, forbidden: readonly string[] = ["capabilityId", "generation", "approvalId", "signature", "confirm"]): void {
  for (const key of forbidden) if (key in input) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", `caller field is not authoritative: ${key}`);
}
