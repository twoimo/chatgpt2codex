import { createHash, createPublicKey, createVerify, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import {
  canonicalJson,
  digest,
  GITHUB_PR_WRITE_ACCOUNT,
  OPERATOR_KEY_PROFILE,
  WRITE_OPERATIONS,
} from "./github-pr-write-contract.js";
import { OPERATOR_KEY_ID } from "./github-pr-write-attestation.js";
import {
  assertGithubPrWriteAdminArgv,
  defaultGithubPrWriteStateDir,
  defaultGithubPrWriteOperatorSocketPath,
  type GithubPrWriteAdminOperation,
} from "./github-pr-write-operator-client.js";
import {
  loadWriteDeploymentManifest,
  writeDeploymentManifestDigest,
  WRITE_DEPLOYMENT_MANIFEST,
  type SignedWriteDeploymentManifest,
} from "./github-pr-write-manifest.js";
import { GithubPrWriteAuthority } from "./github-pr-write-authority.js";

const MAX_FRAME_BYTES = 16 * 1024;
const SOCKET_MODE = 0o600;
const PRIVATE_DIRECTORY_BITS = 0o077;
const HELPER_PROTOCOL = "github-pr-write-helper-v1" as const;
const ADMIN_TIMEOUT_MS = 120_000;
const PROFILE_JSON = canonicalJson(OPERATOR_KEY_PROFILE);
const ADMIN_KEYS = [
  "protocolVersion", "operation", "literalArgv", "manifestDigest", "generationBefore",
  "challengeId", "challengeNonce", "operatorKeyProfile", "operatorKeyId",
  "operatorPublicKeyDigest", "operatorHelperDigest",
] as const;

type AdminRequest = {
  readonly protocol: "admin_challenge_request";
  readonly operation: GithubPrWriteAdminOperation;
  readonly literalArgv: readonly string[];
};

type SignedAdminEnvelope = Record<string, unknown> & {
  protocolVersion: 1;
  operation: GithubPrWriteAdminOperation;
  literalArgv: readonly string[];
  manifestDigest: string;
  generationBefore: number;
  challengeId: string;
  challengeNonce: string;
  operatorKeyProfile: typeof OPERATOR_KEY_PROFILE;
  operatorKeyId: typeof OPERATOR_KEY_ID;
  operatorPublicKeyDigest: string;
  operatorHelperDigest: string;
  signature: string;
  signerRole: "operator-helper";
};

interface PublicKeyMaterial {
  readonly der: Buffer;
  readonly digest: string;
  readonly key: ReturnType<typeof createPublicKey>;
}

export interface GithubPrWriteAdminHostOptions {
  readonly stateDir: string;
  readonly helperSocketPath: string;
  readonly helperBinaryPath: string;
}

export interface GithubPrWriteAdminHost {
  readonly socketPath: string;
  close(): Promise<void>;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidRequest(): Record<string, unknown> {
  return { protocol: HELPER_PROTOCOL, ok: false, error: "invalid_request" };
}

function frame(socket: Socket, value: unknown): void {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) {
    socket.destroy();
    return;
  }
  socket.end(`${encoded}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function parseAdminRequest(raw: string): AdminRequest {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "literalArgv,operation,protocol") {
    throw new Error("invalid request keys");
  }
  if (value.protocol !== "admin_challenge_request" || typeof value.operation !== "string" || !Array.isArray(value.literalArgv)) {
    throw new Error("invalid request shape");
  }
  const literalArgv = value.literalArgv.filter((entry): entry is string => typeof entry === "string");
  if (literalArgv.length !== value.literalArgv.length) throw new Error("invalid argv");
  const operation = assertGithubPrWriteAdminArgv(literalArgv);
  if (operation !== value.operation) throw new Error("operation does not match argv");
  return { protocol: "admin_challenge_request", operation, literalArgv };
}

function receiveFrame(socket: Socket, timeoutMs = ADMIN_TIMEOUT_MS): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("operator helper timeout")), timeoutMs);
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? {});
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("operator helper timeout")));
    socket.on("data", (chunk: Buffer | string) => {
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data, "utf8") > MAX_FRAME_BYTES) {
        finish(new Error("operator helper frame too large"));
        return;
      }
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      if (data.slice(newline + 1).length > 0) {
        finish(new Error("operator helper returned multiple frames"));
        return;
      }
      const frameText = data.slice(0, newline).replace(/\r$/u, "");
      if (!frameText) {
        finish(new Error("operator helper returned an empty frame"));
        return;
      }
      try {
        const parsed = JSON.parse(frameText) as unknown;
        if (!isRecord(parsed)) throw new Error("response is not an object");
        finish(undefined, parsed);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("invalid helper response"));
      }
    });
    socket.once("error", () => finish(new Error("operator helper socket failed")));
    socket.once("close", () => {
      if (!settled) finish(new Error("operator helper closed without a response"));
    });
  });
}

async function requestHelper(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const encoded = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) throw new Error("operator helper request too large");
  const socket = connect(socketPath);
  const response = receiveFrame(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => socket.write(encoded, "utf8", (error?: Error | null) => error ? reject(error) : resolve()));
    socket.once("error", reject);
  });
  return response;
}

function challengePayload(challengeId: string): Buffer {
  return Buffer.from(`{"challengeId":${JSON.stringify(challengeId)},"profile":${PROFILE_JSON}}`, "utf8");
}

function publicKeyMaterial(response: Record<string, unknown>, challengeId?: string): PublicKeyMaterial {
  if (response.protocol !== HELPER_PROTOCOL || response.ok !== true) throw new Error("helper public key proof was not approved");
  if (!sameValue(response.profile, OPERATOR_KEY_PROFILE)) throw new Error("helper profile mismatch");
  if (typeof response.publicKeyDerBase64 !== "string") throw new Error("helper public key proof missing");
  const der = Buffer.from(response.publicKeyDerBase64, "base64");
  if (der.length > 4096) throw new Error("helper public key is out of bounds");
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("helper key profile mismatch");
  if (response.operation !== "public-key") {
    if (response.userPresence !== true || typeof challengeId !== "string" || typeof response.signatureDerBase64 !== "string") {
      throw new Error("helper public key proof missing");
    }
    const signature = Buffer.from(response.signatureDerBase64, "base64");
    if (signature.length === 0 || signature.length > 256) throw new Error("helper key proof is out of bounds");
    const verifier = createVerify("sha256");
    verifier.update(challengePayload(challengeId));
    verifier.end();
    if (!verifier.verify({ key, dsaEncoding: "der" }, signature)) throw new Error("helper challenge signature is invalid");
  } else if (response.userPresence !== false) {
    throw new Error("helper public-key response is invalid");
  }
  const publicDigest = sha256(der);
  if (response.operatorPublicKeyDigest !== publicDigest) throw new Error("helper public key digest mismatch");
  return { der, digest: publicDigest, key };
}

function verifyAdminEnvelope(
  value: Record<string, unknown>,
  unsigned: Record<string, unknown>,
  material: PublicKeyMaterial,
): SignedAdminEnvelope {
  const expectedKeys = [...ADMIN_KEYS, "signature", "signerRole"].sort().join(",");
  if (Object.keys(value).sort().join(",") !== expectedKeys) throw new Error("helper envelope keys are not exact");
  for (const key of ADMIN_KEYS) if (!sameValue(value[key], unsigned[key])) throw new Error(`helper envelope field mismatch: ${key}`);
  if (value.signerRole !== "operator-helper" || typeof value.signature !== "string") throw new Error("helper signer is invalid");
  const signature = Buffer.from(value.signature, "base64");
  if (signature.length === 0 || signature.length > 256) throw new Error("helper signature is out of bounds");
  const verifier = createVerify("sha256");
  verifier.update(Buffer.from(canonicalJson(unsigned), "utf8"));
  verifier.end();
  if (!verifier.verify({ key: material.key, dsaEncoding: "der" }, signature)) throw new Error("helper envelope signature is invalid");
  return value as SignedAdminEnvelope;
}

async function helperDigest(helperBinaryPath: string): Promise<string> {
  const info = await lstat(helperBinaryPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("operator helper binary identity is invalid");
  return sha256(await readFile(helperBinaryPath));
}

async function loadManifest(): Promise<SignedWriteDeploymentManifest | undefined> {
  const configured = process.env.CHATGPT2CODEX_WRITE_MANIFEST;
  if (!configured) {
    if (process.env.CHATGPT2CODEX_REQUIRE_WRITE_ATTESTATION === "1") throw new Error("signed write manifest is required");
    return undefined;
  }
  return loadWriteDeploymentManifest(configured);
}

async function safeSocketPath(socketPath: string, stateDir: string): Promise<void> {
  const parent = await lstat(stateDir);
  const uid = process.getuid?.();
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & PRIVATE_DIRECTORY_BITS) !== 0 || (uid !== undefined && parent.uid !== uid)) {
    throw new Error("operator host state directory identity is invalid");
  }
  const endpoint = await lstat(socketPath).catch(() => undefined);
  if (!endpoint) return;
  if (!endpoint.isSocket() || endpoint.isSymbolicLink() || (endpoint.mode & 0o777) !== SOCKET_MODE || (uid !== undefined && endpoint.uid !== uid)) {
    throw new Error("operator host socket identity is invalid");
  }
  await unlink(socketPath);
}

async function assertHelperSocketIdentity(socketPath: string, stateDir: string): Promise<void> {
  const expectedPath = path.join(stateDir, ".operator-helper", WRITE_DEPLOYMENT_MANIFEST.helperSocketName);
  if (socketPath !== expectedPath) throw new Error("operator helper socket path is fixed");
  const helperDirectory = path.dirname(socketPath);
  const directory = await lstat(helperDirectory);
  const uid = process.getuid?.();
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & PRIVATE_DIRECTORY_BITS) !== 0 || (uid !== undefined && directory.uid !== uid)) {
    throw new Error("operator helper directory identity is invalid");
  }
  const endpoint = await lstat(socketPath);
  if (!endpoint.isSocket() || endpoint.isSymbolicLink() || (endpoint.mode & 0o777) !== SOCKET_MODE || (uid !== undefined && endpoint.uid !== uid)) {
    throw new Error("operator helper socket identity is invalid");
  }
}

async function quarantineV4(stateDir: string, manifestDigest: string): Promise<{ alreadyAbsent: boolean; quarantined: string[] }> {
  const names = ["github-pr-write-v4.sqlite", "github-pr-write-v4.sqlite-wal", "github-pr-write-v4.sqlite-shm"];
  const destinationRoot = path.join(stateDir, `quarantine-v4-${manifestDigest.slice(0, 16)}`);
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  await chmod(destinationRoot, 0o700);
  const quarantined: string[] = [];
  for (const name of names) {
    const source = path.join(stateDir, name);
    const info = await lstat(source).catch(() => undefined);
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("legacy v4 state topology is invalid");
    const target = path.join(destinationRoot, `${name}.${sha256(await readFile(source)).slice(0, 16)}`);
    if (await lstat(target).catch(() => undefined)) throw new Error("legacy v4 quarantine destination already exists");
    await rename(source, target);
    quarantined.push(target);
  }
  return { alreadyAbsent: quarantined.length === 0, quarantined };
}


async function discoverKey(socketPath: string): Promise<PublicKeyMaterial> {
  const response = await requestHelper(socketPath, { protocol: HELPER_PROTOCOL, operation: "public-key" });
  return publicKeyMaterial(response);
}

async function processAdmin(
  raw: string,
  authority: GithubPrWriteAuthority,
  options: GithubPrWriteAdminHostOptions,
  cachedKey: { value?: PublicKeyMaterial },
): Promise<Record<string, unknown>> {
  const request = parseAdminRequest(raw);
  const manifest = await loadManifest();
  const actualHelperDigest = await helperDigest(options.helperBinaryPath);
  if (manifest && manifest.operatorHelperDigest !== actualHelperDigest) throw new Error("operator helper digest does not match manifest");
  const manifestDigest = manifest ? writeDeploymentManifestDigest(manifest) : digest(WRITE_DEPLOYMENT_MANIFEST);
  await assertHelperSocketIdentity(options.helperSocketPath, options.stateDir);
  const material = cachedKey.value ?? await discoverKey(options.helperSocketPath);
  cachedKey.value = material;
  if (manifest && manifest.operatorPublicKeyDigest !== material.digest) throw new Error("operator public key digest does not match manifest");
  if (manifest && manifest.operatorProfileDigest !== digest(OPERATOR_KEY_PROFILE)) throw new Error("operator profile digest does not match manifest");
  const generationBefore = authority.currentGeneration();
  const challengeId = `admin-${randomUUID()}`;
  const challengeNonce = randomUUID();
  const unsigned: Record<string, unknown> = {
    protocolVersion: 1,
    operation: request.operation,
    literalArgv: [...request.literalArgv],
    manifestDigest,
    generationBefore,
    challengeId,
    challengeNonce,
    operatorKeyProfile: OPERATOR_KEY_PROFILE,
    operatorKeyId: OPERATOR_KEY_ID,
    operatorPublicKeyDigest: material.digest,
    operatorHelperDigest: actualHelperDigest,
  };
  const signed = verifyAdminEnvelope(await requestHelper(options.helperSocketPath, unsigned), unsigned, material);
  if (authority.currentGeneration() !== generationBefore) throw new Error("admin generation changed during signing");
  let result: Record<string, unknown>;
  if (request.operation === "status") {
    result = { generation: authority.currentGeneration(), stage: authority.currentStage(), recovery: authority.recover() };
  } else if (request.operation === "enable") {
    if (authority.currentStage() === "enabled") authority.revokeCapability();
    else authority.setStage("enabled");
    const capability = authority.issueCapability(
      GITHUB_PR_WRITE_ACCOUNT,
      authority.currentGeneration(),
      WRITE_OPERATIONS,
      digest(OPERATOR_KEY_PROFILE),
      actualHelperDigest,
      material.digest,
    );
    result = { generation: capability.generation, stage: authority.currentStage(), capabilityId: capability.capabilityId, scopeDigest: capability.scopeDigest };
  } else if (request.operation === "revoke") {
    result = { generation: authority.revokeCapability(), stage: authority.currentStage() };
  } else {
    const quarantine = await quarantineV4(authority.stateDir, manifestDigest);
    result = { ...quarantine, generation: authority.revokeCapability(), stage: authority.currentStage() };
  }
  return { ok: true, ...signed, result };
}

function handleSocket(socket: Socket, handler: (raw: string) => Promise<Record<string, unknown>>): void {
  let data = "";
  let responded = false;
  socket.setTimeout(ADMIN_TIMEOUT_MS, () => socket.destroy());
  socket.on("data", (chunk: Buffer | string) => {
    if (responded) return;
    data += chunk.toString("utf8");
    if (Buffer.byteLength(data, "utf8") > MAX_FRAME_BYTES) {
      responded = true;
      frame(socket, invalidRequest());
      return;
    }
    const newline = data.indexOf("\n");
    if (newline < 0) return;
    responded = true;
    const raw = data.slice(0, newline).replace(/\r$/u, "");
    void handler(raw).then((value) => frame(socket, value)).catch(() => frame(socket, invalidRequest()));
  });
}

export async function startGithubPrWriteAdminHost(options: GithubPrWriteAdminHostOptions): Promise<GithubPrWriteAdminHost> {
  if (process.platform !== "darwin") throw new Error("github-pr-write admin host requires Darwin");
  if (options.stateDir !== defaultGithubPrWriteStateDir()) {
    throw new Error("github-pr-write admin host state directory is fixed");
  }
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await chmod(options.stateDir, 0o700);
  const socketPath = defaultGithubPrWriteOperatorSocketPath();
  await safeSocketPath(socketPath, options.stateDir);
  const authority = await GithubPrWriteAuthority.open(options.stateDir);
  const cachedKey: { value?: PublicKeyMaterial } = {};
  let queue = Promise.resolve();
  const server: Server = createServer((socket) => handleSocket(socket, (raw) => {
    const run = queue.then(() => processAdmin(raw, authority, options, cachedKey));
    queue = run.then(() => undefined, () => undefined);
    return run;
  }));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    await chmod(socketPath, SOCKET_MODE);
    return {
      socketPath,
      async close() {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        authority.close();
        await unlink(socketPath).catch(() => undefined);
      },
    };
  } catch (error) {
    authority.close();
    throw error;
  }
}
