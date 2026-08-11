import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./github-pr-write-contract.js";
import { SECURE_ENCLAVE_OPERATOR_PROFILE, WRITE_HELPER_PROTOCOL, approvalPayloadDigest, requestLocalApproval } from "./github-pr-write-attestation.js";
import { startWriteApprovalHelper } from "./github-pr-write-helper.js";

function signer(challengeId: string) {
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

describe("local write approval helper", () => {
  it("round-trips only a verified physical-presence attestation", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "github-write-helper-"));
    const helper = await startWriteApprovalHelper(stateDir, async (challengeId) => signer(challengeId));
    await expect(requestLocalApproval(helper.socketPath, "challenge-1")).resolves.toMatchObject({ protocol: WRITE_HELPER_PROTOCOL, challengeId: "challenge-1", userPresence: true });
    await helper.close();
    await rm(stateDir, { recursive: true, force: true });
  });
});
