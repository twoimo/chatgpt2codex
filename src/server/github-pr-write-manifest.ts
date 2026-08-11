import { readFile, lstat } from "node:fs/promises";
import { createPublicKey, createVerify } from "node:crypto";
import { canonicalJson, digest, GITHUB_PR_WRITE_ACCOUNT, GITHUB_PR_WRITE_REPOSITORY, GITHUB_PR_WRITE_SCHEMA_VERSION, OPERATOR_KEY_PROFILE, OPERATOR_PROFILE_ID, WRITE_OPERATIONS, WRITE_TTL_MS, CLOCK_SKEW_MS, GithubPrWriteError } from "./github-pr-write-contract.js";

export const WRITE_DEPLOYMENT_MANIFEST_VERSION = 1 as const;
export const WRITE_DEPLOYMENT_MANIFEST = Object.freeze({
  manifestVersion: WRITE_DEPLOYMENT_MANIFEST_VERSION,
  releaseId: "github-pr-monitor-write-v5",
  protocolVersion: 5,
  schemaVersion: GITHUB_PR_WRITE_SCHEMA_VERSION,
  repository: GITHUB_PR_WRITE_REPOSITORY,
  account: GITHUB_PR_WRITE_ACCOUNT,
  repositoryNodeId: "R_kgDOAttestedRepository",
  authoritySchemaVersion: GITHUB_PR_WRITE_SCHEMA_VERSION,
  authorityDatabasePath: "github-pr-write.sqlite",
  authorityDatabaseMode: "0600",
  authorityJournalMode: "WAL",
  operatorProfile: OPERATOR_KEY_PROFILE,
  operatorProfileId: OPERATOR_PROFILE_ID,
  operatorProfileDigest: digest(OPERATOR_KEY_PROFILE),
  helperSocketName: "github-pr-write-helper.sock",
  allowedOperations: WRITE_OPERATIONS,
  allowedRolloutStages: ["off", "shadow", "prepare", "enabled"] as const,
  ttlMs: WRITE_TTL_MS,
  clockSkewMs: CLOCK_SKEW_MS,
  actorMatrixDigest: digest({ accountActor: "User", reviewerActor: "User", topology: "same_repository" }),
  hostSourceDigest: "",
  hostDistDigest: "",
  externalSourceDigest: "",
  externalEntrypointDigest: "",
  dependencyLockDigest: "",
  ociImageDigest: "",
  ociProfile: "monitor-verifier-v2",
  operatorPublicKeyDigest: "",
  operatorHelperDigest: "",
  operatorClientDigest: "",
});

export interface SignedWriteDeploymentManifest {
  manifestVersion: 1;
  releaseId: string;
  protocolVersion: 5;
  schemaVersion: 5;
  repository: typeof GITHUB_PR_WRITE_REPOSITORY;
  account: typeof GITHUB_PR_WRITE_ACCOUNT;
  repositoryNodeId: string;
  authoritySchemaVersion: typeof GITHUB_PR_WRITE_SCHEMA_VERSION;
  authorityDatabasePath: "github-pr-write.sqlite";
  authorityDatabaseMode: "0600";
  authorityJournalMode: "WAL";
  operatorProfile: typeof OPERATOR_KEY_PROFILE;
  operatorProfileId: typeof OPERATOR_PROFILE_ID;
  operatorProfileDigest: string;
  helperSocketName: "github-pr-write-helper.sock";
  allowedOperations: typeof WRITE_OPERATIONS;
  allowedRolloutStages: readonly ["off", "shadow", "prepare", "enabled"];
  ttlMs: typeof WRITE_TTL_MS;
  clockSkewMs: typeof CLOCK_SKEW_MS;
  actorMatrixDigest: string;
  hostSourceDigest: string;
  hostDistDigest: string;
  externalSourceDigest: string;
  externalEntrypointDigest: string;
  dependencyLockDigest: string;
  ociImageDigest: string;
  ociProfile: string;
  operatorPublicKeyDigest: string;
  operatorHelperDigest: string;
  operatorClientDigest: string;
  sourceRevision: string;
  signatureDerBase64: string;
  publicKeyDerBase64: string;
}

function unsigned(manifest: SignedWriteDeploymentManifest): Record<string, unknown> {
  const { signatureDerBase64: _signature, publicKeyDerBase64: _publicKey, ...value } = manifest;
  return value;
}

