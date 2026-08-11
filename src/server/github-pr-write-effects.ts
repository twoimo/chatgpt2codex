import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GITHUB_PR_WRITE_ACCOUNT, GITHUB_PR_WRITE_REPOSITORY, GithubPrWriteError } from "./github-pr-write-contract.js";
import { AUTO_MARKER_PREFIX, MAX_COMMENT_BYTES, assertSafeBody } from "./github-pr-write-policy.js";

export interface GhResult { stdout: string; stderr?: string; exitCode?: number; timedOut?: boolean; }
export type GhCommand = (argv: readonly string[], timeoutMs: number) => Promise<GhResult>;
const execFileAsync = promisify(execFile);
export const defaultGhCommand: GhCommand = async (argv, timeoutMs) => {
  try {
    const result = await execFileAsync("gh", [...argv], {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return {
      stdout: typeof value.stdout === "string" ? value.stdout : "",
      stderr: typeof value.stderr === "string" ? value.stderr : "",
      exitCode: typeof value.code === "number" ? value.code : 1,
      timedOut: value.killed === true,
    };
  }
};

export interface RemoteReviewContext {
  repository: string;
  prNumber: number;
  expectedHead: string;
  actor: string;
  actorType?: string;
  author: string;
  baseRepository?: string;
  headRepository?: string;
}
export type ReviewEffect =
  | { operation: "post_comment"; body: string; effectIdentity: string }
  | { operation: "post_reply"; body: string; effectIdentity: string; threadId: string; replyReceiptId: string }
  | { operation: "resolve_thread"; threadId: string; replyReceiptId: string }
  | { operation: "rerequest_reviewer"; reviewer: string };

export interface EffectReceipt {
  operation: ReviewEffect["operation"];
  status: "completed" | "recovery_required";
  effectDigest: string;
  remoteId?: string;
}

const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 15_000;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA = /^[0-9a-f]{40}$/iu;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message: string, details?: Record<string, unknown>): never => { throw new GithubPrWriteError("GITHUB_WRITE_RECOVERY_REQUIRED", message, details); };
const json = (result: GhResult, label: string): string => {
  if (typeof result.stdout !== "string" || result.timedOut || result.exitCode !== 0) fail(`${label} remote result is ambiguous`);
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT) fail(`${label} output exceeds limit`);
  return result.stdout.trim();
};
const parse = <T>(result: GhResult, label: string): T => { try { return JSON.parse(json(result, label)) as T; } catch { return fail(`${label} returned invalid evidence`); } };
function assertRemoteSuccess(operation: ReviewEffect["operation"], parsed: Record<string, unknown>, reviewer?: string): void {
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) fail(`${operation} remote result is ambiguous`);
  if (operation === "post_comment" && (typeof parsed.id !== "number" && typeof parsed.id !== "string")) fail("post_comment remote result is ambiguous");
  if (operation === "post_reply") {
    const data = parsed.data as Record<string, unknown> | undefined;
    const payload = data?.addPullRequestReviewThreadReply as Record<string, unknown> | undefined;
    const comment = payload?.comment as Record<string, unknown> | undefined;
    if (typeof comment?.id !== "string") fail("post_reply remote result is ambiguous");
  }
  if (operation === "resolve_thread") {
    const data = parsed.data as Record<string, unknown> | undefined;
    const payload = data?.resolveReviewThread as Record<string, unknown> | undefined;
    const thread = payload?.thread as Record<string, unknown> | undefined;
    if (thread?.isResolved !== true) fail("resolve_thread remote result is ambiguous");
  }
  if (operation === "rerequest_reviewer") {
    const users = parsed.users;
    const teams = parsed.teams;
    if (!Array.isArray(users) || (teams !== undefined && (!Array.isArray(teams) || teams.length > 0)) || typeof reviewer !== "string" || !users.some((user) => user && typeof user === "object" && (user as Record<string, unknown>).login === reviewer)) fail("rerequest_reviewer remote result is ambiguous");
  }
}

