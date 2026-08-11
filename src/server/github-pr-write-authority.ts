import { createRequire } from "node:module";
import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AuthorityClock, GithubPrWriteError, WRITE_TTL_MS, GITHUB_PR_WRITE_SCHEMA_VERSION,
  assertFreshExpiry, digest, newEffectIdentity,
} from "./github-pr-write-contract.js";
import type { WriteOperation } from "./github-pr-write-contract.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require(`node:${"sqlite"}`) as { DatabaseSync: new (path: string, options?: { timeout?: number }) => SqliteDatabase };
interface SqliteStatement { get(...args: unknown[]): Record<string, unknown> | undefined; all(...args: unknown[]): Record<string, unknown>[]; run(...args: unknown[]): { changes: number }; }
interface SqliteDatabase { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void; }
const MAX_ID = 128;
const MAX_JSON = 32_000;
const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID || /[\0\r\n]/u.test(value))
    throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", `invalid ${field}`);
  return value;
};
const json = (value: unknown): string => {
  const result = JSON.stringify(value);
  if (result === undefined || result.length > MAX_JSON) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "input is too large");
  return result;
};

export interface Capability { capabilityId: string; principal: string; generation: number; expiresAt: number; }
export interface WriteSession { sessionId: string; capabilityId: string; generation: number; expiresAt: number; }
export interface Preview { previewId: string; sessionId: string; operation: WriteOperation; requestDigest: string; expiresAt: number; }
export interface Challenge { challengeId: string; previewId: string; expiresAt: number; }
export interface Approval { approvalId: string; challengeId: string; expiresAt: number; }
export interface EffectIntent { effectId: string; previewId: string; idempotencyKey: string; status: "pending" | "completed" | "failed"; }

/** Host-owned, fail-closed authority store. This is deliberately not a projection or migration layer. */
export class GithubPrWriteAuthority {
  readonly databasePath: string;
  private readonly clock: AuthorityClock;
  private readonly db: SqliteDatabase;
  constructor(readonly stateDir: string, clock = new AuthorityClock()) {
    this.clock = clock;
    this.databasePath = join(stateDir, "github-pr-write.sqlite");
    throw new Error("constructor requires async initialization; use GithubPrWriteAuthority.open");
  }

  private constructorOpen(stateDir: string, clock: AuthorityClock): GithubPrWriteAuthority { return new GithubPrWriteAuthority(stateDir, clock); }

  static async open(stateDir: string, clock = new AuthorityClock()): Promise<GithubPrWriteAuthority> {
    await mkdir(stateDir, { recursive: true, mode: 0o700 }); await chmod(stateDir, 0o700);
    const path = join(stateDir, "github-pr-write.sqlite"); const db = new DatabaseSync(path, { timeout: 5_000 });
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    const version = Number((db.prepare("PRAGMA user_version").get()?.user_version) ?? 0);
    if (version === 4) { db.close(); throw new GithubPrWriteError("GITHUB_WRITE_LEGACY_STATE", "legacy v4 authority is refused"); }
    if (version !== 0 && version !== GITHUB_PR_WRITE_SCHEMA_VERSION) { db.close(); throw new GithubPrWriteError("GITHUB_WRITE_LEGACY_STATE", "unsupported authority schema"); }
    if (version === 0) {
      db.exec(`CREATE TABLE IF NOT EXISTS capabilities (capability_id TEXT PRIMARY KEY, principal TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS previews (preview_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, operation TEXT NOT NULL, request_digest TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (challenge_id TEXT PRIMARY KEY, preview_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS effect_intents (effect_id TEXT PRIMARY KEY, preview_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, request_digest TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS effect_outcomes (effect_id TEXT PRIMARY KEY, outcome_digest TEXT NOT NULL, completed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (audit_id TEXT PRIMARY KEY, event TEXT NOT NULL, subject TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL);
PRAGMA user_version = 5;`);
    }
    const authority = Object.create(GithubPrWriteAuthority.prototype) as GithubPrWriteAuthority;
    Object.assign(authority, { stateDir, clock, databasePath: path, db }); return authority;
  }

