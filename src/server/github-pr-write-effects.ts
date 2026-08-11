import { createHash } from "node:crypto";
import { GithubPrWriteError } from "./github-pr-write-contract.js";
import { AUTO_MARKER_PREFIX, MAX_COMMENT_BYTES, assertSafeBody } from "./github-pr-write-policy.js";

export interface GhResult { stdout: string; stderr?: string; exitCode?: number; timedOut?: boolean; }
export type GhCommand = (argv: readonly string[], timeoutMs: number) => Promise<GhResult>;

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
  | { operation: "request_reviewer"; reviewer: string };

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
  if (result.timedOut || result.exitCode !== 0) fail(`${label} remote result is ambiguous`);
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT) fail(`${label} output exceeds limit`);
  return result.stdout.trim();
};
const parse = <T>(result: GhResult, label: string): T => { try { return JSON.parse(json(result, label)) as T; } catch { return fail(`${label} returned invalid evidence`); } };

/** Executes only fixed GitHub review mutations. The command implementation must not invoke a shell. */
export class GithubPrWriteEffects {
  constructor(private readonly gh: GhCommand, private readonly timeoutMs = TIMEOUT_MS) {}

  private async run(argv: readonly string[], label: string): Promise<GhResult> {
    if (argv.some((part) => part.includes("\0") || part.includes("\r") || part.includes("\n"))) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "invalid gh argument");
    return this.gh(argv, this.timeoutMs).catch(() => fail(`${label} command failed`));
  }

  private validateContext(context: RemoteReviewContext): void {
    if (!REPO.test(context.repository) || !Number.isSafeInteger(context.prNumber) || context.prNumber < 1 || !SHA.test(context.expectedHead) || !LOGIN.test(context.actor) || !LOGIN.test(context.author))
      throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "invalid review target");
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
    const names = [repo?.nameWithOwner, headRepo?.nameWithOwner, baseRepo?.nameWithOwner].filter((x): x is string => typeof x === "string");
    if (view.state !== "OPEN" || view.headRefOid !== context.expectedHead || author?.login !== context.author || names.some((name) => name !== context.repository)) fail("pull request evidence is stale or mismatched");
  }

  async execute(context: RemoteReviewContext, effect: ReviewEffect): Promise<EffectReceipt> {
    this.validateContext(context);
    if (effect.operation !== "request_reviewer") {
      assertSafeBody(effect.body);
      const marker = `${AUTO_MARKER_PREFIX}${effect.effectIdentity} -->`;
      if (!LOGIN.test(effect.effectIdentity) && effect.effectIdentity.length > 128) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "invalid effect identity");
      if (Buffer.byteLength(`${effect.body}\n${marker}`, "utf8") > MAX_COMMENT_BYTES) throw new GithubPrWriteError("GITHUB_WRITE_PREVIEW_LIMIT", "comment marker exceeds UTF-8 byte limit");
    }
    if (effect.operation === "request_reviewer" && !LOGIN.test(effect.reviewer)) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "invalid reviewer");
    const renderedBody = effect.operation === "request_reviewer" ? undefined : `${effect.body}\n${AUTO_MARKER_PREFIX}${effect.effectIdentity} -->`;
    if (effect.operation !== "post_comment" && effect.operation !== "request_reviewer" && (!effect.threadId || !effect.replyReceiptId)) throw new GithubPrWriteError("GITHUB_WRITE_INVALID_INPUT", "thread provenance is required");
    await this.evidence(context);
    let argv: string[];
    if (effect.operation === "post_comment") argv = ["api", `repos/${context.repository}/issues/${context.prNumber}/comments`, "--hostname", "github.com", "--method", "POST", "-f", `body=${renderedBody}`];
    else if (effect.operation === "post_reply") argv = ["api", "graphql", "--hostname", "github.com", "-f", `threadId=${effect.threadId}`, "-f", `body=${renderedBody}`, "-f", "query=mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id body}}}"];
    else if (effect.operation === "resolve_thread") argv = ["api", "graphql", "--hostname", "github.com", "-f", `threadId=${effect.threadId}`, "-f", "query=mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}"];
    else argv = ["api", `repos/${context.repository}/pulls/${context.prNumber}/requested_reviewers`, "--hostname", "github.com", "--method", "POST", "-f", `reviewers[]=${effect.reviewer}`];
    const result = await this.run(argv, effect.operation);
    json(result, effect.operation);
    return { operation: effect.operation, status: "completed", effectDigest: digest({ context: { repository: context.repository, prNumber: context.prNumber, expectedHead: context.expectedHead }, effect }) };
  }
}