/** Executes only fixed GitHub review mutations. The command implementation must not invoke a shell. */
export class GithubPrWriteEffects {
  constructor(private readonly gh: GhCommand, private readonly timeoutMs = TIMEOUT_MS) {}

  private async run(argv: readonly string[], label: string): Promise<GhResult> {
    if (argv.some((part) => part.includes("\0"))) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "invalid gh argument");
    return this.gh(argv, this.timeoutMs).catch(() => fail(`${label} command failed`));
  }

  private validateContext(context: RemoteReviewContext): void {
    if (context.repository !== GITHUB_PR_WRITE_REPOSITORY || context.actor !== GITHUB_PR_WRITE_ACCOUNT || !REPO.test(context.repository) || !Number.isSafeInteger(context.prNumber) || context.prNumber < 1 || !SHA.test(context.expectedHead) || !LOGIN.test(context.actor) || !LOGIN.test(context.author))
      throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "review target is outside the approved repository/account");
    if (context.actorType && context.actorType !== "User") throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "review effects require a User actor");
  }

  private async evidence(context: RemoteReviewContext): Promise<void> {
    const user = json(await this.run(["api", "user", "--hostname", "github.com", "--jq", ".login"], "authenticated user"), "authenticated user");
    if (user !== context.actor) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "authenticated account does not match actor");
    const view = parse<Record<string, unknown>>(await this.run(["pr", "view", String(context.prNumber), "--repo", context.repository, "--hostname", "github.com", "--json", "state,author,headRefOid,baseRepository,headRepository,repository"], "pull request evidence"), "pull request evidence");
    const author = view.author as Record<string, unknown> | undefined;
    const repo = view.repository as Record<string, unknown> | undefined;
    const headRepo = view.headRepository as Record<string, unknown> | undefined;
    const baseRepo = view.baseRepository as Record<string, unknown> | undefined;
    const baseName = typeof context.baseRepository === "string" ? context.baseRepository : context.repository;
    const headName = typeof context.headRepository === "string" ? context.headRepository : context.repository;
    if (view.state !== "OPEN" || String(view.headRefOid).toLowerCase() !== context.expectedHead.toLowerCase() || author?.login !== context.author || repo?.nameWithOwner !== context.repository || baseRepo?.nameWithOwner !== baseName || headRepo?.nameWithOwner !== headName) fail("pull request evidence is stale or mismatched");
  }
  private async reconcileComment(
    context: RemoteReviewContext,
    effect: Extract<ReviewEffect, { operation: "post_comment" | "post_reply" }>,
    renderedBody: string,
  ): Promise<EffectReceipt> {
    const result = await this.run(
      ["api", `repos/${context.repository}/issues/${context.prNumber}/comments`, "--hostname", "github.com", "--paginate", "--jq", "."],
      "comment read-back",
    );
    const raw = json(result, "comment read-back");
    let comments: unknown;
    try {
      comments = JSON.parse(raw);
    } catch {
      fail("comment read-back returned invalid evidence");
    }
    const values: unknown[] = Array.isArray(comments)
      ? comments
      : comments && typeof comments === "object" && Array.isArray((comments as Record<string, unknown>).comments)
        ? ((comments as Record<string, unknown>).comments as unknown[])
        : [];
    const matches = values.filter((value): value is Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      const user = record.user as Record<string, unknown> | undefined;
      return record.body === renderedBody && user?.login === context.actor;
    });
    if (matches.length !== 1) fail("comment marker read-back is ambiguous");
    const remoteValue = matches[0]?.id;
    if (typeof remoteValue !== "string" && typeof remoteValue !== "number") fail("comment marker read-back is missing an id");
    return {
      operation: effect.operation,
      status: "completed",
      remoteId: digest(String(remoteValue)),
      effectDigest: digest({
        context: { repository: context.repository, prNumber: context.prNumber, expectedHead: context.expectedHead },
        effect,
        recovery: "marker-read-back",
        outputDigest: digest(raw),
      }),
    };
  }

  async execute(context: RemoteReviewContext, effect: ReviewEffect): Promise<EffectReceipt> {
    this.validateContext(context);
    if (effect.operation === "rerequest_reviewer" && context.author !== context.actor) throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "reviewer re-request requires an authored PR");
    if (effect.operation === "post_comment" || effect.operation === "post_reply") {
      assertSafeBody(effect.body);
      const marker = `${AUTO_MARKER_PREFIX}${effect.effectIdentity} -->`;
      if (effect.effectIdentity.length === 0 || effect.effectIdentity.length > 128 || /[\0\r\n]/u.test(effect.effectIdentity)) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "invalid effect identity");
      if (Buffer.byteLength(`${effect.body}\n${marker}`, "utf8") > MAX_COMMENT_BYTES) throw new GithubPrWriteError("GITHUB_WRITE_PREVIEW_LIMIT", "comment marker exceeds UTF-8 byte limit");
    }
    if (effect.operation === "rerequest_reviewer" && !LOGIN.test(effect.reviewer)) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "invalid reviewer");
    let renderedBody: string | undefined;
    if (effect.operation === "post_comment" || effect.operation === "post_reply") renderedBody = `${effect.body}\n${AUTO_MARKER_PREFIX}${effect.effectIdentity} -->`;
    if (effect.operation !== "post_comment" && effect.operation !== "rerequest_reviewer" && (!effect.threadId || !effect.replyReceiptId)) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "thread provenance is required");
    await this.evidence(context);
    if (effect.operation === "rerequest_reviewer") {
      const reviewerType = json(await this.run(["api", `users/${effect.reviewer}`, "--hostname", "github.com", "--jq", ".type"], "reviewer evidence"), "reviewer evidence");
      if (reviewerType !== "User") throw new GithubPrWriteError("GITHUB_WRITE_MUTATION_DENIED", "requested reviewer must be a direct User");
    }
    let argv: string[];
    if (effect.operation === "post_comment") argv = ["api", `repos/${context.repository}/issues/${context.prNumber}/comments`, "--hostname", "github.com", "--method", "POST", "-f", `body=${renderedBody}`];
    else if (effect.operation === "post_reply") argv = ["api", "graphql", "--hostname", "github.com", "-f", `threadId=${effect.threadId}`, "-f", `body=${renderedBody}`, "-f", "query=mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id body}}}"];
    else if (effect.operation === "resolve_thread") argv = ["api", "graphql", "--hostname", "github.com", "-f", `threadId=${effect.threadId}`, "-f", "query=mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}"];
    else argv = ["api", `repos/${context.repository}/pulls/${context.prNumber}/requested_reviewers`, "--hostname", "github.com", "--method", "POST", "-f", `reviewers[]=${effect.reviewer}`];
    const result = await this.run(argv, effect.operation);
    if (effect.operation === "post_comment" || effect.operation === "post_reply") {
      if (result.timedOut === true || result.exitCode !== 0) return this.reconcileComment(context, effect, renderedBody!);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = parse<Record<string, unknown>>(result, effect.operation);
      assertRemoteSuccess(effect.operation, parsed, effect.operation === "rerequest_reviewer" ? effect.reviewer : undefined);
    } catch (error) {
      if (effect.operation === "post_comment" || effect.operation === "post_reply") return this.reconcileComment(context, effect, renderedBody!);
      throw error;
    }
    const remoteValue = parsed.id ?? (((parsed.data as Record<string, unknown> | undefined)?.addPullRequestReviewThreadReply as Record<string, unknown> | undefined)?.comment as Record<string, unknown> | undefined)?.id;
    const remoteId = typeof remoteValue === "string" || typeof remoteValue === "number" ? digest(String(remoteValue)) : undefined;
    return { operation: effect.operation, status: "completed", ...(remoteId ? { remoteId } : {}), effectDigest: digest({ context: { repository: context.repository, prNumber: context.prNumber, expectedHead: context.expectedHead }, effect, outputDigest: digest(result.stdout) }) };
  }
}
