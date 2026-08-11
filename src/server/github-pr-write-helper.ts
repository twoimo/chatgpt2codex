import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { verifyOperatorApproval, WRITE_HELPER_PROTOCOL, WRITE_HELPER_SOCKET_NAME, type OperatorApprovalAttestation } from "./github-pr-write-attestation.js";
import { GithubPrWriteError } from "./github-pr-write-contract.js";

export type PresenceSigner = (challengeId: string) => Promise<OperatorApprovalAttestation>;
export interface WriteApprovalHelper {
  socketPath: string;
  close(): Promise<void>;
}
const MAX_FRAME_BYTES = 16 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function frame(socket: Socket, value: unknown): void {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION");
  socket.end(`${encoded}\n`);
}

/**
 * Host-local adapter for the status-bar/physical-gesture signer. The signer
 * must be supplied by the exact macOS Secure Enclave helper; no software
 * fallback is provided here.
 */
export async function startWriteApprovalHelper(stateDir: string, signer: PresenceSigner): Promise<WriteApprovalHelper> {
  if (process.platform !== "darwin" || typeof signer !== "function") throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const socketPath = path.join(stateDir, WRITE_HELPER_SOCKET_NAME);
  await unlink(socketPath).catch(() => undefined);
  const server: Server = createServer((socket) => handle(socket, signer));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await unlink(socketPath).catch(() => undefined);
    },
  };
}

function handle(socket: Socket, signer: PresenceSigner): void {
  let data = "";
  socket.setTimeout(15_000, () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    data += chunk.toString("utf8");
    if (Buffer.byteLength(data, "utf8") > MAX_FRAME_BYTES) { socket.destroy(); return; }
    const newline = data.indexOf("\n");
    if (newline < 0) return;
    void respond(socket, data.slice(0, newline), signer);
  });
}

async function respond(socket: Socket, raw: string, signer: PresenceSigner): Promise<void> {
  try {
    const request = JSON.parse(raw) as { protocol?: unknown; challengeId?: unknown };
    if (request.protocol !== WRITE_HELPER_PROTOCOL || typeof request.challengeId !== "string" || !SAFE_ID.test(request.challengeId)) throw new GithubPrWriteError("GITHUB_WRITE_ATTESTATION");
    const proof = await signer(request.challengeId);
    verifyOperatorApproval(proof, request.challengeId);
    frame(socket, proof);
  } catch {
    frame(socket, { protocol: WRITE_HELPER_PROTOCOL, error: "GITHUB_WRITE_ATTESTATION" });
  }
}
