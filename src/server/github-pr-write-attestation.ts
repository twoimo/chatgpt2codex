import { createHash, createPublicKey, createVerify } from "node:crypto";
import { connect } from "node:net";
import { OPERATOR_KEY_PROFILE, OPERATOR_PROFILE_ID, GithubPrWriteError, canonicalJson } from "./github-pr-write-contract.js";
import type { Approval, GithubPrWriteAuthority } from "./github-pr-write-authority.js";

export const WRITE_HELPER_PROTOCOL = "github-pr-write-helper-v1" as const;
export const WRITE_HELPER_SOCKET_NAME = "github-pr-write-helper.sock" as const;
export const SECURE_ENCLAVE_OPERATOR_PROFILE = OPERATOR_KEY_PROFILE;
export const OPERATOR_KEY_ID = "app.ezbuilder.chatgpt2codex.operator.p256" as const;

export interface OperatorApprovalAttestation {
  protocol: typeof WRITE_HELPER_PROTOCOL;
  challengeId: string;
  helperUid: number;
  userPresence: true;
  profile: typeof SECURE_ENCLAVE_OPERATOR_PROFILE;
  payloadDigest: string;
  publicKeyDerBase64: string;
  signatureDerBase64: string;
  challengeNonce?: string;
  previewDigest?: string;
  sessionBindingDigest?: string;
  operatorProfileId?: string;
  operatorKeyId?: string;
  operatorKeyProfileDigest?: string;
  operatorPublicKeyDigest?: string;
  operatorHelperDigest?: string;
}

const MAX_FRAME_BYTES = 16 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;
export function secureEnclaveProfileDigest(): string {
  return createHash("sha256").update(canonicalJson(SECURE_ENCLAVE_OPERATOR_PROFILE), "utf8").digest("hex");
}

function payloadFor(challengeId: string, profile: typeof SECURE_ENCLAVE_OPERATOR_PROFILE): string {
  return canonicalJson({ challengeId, profile });
}

export function approvalPayloadDigest(challengeId: string): string {
  return createHash("sha256").update(payloadFor(challengeId, SECURE_ENCLAVE_OPERATOR_PROFILE), "utf8").digest("hex");
}

export function verifyOperatorApproval(attestation: OperatorApprovalAttestation, challengeId: string, expectedUid = process.getuid?.() ?? -1): void {
  if (
    process.platform !== "darwin" ||
    !attestation ||
    typeof attestation !== "object" ||
    !SAFE_ID.test(challengeId) ||
    attestation.protocol !== WRITE_HELPER_PROTOCOL ||
    attestation.challengeId !== challengeId ||
    attestation.userPresence !== true ||
    attestation.helperUid !== expectedUid ||
    !Number.isSafeInteger(attestation.helperUid)
  ) throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION");
  if (
    typeof attestation.publicKeyDerBase64 !== "string" ||
    attestation.publicKeyDerBase64.length === 0 ||
    attestation.publicKeyDerBase64.length > 4096 ||
    typeof attestation.signatureDerBase64 !== "string" ||
    attestation.signatureDerBase64.length === 0 ||
    attestation.signatureDerBase64.length > 4096 ||
    (attestation.challengeNonce !== undefined && !SAFE_ID.test(attestation.challengeNonce)) ||
    (attestation.operatorProfileId !== undefined && attestation.operatorProfileId !== OPERATOR_PROFILE_ID) ||
    (attestation.operatorKeyId !== undefined && attestation.operatorKeyId !== OPERATOR_KEY_ID) ||
    (attestation.previewDigest !== undefined && !HEX_DIGEST.test(attestation.previewDigest)) ||
    (attestation.sessionBindingDigest !== undefined && !HEX_DIGEST.test(attestation.sessionBindingDigest)) ||
    (attestation.operatorKeyProfileDigest !== undefined && !HEX_DIGEST.test(attestation.operatorKeyProfileDigest)) ||
    (attestation.operatorPublicKeyDigest !== undefined && !HEX_DIGEST.test(attestation.operatorPublicKeyDigest)) ||
    (attestation.operatorHelperDigest !== undefined && !HEX_DIGEST.test(attestation.operatorHelperDigest))
  ) throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION");
  if (canonicalJson(attestation.profile) !== canonicalJson(SECURE_ENCLAVE_OPERATOR_PROFILE) || attestation.payloadDigest !== approvalPayloadDigest(challengeId) || !HEX_DIGEST.test(attestation.payloadDigest)) throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION");
  if (attestation.operatorKeyProfileDigest !== undefined && attestation.operatorKeyProfileDigest !== secureEnclaveProfileDigest()) throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION");
  let publicKey: ReturnType<typeof createPublicKey>;
  let signature: Buffer;
  try {
    publicKey = createPublicKey({ key: Buffer.from(attestation.publicKeyDerBase64, "base64"), format: "der", type: "spki" });
    signature = Buffer.from(attestation.signatureDerBase64, "base64");
    if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("operator key profile");
    if (attestation.operatorPublicKeyDigest !== undefined && attestation.operatorPublicKeyDigest !== createHash("sha256").update(Buffer.from(attestation.publicKeyDerBase64, "base64")).digest("hex")) throw new Error("operator key digest");
  } catch {
    throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION");
  }
  const verifier = createVerify("sha256");
  verifier.update(payloadFor(challengeId, SECURE_ENCLAVE_OPERATOR_PROFILE), "utf8");
  verifier.end();
  if (!verifier.verify({ key: publicKey, dsaEncoding: "der" }, signature)) throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION");
}

export async function requestLocalApproval(socketPath: string, challengeId: string, timeoutMs = 15_000): Promise<OperatorApprovalAttestation> {
  if (process.platform !== "darwin" || !SAFE_ID.test(challengeId) || socketPath.length === 0 || socketPath.length > 256) throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION");
  const frame = `${JSON.stringify({ protocol: WRITE_HELPER_PROTOCOL, challengeId })}\n`;
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new GithubPrWriteError("GITHUB_WRITE_ATTESTATION")); }, timeoutMs);
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data, "utf8") > MAX_FRAME_BYTES) { clearTimeout(timer); socket.destroy(); reject(new GithubPrWriteError("GITHUB_WRITE_ATTESTATION")); return; }
      const newline = data.indexOf("\n");
      if (newline >= 0) { clearTimeout(timer); socket.end(); resolve(data.slice(0, newline)); }
    });
    socket.on("error", () => { clearTimeout(timer); reject(new GithubPrWriteError("GITHUB_WRITE_ATTESTATION")); });
    socket.on("close", () => { if (!data) { clearTimeout(timer); reject(new GithubPrWriteError("GITHUB_WRITE_ATTESTATION")); } });
  });
  let attestation: OperatorApprovalAttestation;
  try { attestation = JSON.parse(response) as OperatorApprovalAttestation; } catch { throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION"); }
  verifyOperatorApproval(attestation, challengeId);
  return attestation;
}

export async function approveWithLocalPresence(authority: GithubPrWriteAuthority, stateDir: string, challengeId: string): Promise<Approval> {
  const socketPath = `${stateDir}/${WRITE_HELPER_SOCKET_NAME}`;
  const attestation = await requestLocalApproval(socketPath, challengeId);
  return authority.approve(challengeId, attestation);
}
