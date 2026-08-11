import { lstat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { WRITE_DEPLOYMENT_MANIFEST } from "./github-pr-write-manifest.js";

/** The only administrative argv vectors accepted by this client. */
export const GITHUB_PR_WRITE_ADMIN_VECTORS = Object.freeze([
  Object.freeze(["github-pr-write", "--enable"]),
  Object.freeze(["github-pr-write", "--revoke"]),
  Object.freeze(["github-pr-write", "--status"]),
  Object.freeze(["github-pr-write", "quarantine-v4"]),
] as const);

export const GITHUB_PR_WRITE_ADMIN_PROTOCOL = "admin_challenge_request" as const;
export const GITHUB_PR_WRITE_ADMIN_OPERATIONS = Object.freeze([
  "enable",
  "revoke",
  "status",
  "quarantine-v4",
] as const);
export type GithubPrWriteAdminOperation = (typeof GITHUB_PR_WRITE_ADMIN_OPERATIONS)[number];

/** Keep request and response frames bounded before writing or parsing them. */
export const MAX_ADMIN_FRAME_BYTES = 16 * 1024;
export const ADMIN_REQUEST_TIMEOUT_MS = 120_000;

const DEFAULT_STATE_DIR_PARTS = [".local", "share", "chatgpt2codex"] as const;
const SOCKET_MODE = 0o600;
const PRIVATE_DIRECTORY_BITS = 0o077;

export interface AdminChallengeRequest {
  readonly protocol: typeof GITHUB_PR_WRITE_ADMIN_PROTOCOL;
  readonly operation: GithubPrWriteAdminOperation;
  readonly literalArgv: readonly string[];
}

export interface OperatorClientIo {
  readonly stdin: { readonly isTTY?: boolean };
  readonly stdout: { readonly isTTY?: boolean };
}

export interface OperatorClientEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly io?: OperatorClientIo;
}

/** Resolve the canonical state directory without consulting override variables. */
export function defaultGithubPrWriteStateDir(): string {
  return path.join(os.homedir(), ...DEFAULT_STATE_DIR_PARTS);
}

/** Resolve the socket name from the deployment manifest, never from argv/env. */
export function defaultGithubPrWriteOperatorSocketPath(): string {
  return path.join(defaultGithubPrWriteStateDir(), WRITE_DEPLOYMENT_MANIFEST.helperSocketName);
}

function sameVector(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Map one exact argv vector to its fixed operation; no challenge IDs are accepted. */
export function githubPrWriteAdminOperation(argv: readonly string[]): GithubPrWriteAdminOperation | undefined {
  const index = GITHUB_PR_WRITE_ADMIN_VECTORS.findIndex((candidate) => sameVector(argv, candidate));
  return index < 0 ? undefined : GITHUB_PR_WRITE_ADMIN_OPERATIONS[index];
}

export function assertGithubPrWriteAdminArgv(argv: readonly string[]): GithubPrWriteAdminOperation {
  const operation = githubPrWriteAdminOperation(argv);
  if (!operation) {
    throw new Error(
      "usage: github-pr-write --enable|--revoke|--status|quarantine-v4",
    );
  }
  return operation;
}

/** Build only a non-authorizing request. The host creates the challenge. */
export function makeAdminChallengeRequest(argv: readonly string[]): AdminChallengeRequest {
  const operation = assertGithubPrWriteAdminArgv(argv);
  const request: AdminChallengeRequest = {
    protocol: GITHUB_PR_WRITE_ADMIN_PROTOCOL,
    operation,
    literalArgv: [...argv],
  };
  const bytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  if (bytes > MAX_ADMIN_FRAME_BYTES) throw new Error("github-pr-write admin request exceeds the bounded frame limit");
  return request;
}

export function assertOperatorEnvironment(environment: OperatorClientEnvironment = {}): void {
  const platform = environment.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("github-pr-write is available only on Darwin");
  const io = environment.io ?? process;
  if (io.stdin.isTTY !== true || io.stdout.isTTY !== true) {
    throw new Error("github-pr-write requires a local interactive TTY on stdin and stdout");
  }
}

async function assertFixedSocketIdentity(socketPath: string): Promise<void> {
  const fixedPath = defaultGithubPrWriteOperatorSocketPath();
  if (socketPath !== fixedPath) throw new Error("github-pr-write operator socket path is fixed");
  if (Buffer.byteLength(socketPath, "utf8") >= 104) throw new Error("github-pr-write operator socket path is invalid");

  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("github-pr-write cannot establish the local user identity");

  const state = await lstat(defaultGithubPrWriteStateDir());
  if (!state.isDirectory() || state.uid !== uid || (state.mode & PRIVATE_DIRECTORY_BITS) !== 0) {
    throw new Error("github-pr-write state directory identity is invalid");
  }
  const endpoint = await lstat(socketPath);
  if (!endpoint.isSocket() || endpoint.uid !== uid || (endpoint.mode & 0o777) !== SOCKET_MODE) {
    throw new Error("github-pr-write operator socket identity is invalid");
  }
}

function readOneFrame(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      socket.removeAllListeners("timeout");
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("github-pr-write operator request timed out"));
    }, timeoutMs);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      finish(new Error("github-pr-write operator request timed out"));
    });
    socket.on("data", (chunk: Buffer | string) => {
      data += chunk.toString();
      if (Buffer.byteLength(data, "utf8") > MAX_ADMIN_FRAME_BYTES) {
        socket.destroy();
        finish(new Error("github-pr-write operator response exceeds the bounded frame limit"));
        return;
      }
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      const frame = data.slice(0, newline).replace(/\r$/u, "");
      if (data.slice(newline + 1).length > 0) {
        socket.destroy();
        finish(new Error("github-pr-write operator returned more than one response frame"));
        return;
      }
      if (frame.length === 0) {
        finish(new Error("github-pr-write operator returned an empty response"));
      } else {
        finish(undefined, frame);
      }
    });
    socket.once("error", () => finish(new Error("github-pr-write operator socket failed")));
    socket.once("close", () => {
      if (!settled) finish(new Error("github-pr-write operator closed the connection without a response"));
    });
  });
}

async function requestOverFixedSocket(
  request: AdminChallengeRequest,
  socketPath: string,
  timeoutMs: number,
): Promise<unknown> {
  const encoded = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_ADMIN_FRAME_BYTES) {
    throw new Error("github-pr-write admin request exceeds the bounded frame limit");
  }
  const socket = connect(socketPath);
  try {
    const frame = readOneFrame(socket, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => {
        socket.write(encoded, "utf8", (error?: Error | null) => (error ? reject(error) : resolve()));
      });
      socket.once("error", reject);
    });
    const response = await frame;
    try {
      return JSON.parse(response) as unknown;
    } catch {
      throw new Error("github-pr-write operator returned invalid JSON");
    }
  } finally {
    socket.destroy();
  }
}

/**
 * Send one fixed, bounded request to the local operator endpoint. This client
 * It only validates the fixed argv vector and relays one bounded request.
 */
export async function requestGithubPrWriteAdmin(argv: readonly string[]): Promise<unknown> {
  assertOperatorEnvironment();
  const request = makeAdminChallengeRequest(argv);
  const socketPath = defaultGithubPrWriteOperatorSocketPath();
  await assertFixedSocketIdentity(socketPath);
  return await requestOverFixedSocket(request, socketPath, ADMIN_REQUEST_TIMEOUT_MS);
}

export function isAdminSuccess(response: unknown): boolean {
  return !!response && typeof response === "object" && !Array.isArray(response) && (response as { ok?: unknown }).ok === true;
}
