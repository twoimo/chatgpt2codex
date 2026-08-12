import { createRequire } from "node:module";
import { mkdir, chmod, lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AuthorityClock,
  GithubPrWriteError,
  WRITE_TTL_MS,
  GITHUB_PR_WRITE_SCHEMA_VERSION,
  WRITE_STAGES,
  WRITE_OPERATIONS,
  assertFreshExpiry,
  digest,
  effectIdentityFor,
  type WriteOperation,
  type WriteStage,
} from "./github-pr-write-contract.js";
import { verifyOperatorApproval, type OperatorApprovalAttestation } from "./github-pr-write-attestation.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require(`node:${"sqlite"}`) as {
  DatabaseSync: new (path: string, options?: { timeout?: number }) => SqliteDatabase;
};
interface SqliteStatement {
  get(...args: unknown[]): Record<string, unknown> | undefined;
  all(...args: unknown[]): Record<string, unknown>[];
  run(...args: unknown[]): { changes: number };
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const MAX_ID = 128;
const MAX_JSON = 32_000;
const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID || /[\0\r\n]/u.test(value)) {
    throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", `invalid ${field}`);
  }
  return value;
};
const json = (value: unknown): string => {
  const result = JSON.stringify(value);
  if (result === undefined || Buffer.byteLength(result, "utf8") > MAX_JSON) {
    throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "input is too large");
  }
  return result;
};
const number = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value)) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", `invalid ${field}`);
  return value as number;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS authority_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS capabilities (
  capability_id TEXT PRIMARY KEY, principal TEXT NOT NULL, generation INTEGER NOT NULL,
  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL,
  scope_digest TEXT NOT NULL, profile_digest TEXT NOT NULL, helper_digest TEXT NOT NULL, key_digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, generation INTEGER NOT NULL,
  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, binding_digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS previews (
  preview_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, operation TEXT NOT NULL,
  request_digest TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges (
  challenge_id TEXT PRIMARY KEY, preview_id TEXT NOT NULL, nonce TEXT NOT NULL,
  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL, issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, status TEXT NOT NULL, attestation_digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS effect_intents (
  effect_id TEXT PRIMARY KEY, preview_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, request_digest TEXT NOT NULL, binding_digest TEXT NOT NULL, issued_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS effect_outcomes (
  effect_id TEXT PRIMARY KEY, outcome_digest TEXT NOT NULL, operation TEXT NOT NULL,
  proof_digest TEXT, completed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_tasks (
  effect_id TEXT PRIMARY KEY, reason TEXT NOT NULL, evidence_digest TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  audit_id TEXT PRIMARY KEY, event TEXT NOT NULL, subject TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL
);
`;
const SCHEMA_HASH = digest(SCHEMA_SQL);
const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  authority_meta: ["key", "value"],
  capabilities: ["capability_id", "principal", "generation", "issued_at", "expires_at", "status", "scope_digest", "profile_digest", "helper_digest", "key_digest"],
  sessions: ["session_id", "capability_id", "generation", "issued_at", "expires_at", "status", "binding_digest"],
  previews: ["preview_id", "session_id", "operation", "request_digest", "issued_at", "expires_at", "status"],
  challenges: ["challenge_id", "preview_id", "nonce", "issued_at", "expires_at", "status"],
  approvals: ["approval_id", "challenge_id", "issued_at", "expires_at", "status", "attestation_digest"],
  effect_intents: ["effect_id", "preview_id", "idempotency_key", "status", "request_digest", "binding_digest", "issued_at"],
  effect_outcomes: ["effect_id", "outcome_digest", "operation", "proof_digest", "completed_at"],
  recovery_tasks: ["effect_id", "reason", "evidence_digest", "updated_at"],
  audit: ["audit_id", "event", "subject", "digest", "created_at"],
};

export interface Capability {
  capabilityId: string;
  principal: string;
  generation: number;
  issuedAt: number;
  expiresAt: number;
  status: "active" | "revoked";
  scopeDigest: string;
}
export interface WriteSession {
  sessionId: string;
  capabilityId: string;
  generation: number;
  issuedAt: number;
  expiresAt: number;
  status: "active" | "closed";
  bindingDigest: string;
}
export interface Preview {
  previewId: string;
  sessionId: string;
  operation: WriteOperation;
  requestDigest: string;
  issuedAt: number;
  expiresAt: number;
  status: "preview_issued" | "approval_pending" | "approved" | "claimed" | "revoked" | "failed";
}
export interface Challenge {
  challengeId: string;
  previewId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "rejected" | "expired";
}
export interface Approval {
  approvalId: string;
  challengeId: string;
  issuedAt: number;
  expiresAt: number;
  status: "approved" | "revoked";
}
export interface EffectIntent {
  effectId: string;
  previewId: string;
  idempotencyKey: string;
  status: "pending" | "completed" | "failed" | "recovery_required";
  bindingDigest: string;
}

/** Host-owned v5 authority. External monitor stores are never opened here. */
export class GithubPrWriteAuthority {
  readonly databasePath: string;
  private constructor(
    readonly stateDir: string,
    private readonly clock: AuthorityClock,
    private readonly db: SqliteDatabase,
    databasePath: string,
  ) {
    this.databasePath = databasePath;
  }

  static async open(stateDir: string, clock = new AuthorityClock()): Promise<GithubPrWriteAuthority> {
    const state = await lstat(stateDir).catch(() => undefined);
    if (state?.isSymbolicLink()) throw new GithubPrWriteError("GITHUB_WRITE_LEGACY_STATE", "authority state directory must not be a symlink");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    const stateInfo = await stat(stateDir);
    if (!stateInfo.isDirectory() || (stateInfo.mode & 0o077) !== 0) throw new GithubPrWriteError("GITHUB_WRITE_LEGACY_STATE", "authority state directory permissions are unsafe");

    const path = join(stateDir, "github-pr-write.sqlite");
    const existing = await lstat(path).catch(() => undefined);
    if (existing?.isSymbolicLink()) throw new GithubPrWriteError("GITHUB_WRITE_LEGACY_STATE", "authority database must not be a symlink");
    const db = new DatabaseSync(path, { timeout: 5_000 });
    try {
      await chmod(path, 0o600);
      const info = await stat(path);
      const owner = typeof process.getuid === "function" ? process.getuid() : info.uid;
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== owner)) {
        throw new GithubPrWriteError("GITHUB_WRITE_LEGACY_STATE", "authority database permissions are unsafe");
      }
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
      await chmod(`${path}-wal`, 0o600).catch(() => undefined);
      await chmod(`${path}-shm`, 0o600).catch(() => undefined);
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (version === 4) throw new GithubPrWriteError("GITHUB_WRITE_LEGACY_STATE", "legacy v4 authority is refused");
      if (version !== 0 && version !== GITHUB_PR_WRITE_SCHEMA_VERSION) throw new GithubPrWriteError("GITHUB_WRITE_LEGACY_STATE", "unsupported authority schema");
      if (version === 0) {
        db.exec(SCHEMA_SQL);
        db.prepare("INSERT OR REPLACE INTO authority_meta(key, value) VALUES (?, ?)").run("schema_hash", SCHEMA_HASH);
        db.prepare("INSERT OR REPLACE INTO authority_meta(key, value) VALUES (?, ?)").run("generation", "1");
        db.prepare("INSERT OR REPLACE INTO authority_meta(key, value) VALUES (?, ?)").run("stage", "off");
        db.exec("PRAGMA user_version = 5");
      } else {
        for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
          const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
          if (columns.some((column) => !actual.has(column))) throw new GithubPrWriteError("GITHUB_WRITE_LEGACY_STATE", `authority table ${table} is stale`);
        }
        const schemaHash = db.prepare("SELECT value FROM authority_meta WHERE key = 'schema_hash'").get()?.value;
        if (schemaHash !== SCHEMA_HASH) throw new GithubPrWriteError("GITHUB_WRITE_LEGACY_STATE", "authority schema hash does not match the release");
      }
      return new GithubPrWriteAuthority(stateDir, clock, db, path);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  private now(): number {
    return this.clock.now();
  }

  private expiry(ttl: number): { issuedAt: number; expiresAt: number } {
    const issuedAt = this.now();
    const expiresAt = issuedAt + ttl;
    assertFreshExpiry(expiresAt, issuedAt, ttl, issuedAt);
    return { issuedAt, expiresAt };
  }

  private assertWindow(row: Record<string, unknown>, ttl: number): void {
    const issuedAt = number(row.issued_at, "issuedAt");
    const expiresAt = number(row.expires_at, "expiresAt");
    const now = this.now();
    if (now >= expiresAt) throw new GithubPrWriteError("GITHUB_WRITE_EXPIRED", "authority window has expired");
    this.clock.assertPersistedWindow(issuedAt, expiresAt, ttl, now);
  }

  private audit(event: string, subject: string, value: unknown): void {
    this.db.prepare("INSERT INTO audit VALUES (?, ?, ?, ?, ?)").run(randomUUID(), event, subject, digest(value), this.now());
  }

  private generationValue(): number {
    const raw = Number(this.db.prepare("SELECT value FROM authority_meta WHERE key = 'generation'").get()?.value ?? 0);
    if (!Number.isSafeInteger(raw) || raw < 1) throw new GithubPrWriteError("GITHUB_WRITE_LEGACY_STATE", "authority generation is invalid");
    return raw;
  }

  currentGeneration(): number { return this.generationValue(); }
  currentStage(): WriteStage {
    const stage = String(this.db.prepare("SELECT value FROM authority_meta WHERE key = 'stage'").get()?.value ?? "off");
    if (!WRITE_STAGES.includes(stage as WriteStage)) throw new GithubPrWriteError("GITHUB_WRITE_ROLLOUT_BLOCKED", "authority stage is invalid");
    return stage as WriteStage;
  }

  issueCapability(
    principal: string,
    generation?: number,
    scope: readonly WriteOperation[] = [],
    profileDigest = "",
    helperDigest = "",
    keyDigest = "",
  ): Capability {
    text(principal, "principal");
    const currentGeneration = this.generationValue();
    const selectedGeneration = generation ?? currentGeneration;
    number(selectedGeneration, "generation");
    if (selectedGeneration < currentGeneration) throw new GithubPrWriteError("GITHUB_WRITE_CAPABILITY_REVOKED", "capability generation is stale");
    const { issuedAt, expiresAt } = this.expiry(WRITE_TTL_MS.capability);
    const capabilityId = randomUUID();
    const scopeDigest = digest(scope);
    this.transaction(() => {
      if (selectedGeneration > currentGeneration) {
        this.db.prepare("UPDATE authority_meta SET value = ? WHERE key = 'generation'").run(String(selectedGeneration));
      }
      this.db.prepare("INSERT INTO capabilities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(capabilityId, principal, selectedGeneration, issuedAt, expiresAt, "active", scopeDigest, profileDigest, helperDigest, keyDigest);
      this.audit("capability.issued", capabilityId, { principal, generation: selectedGeneration, scopeDigest });
    });
    return { capabilityId, principal, generation: selectedGeneration, issuedAt, expiresAt, status: "active", scopeDigest };
  }

  activeCapability(principal: string): Capability | undefined {
    text(principal, "principal");
    const row = this.db.prepare(
      "SELECT capability_id, principal, generation, issued_at, expires_at, status, scope_digest FROM capabilities WHERE principal = ? AND status = 'active' ORDER BY issued_at DESC LIMIT 1",
    ).get(principal);
    if (!row) return undefined;
    this.assertWindow(row, WRITE_TTL_MS.capability);
    return {
      capabilityId: String(row.capability_id),
      principal: String(row.principal),
      generation: Number(row.generation),
      issuedAt: Number(row.issued_at),
      expiresAt: Number(row.expires_at),
      status: "active",
      scopeDigest: String(row.scope_digest),
    };
  }

  /** Explicit unattended mode may renew its bounded capability after expiry. */
  unattendedCapability(principal: string, scope: readonly WriteOperation[] = WRITE_OPERATIONS): Capability {
    if (process.env.CHATGPT2CODEX_UNATTENDED_WRITE !== "1") {
      throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION", "unattended capability renewal is disabled");
    }
    if (this.currentStage() !== "enabled") {
      throw new GithubPrWriteError("GITHUB_WRITE_ROLLOUT_BLOCKED", "unattended capability renewal requires enabled rollout");
    }
    text(principal, "principal");
    if (scope.length !== WRITE_OPERATIONS.length || scope.some((operation, index) => operation !== WRITE_OPERATIONS[index])) {
      throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "unattended capability scope is fixed");
    }
    try {
      const active = this.activeCapability(principal);
      const expectedScopeDigest = digest(scope);
      if (active?.scopeDigest === expectedScopeDigest) return active;
      if (active) this.revokeCapability(active.capabilityId);
    } catch (error) {
      if (!(error instanceof GithubPrWriteError) || error.code !== "GITHUB_WRITE_EXPIRED") throw error;
    }
    return this.issueCapability(principal, this.currentGeneration(), scope);
  }

  openSession(capabilityId: string, generation: number, binding: unknown = { transport: "local" }): WriteSession {
    text(capabilityId, "capabilityId");
    number(generation, "generation");
    const row = this.db.prepare("SELECT principal, generation, issued_at, expires_at, status, scope_digest FROM capabilities WHERE capability_id = ?").get(capabilityId);
    if (!row || row.status !== "active" || Number(row.generation) !== generation || generation !== this.generationValue()) throw new GithubPrWriteError("GITHUB_WRITE_CAPABILITY_REQUIRED", "capability is invalid or revoked");
    this.assertWindow(row, WRITE_TTL_MS.capability);
    const { issuedAt, expiresAt } = this.expiry(WRITE_TTL_MS.session);
    const sessionId = randomUUID();
    const bindingDigest = digest(binding);
    this.transaction(() => {
      this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run(sessionId, capabilityId, generation, issuedAt, expiresAt, "active", bindingDigest);
      this.audit("session.opened", sessionId, { capabilityId, generation, bindingDigest });
    });
    return { sessionId, capabilityId, generation, issuedAt, expiresAt, status: "active", bindingDigest };
  }

  assertSession(sessionId: string, binding?: unknown): WriteSession {
    text(sessionId, "sessionId");
    const row = this.db.prepare("SELECT session_id, capability_id, generation, issued_at, expires_at, status, binding_digest FROM sessions WHERE session_id = ?").get(sessionId);
    if (!row) throw new GithubPrWriteError("GITHUB_WRITE_SESSION_REQUIRED", "session is unavailable");
    if (row.status !== "active") throw new GithubPrWriteError("GITHUB_WRITE_SESSION_INVALID", "session is invalid or closed");
    this.assertWindow(row, WRITE_TTL_MS.session);
    if (Number(row.generation) !== this.generationValue()) throw new GithubPrWriteError("GITHUB_WRITE_CAPABILITY_REVOKED", "session generation is revoked");
    if (binding !== undefined && String(row.binding_digest) !== digest(binding)) throw new GithubPrWriteError("GITHUB_WRITE_SESSION_INVALID", "session transport binding does not match");
    const session: WriteSession = {
      sessionId: String(row.session_id), capabilityId: String(row.capability_id), generation: Number(row.generation),
      issuedAt: Number(row.issued_at), expiresAt: Number(row.expires_at), status: "active", bindingDigest: String(row.binding_digest),
    };
    return session;
  }

  closeSession(sessionId: string): void {
    this.assertSession(sessionId);
    this.transaction(() => {
      this.db.prepare("UPDATE sessions SET status = 'closed' WHERE session_id = ? AND status = 'active'").run(sessionId);
      this.db.prepare("UPDATE previews SET status = 'revoked' WHERE session_id = ? AND status IN ('preview_issued', 'approval_pending', 'approved')").run(sessionId);
      this.audit("session.closed", sessionId, {});
    });
  }

  createPreview(sessionId: string, operation: WriteOperation, request: unknown): Preview {
    const session = this.assertSession(sessionId);
    text(operation, "operation");
    const { issuedAt, expiresAt } = this.expiry(WRITE_TTL_MS.preview);
    const previewId = randomUUID();
    const requestDigest = digest(request);
    this.transaction(() => {
      this.db.prepare("INSERT INTO previews VALUES (?, ?, ?, ?, ?, ?, ?)").run(previewId, session.sessionId, operation, requestDigest, issuedAt, expiresAt, "preview_issued");
      this.audit("preview.created", previewId, { sessionId, operation, requestDigest, generation: session.generation });
    });
    return { previewId, sessionId, operation, requestDigest, issuedAt, expiresAt, status: "preview_issued" };
  }

  createChallenge(previewId: string): Challenge {
    text(previewId, "previewId");
    const row = this.db.prepare("SELECT preview_id, issued_at, expires_at, status FROM previews WHERE preview_id = ?").get(previewId);
    if (!row || !["preview_issued", "approval_pending"].includes(String(row.status))) throw new GithubPrWriteError("GITHUB_WRITE_EXPIRED", "preview is invalid or already consumed");
    this.assertWindow(row, WRITE_TTL_MS.preview);
    const { issuedAt, expiresAt } = this.expiry(WRITE_TTL_MS.challenge);
    const challengeId = randomUUID();
    const nonce = randomUUID();
    this.transaction(() => {
      this.db.prepare("UPDATE previews SET status = 'approval_pending' WHERE preview_id = ?").run(previewId);
      this.db.prepare("INSERT INTO challenges VALUES (?, ?, ?, ?, ?, ?)").run(challengeId, previewId, nonce, issuedAt, expiresAt, "pending");
      this.audit("challenge.created", challengeId, { previewId });
    });
    return { challengeId, previewId, nonce, issuedAt, expiresAt, status: "pending" };
  }

  approve(challengeId: string, attestation: OperatorApprovalAttestation): Approval {
    text(challengeId, "challengeId");
    if (!attestation) throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION_INVALID");
    verifyOperatorApproval(attestation, challengeId);
    const row = this.db.prepare("SELECT preview_id, nonce, issued_at, expires_at, status FROM challenges WHERE challenge_id = ?").get(challengeId);
    if (!row || row.status !== "pending") throw new GithubPrWriteError("GITHUB_WRITE_APPROVAL_INVALID", "challenge is invalid or already consumed");
    this.assertWindow(row, WRITE_TTL_MS.challenge);
    if (attestation.challengeNonce !== undefined && attestation.challengeNonce !== String(row.nonce)) throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION_INVALID", "challenge nonce does not match");
    const { issuedAt, expiresAt } = this.expiry(WRITE_TTL_MS.approval);
    const approvalId = randomUUID();
    const attestationDigest = digest({ protocol: attestation.protocol, challengeId, payloadDigest: attestation.payloadDigest, publicKey: attestation.publicKeyDerBase64 });
    this.transaction(() => {
      this.db.prepare("UPDATE challenges SET status = 'approved' WHERE challenge_id = ? AND status = 'pending'").run(challengeId);
      this.db.prepare("UPDATE previews SET status = 'approved' WHERE preview_id = ? AND status = 'approval_pending'").run(String(row.preview_id));
      this.db.prepare("INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?)").run(approvalId, challengeId, issuedAt, expiresAt, "approved", attestationDigest);
      this.audit("approval.granted", approvalId, { challengeId, attestationDigest });
    });
    return { approvalId, challengeId, issuedAt, expiresAt, status: "approved" };
  }

  approveUnattended(challengeId: string, binding: unknown): Approval {
    if (process.env.CHATGPT2CODEX_UNATTENDED_WRITE !== "1") {
      throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION", "unattended approval is disabled");
    }
    text(challengeId, "challengeId");
    const row = this.db.prepare("SELECT preview_id, issued_at, expires_at, status FROM challenges WHERE challenge_id = ?").get(challengeId);
    if (!row || row.status !== "pending") throw new GithubPrWriteError("GITHUB_WRITE_APPROVAL_INVALID", "challenge is invalid or already consumed");
    this.assertWindow(row, WRITE_TTL_MS.challenge);
    const { issuedAt, expiresAt } = this.expiry(WRITE_TTL_MS.approval);
    const approvalId = randomUUID();
    const unattendedDigest = digest({ mode: "unattended-v1", challengeId, binding });
    this.transaction(() => {
      const challengeUpdate = this.db.prepare("UPDATE challenges SET status = 'approved' WHERE challenge_id = ? AND status = 'pending'").run(challengeId);
      const previewUpdate = this.db.prepare("UPDATE previews SET status = 'approved' WHERE preview_id = ? AND status = 'approval_pending'").run(String(row.preview_id));
      if (challengeUpdate.changes !== 1 || previewUpdate.changes !== 1) {
        throw new GithubPrWriteError("GITHUB_WRITE_APPROVAL_INVALID", "challenge approval state changed");
      }
      this.db.prepare("INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?)").run(approvalId, challengeId, issuedAt, expiresAt, "approved", unattendedDigest);
      this.audit("approval.granted_unattended", approvalId, { challengeId, unattendedDigest });
    });
    return { approvalId, challengeId, issuedAt, expiresAt, status: "approved" };
  }

  effectIntent(idempotencyKey: string): EffectIntent | undefined {
    text(idempotencyKey, "idempotencyKey");
    const row = this.db.prepare("SELECT effect_id, preview_id, idempotency_key, status, binding_digest FROM effect_intents WHERE idempotency_key = ?").get(idempotencyKey);
    return row ? {
      effectId: String(row.effect_id), previewId: String(row.preview_id), idempotencyKey: String(row.idempotency_key),
      status: row.status as EffectIntent["status"], bindingDigest: String(row.binding_digest),
    } : undefined;
  }

  recordEffectIntent(previewId: string, idempotencyKey: string, binding?: unknown): EffectIntent {
    text(previewId, "previewId"); text(idempotencyKey, "idempotencyKey");
    const preview = this.db.prepare("SELECT session_id, operation, request_digest, issued_at, expires_at, status FROM previews WHERE preview_id = ?").get(previewId);
    if (!preview || !["approved", "claimed"].includes(String(preview.status))) throw new GithubPrWriteError("GITHUB_WRITE_APPROVAL_REQUIRED", "preview is not approved");
    this.assertWindow(preview, WRITE_TTL_MS.preview);
    const bindingDigest = digest(binding ?? { previewId, operation: preview.operation, requestDigest: preview.request_digest, sessionId: preview.session_id });
    const existing = this.db.prepare("SELECT effect_id, preview_id, idempotency_key, status, binding_digest FROM effect_intents WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) {
      if (String(existing.binding_digest) !== bindingDigest) throw new GithubPrWriteError("GITHUB_WRITE_CONFLICT", "idempotency key is bound to different effect data");
      return { effectId: String(existing.effect_id), previewId: String(existing.preview_id), idempotencyKey: String(existing.idempotency_key), status: existing.status as EffectIntent["status"], bindingDigest: String(existing.binding_digest) };
    }
    const effectId = effectIdentityFor({ previewId, operation: preview.operation, requestDigest: preview.request_digest, sessionId: preview.session_id });
    this.transaction(() => {
      this.db.prepare("UPDATE previews SET status = 'claimed' WHERE preview_id = ? AND status = 'approved'").run(previewId);
      this.db.prepare("INSERT INTO effect_intents VALUES (?, ?, ?, ?, ?, ?, ?)").run(effectId, previewId, idempotencyKey, "pending", String(preview.request_digest), bindingDigest, this.now());
      this.audit("effect.intent", effectId, { previewId, operation: preview.operation, bindingDigest });
    });
    return { effectId, previewId, idempotencyKey, status: "pending", bindingDigest };
  }

  recordEffectOutcome(effectId: string, outcome: unknown): void {
    text(effectId, "effectId");
    const serialized = json(outcome);
    const outcomeDigest = digest(outcome);
    const operation = typeof outcome === "object" && outcome !== null && typeof (outcome as Record<string, unknown>).operation === "string"
      ? String((outcome as Record<string, unknown>).operation) : "unknown";
    const proofDigest = typeof outcome === "object" && outcome !== null && typeof (outcome as Record<string, unknown>).verificationProofDigest === "string"
      ? String((outcome as Record<string, unknown>).verificationProofDigest) : null;
    const existing = this.db.prepare("SELECT outcome_digest, proof_digest FROM effect_outcomes WHERE effect_id = ?").get(effectId);
    if (existing) {
      if (String(existing.outcome_digest) !== outcomeDigest || (existing.proof_digest ?? null) !== proofDigest) throw new GithubPrWriteError("GITHUB_WRITE_CONFLICT", "completed effect outcome is immutable");
      return;
    }
    const intent = this.db.prepare("SELECT status FROM effect_intents WHERE effect_id = ?").get(effectId);
    if (!intent || intent.status !== "pending") throw new GithubPrWriteError("GITHUB_WRITE_CONFLICT", "effect intent is not pending");
    this.transaction(() => {
      this.db.prepare("INSERT INTO effect_outcomes VALUES (?, ?, ?, ?, ?)").run(effectId, outcomeDigest, operation, proofDigest, this.now());
      this.db.prepare("UPDATE effect_intents SET status = 'completed' WHERE effect_id = ? AND status = 'pending'").run(effectId);
      this.db.prepare("DELETE FROM recovery_tasks WHERE effect_id = ?").run(effectId);
      this.audit("effect.outcome", effectId, { outcome: outcomeDigest, operation, bytes: Buffer.byteLength(serialized, "utf8") });
    });
  }

  markRecoveryRequired(effectId: string, reason: string, evidence?: unknown): void {
    text(effectId, "effectId"); text(reason, "reason");
    const evidenceDigest = evidence === undefined ? null : digest(evidence);
    this.transaction(() => {
      const updated = this.db.prepare("UPDATE effect_intents SET status = 'recovery_required' WHERE effect_id = ? AND status = 'pending'").run(effectId);
      if (updated.changes !== 1) throw new GithubPrWriteError("GITHUB_WRITE_CONFLICT", "effect intent is not pending");
      this.db.prepare("INSERT OR REPLACE INTO recovery_tasks VALUES (?, ?, ?, ?)").run(effectId, reason, evidenceDigest, this.now());
      this.audit("effect.recovery_required", effectId, { reason, evidenceDigest });
    });
  }

  outcomeDigest(effectId: string): string | undefined {
    text(effectId, "effectId");
    const row = this.db.prepare("SELECT outcome_digest FROM effect_outcomes WHERE effect_id = ?").get(effectId);
    return row ? String(row.outcome_digest) : undefined;
  }

  hasOutcomeDigest(value: string, operation = "apply_suggestions", proofDigest?: string, requestDigest?: string): boolean {
    if (
      !/^[0-9a-f]{64}$/iu.test(value)
      || (proofDigest !== undefined && !/^[0-9a-f]{64}$/iu.test(proofDigest))
      || (requestDigest !== undefined && !/^[0-9a-f]{64}$/iu.test(requestDigest))
    ) return false;
    const conditions = ["o.outcome_digest = ?", "o.operation = ?"];
    const args: unknown[] = [value, operation];
    if (proofDigest !== undefined) {
      conditions.push("o.proof_digest = ?");
      args.push(proofDigest);
    }
    if (requestDigest !== undefined) {
      conditions.push("i.request_digest = ?");
      args.push(requestDigest);
    }
    const row = this.db.prepare(
      `SELECT o.effect_id FROM effect_outcomes o JOIN effect_intents i ON i.effect_id = o.effect_id WHERE ${conditions.join(" AND ")} LIMIT 1`,
    ).get(...args);
    return Boolean(row);
  }
  assertEffectSession(effectId: string, sessionId: string): void {
    text(effectId, "effectId");
    text(sessionId, "sessionId");
    const row = this.db.prepare("SELECT p.session_id FROM effect_intents i JOIN previews p ON p.preview_id = i.preview_id WHERE i.effect_id = ?").get(effectId);
    if (!row || String(row.session_id) !== sessionId) throw new GithubPrWriteError("GITHUB_WRITE_SESSION_INVALID", "effect is not bound to this session");
  }

  assertRequestAuthorized(sessionId: string, previewId: string, approvalId: string, operation: WriteOperation, request: unknown, binding?: unknown): Preview {
    const session = this.assertSession(sessionId, binding);
    text(previewId, "previewId"); text(approvalId, "approvalId"); text(operation, "operation");
    const preview = this.db.prepare("SELECT session_id, operation, request_digest, issued_at, expires_at, status FROM previews WHERE preview_id = ?").get(previewId);
    if (!preview || String(preview.session_id) !== sessionId || String(preview.operation) !== operation || !["approved", "claimed"].includes(String(preview.status))) throw new GithubPrWriteError("GITHUB_WRITE_CONFLICT", "preview does not match the request");
    this.assertWindow(preview, WRITE_TTL_MS.preview);
    if (String(preview.request_digest) !== digest(request)) throw new GithubPrWriteError("GITHUB_WRITE_CONFLICT", "request does not match the preview");
    const approval = this.db.prepare("SELECT c.preview_id, a.issued_at, a.expires_at, a.status FROM approvals a JOIN challenges c ON c.challenge_id = a.challenge_id WHERE a.approval_id = ?").get(approvalId);
    if (!approval || String(approval.preview_id) !== previewId || approval.status !== "approved") throw new GithubPrWriteError("GITHUB_WRITE_APPROVAL_INVALID", "approval is invalid");
    this.assertWindow(approval, WRITE_TTL_MS.approval);
    return {
      previewId,
      sessionId,
      operation,
      requestDigest: String(preview.request_digest),
      issuedAt: Number(preview.issued_at),
      expiresAt: Number(preview.expires_at),
      status: String(preview.status) as Preview["status"],
    };
  }

  revokeCapability(capabilityId?: string): number {
    return this.transaction(() => {
      const current = this.generationValue();
      const next = current + 1;
      if (capabilityId !== undefined) {
        text(capabilityId, "capabilityId");
        this.db.prepare("UPDATE capabilities SET status = 'revoked' WHERE capability_id = ?").run(capabilityId);
      } else {
        this.db.prepare("UPDATE capabilities SET status = 'revoked' WHERE status = 'active'").run();
      }
      this.db.prepare("UPDATE sessions SET status = 'closed' WHERE status = 'active'").run();
      this.db.prepare("UPDATE previews SET status = 'revoked' WHERE status IN ('preview_issued', 'approval_pending', 'approved')").run();
      this.db.prepare("UPDATE authority_meta SET value = ? WHERE key = 'generation'").run(String(next));
      this.audit("capability.revoked", capabilityId ?? "all", { generationBefore: current, generationAfter: next });
      return next;
    });
  }

  setStage(stage: WriteStage): void {
    if (!WRITE_STAGES.includes(stage)) throw new GithubPrWriteError("GITHUB_WRITE_ROLLOUT_BLOCKED", "unknown rollout stage");
    const current = this.currentStage();
    if (current === stage) return;
    this.transaction(() => {
      const generationBefore = this.generationValue();
      const generationAfter = generationBefore + 1;
      this.db.prepare("UPDATE authority_meta SET value = ? WHERE key = 'stage'").run(stage);
      this.db.prepare("UPDATE capabilities SET status = 'revoked' WHERE status = 'active'").run();
      this.db.prepare("UPDATE sessions SET status = 'closed' WHERE status = 'active'").run();
      this.db.prepare("UPDATE previews SET status = 'revoked' WHERE status IN ('preview_issued', 'approval_pending', 'approved')").run();
      this.db.prepare("UPDATE authority_meta SET value = ? WHERE key = 'generation'").run(String(generationAfter));
      this.audit("rollout.stage_changed", stage, { previous: current, stage, generationBefore, generationAfter });
    });
  }

  assertRolloutStage(expected: WriteStage): void {
    if (this.currentStage() !== expected) throw new GithubPrWriteError("GITHUB_WRITE_ROLLOUT_BLOCKED", "rollout stage does not match authority");
  }

  recover(): { pendingEffectIds: string[]; recoveryRequiredEffectIds: string[] } {
    const pending = this.db.prepare("SELECT effect_id FROM effect_intents WHERE status = 'pending'").all().map((row) => String(row.effect_id));
    const recovery = this.db.prepare("SELECT effect_id FROM effect_intents WHERE status = 'recovery_required'").all().map((row) => String(row.effect_id));
    return { pendingEffectIds: pending, recoveryRequiredEffectIds: recovery };
  }

  auditEntries(): Array<{ event: string; subject: string; digest: string; createdAt: number }> {
    return this.db.prepare("SELECT event, subject, digest, created_at FROM audit ORDER BY created_at, audit_id").all().map((row) => ({ event: String(row.event), subject: String(row.subject), digest: String(row.digest), createdAt: Number(row.created_at) }));
  }

  close(): void { this.db.close(); }
}
