import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./github-pr-write-contract.js";
import { WRITE_DEPLOYMENT_MANIFEST, verifyWriteDeploymentManifest, type SignedWriteDeploymentManifest } from "./github-pr-write-manifest.js";

describe("write deployment manifest", () => {
  it("accepts an exact signed manifest and rejects drift", () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const unsigned = { ...WRITE_DEPLOYMENT_MANIFEST, sourceRevision: "0123456789abcdef0123456789abcdef01234567" } as SignedWriteDeploymentManifest;
    const payload = canonicalJson(unsigned);
    const signature = sign("sha256", Buffer.from(payload, "utf8"), { key: pair.privateKey, dsaEncoding: "der" });
    const manifest = { ...unsigned, publicKeyDerBase64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"), signatureDerBase64: signature.toString("base64") };
    expect(() => verifyWriteDeploymentManifest(manifest)).not.toThrow();
    expect(() => verifyWriteDeploymentManifest({ ...manifest, repository: "evil/repo" } as never)).toThrow();
  });
});
