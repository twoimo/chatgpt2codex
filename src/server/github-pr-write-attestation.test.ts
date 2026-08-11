import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SECURE_ENCLAVE_OPERATOR_PROFILE, WRITE_HELPER_PROTOCOL, approvalPayloadDigest, verifyOperatorApproval } from "./github-pr-write-attestation.js";
import { canonicalJson } from "./github-pr-write-contract.js";

function attestation(challengeId: string) {
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

describe("github write operator attestation", () => {
  it("verifies the exact Secure Enclave profile and DER signature", () => {
    const proof = attestation("challenge-1");
    expect(() => verifyOperatorApproval(proof, "challenge-1")).not.toThrow();
    expect(proof.profile).toMatchObject({ curve: "P-256", secureEnclave: true, accessibility: "WhenUnlockedThisDeviceOnly", signatureEncoding: "DER" });
  });
  it("rejects a different challenge, uid, or profile", () => {
    const proof = attestation("challenge-1");
    expect(() => verifyOperatorApproval(proof, "challenge-2")).toThrow();
    expect(() => verifyOperatorApproval({ ...proof, helperUid: 999999 }, "challenge-1")).toThrow();
    expect(() => verifyOperatorApproval({ ...proof, profile: { ...proof.profile, curve: "P-384" } }, "challenge-1")).toThrow();
  });
});
