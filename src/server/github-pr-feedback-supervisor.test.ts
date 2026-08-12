import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  feedbackStateKey,
  fetchCdpTargets,
  markFeedbackProcessed,
  normalizeCdpWebSocketUrl,
  parseLlmDecision,
  prepareWorktree,
  runGithubPrFeedbackSupervisor,
  supervisorApprovalEligible,
} from "./github-pr-feedback-supervisor.js";
import type { GhCommand } from "./github-pr-write-effects.js";

const temporaryRoots: string[] = [];
const previousUnattended = process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
const previousRollout = process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
const previousAllowlist = process.env.CHATGPT2CODEX_GITHUB_PR_ALLOWLIST;

const emptyGh: GhCommand = async (argv) => {
  if (argv[0] === "search") return { stdout: "[]", exitCode: 0 };
  throw new Error(`unexpected gh command: ${argv.join(" ")}`);
};

afterEach(async () => {
  vi.useRealTimers();
  if (previousUnattended === undefined) delete process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
  else process.env.CHATGPT2CODEX_UNATTENDED_WRITE = previousUnattended;
  if (previousRollout === undefined) delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
  else process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = previousRollout;
  if (previousAllowlist === undefined) delete process.env.CHATGPT2CODEX_GITHUB_PR_ALLOWLIST;
  else process.env.CHATGPT2CODEX_GITHUB_PR_ALLOWLIST = previousAllowlist;
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("GitHub PR feedback supervisor lifetime", () => {
  it("requires Korean natural language in reply and fix outputs", () => {
    expect(() => parseLlmDecision(JSON.stringify({
      action: "reply",
      body: "This is an English reply.",
      rationale: "The requested change is clear.",
    }))).toThrow("reply body must be predominantly Korean");
    expect(parseLlmDecision(JSON.stringify({
      action: "reply",
      body: "수정 내용을 반영했습니다.",
      rationale: "요청된 변경을 확인했습니다.",
    }))).toMatchObject({ action: "reply" });
    expect(() => parseLlmDecision(JSON.stringify({
      action: "wait",
      rationale: "Waiting for more information.",
    }))).toThrow("decision rationale must be predominantly Korean");
    expect(() => parseLlmDecision(JSON.stringify({
      action: "fix",
      rationale: "변경이 필요합니다.",
      commitMessage: "fix review feedback",
      suggestions: [{ path: "src/a.ts", startLine: 1, endLine: 1, oldText: "a", replacement: "b" }],
    }))).toThrow("commit message must be predominantly Korean");
  });

  it("ends after an explicitly bounded unattended window", async () => {
    vi.useFakeTimers();
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = "enabled";
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-supervisor-test-"));
    temporaryRoots.push(stateDir);

    const supervisor = await runGithubPrFeedbackSupervisor({
      stateDir,
      workspaceRoot: stateDir,
      intervalMs: 60_000,
      durationMs: 60_000,
      repositoryAllowlist: ["twoimo/tzudong"],
      gh: emptyGh,
    });
    let finished = false;
    const wait = supervisor.waitUntilFinished().then(() => { finished = true; });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(finished).toBe(true);
    await supervisor.close();
  });

  it("accepts a seven-day unattended window", async () => {
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-supervisor-seven-day-"));
    temporaryRoots.push(stateDir);
    const supervisor = await runGithubPrFeedbackSupervisor({
      stateDir,
      workspaceRoot: stateDir,
      durationMs: 7 * 24 * 60 * 60 * 1000,
      repositoryAllowlist: ["twoimo/tzudong"],
      once: true,
      gh: emptyGh,
    });
    await supervisor.waitUntilFinished();
    const state = JSON.parse(await fs.readFile(path.join(stateDir, "github-pr-feedback-supervisor.json"), "utf8")) as {
      unattendedStartedAt: number;
      unattendedExpiresAt: number;
    };
    expect(state.unattendedExpiresAt - state.unattendedStartedAt).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("rejects a duration longer than seven days", async () => {
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    await expect(runGithubPrFeedbackSupervisor({
      stateDir: os.tmpdir(),
      workspaceRoot: os.tmpdir(),
      durationMs: 7 * 24 * 60 * 60 * 1000 + 1,
      repositoryAllowlist: ["twoimo/tzudong"],
      gh: emptyGh,
    })).rejects.toThrow("duration must be between 60000 and 604800000 milliseconds");
  });

  it("does not enter the supervisor merge path for completed-only checks", async () => {
    const previousUnattended = process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
    const previousRollout = process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = "enabled";
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-supervisor-checks-"));
    temporaryRoots.push(stateDir);
    const repository = "twoimo/tzudong";
    const head = "0123456789abcdef0123456789abcdef01234567";
    const calls: string[][] = [];
    const view = JSON.stringify({
      number: 7,
      title: "검증",
      body: "",
      state: "OPEN",
      reviewDecision: "APPROVED",
      author: { login: "alice" },
      headRefName: "main",
      headRefOid: head,
      headRepository: { nameWithOwner: repository },
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [{ status: "COMPLETED" }],
    });
    const gh: GhCommand = async (argv) => {
      calls.push([...argv]);
      if (argv[0] === "search") return { stdout: JSON.stringify([{ repository: { nameWithOwner: repository }, number: 7 }]), exitCode: 0 };
      if (argv[0] === "pr" && argv[1] === "view") return { stdout: view, exitCode: 0 };
      if (argv[0] === "api" && argv[1] === "user") return { stdout: JSON.stringify({ login: "twoimo", id: 1, node_id: "U1", type: "User" }), exitCode: 0 };
      if (argv[0] === "api" && argv[1] === `repos/${repository}`) {
        return { stdout: JSON.stringify({ id: 2, node_id: "R1", permissions: { push: true } }), exitCode: 0 };
      }
      if (argv[0] === "api" && argv[1] === "users/alice") {
        return { stdout: JSON.stringify({ id: 3, node_id: "U2", type: "User" }), exitCode: 0 };
      }
      if (argv[0] === "api" && typeof argv[1] === "string" && (
        argv[1] === `repos/${repository}/pulls/7/reviews`
        || argv[1] === `repos/${repository}/issues/7/comments`
        || argv[1] === `repos/${repository}/pulls/7/comments`
      )) return { stdout: "[]", exitCode: 0 };
      throw new Error(`unexpected gh command: ${argv.join(" ")}`);
    };
    try {
      const supervisor = await runGithubPrFeedbackSupervisor({
        stateDir,
        workspaceRoot: stateDir,
        durationMs: 60_000,
        repositoryAllowlist: [repository],
        once: true,
        gh,
      });
      await supervisor.waitUntilFinished();
      expect(calls.some((argv) => argv[0] === "api" && typeof argv[1] === "string" && argv[1].includes("/merge"))).toBe(false);
      expect(calls.some((argv) => argv[0] === "api" && argv.includes("--method") && typeof argv[1] === "string" && argv[1].includes("/reviews"))).toBe(false);
    } finally {
      if (previousUnattended === undefined) delete process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
      else process.env.CHATGPT2CODEX_UNATTENDED_WRITE = previousUnattended;
      if (previousRollout === undefined) delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
      else process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = previousRollout;
    }
  });

  it("requires an explicit repository allowlist", async () => {
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    await expect(runGithubPrFeedbackSupervisor({
      stateDir: os.tmpdir(),
      workspaceRoot: os.tmpdir(),
      durationMs: 60_000,
      gh: emptyGh,
    })).rejects.toThrow("CHATGPT2CODEX_GITHUB_PR_ALLOWLIST or --repositories is required");
  });

  it("rejects a non-loopback ChatGPT CDP endpoint", async () => {
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    await expect(runGithubPrFeedbackSupervisor({
      stateDir: os.tmpdir(),
      workspaceRoot: os.tmpdir(),
      durationMs: 60_000,
      repositoryAllowlist: ["twoimo/tzudong"],
      chatgptCdpUrl: "http://example.com:9229",
      gh: emptyGh,
    })).rejects.toThrow("loopback HTTP URL");
  });

  it("accepts only loopback CDP page WebSocket targets", () => {
    expect(normalizeCdpWebSocketUrl("ws://127.0.0.1:9229/devtools/page/abc")).toContain("/devtools/page/abc");
    expect(() => normalizeCdpWebSocketUrl("ws://example.com:9229/devtools/page/abc")).toThrow("loopback WebSocket URL");
    expect(() => normalizeCdpWebSocketUrl("ws://127.0.0.1:9229/devtools/browser/abc")).toThrow("loopback WebSocket URL");
    expect(() => normalizeCdpWebSocketUrl("ws://127.0.0.1:9229/devtools/page/abc?token=secret")).toThrow("loopback WebSocket URL");
  });

  it("rejects an oversized CDP target-list body before parsing", async () => {
    const fetcher = async (_input: string, init: { signal: AbortSignal; redirect: "error" }) => {
      expect(init.redirect).toBe("error");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(512 * 1024 + 1));
          controller.close();
        },
      }), { status: 200 });
    };
    await expect(fetchCdpTargets("http://127.0.0.1:9229", fetcher, 100)).rejects.toThrow("CDP endpoint is unavailable");
  });

  it("aborts an indefinitely streaming CDP target-list body", async () => {
    let aborted = false;
    const fetcher = async (_input: string, init: { signal: AbortSignal; redirect: "error" }) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          try { controller.close(); } catch { /* the reader may already have cancelled */ }
        }, { once: true });
      },
    }), { status: 200 });
    await expect(fetchCdpTargets("http://127.0.0.1:9229", fetcher, 20)).rejects.toThrow("CDP endpoint is unavailable");
    expect(aborted).toBe(true);
  });

  it("keeps feedback identities distinct across feedback kinds", () => {
    expect(feedbackStateKey("review", "42")).toBe("review:42");
    expect(feedbackStateKey("issue_comment", "42")).toBe("issue_comment:42");
    expect(feedbackStateKey("review", "42")).not.toBe(feedbackStateKey("issue_comment", "42"));
  });

  it("marks only the feedback item that was acted on", () => {
    const processed: Record<string, string> = {};
    markFeedbackProcessed(processed, { kind: "review", id: "1", digest: "old" });
    expect(processed).toEqual({ "review:1": "old" });
  });

  it("only auto-approves an explicitly review-required PR", () => {
    expect(supervisorApprovalEligible("REVIEW_REQUIRED")).toBe(true);
    expect(supervisorApprovalEligible(null)).toBe(false);
    expect(supervisorApprovalEligible("UNKNOWN")).toBe(false);
    expect(supervisorApprovalEligible("APPROVED")).toBe(false);
  });

  it("rejects a symlinked unattended state directory", async () => {
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-supervisor-state-target-"));
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-supervisor-state-link-"));
    const stateDir = path.join(parent, "state");
    await fs.symlink(target, stateDir);
    temporaryRoots.push(target, parent);
    await expect(runGithubPrFeedbackSupervisor({
      stateDir,
      workspaceRoot: parent,
      durationMs: 60_000,
      repositoryAllowlist: ["twoimo/tzudong"],
      once: true,
      gh: emptyGh,
    })).rejects.toThrow("state directory is invalid");
  });

  it("rejects a symlink-steered existing supervisor worktree", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-supervisor-worktree-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-supervisor-outside-"));
    const linkParent = path.join(workspaceRoot, ".github-pr-supervisor");
    await fs.mkdir(linkParent, { recursive: true });
    await fs.symlink(outside, path.join(linkParent, "twoimo-tzudong-7-0123456789ab"));
    temporaryRoots.push(workspaceRoot, outside);
    await expect(prepareWorktree(emptyGh, {
      repository: "twoimo/tzudong",
      number: 7,
      expectedHead: "0123456789abcdef0123456789abcdef01234567",
    } as never, workspaceRoot)).rejects.toThrow("worktree path is invalid");
  });

  it("rejects a symlinked supervisor worktree parent", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-supervisor-parent-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-supervisor-parent-outside-"));
    await fs.symlink(outside, path.join(workspaceRoot, ".github-pr-supervisor"));
    temporaryRoots.push(workspaceRoot, outside);
    await expect(prepareWorktree(emptyGh, {
      repository: "twoimo/tzudong",
      number: 7,
      expectedHead: "0123456789abcdef0123456789abcdef01234567",
    } as never, workspaceRoot)).rejects.toThrow("worktree path is invalid");
  });

  it("rejects a persisted unattended window longer than seven days", async () => {
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-supervisor-state-"));
    temporaryRoots.push(stateDir);
    const startedAt = Date.now();
    await fs.writeFile(path.join(stateDir, "github-pr-feedback-supervisor.json"), JSON.stringify({
      version: 1,
      processed: {},
      terminal: {},
      unattendedStartedAt: startedAt,
      unattendedExpiresAt: startedAt + 7 * 24 * 60 * 60 * 1000 + 1,
    }));
    await expect(runGithubPrFeedbackSupervisor({
      stateDir,
      workspaceRoot: stateDir,
      durationMs: 60_000,
      repositoryAllowlist: ["twoimo/tzudong"],
      once: true,
      gh: emptyGh,
    })).rejects.toThrow("unattended window state is invalid");
  });

  it("allows an explicit operator reset to start a fresh seven-day window", async () => {
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-supervisor-reset-"));
    temporaryRoots.push(stateDir);
    const startedAt = Date.now() - 60 * 60 * 1000;
    await fs.writeFile(path.join(stateDir, "github-pr-feedback-supervisor.json"), JSON.stringify({
      version: 1,
      processed: { "review:1": "digest" },
      terminal: {},
      unattendedStartedAt: startedAt,
      unattendedExpiresAt: startedAt + 60 * 60 * 1000,
    }));
    const supervisor = await runGithubPrFeedbackSupervisor({
      stateDir,
      workspaceRoot: stateDir,
      durationMs: 7 * 24 * 60 * 60 * 1000,
      repositoryAllowlist: ["twoimo/tzudong"],
      once: true,
      resetUnattendedWindow: true,
      gh: emptyGh,
    });
    await supervisor.waitUntilFinished();
    const state = JSON.parse(await fs.readFile(path.join(stateDir, "github-pr-feedback-supervisor.json"), "utf8")) as {
      processed: Record<string, string>;
      unattendedStartedAt: number;
      unattendedExpiresAt: number;
    };
    expect(state.unattendedExpiresAt - state.unattendedStartedAt).toBe(7 * 24 * 60 * 60 * 1000);
    expect(state.processed).toEqual({ "review:1": "digest" });
  });

  it("does not renew the unattended window after a restart", async () => {
    vi.useFakeTimers();
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-supervisor-restart-"));
    temporaryRoots.push(stateDir);
    const first = await runGithubPrFeedbackSupervisor({
      stateDir,
      workspaceRoot: stateDir,
      repositoryAllowlist: ["twoimo/tzudong"],
      durationMs: 60_000,
      once: true,
      gh: emptyGh,
    });
    await first.waitUntilFinished();
    const statePath = path.join(stateDir, "github-pr-feedback-supervisor.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { unattendedStartedAt: number; unattendedExpiresAt: number };
    await fs.writeFile(statePath, JSON.stringify({
      version: 1,
      processed: {},
      terminal: {},
      unattendedStartedAt: state.unattendedStartedAt,
      unattendedExpiresAt: state.unattendedExpiresAt,
    }));
    await vi.advanceTimersByTimeAsync(60_001);
    const second = await runGithubPrFeedbackSupervisor({
      stateDir,
      workspaceRoot: stateDir,
      repositoryAllowlist: ["twoimo/tzudong"],
      durationMs: 7 * 24 * 60 * 60 * 1000,
      gh: emptyGh,
    });
    await second.waitUntilFinished();
    await expect(second.waitUntilFinished()).resolves.toBeUndefined();
  });
});
