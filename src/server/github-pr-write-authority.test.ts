import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { GithubPrWriteAuthority } from "./github-pr-write-authority.js";
import { SECURE_ENCLAVE_OPERATOR_PROFILE, WRITE_HELPER_PROTOCOL, approvalPayloadDigest } from "./github-pr-write-attestation.js";
import { canonicalJson, GithubPrWriteError, AuthorityClock, WRITE_TTL_MS } from "./github-pr-write-contract.js";

const dir = () => mkdtempSync(join(tmpdir(), "gjc-write-authority-"));
const sqlite = () => (createRequire(import.meta.url)(`node:${"sqlite"}`) as { DatabaseSync: new (p: string) => { exec(s: string): void; close(): void } }).DatabaseSync;
function proof(challengeId: string) {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const payload = canonicalJson({ challengeId, profile: SECURE_ENCLAVE_OPERATOR_PROFILE });
  const signature = sign("sha256", Buffer.from(payload, "utf8"), { key: pair.privateKey, dsaEncoding: "der" });
  return {
    protocol: WRITE_HELPER_PROTOCOL,
    challengeId,
    helperUid: process.getuid?.() ?? -1,
    userPresence: true as const,
    profile: SECURE_ENCLAVE_OPERATOR_PROFILE,
    payloadDigest: approvalPayloadDigest(challengeId),
    publicKeyDerBase64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    signatureDerBase64: signature.toString("base64"),
  };
}

describe("GithubPrWriteAuthority v5", () => {
  it("persists the complete authority lifecycle and idempotent effects", async () => {
    const authority = await GithubPrWriteAuthority.open(dir());
    const capability = authority.issueCapability("operator", 3);
    const session = authority.openSession(capability.capabilityId, 3);
    const preview = authority.createPreview(session.sessionId, "post_comment", { body: "hello" });
    const challenge = authority.createChallenge(preview.previewId);
    authority.approve(challenge.challengeId, proof(challenge.challengeId));
    const first = authority.recordEffectIntent(preview.previewId, "request-1");
    const second = authority.recordEffectIntent(preview.previewId, "request-1");
    expect(second.effectId).toBe(first.effectId);
    const outcome = { operation: "apply_suggestions", status: "ok" };
    authority.recordEffectOutcome(first.effectId, outcome);
    const outcomeDigest = authority.outcomeDigest(first.effectId);
    expect(outcomeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(authority.hasOutcomeDigest(outcomeDigest!)).toBe(true);
    expect(authority.recover().pendingEffectIds).toEqual([]);
    expect(authority.auditEntries().every((entry) => !entry.subject.includes("operator"))).toBe(true);
    authority.close();
  });

  it("refuses legacy v4 without migration or replay", async () => {
    const stateDir = dir(); const DatabaseSync = sqlite();
    const db = new DatabaseSync(join(stateDir, "github-pr-write.sqlite")); db.exec("PRAGMA user_version = 4"); db.close();
    await expect(GithubPrWriteAuthority.open(stateDir)).rejects.toMatchObject({ code: "GITHUB_WRITE_LEGACY_STATE" });
  });

  it("treats expiry at exactly now as expired", () => {
    let now = 1000;
    const clock = new AuthorityClock(() => now, () => now);
    expect(clock.isExpired(now)).toBe(true);
    expect(clock.isExpired(now + WRITE_TTL_MS.capability)).toBe(false);
    now += WRITE_TTL_MS.capability;
    expect(clock.isExpired(now)).toBe(true);
  });

  it("rejects bounded and unsafe identifiers", async () => {
    const authority = await GithubPrWriteAuthority.open(dir());
    expect(() => authority.issueCapability("bad\nvalue")).toThrowError(GithubPrWriteError);
    expect(() => authority.issueCapability("x".repeat(129))).toThrowError(GithubPrWriteError);
    authority.close();
  });
});