  private expiry(ttl: number): number { const now = this.clock.now(); return now + ttl; }
  private audit(event: string, subject: string, value: unknown): void { this.db.prepare("INSERT INTO audit VALUES (?, ?, ?, ?, ?)").run(randomUUID(), event, subject, digest(value), this.clock.now()); }
  issueCapability(principal: string, generation = 1): Capability {
    text(principal, "principal"); if (!Number.isSafeInteger(generation) || generation < 1) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "invalid generation");
    const capabilityId = randomUUID(), expiresAt = this.expiry(WRITE_TTL_MS.capability);
    this.db.prepare("INSERT INTO capabilities VALUES (?, ?, ?, ?)").run(capabilityId, principal, generation, expiresAt); this.audit("capability.issued", capabilityId, { principal, generation });
    return { capabilityId, principal, generation, expiresAt };
  }
  openSession(capabilityId: string, generation: number): WriteSession {
    text(capabilityId, "capabilityId"); const row = this.db.prepare("SELECT principal, generation, expires_at FROM capabilities WHERE capability_id = ?").get(capabilityId);
    if (!row || row.generation !== generation || this.clock.isExpired(Number(row.expires_at))) throw new GithubPrWriteError("GITHUB_WRITE_CAPABILITY_REQUIRED", "capability is invalid or expired");
    const sessionId = randomUUID(), expiresAt = this.expiry(WRITE_TTL_MS.session); this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(sessionId, capabilityId, generation, expiresAt); this.audit("session.opened", sessionId, { capabilityId, generation });
    return { sessionId, capabilityId, generation, expiresAt };
  }
  createPreview(sessionId: string, operation: WriteOperation, request: unknown): Preview {
    text(sessionId, "sessionId"); text(operation, "operation"); const row = this.db.prepare("SELECT capability_id, generation, expires_at FROM sessions WHERE session_id = ?").get(sessionId);
    if (!row || this.clock.isExpired(Number(row.expires_at))) throw new GithubPrWriteError("GITHUB_WRITE_SESSION_REQUIRED", "session is invalid or expired");
    const previewId = randomUUID(), requestDigest = digest(request), expiresAt = this.expiry(WRITE_TTL_MS.preview); this.db.prepare("INSERT INTO previews VALUES (?, ?, ?, ?, ?)").run(previewId, sessionId, operation, requestDigest, expiresAt); this.audit("preview.created", previewId, { sessionId, operation, requestDigest });
    return { previewId, sessionId, operation, requestDigest, expiresAt };
  }
  createChallenge(previewId: string): Challenge {
    text(previewId, "previewId"); const row = this.db.prepare("SELECT expires_at FROM previews WHERE preview_id = ?").get(previewId); if (!row || this.clock.isExpired(Number(row.expires_at))) throw new GithubPrWriteError("GITHUB_WRITE_EXPIRED", "preview is invalid or expired");
    const challengeId = randomUUID(), expiresAt = this.expiry(WRITE_TTL_MS.challenge); this.db.prepare("INSERT INTO challenges VALUES (?, ?, ?)").run(challengeId, previewId, expiresAt); this.audit("challenge.created", challengeId, { previewId }); return { challengeId, previewId, expiresAt };
  }
  approve(challengeId: string): Approval {
    text(challengeId, "challengeId"); const row = this.db.prepare("SELECT expires_at FROM challenges WHERE challenge_id = ?").get(challengeId); if (!row || this.clock.isExpired(Number(row.expires_at))) throw new GithubPrWriteError("GITHUB_WRITE_APPROVAL_REQUIRED", "challenge is invalid or expired");
    const approvalId = randomUUID(), expiresAt = this.expiry(WRITE_TTL_MS.approval); this.db.prepare("INSERT INTO approvals VALUES (?, ?, ?)").run(approvalId, challengeId, expiresAt); this.audit("approval.granted", approvalId, { challengeId }); return { approvalId, challengeId, expiresAt };
  }
  recordEffectIntent(previewId: string, idempotencyKey: string): EffectIntent {
    text(previewId, "previewId"); text(idempotencyKey, "idempotencyKey"); const existing = this.db.prepare("SELECT effect_id, preview_id, idempotency_key, status FROM effect_intents WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return { effectId: String(existing.effect_id), previewId: String(existing.preview_id), idempotencyKey: String(existing.idempotency_key), status: existing.status as EffectIntent["status"] };
    const effectId = newEffectIdentity(); this.db.prepare("INSERT INTO effect_intents VALUES (?, ?, ?, ?, ?)").run(effectId, previewId, idempotencyKey, "pending", digest({ previewId, idempotencyKey })); this.audit("effect.intent", effectId, { previewId, idempotencyKey }); return { effectId, previewId, idempotencyKey, status: "pending" };
  }
  recordEffectOutcome(effectId: string, outcome: unknown): void { text(effectId, "effectId"); json(outcome); this.db.prepare("INSERT OR REPLACE INTO effect_outcomes VALUES (?, ?, ?)").run(effectId, digest(outcome), this.clock.now()); this.db.prepare("UPDATE effect_intents SET status = 'completed' WHERE effect_id = ?").run(effectId); this.audit("effect.outcome", effectId, { outcome: digest(outcome) }); }
  recover(): { pendingEffectIds: string[] } { const rows = this.db.prepare("SELECT effect_id FROM effect_intents WHERE status = 'pending'").all(); return { pendingEffectIds: rows.map(row => String(row.effect_id)) }; }
  auditEntries(): Array<{ event: string; subject: string; digest: string; createdAt: number }> { return this.db.prepare("SELECT event, subject, digest, created_at FROM audit ORDER BY created_at, audit_id").all().map(row => ({ event: String(row.event), subject: String(row.subject), digest: String(row.digest), createdAt: Number(row.created_at) })); }
  close(): void { this.db.close(); }
}
