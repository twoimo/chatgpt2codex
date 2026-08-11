import { GithubPrWriteError, WriteOperation, WriteStage, digest, sha256 } from "./github-pr-write-contract";

export const MAX_COMMENT_BYTES = 6_000;
export const AUTO_MARKER_PREFIX = "<!-- gjc:auto-response:v2:";
export type ActorType = "User" | "Bot" | "Team" | "App" | "Unknown";
export type Permission = "NONE" | "READ" | "TRIAGE" | "WRITE" | "MAINTAIN" | "ADMIN";

export interface GithubEvidence {
  account: { login: string; id: number; nodeId: string; actorType: ActorType };
  author: { login: string; id: number; nodeId: string; actorType: ActorType };
  baseRepositoryId: number; headRepositoryId: number; repositoryId: number;
  permission: Permission; canPush: boolean; expectedHead: string;
}

const rank: Record<Permission, number> = { NONE: 0, READ: 1, TRIAGE: 2, WRITE: 3, MAINTAIN: 4, ADMIN: 5 };
export function isSameRepository(e: GithubEvidence): boolean { return e.baseRepositoryId === e.headRepositoryId && e.baseRepositoryId === e.repositoryId; }
export function canWriteCode(e: GithubEvidence): boolean {
  return e.account.actorType === "User" && e.author.actorType === "User" && isSameRepository(e) && rank[e.permission] >= rank.WRITE && e.canPush;
}
export function assertOperationAllowed(operation: WriteOperation, e: GithubEvidence, stage: WriteStage): void {
  if (stage === "off" || (stage === "shadow" && ["commit", "push"].includes(operation))) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "operation is disabled at rollout stage");
  if (!["post_comment", "post_reply", "resolve_thread", "request_reviewer"].includes(operation) && !canWriteCode(e)) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "code writes require authored same-repository User PR and push permission");
  if (e.account.actorType !== "User" || e.author.actorType !== "User") throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "bot, team, and app actors are not eligible");
  if (!Number.isSafeInteger(e.repositoryId) || !Number.isSafeInteger(e.baseRepositoryId) || !Number.isSafeInteger(e.headRepositoryId)) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "immutable repository IDs are required");
}

/** Detects GitHub/network mutation intent before a generic command is spawned. */
export function isGithubMutationIntent(argvOrCommand: string | readonly string[]): boolean {
  const text = (Array.isArray(argvOrCommand) ? argvOrCommand.join(" ") : argvOrCommand).toLowerCase();
  return /(^|[\s;&|])(?:gh|hub)(?:[\s;&|]|$)/.test(text)
    || /git\s+(?:push|commit|update-ref|send-pack|receive-pack|fetch|pull|clone)\b/.test(text)
    || /(?:graphql|api\.github\.com|github\.com)[^\n]*(?:mutation|post|put|patch|delete|push)/.test(text)
    || /(?:npm|make|just|task)\b[^\n]*(?:gh|git\s+(?:push|commit)|github)/.test(text);
}

export function assertSafeBody(body: string): void {
  if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES) throw new GithubPrWriteError("GITHUB_WRITE_PREVIEW_LIMIT", "comment exceeds UTF-8 byte limit");
  if (/\0|\r|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body)) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "control characters are not allowed");
  if (body.split("\n").some(line => line.startsWith(AUTO_MARKER_PREFIX))) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "reserved marker prefix");
}
export function renderComment(body: string, effectIdentity: string): { body: string; bytes: number; contentDigest: string } {
  assertSafeBody(body);
  const rendered = `${body}\n${AUTO_MARKER_PREFIX}${effectIdentity} -->`;
  return { body: rendered, bytes: Buffer.byteLength(rendered, "utf8"), contentDigest: sha256(rendered) };
}
export function operationDigest(operation: WriteOperation, target: unknown): string { return digest({ operation, target }); }
