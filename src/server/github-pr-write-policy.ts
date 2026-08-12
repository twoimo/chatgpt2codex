import { GITHUB_PR_WRITE_ACCOUNT, GITHUB_PR_WRITE_FORK_REPOSITORY, GITHUB_PR_WRITE_REPOSITORY, GithubPrWriteError, WriteOperation, WriteStage, digest, sha256 } from "./github-pr-write-contract.js";

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

export interface RepositoryTopology {
  baseRepository: string;
  headRepository: string;
}

const rank: Record<Permission, number> = { NONE: 0, READ: 1, TRIAGE: 2, WRITE: 3, MAINTAIN: 4, ADMIN: 5 };
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
export function unattendedWriteEnabled(): boolean {
  return process.env.CHATGPT2CODEX_UNATTENDED_WRITE === "1";
}
function unattendedRepository(value: string): boolean {
  return REPOSITORY_PATTERN.test(value) && !value.includes("..");
}
export function isSameRepository(e: GithubEvidence): boolean { return e.baseRepositoryId === e.headRepositoryId && e.baseRepositoryId === e.repositoryId; }
export function isOwnedFork(e: GithubEvidence, topology?: RepositoryTopology): boolean {
  return topology?.baseRepository === GITHUB_PR_WRITE_REPOSITORY
    && topology.headRepository === GITHUB_PR_WRITE_FORK_REPOSITORY
    && e.repositoryId === e.baseRepositoryId
    && e.headRepositoryId !== e.baseRepositoryId;
}
export function canWriteCode(e: GithubEvidence, topology?: RepositoryTopology): boolean {
  return e.account.login === GITHUB_PR_WRITE_ACCOUNT
    && e.author.login === GITHUB_PR_WRITE_ACCOUNT
    && e.account.actorType === "User"
    && e.author.actorType === "User"
    && (isSameRepository(e) || isOwnedFork(e, topology))
    && rank[e.permission] >= rank.WRITE
    && e.canPush;
}
export function canWriteCodeUnattended(e: GithubEvidence, topology?: RepositoryTopology): boolean {
  if (!unattendedWriteEnabled() || !topology || !unattendedRepository(topology.baseRepository) || !unattendedRepository(topology.headRepository)) return false;
  const headOwner = topology.headRepository.split("/", 1)[0];
  return e.account.login === GITHUB_PR_WRITE_ACCOUNT
    && e.author.login === GITHUB_PR_WRITE_ACCOUNT
    && e.account.actorType === "User"
    && e.author.actorType === "User"
    && e.canPush
    && rank[e.permission] >= rank.WRITE
    && (topology.baseRepository === topology.headRepository || headOwner?.toLowerCase() === GITHUB_PR_WRITE_ACCOUNT.toLowerCase());
}
export function assertOperationAllowed(operation: WriteOperation, e: GithubEvidence, stage: WriteStage, topology?: RepositoryTopology): void {
  if (stage === "off" || (stage === "prepare" && operation !== "apply_suggestions")) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "operation is disabled at rollout stage");
  const reviewOperation = ["post_comment", "post_reply", "resolve_thread", "rerequest_reviewer", "approve", "merge"].includes(operation);
  if (stage !== "shadow" && !reviewOperation && !canWriteCode(e, topology) && !canWriteCodeUnattended(e, topology)) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "code writes require an authored User PR on the approved repository topology with push permission");
  if (e.account.actorType !== "User") throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "the authenticated account must be a User");
  if (!reviewOperation && e.author.actorType !== "User") throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "code writes require a User-authored PR");
  if (!Number.isSafeInteger(e.repositoryId) || !Number.isSafeInteger(e.baseRepositoryId) || !Number.isSafeInteger(e.headRepositoryId)) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "immutable repository IDs are required");
}

/** Detects GitHub/network mutation intent before a generic command is spawned. */
export function isGithubMutationIntent(argvOrCommand: string | readonly string[]): boolean {
  const text = (typeof argvOrCommand === "string" ? argvOrCommand : Array.from(argvOrCommand).join(" ")).toLowerCase();
  return /(^|[\s;&|])(?:gh|hub)(?:[\s;&|]|$)/.test(text)
    || /\b(?:env|command|xargs|exec|sudo)\s+(?:gh|hub)\b/.test(text)
    || /git\s+(?:push|commit|update-ref|send-pack|receive-pack|fetch|pull|clone)\b/.test(text)
    || /(?:graphql|api\.github\.com|github\.com)[^\n]*(?:mutation|post|put|patch|delete|push)/.test(text)
    || /(?:npm|pnpm|yarn|bun|make|just|task)\b[^\n]*(?:gh|hub|git\s+(?:push|commit)|github)/.test(text)
    || /(?:sh|bash|zsh|fish|python|node|ruby|perl)\b[^\n]*(?:-c|eval|exec)[^\n]*(?:gh|hub|git\s+(?:push|commit)|github)/.test(text)
    || /(?:base64|printf|echo)[^\n]*(?:gh|hub|github|git\s+(?:push|commit))[^\n]*(?:\||-d|decode|sh|bash)/.test(text);
}

export function assertSafeBody(body: string): void {
  if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES) throw new GithubPrWriteError("GITHUB_WRITE_PREVIEW_LIMIT", "comment exceeds UTF-8 byte limit");
  if (/\0|\r|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body)) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "control characters are not allowed");
  if (body.split("\n").some(line => line.startsWith(AUTO_MARKER_PREFIX))) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "reserved marker prefix");
}
export function renderComment(body: string, effectIdentity: string): { body: string; bytes: number; contentDigest: string } {
  assertSafeBody(body);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(effectIdentity)) {
    throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "invalid effect identity");
  }
  const rendered = `${body}\n${AUTO_MARKER_PREFIX}${effectIdentity} -->`;
  const bytes = Buffer.byteLength(rendered, "utf8");
  if (bytes > MAX_COMMENT_BYTES) throw new GithubPrWriteError("GITHUB_WRITE_PREVIEW_LIMIT", "rendered comment exceeds UTF-8 byte limit");
  return { body: rendered, bytes, contentDigest: sha256(rendered) };
}
export function operationDigest(operation: WriteOperation, target: unknown): string { return digest({ operation, target }); }
