import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});
import {
  COMMENTS_QUERY,
  GITHUB_PR_VIEW_FIELDS,
  LATEST_REVIEWS_QUERY,
  MAX_FEEDBACK,
  MAX_SEARCH_ISSUES,
  REVIEW_REQUESTS_QUERY,
  REVIEW_THREADS_QUERY,
  REVIEWS_QUERY,
  SEARCH_QUERY,
  THREAD_COMMENTS_QUERY,
  type GithubPrMonitorReadResult,
} from "./github-pr-monitor-contract.js";
import { runGithubPrMonitorRead, defaultGhCommand, COMMAND_CLEANUP_GRACE_MS, type GhCommand, type GhCommandResult } from "./github-pr-monitor-read.js";

const INPUT = { runId: "run-test", actionPlanId: "plan-test" };
const NOW = new Date("2026-08-10T00:00:00.000Z");

type FakeOptions = {
  singleCandidate?: boolean;
  childPageOverflow?: boolean;
  badReviewerType?: boolean;
  authFailure?: boolean;
  discoveryLimit?: boolean;
  mixedCaseUrl?: boolean;
  aggregateThreadOverflow?: boolean;
};
type FakeGh = { gh: GhCommand; calls: string[][] };

function stdout(value: unknown, code = 0, stderr = ""): GhCommandResult {
  return { stdout: typeof value === "string" ? value : JSON.stringify(value), stderr, code };
}
function graph(data: unknown): GhCommandResult {
  return stdout({ data });
}
function arg(args: string[], key: string): string | undefined {
  return args.find((value) => value.startsWith(`${key}=`))?.slice(key.length + 1);
}
function connection(nodes: unknown[], hasNextPage = false, endCursor: string | null = null): Record<string, unknown> {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}
function candidate(number: number): { id: string; name: string; author: Record<string, unknown>; head: Record<string, string> } {
  if (number === 1) {
    return {
      id: "repo-1",
      name: "acme/repo",
      author: { login: "alice", __typename: "User", name: "Alice", email: "PRIVATE_AUTHOR_EMAIL" },
      head: { id: "head-1", name: "Fork", nameWithOwner: "acme/Fork" },
    };
  }
  return {
    id: "repo-2",
    name: "acme/other",
    author: { login: "otherauthor", __typename: "Bot", name: "PRIVATE_BOT_NAME" },
    head: { id: "head-2", name: "OtherFork", nameWithOwner: "acme/OtherFork" },
  };
}
function reviewerNodes(number: number, options: FakeOptions): unknown[] {
  if (number === 1) {
    return [
      { requestedReviewer: { __typename: "User", login: "ALICE" } },
      { requestedReviewer: { __typename: "User", login: "alice" } },
      { requestedReviewer: { __typename: "Bot", login: "review-bot" } },
      { requestedReviewer: { __typename: "EnterpriseTeam", login: "team" } },
      { requestedReviewer: { __typename: "Mannequin", login: "mannequin" } },
      { requestedReviewer: { __typename: "Team", login: "team" } },
      ...(options.badReviewerType ? [{ requestedReviewer: { __typename: "Organization", login: "not-a-user-reviewer" } }] : []),
    ];
  }
  return [
    { requestedReviewer: { __typename: "User", login: "Alice" } },
    { requestedReviewer: { __typename: "Bot", login: "ignored-bot" } },
  ];
}
function feedbackNodes(number: number, kind: "reviews" | "comments" | "latestReviews"): unknown[] {
  if (number !== 1) return [];
  if (kind === "reviews") {
    return [
      { id: "review-2", body: "z review <!-- review-marker --> SECRET_REVIEW_BODY", author: { login: "org", __typename: "Organization" }, authorAssociation: "MEMBER", state: "approved" },
      { id: "review-1", body: "a review", author: { login: "review-bot", __typename: "Bot" }, authorAssociation: "COLLABORATOR", state: "commented" },
    ];
  }
  if (kind === "latestReviews") {
    return [{ id: "review-1", body: "a review", author: { login: "review-bot", __typename: "Bot" }, authorAssociation: "COLLABORATOR", state: "commented" }];
  }
  return [{ id: "comment-1", body: "PRIVATE_COMMENT_BODY", author: null, authorAssociation: "NONE" }];
}
function makeFakeGh(options: FakeOptions = {}): FakeGh {
  const calls: string[][] = [];
  const childPages = new Map<string, number>();
  const gh: GhCommand = async (args) => {
    calls.push([...args]);
    if (args[0] === "api" && args[1] === "user") {
      return options.authFailure ? stdout("", 1, "PRIVATE_GITHUB_TOKEN") : stdout("alice\n");
    }
    if (args[0] === "pr" && args[1] === "view") {
      const number = Number(args[2]);
      const item = candidate(number);
      return stdout({
        number,
        url: options.mixedCaseUrl ? `https://github.com/AcMe/RePo/pull/${number}` : `https://github.com/${item.name}/pull/${number}`,
        state: "OPEN",
        author: { login: item.author.login },
        baseRefName: "main",
        headRefName: number === 1 ? "feature/private" : "bot-fix",
        baseRefOid: "A".repeat(40),
        headRefOid: "B".repeat(40),
        headRepository: { ...item.head, privateMetadata: "PRIVATE_HEAD_METADATA" },
        statusCheckRollup: number === 1
          ? [{ status: "SUCCESS", conclusion: "success" }, { status: "PENDING", conclusion: null }]
          : [],
        body: "PRIVATE_PULL_REQUEST_BODY",
        mergeable: "MERGEABLE",
      });
    }
    if (args[0] !== "api" || args[1] !== "graphql") throw new Error(`unexpected authority command: ${args.join(" ")}`);
    const query = arg(args, "query");
    if (query === SEARCH_QUERY) {
      const q = arg(args, "q");
      if (options.discoveryLimit) return graph({ search: { issueCount: MAX_SEARCH_ISSUES + 1, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
      const authored = q === "is:pr is:open author:alice";
      const nodes = authored || options.singleCandidate
        ? [{ __typename: "PullRequest", number: 1, repository: { id: "repo-1", nameWithOwner: authored ? "Acme/Repo" : "acme/REPO" } }]
        : [
          { __typename: "PullRequest", number: 1, repository: { id: "repo-1", nameWithOwner: "acme/REPO" } },
          { __typename: "PullRequest", number: 2, repository: { id: "repo-2", nameWithOwner: "Acme/Other" } },
        ];
      return graph({ search: { issueCount: nodes.length, nodes, pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    const number = Number(arg(args, "number"));
    const item = candidate(number);
    const repository = { id: item.id, nameWithOwner: item.name };
    const author = item.author;
    if (query === REVIEW_REQUESTS_QUERY) {
      return graph({ repository: { ...repository, pullRequest: { author, reviewRequests: connection(reviewerNodes(number, options)) } } });
    }
    if (query === REVIEWS_QUERY || query === COMMENTS_QUERY || query === LATEST_REVIEWS_QUERY) {
      const kind = query === REVIEWS_QUERY ? "reviews" : query === COMMENTS_QUERY ? "comments" : "latestReviews";
      return graph({ repository: { ...repository, pullRequest: { author, [kind]: connection(feedbackNodes(number, kind)) } } });
    }
    if (query === REVIEW_THREADS_QUERY) {
      const nodes = options.aggregateThreadOverflow
        ? [
          { id: "thread-aggregate-1", isResolved: false, isOutdated: false },
          { id: "thread-aggregate-2", isResolved: false, isOutdated: false },
        ]
        : number === 1 ? [{ id: "thread-1", isResolved: false, isOutdated: false }] : [];
      return graph({ repository: { ...repository, pullRequest: { reviewThreads: connection(nodes) } } });
    }
    if (query === THREAD_COMMENTS_QUERY) {
      const threadId = arg(args, "threadId")!;
      const page = (childPages.get(threadId) ?? 0) + 1;
      childPages.set(threadId, page);
      let nodes: unknown[];
      let hasNextPage: boolean;
      if (options.aggregateThreadOverflow && threadId === "thread-aggregate-1") {
        nodes = Array.from({ length: 100 }, (_, index) => ({
          id: `aggregate-thread-comment-${(page - 1) * 100 + index}`,
          body: `aggregate thread comment ${page}-${index}`,
          author: { login: "alice", __typename: "User" },
        }));
        hasNextPage = page < MAX_FEEDBACK / 100;
      } else if (options.aggregateThreadOverflow && threadId === "thread-aggregate-2") {
        nodes = page === 1
          ? [
            { id: "aggregate-overflow-valid", body: "aggregate overflow valid", author: { login: "alice", __typename: "User" } },
            { id: "aggregate-overflow-invalid", body: 42, author: { login: "alice", __typename: "User" } },
          ]
          : [];
        hasNextPage = false;
      } else {
        nodes = page === 1
          ? [
            { id: "thread-comment-b", body: "b thread comment", author: { login: "alice", __typename: "User" }, path: "src/file.ts", line: 2, startLine: 1, outdated: false, commit: { oid: "C".repeat(40) } },
            { id: "thread-comment-a", body: "a thread comment", author: { login: "review-bot", __typename: "Bot" }, path: "src/file.ts", line: 1, outdated: true },
          ]
          : page === 2
            ? [{ id: "thread-comment-c", body: "c thread comment", author: { login: "org", __typename: "Organization" } }]
            : [];
        hasNextPage = options.childPageOverflow ? page <= 5 : page === 1;
      }
      const endCursor = hasNextPage ? `child-${page}` : null;
      return graph({ node: { __typename: "PullRequestReviewThread", id: threadId, isResolved: false, isOutdated: false, comments: connection(nodes, hasNextPage, endCursor) } });
    }
    throw new Error(`unexpected GraphQL query: ${query}`);
  };
  return { gh, calls };
}

async function successful(fake: FakeGh, options: { nonce?: string } = {}): Promise<GithubPrMonitorReadResult> {
  const result = await runGithubPrMonitorRead(INPUT, {
    gh: fake.gh,
    now: () => NOW,
    nonce: () => options.nonce ?? "fixed-nonce",
    deadlineMs: 2_000,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("github PR monitor read", () => {
  it("performs only the exact read queries and flags through an injected GhCommand", async () => {
    const fake = makeFakeGh({ singleCandidate: true });
    const result = await successful(fake);
    expect(result.discovery).toEqual({
      authored: { issueCount: 1, fetchedCount: 1, pageCount: 1, complete: true },
      requestedReviewer: { issueCount: 1, fetchedCount: 1, pageCount: 1, complete: true },
      uniqueCandidateCount: 1,
      snapshotAttemptCount: 1,
      snapshotCount: 1,
      races: { prClosed: 0, authoredRoleLost: 0, reviewerRequestLost: 0 },
      complete: true,
    });

    expect(fake.calls[0]).toEqual(["api", "user", "--jq", ".login"]);
    const view = fake.calls.find((args) => args[0] === "pr" && args[1] === "view");
    expect(view).toEqual(["pr", "view", "1", "--repo", "acme/repo", "--json", GITHUB_PR_VIEW_FIELDS]);
    const graphqlCalls = fake.calls.filter((args) => args[0] === "api" && args[1] === "graphql");
    expect(graphqlCalls.length).toBeGreaterThan(0);
    for (const args of graphqlCalls) {
      expect(args.slice(0, 3)).toEqual(["api", "graphql", "-f"]);
      expect(args[3]).toMatch(/^query=/u);
      expect(args.slice(4).length % 2).toBe(0);
      for (const flag of args.slice(4).filter((_, index) => index % 2 === 0)) expect(["-f", "-F"]).toContain(flag);
      const query = args[3]!.slice("query=".length);
      if (query === SEARCH_QUERY) {
        expect(args.slice(4)).toEqual(["-f", `q=is:pr is:open ${args.includes("q=is:pr is:open author:alice") ? "author:alice" : "review-requested:alice"}`, "-F", "first=100"]);
      } else if (query === REVIEW_REQUESTS_QUERY || query === REVIEWS_QUERY || query === COMMENTS_QUERY || query === LATEST_REVIEWS_QUERY || query === REVIEW_THREADS_QUERY) {
        expect(args.slice(4)).toEqual(["-f", "owner=acme", "-f", "repo=repo", "-F", "number=1"]);
      } else {
        expect(query).toBe(THREAD_COMMENTS_QUERY);
        const variables = args.slice(4);
        expect(variables).toEqual(args.includes("after=child-1") ? ["-f", "threadId=thread-1", "-f", "after=child-1"] : ["-f", "threadId=thread-1"]);
      }
    }
    expect(fake.calls.some((args) => ["auth", "merge", "close", "create", "edit", "delete", "review"].some((word) => args.includes(word)))).toBe(false);
  });

  it("unions authored and reviewer discovery with casefolded candidate deduplication and stable counts", async () => {
    const fake = makeFakeGh();
    const result = await successful(fake);

    expect(result.discovery).toEqual({
      authored: { issueCount: 1, fetchedCount: 1, pageCount: 1, complete: true },
      requestedReviewer: { issueCount: 2, fetchedCount: 2, pageCount: 1, complete: true },
      uniqueCandidateCount: 2,
      snapshotAttemptCount: 2,
      snapshotCount: 2,
      races: { prClosed: 0, authoredRoleLost: 0, reviewerRequestLost: 0 },
      complete: true,
    });
    expect(result.prs.map((pr) => [pr.baseRepository.nameWithOwner, pr.number])).toEqual([["acme/other", 2], ["acme/repo", 1]]);
    expect(result.prs.find((pr) => pr.number === 1)?.roles).toEqual(["authored", "requested_reviewer"]);
    expect(result.prs.find((pr) => pr.number === 2)?.roles).toEqual(["requested_reviewer"]);
    expect(result.prs.find((pr) => pr.number === 2)?.author).toEqual({ login: "otherauthor", actorType: "Bot" });
  });

  it("redacts snapshot metadata, applies typed actor/reviewer policy, and normalizes bounded child data", async () => {
    const fake = makeFakeGh({ singleCandidate: true });
    const result = await successful(fake);
    const snapshot = result.prs[0]!;

    expect(Object.keys(snapshot).sort()).toEqual([
      "author", "baseRefName", "baseRefOid", "baseRepository", "ciSummary", "comments", "headRefName",
      "headRefOid", "headRepository", "latestReviews", "number", "reviewRequests", "reviewThreads", "reviews",
      "roles", "state", "statusCheckRollup", "url",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
    expect(snapshot.author).toEqual({ login: "alice", actorType: "User" });
    expect(snapshot.reviewRequests).toEqual([{ login: "ALICE", actorType: "User" }]);
    expect(snapshot.reviews.map((review) => review.author)).toEqual([
      { login: "review-bot", actorType: "Bot" },
      { login: "org", actorType: "Organization" },
    ]);
    expect(snapshot.reviews.every((review) => !Object.hasOwn(review, "marker"))).toBe(true);
    expect(snapshot.comments[0]?.author).toEqual({ login: null, actorType: "Deleted" });
    expect(snapshot.reviewThreads[0]?.comments.nodes.map((comment) => comment.id)).toEqual(["thread-comment-a", "thread-comment-b", "thread-comment-c"]);
    expect(snapshot.reviewThreads[0]?.comments.nodes[1]?.commitOid).toBe("c".repeat(40));
    expect(snapshot.statusCheckRollup).toEqual([{ status: "PENDING", conclusion: null }, { status: "SUCCESS", conclusion: "SUCCESS" }]);
    expect(snapshot.ciSummary).toEqual({ total: 2, success: 1, failure: 0, pending: 1, cancelled: 0, neutral: 0, unknown: 0 });
    expect(snapshot.baseRefOid).toBe("a".repeat(40));
    expect(snapshot.headRefOid).toBe("b".repeat(40));
  });

  it("accepts a mixed-case PR URL and emits its canonical repository identity", async () => {
    const result = await successful(makeFakeGh({ singleCandidate: true, mixedCaseUrl: true }));
    expect(result.prs[0]?.url).toBe("https://github.com/acme/repo/pull/1");
    expect(result.prs[0]?.baseRepository).toEqual({ id: "repo-1", nameWithOwner: "acme/repo" });
  });

  it("rejects aggregate thread comments before retaining malformed overflow data", async () => {
    const fake = makeFakeGh({ singleCandidate: true, aggregateThreadOverflow: true });
    const result = await runGithubPrMonitorRead(INPUT, {
      gh: fake.gh,
      now: () => NOW,
      nonce: () => "fixed-nonce",
      deadlineMs: 2_000,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "GITHUB_MONITOR_OUTPUT_LIMIT",
      error: "GitHub PR monitor output exceeded its bounded limit.",
    });
    const childCalls = fake.calls.filter((args) => args[0] === "api" && args[1] === "graphql" && args[3] === `query=${THREAD_COMMENTS_QUERY}`);
    expect(childCalls).toHaveLength(6);
  });

  it("produces byte-for-byte deterministic output when time and nonce are injected", async () => {
    const first = await successful(makeFakeGh());
    const second = await successful(makeFakeGh());
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("returns sanitized errors for authority failures and never leaks command output", async () => {
    const fake = makeFakeGh({ authFailure: true });
    const result = await runGithubPrMonitorRead(INPUT, { gh: fake.gh, now: () => NOW, deadlineMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_AUTH", error: "GitHub authentication is unavailable." });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_GITHUB_TOKEN");
    expect(fake.calls).toEqual([["api", "user", "--jq", ".login"]]);
  });

  it("enforces discovery caps with stable bounded errors", async () => {
    const fake = makeFakeGh({ discoveryLimit: true });
    const result = await runGithubPrMonitorRead(INPUT, { gh: fake.gh, now: () => NOW, deadlineMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_DISCOVERY_LIMIT", error: "GitHub PR discovery exceeded its bounded limit." });
    expect(JSON.stringify(result)).not.toContain("issueCount");
    expect(fake.calls.filter((args) => args[0] === "pr")).toHaveLength(0);
  });

  it("stops before an unbounded sixth child-comments page", async () => {
    const fake = makeFakeGh({ singleCandidate: true, childPageOverflow: true });
    const result = await runGithubPrMonitorRead(INPUT, { gh: fake.gh, now: () => NOW, nonce: () => "fixed-nonce", deadlineMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_SNAPSHOT_INVALID", error: "GitHub PR snapshot returned invalid data." });
    const childCalls = fake.calls.filter((args) => args[0] === "api" && args[1] === "graphql" && args[3] === `query=${THREAD_COMMENTS_QUERY}`);
    expect(childCalls).toHaveLength(5);
    expect(childCalls.map((args) => arg(args, "after"))).toEqual([undefined, "child-1", "child-2", "child-3", "child-4"]);
    expect(fake.calls.some((args) => args.includes("merge") || args.includes("close") || args.includes("create"))).toBe(false);
  });

  it("rejects aliases before invoking even an injected command", async () => {
    const fake = makeFakeGh();
    const result = await runGithubPrMonitorRead({ runId: INPUT.runId, actionPlan: INPUT.actionPlanId }, { gh: fake.gh });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_INVALID_INPUT" });
    expect(fake.calls).toEqual([]);
  });

  it("rejects a reviewer typename outside the typed reviewer policy", async () => {
    const fake = makeFakeGh({ singleCandidate: true, badReviewerType: true });
    const result = await runGithubPrMonitorRead(INPUT, { gh: fake.gh, now: () => NOW, deadlineMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_SNAPSHOT_INVALID", error: "GitHub PR snapshot returned invalid data." });
    expect(JSON.stringify(result)).not.toContain("not-a-user-reviewer");
  });
  it("rejects JSON auth scalars without falling back to their raw encoding", async () => {
    const fake = makeFakeGh();
    const gh: GhCommand = async (args, options) => {
      if (args[0] === "api" && args[1] === "user") return stdout(null);
      return fake.gh(args, options);
    };

    const result = await runGithubPrMonitorRead(INPUT, { gh, deadlineMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_AUTH" });
  });

  it("rejects malformed cursors as discovery-invalid data", async () => {
    const fake = makeFakeGh({ singleCandidate: true });
    const gh: GhCommand = async (args, options) => {
      const result = await fake.gh(args, options);
      if (arg(args, "query") !== SEARCH_QUERY) return result;
      const parsed = JSON.parse(typeof result === "string" ? result : result.stdout) as { data: { search: Record<string, unknown> } };
      parsed.data.search.pageInfo = { hasNextPage: true, endCursor: "cursor\u0000" };
      return stdout(parsed);
    };

    const result = await runGithubPrMonitorRead(INPUT, { gh, deadlineMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_DISCOVERY_INVALID" });
  });
  it("accepts null and absent terminal cursors when no page follows", async () => {
    for (const endCursor of [null, undefined]) {
      const fake = makeFakeGh({ singleCandidate: true });
      const gh: GhCommand = async (args, options) => {
        const result = await fake.gh(args, options);
        if (arg(args, "query") !== SEARCH_QUERY) return result;
        const parsed = JSON.parse(typeof result === "string" ? result : result.stdout) as { data: { search: Record<string, unknown> } };
        parsed.data.search.pageInfo = endCursor === undefined
          ? { hasNextPage: false }
          : { hasNextPage: false, endCursor };
        return stdout(parsed);
      };
      const result = await runGithubPrMonitorRead(INPUT, { gh, now: () => NOW, nonce: () => "fixed-nonce", deadlineMs: 2_000 });
      expect(result.ok).toBe(true);
    }
  });
  it("rejects any terminal cursor when no page follows", async () => {
    const fake = makeFakeGh({ singleCandidate: true });
    const gh: GhCommand = async (args, options) => {
      const result = await fake.gh(args, options);
      if (arg(args, "query") !== SEARCH_QUERY) return result;
      const parsed = JSON.parse(typeof result === "string" ? result : result.stdout) as { data: { search: Record<string, unknown> } };
      parsed.data.search.pageInfo = { hasNextPage: false, endCursor: "terminal-cursor" };
      return stdout(parsed);
    };
    const result = await runGithubPrMonitorRead(INPUT, { gh, deadlineMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_DISCOVERY_INVALID" });
  });

  it("rejects unsafe terminal cursors even when no page follows", async () => {
    const fake = makeFakeGh({ singleCandidate: true });
    const gh: GhCommand = async (args, options) => {
      const result = await fake.gh(args, options);
      if (arg(args, "query") !== SEARCH_QUERY) return result;
      const parsed = JSON.parse(typeof result === "string" ? result : result.stdout) as { data: { search: Record<string, unknown> } };
      parsed.data.search.pageInfo = { hasNextPage: false, endCursor: "cursor\u0000" };
      return stdout(parsed);
    };
    const result = await runGithubPrMonitorRead(INPUT, { gh, deadlineMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_DISCOVERY_INVALID" });
  });

  it("rejects malformed open-state and actor fields instead of reporting races", async () => {
    const fake = makeFakeGh({ singleCandidate: true });
    const gh: GhCommand = async (args, options) => {
      const result = await fake.gh(args, options);
      if (args[0] !== "pr" || args[1] !== "view" || typeof result === "string") return result;
      return stdout({ ...JSON.parse(result.stdout), state: null, author: { login: null, __typename: "User" } });
    };

    const result = await runGithubPrMonitorRead(INPUT, { gh, deadlineMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_SNAPSHOT_INVALID" });
  });
  it("rejects malformed, null, and unsafe login-only CLI authors", async () => {
    for (const author of [null, {}, { login: null }, { login: "bad login" }, { login: "alice\u0000" }] as unknown[]) {
      const fake = makeFakeGh({ singleCandidate: true });
      const gh: GhCommand = async (args, options) => {
        const result = await fake.gh(args, options);
        if (args[0] !== "pr" || args[1] !== "view" || typeof result === "string") return result;
        return stdout({ ...JSON.parse(result.stdout), author });
      };
      const result = await runGithubPrMonitorRead(INPUT, { gh, deadlineMs: 2_000 });
      expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_SNAPSHOT_INVALID" });
    }
  });
  it("projects safe IDs and uses a fixed digest for oversized invalid input", async () => {
    const secret = "PRIVATE_MONITOR_SECRET_".repeat(20_000);
    const result = await runGithubPrMonitorRead({ ...INPUT, secret, nested: { secret } });
    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({
      ok: false,
      code: "GITHUB_MONITOR_INVALID_INPUT",
      runId: INPUT.runId,
      actionPlanId: INPUT.actionPlanId,
      chatgpt2codexToolCall: { ok: false, input: INPUT },
    });
    expect(result.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("nested");
  });
  it("waits for aborted sibling command cleanup before returning the first discovery failure", async () => {
    let siblingCleaned = false;
    let calls = 0;
    const gh: GhCommand = async (args, options) => {
      calls++;
      if (args[0] === "api" && args[1] === "user") return stdout("alice\n");
      if (args[0] !== "api" || args[1] !== "graphql" || arg(args, "query") !== SEARCH_QUERY) {
        throw new Error(`unexpected authority command: ${args.join(" ")}`);
      }
      const query = arg(args, "q");
      if (query === "is:pr is:open author:alice") {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        throw new Error("first discovery failure");
      }
      await new Promise<void>((resolve) => {
        const finishCleanup = () => {
          setTimeout(() => {
            siblingCleaned = true;
            resolve();
          }, 25);
        };
        if (options?.signal?.aborted) finishCleanup();
        else options?.signal?.addEventListener("abort", finishCleanup, { once: true });
      });
      return graph({ search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    };

    const result = await runGithubPrMonitorRead(INPUT, { gh, deadlineMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_UNAVAILABLE" });
    expect(siblingCleaned).toBe(true);
    const callsAfterReturn = calls;
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    expect(calls).toBe(callsAfterReturn);
  });
  it("bounds return when an aborted sibling command never settles", async () => {
    let calls = 0;
    let siblingAborted = false;
    const gh: GhCommand = async (args, options) => {
      calls++;
      if (args[0] === "api" && args[1] === "user") return stdout("alice\n");
      if (args[0] !== "api" || args[1] !== "graphql" || arg(args, "query") !== SEARCH_QUERY) {
        throw new Error(`unexpected authority command: ${args.join(" ")}`);
      }
      if (arg(args, "q") === "is:pr is:open author:alice") throw new Error("first discovery failure");
      options?.signal?.addEventListener("abort", () => { siblingAborted = true; }, { once: true });
      await new Promise<never>(() => {});
    };

    const startedAt = Date.now();
    const result = await runGithubPrMonitorRead(INPUT, { gh, deadlineMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_UNAVAILABLE" });
    expect(siblingAborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(COMMAND_CLEANUP_GRACE_MS + 750);
    const callsAfterReturn = calls;
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    expect(calls).toBe(callsAfterReturn);
  });
  it("returns after snapshot cleanup grace without waiting for a noncooperative sibling", async () => {
    const fake = makeFakeGh({ singleCandidate: true });
    let calls = 0;
    let siblingAborted = false;
    let siblingSettled = false;
    const gh: GhCommand = async (args, options) => {
      calls++;
      const query = arg(args, "query");
      if (query === REVIEWS_QUERY) throw new Error("first snapshot branch failure");
      if (query === COMMENTS_QUERY) {
        options?.signal?.addEventListener("abort", () => { siblingAborted = true; }, { once: true });
        await new Promise<never>(() => {});
      }
      try {
        return await fake.gh(args, options);
      } finally {
        if (query === COMMENTS_QUERY) siblingSettled = true;
      }
    };
    const startedAt = Date.now();
    const result = await runGithubPrMonitorRead(INPUT, { gh, deadlineMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_MONITOR_UNAVAILABLE" });
    expect(siblingAborted).toBe(true);
    expect(siblingSettled).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(COMMAND_CLEANUP_GRACE_MS + 750);
    const callsAfterReturn = calls;
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    expect(calls).toBe(callsAfterReturn);
    expect(siblingSettled).toBe(false);
  });
  it("bounds a killed command when the child never emits close and does not expose raw output", async () => {
    class NeverCloseChild extends EventEmitter {
      readonly stdout = new Readable({ read() {} });
      readonly stderr = new Readable({ read() {} });
      readonly pid = undefined;
      readonly kills: string[] = [];
      kill(signal: string = "SIGKILL"): boolean {
        this.kills.push(signal);
        return true;
      }
    }

    const child = new NeverCloseChild();
    spawnMock.mockReset().mockReturnValue(child);
    const raw = "PRIVATE_GH_OUTPUT";
    const startedAt = Date.now();
    const command = defaultGhCommand(["version"], { timeoutMs: 5 });
    child.stdout.emit("data", Buffer.from(raw, "utf8"));
    let error: unknown;
    try {
      await command;
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ monitorCode: "GITHUB_MONITOR_TIMEOUT" });
    expect(String(error)).not.toContain(raw);
    expect(child.kills).toEqual(["SIGKILL"]);
    expect(spawnMock).toHaveBeenCalledWith(
      "gh",
      ["version"],
      expect.objectContaining({ detached: process.platform !== "win32" }),
    );
    expect(Date.now() - startedAt).toBeLessThan(COMMAND_CLEANUP_GRACE_MS);
  });
});