export function verifyWriteDeploymentManifest(manifest: SignedWriteDeploymentManifest): void {
  const expected = WRITE_DEPLOYMENT_MANIFEST;
  const valid =
    Boolean(manifest) &&
    manifest.manifestVersion === expected.manifestVersion &&
    manifest.protocolVersion === expected.protocolVersion &&
    manifest.schemaVersion === expected.schemaVersion &&
    manifest.repository === expected.repository &&
    manifest.account === expected.account &&
    typeof manifest.repositoryNodeId === "string" &&
    manifest.authoritySchemaVersion === expected.authoritySchemaVersion &&
    manifest.authorityDatabasePath === expected.authorityDatabasePath &&
    manifest.authorityDatabaseMode === expected.authorityDatabaseMode &&
    manifest.authorityJournalMode === expected.authorityJournalMode &&
    canonicalJson(manifest.operatorProfile) === canonicalJson(expected.operatorProfile) &&
    manifest.operatorProfileId === expected.operatorProfileId &&
    manifest.operatorProfileDigest === expected.operatorProfileDigest &&
    manifest.helperSocketName === expected.helperSocketName &&
    canonicalJson(manifest.allowedOperations) === canonicalJson(expected.allowedOperations) &&
    canonicalJson(manifest.allowedRolloutStages) === canonicalJson(expected.allowedRolloutStages) &&
    canonicalJson(manifest.ttlMs) === canonicalJson(expected.ttlMs) &&
    manifest.clockSkewMs === expected.clockSkewMs &&
    typeof manifest.actorMatrixDigest === "string" &&
    typeof manifest.hostSourceDigest === "string" &&
    typeof manifest.hostDistDigest === "string" &&
    typeof manifest.externalSourceDigest === "string" &&
    typeof manifest.externalEntrypointDigest === "string" &&
    typeof manifest.dependencyLockDigest === "string" &&
    typeof manifest.ociImageDigest === "string" &&
    typeof manifest.ociProfile === "string" &&
    typeof manifest.operatorPublicKeyDigest === "string" &&
    typeof manifest.operatorHelperDigest === "string" &&
    typeof manifest.operatorClientDigest === "string" &&
    typeof manifest.sourceRevision === "string" &&
    /^[0-9a-f]{40}$/iu.test(manifest.sourceRevision) &&
    typeof manifest.publicKeyDerBase64 === "string" &&
    manifest.publicKeyDerBase64.length > 0 &&
    manifest.publicKeyDerBase64.length <= 4096 &&
    typeof manifest.signatureDerBase64 === "string" &&
    manifest.signatureDerBase64.length > 0 &&
    manifest.signatureDerBase64.length <= 4096;
  if (!valid) throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION");
  try {
    const verifier = createVerify("sha256");
    verifier.update(canonicalJson(unsigned(manifest)), "utf8");
    verifier.end();
    const publicKey = createPublicKey({ key: Buffer.from(manifest.publicKeyDerBase64, "base64"), format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("manifest key profile");
    if (publicKey.asymmetricKeyType !== "ec" || !verifier.verify({ key: publicKey, dsaEncoding: "der" }, Buffer.from(manifest.signatureDerBase64, "base64"))) {
      throw new Error("signature");
    }
  } catch {
    throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION");
  }
}
export async function loadWriteDeploymentManifest(path?: string): Promise<SignedWriteDeploymentManifest> {
  const candidate = path ?? process.env.CHATGPT2CODEX_WRITE_MANIFEST;
  if (!candidate || candidate.length > 512 || candidate.includes("\0")) {
    throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION", "signed write manifest path is required");
  }
  const info = await lstat(candidate).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION", "signed write manifest is unavailable");
  }
  let manifest: SignedWriteDeploymentManifest;
  try {
    manifest = JSON.parse(await readFile(candidate, "utf8")) as SignedWriteDeploymentManifest;
  } catch {
    throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION", "signed write manifest is invalid");
  }
  verifyWriteDeploymentManifest(manifest);
  return manifest;
}

export function writeDeploymentManifestDigest(manifest: SignedWriteDeploymentManifest): string {
  return digest(unsigned(manifest));
}
