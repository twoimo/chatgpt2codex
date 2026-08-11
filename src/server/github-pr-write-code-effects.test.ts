import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GithubPrWriteCodeEffects, type GitCommand } from "./github-pr-write-code-effects.js";

const head = "0123456789abcdef0123456789abcdef01234567";
const nextHead = "abcdef0123456789abcdef0123456789abcdef01";
const evidence = { account: { login: "twoimo", id: 1, nodeId: "U1", actorType: "User" as const }, author: { login: "twoimo", id: 1, nodeId: "U1", actorType: "User" as const }, baseRepositoryId: 1, headRepositoryId: 1, repositoryId: 1, permission: "WRITE" as const, canPush: true, expectedHead: head };

function fakeGit(responses: Array<{ stdout?: string; exitCode?: number }>, calls: string[][]): GitCommand {
  return async (argv) => {
    calls.push([...argv]);
    const response = responses.shift() ?? { stdout: "", exitCode: 0 };
    return { stdout: response.stdout ?? "", exitCode: response.exitCode ?? 0 };
  };
}

describe("GithubPrWriteCodeEffects", () => {
  it("validates exact suggestion preconditions and commits only declared paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "github-code-effects-"));
    const worktree = path.join(root, "worktree");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(worktree, { recursive: true }));
    const original = "one\ntwo\n";
    await writeFile(path.join(worktree, "file.txt"), original, "utf8");
    const calls: string[][] = [];
    const git = fakeGit([
      { stdout: "https://github.com/Yeachan-Heo/gajae-code.git\n" },
      { stdout: `${head}\n` },
      { stdout: "" },
      { stdout: " M file.txt\n" },
      {},
      {},
      {},
      { stdout: `${nextHead}\n` },
    ], calls);
    const effects = new GithubPrWriteCodeEffects(git);
    const result = await effects.execute({ workspaceRoot: root, repository: "Yeachan-Heo/gajae-code", prNumber: 7, expectedHead: head, evidence }, {
      operation: "apply_suggestions",
      effectIdentity: "effect-1",
      worktreePath: worktree,
      suggestions: [{ path: "file.txt", startLine: 2, endLine: 2, expectedDigest: "3fc4ccfe745870e2c0d99f71f30ff0656c8dedd41cc1d7d3d376b0dbe685e2f3", replacement: "changed" }],
    });
    expect(result).toMatchObject({ operation: "apply_suggestions", status: "completed", changedPaths: ["file.txt"] });
    expect(await import("node:fs/promises").then(({ readFile: read }) => read(path.join(worktree, "file.txt"), "utf8"))).toContain("changed");
    expect(calls.some((call) => call[0] === "commit")).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("denies foreign fork or non-push-capable code evidence before touching the worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "github-code-effects-"));
    const calls: string[][] = [];
    const effects = new GithubPrWriteCodeEffects(fakeGit([], calls));
    await expect(effects.execute({ workspaceRoot: root, repository: "Yeachan-Heo/gajae-code", prNumber: 7, expectedHead: head, evidence: { ...evidence, headRepositoryId: 2 } }, {
      operation: "apply_suggestions", effectIdentity: "effect-1", worktreePath: path.join(root, "worktree"), suggestions: [],
    })).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await rm(root, { recursive: true, force: true });
  });
  it("allows authored code updates on the operator-owned fork with fresh topology evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "github-code-effects-"));
    const worktree = path.join(root, "worktree");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(worktree, { recursive: true }));
    await writeFile(path.join(worktree, "file.txt"), "one\ntwo\n", "utf8");
    const calls: string[][] = [];
    const git = fakeGit([
      { stdout: "https://github.com/twoimo/gajae-code.git\n" },
      { stdout: `${head}\n` },
      { stdout: "" },
      { stdout: " M file.txt\n" },
      {},
      {},
      {},
      { stdout: `${nextHead}\n` },
    ], calls);
    const gh = async (argv: readonly string[]) => argv[0] === "api"
      ? { stdout: "twoimo\n", exitCode: 0 }
      : {
        stdout: JSON.stringify({
          state: "OPEN",
          author: { login: "twoimo" },
          headRefOid: head,
          repository: { nameWithOwner: "Yeachan-Heo/gajae-code" },
          baseRepository: { nameWithOwner: "Yeachan-Heo/gajae-code" },
          headRepository: { nameWithOwner: "twoimo/gajae-code" },
        }),
        exitCode: 0,
      };
    const effects = new GithubPrWriteCodeEffects(git, gh);
    const result = await effects.execute({
      workspaceRoot: root,
      repository: "Yeachan-Heo/gajae-code",
      prNumber: 7,
      expectedHead: head,
      baseRepository: "Yeachan-Heo/gajae-code",
      headRepository: "twoimo/gajae-code",
      evidence: { ...evidence, headRepositoryId: 2 },
    }, {
      operation: "apply_suggestions",
      effectIdentity: "fork-effect-1",
      worktreePath: worktree,
      suggestions: [{ path: "file.txt", startLine: 2, endLine: 2, expectedDigest: "3fc4ccfe745870e2c0d99f71f30ff0656c8dedd41cc1d7d3d376b0dbe685e2f3", replacement: "changed" }],
    });
    expect(result).toMatchObject({ operation: "apply_suggestions", status: "completed", changedPaths: ["file.txt"] });
    expect(calls.some((call) => call[0] === "commit")).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("requires the remote branch to remain at the expected head before push", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "github-code-effects-"));
    const worktree = path.join(root, "worktree");
    const calls: string[][] = [];
    const effects = new GithubPrWriteCodeEffects(fakeGit([{ stdout: "https://github.com/Yeachan-Heo/gajae-code.git\n" }, { stdout: `${head}\n` }, { stdout: "" }, { stdout: `${nextHead}\trefs/heads/feature\n` }], calls));
    await expect(effects.execute({ workspaceRoot: root, repository: "Yeachan-Heo/gajae-code", prNumber: 7, expectedHead: head, headRef: "feature", evidence }, {
      operation: "push_prepared_worktree", effectIdentity: "effect-1", worktreePath: worktree, headRef: "feature", verificationReceiptId: "a".repeat(64), verificationProofDigest: "b".repeat(64),
    })).rejects.toThrow();
    expect(calls.map((call) => call[0])).toEqual(["remote", "rev-parse", "status", "ls-remote"]);
    await rm(root, { recursive: true, force: true });
  });
});
