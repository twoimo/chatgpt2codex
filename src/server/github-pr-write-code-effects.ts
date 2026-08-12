import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GITHUB_PR_WRITE_ACCOUNT, GITHUB_PR_WRITE_FORK_REPOSITORY, GITHUB_PR_WRITE_REPOSITORY, GithubPrWriteError } from "./github-pr-write-contract.js";
import { defaultGhCommand, type GhCommand } from "./github-pr-write-effects.js";
import { canWriteCode, canWriteCodeUnattended, type GithubEvidence, unattendedWriteEnabled } from "./github-pr-write-policy.js";

export interface GitResult { stdout: string; stderr?: string; exitCode?: number; timedOut?: boolean; }
export type GitCommand = (argv: readonly string[], cwd: string, timeoutMs: number) => Promise<GitResult>;

export interface CodeEffectContext {
  workspaceRoot: string;
  repository: string;
  prNumber: number;
  expectedHead: string;
  baseRepository?: string;
  headRepository?: string;
  headRef?: string;
  evidence: GithubEvidence;
}

export interface Suggestion {
  path: string;
  startLine: number;
  endLine: number;
  expectedDigest: string;
  replacement: string;
}

export type CodeEffect =
  | { operation: "apply_suggestions"; effectIdentity: string; suggestions: Suggestion[]; worktreePath: string; message?: string }
  | { operation: "push_prepared_worktree"; effectIdentity: string; worktreePath: string; headRef: string; verificationReceiptId: string; verificationProofDigest: string };

const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 30_000;
const SHA = /^[0-9a-f]{40}$/iu;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/u;
const DIGEST = /^[0-9a-f]{64}$/iu;
const RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const execFileAsync = promisify(execFile);

export const defaultGitCommand: GitCommand = async (argv, cwd, timeoutMs) => {
  try {
    const result = await execFileAsync("git", [...argv], { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return { stdout: typeof value.stdout === "string" ? value.stdout : "", stderr: typeof value.stderr === "string" ? value.stderr : "", exitCode: typeof value.code === "number" ? value.code : 1, timedOut: value.killed === true };
  }
};

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const fail = (code: "GITHUB_WRITE_INVALID_INPUT" | "GITHUB_WRITE_MUTATION_DENIED" | "GITHUB_WRITE_RECOVERY_REQUIRED", message: string): never => { throw new GithubPrWriteError(code, message); };

export class GithubPrWriteCodeEffects {
  constructor(private readonly git: GitCommand = defaultGitCommand, private readonly gh?: GhCommand, private readonly timeoutMs = TIMEOUT_MS) {}
  private async freshRemoteEvidence(context: CodeEffectContext): Promise<void> {
    if (!this.gh) return;
    const baseRepositoryName = context.baseRepository ?? GITHUB_PR_WRITE_REPOSITORY;
    const headRepositoryName = context.headRepository ?? GITHUB_PR_WRITE_REPOSITORY;
    try {
      const user = await this.gh(["api", "user", "--hostname", "github.com", "--jq", ".login"], this.timeoutMs);
      if (typeof user.stdout !== "string" || user.timedOut || user.exitCode !== 0 || user.stdout.trim() !== GITHUB_PR_WRITE_ACCOUNT) fail("GITHUB_WRITE_RECOVERY_REQUIRED", "authenticated account evidence is ambiguous");
      const repositoryName = unattendedWriteEnabled() ? context.repository : GITHUB_PR_WRITE_REPOSITORY;
      const view = await this.gh(["pr", "view", String(context.prNumber), "--repo", repositoryName, "--json", "state,author,headRefOid,headRepository"], this.timeoutMs);
      if (typeof view.stdout !== "string" || view.timedOut || view.exitCode !== 0 || Buffer.byteLength(view.stdout, "utf8") > MAX_OUTPUT) fail("GITHUB_WRITE_RECOVERY_REQUIRED", "pull request evidence is ambiguous");
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(view.stdout) as Record<string, unknown>; } catch { fail("GITHUB_WRITE_RECOVERY_REQUIRED", "pull request evidence is invalid"); }
      const author = parsed.author as Record<string, unknown> | undefined;
      const headRepository = parsed.headRepository as Record<string, unknown> | undefined;
      const fixedTopology = baseRepositoryName === GITHUB_PR_WRITE_REPOSITORY
        && (headRepositoryName === GITHUB_PR_WRITE_REPOSITORY || headRepositoryName === GITHUB_PR_WRITE_FORK_REPOSITORY)
        && repositoryName === GITHUB_PR_WRITE_REPOSITORY;
      const dynamicTopology = unattendedWriteEnabled()
        && baseRepositoryName === repositoryName
        && REPOSITORY.test(baseRepositoryName)
        && REPOSITORY.test(headRepositoryName);
      if ((!fixedTopology && !dynamicTopology)
        || parsed.state !== "OPEN"
        || String(parsed.headRefOid).toLowerCase() !== context.expectedHead.toLowerCase()
        || author?.login !== GITHUB_PR_WRITE_ACCOUNT
        || headRepository?.nameWithOwner !== headRepositoryName) {
        fail("GITHUB_WRITE_MUTATION_DENIED", "pull request topology or head evidence is stale");
      }
    } catch (error) {
      if (error instanceof GithubPrWriteError) throw error;
      fail("GITHUB_WRITE_RECOVERY_REQUIRED", "pull request evidence is ambiguous");
    }
  }

  private validateContext(context: CodeEffectContext): void {
    const baseRepository = context.baseRepository ?? GITHUB_PR_WRITE_REPOSITORY;
    const headRepository = context.headRepository ?? GITHUB_PR_WRITE_REPOSITORY;
    const topology = { baseRepository, headRepository };
    const allowed = canWriteCode(context.evidence, topology) || canWriteCodeUnattended(context.evidence, topology);
    const fixedTarget = baseRepository === GITHUB_PR_WRITE_REPOSITORY
      && (headRepository === GITHUB_PR_WRITE_REPOSITORY || headRepository === GITHUB_PR_WRITE_FORK_REPOSITORY)
      && context.repository === GITHUB_PR_WRITE_REPOSITORY;
    const dynamicTarget = unattendedWriteEnabled()
      && baseRepository === context.repository
      && REPOSITORY.test(context.repository)
      && REPOSITORY.test(headRepository);
    if (!allowed || (!fixedTarget && !dynamicTarget) || !SHA.test(context.expectedHead) || !Number.isSafeInteger(context.prNumber) || context.prNumber < 1 || !REF.test(context.repository)) fail("GITHUB_WRITE_MUTATION_DENIED", "code writes require an authored User PR on the approved repository topology with push permission");
    if (context.headRef !== undefined && (!REF.test(context.headRef) || context.headRef.split("/").some((part) => part === "." || part === ".."))) fail("GITHUB_WRITE_INVALID_INPUT", "head ref is invalid");
    const root = path.resolve(context.workspaceRoot);
    if (!root || root === path.parse(root).root) fail("GITHUB_WRITE_INVALID_INPUT", "workspace root is invalid");
  }

  private worktree(context: CodeEffectContext, worktreePath: string): string {
    if (typeof worktreePath !== "string" || path.isAbsolute(worktreePath) === false) fail("GITHUB_WRITE_INVALID_INPUT", "an absolute disposable worktree path is required");
    const root = path.resolve(context.workspaceRoot);
    const resolved = path.resolve(worktreePath);
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) fail("GITHUB_WRITE_MUTATION_DENIED", "worktree is outside the workspace root");
    return resolved;
  }

  private validateSuggestions(suggestions: Suggestion[]): void {
    if (!Array.isArray(suggestions) || suggestions.length < 1 || suggestions.length > 10) fail("GITHUB_WRITE_INVALID_INPUT", "one to ten suggestions are required");
    const seen = new Set<string>();
    for (const suggestion of suggestions) {
      if (!suggestion || !RELATIVE.test(suggestion.path) || suggestion.path === ".git" || suggestion.path.startsWith(".git/") || seen.has(suggestion.path) || !Number.isSafeInteger(suggestion.startLine) || !Number.isSafeInteger(suggestion.endLine) || suggestion.startLine < 1 || suggestion.endLine < suggestion.startLine || suggestion.endLine - suggestion.startLine > 200 || !DIGEST.test(suggestion.expectedDigest) || typeof suggestion.replacement !== "string" || suggestion.replacement.length > 12_000 || /\0|\r/u.test(suggestion.replacement)) fail("GITHUB_WRITE_INVALID_INPUT", "suggestion is invalid");
      seen.add(suggestion.path);
    }
  }

  private async run(argv: readonly string[], cwd: string, label: string): Promise<GitResult> {
    if (argv.some((part) => part.includes("\0"))) fail("GITHUB_WRITE_INVALID_INPUT", "git argument is invalid");
    const result = await this.git(argv, cwd, this.timeoutMs).catch(() => fail("GITHUB_WRITE_RECOVERY_REQUIRED", `${label} outcome is ambiguous`));
    if (typeof result.stdout !== "string" || result.timedOut || result.exitCode !== 0 || Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT) fail("GITHUB_WRITE_RECOVERY_REQUIRED", `${label} outcome is ambiguous`);
    return result;
  }

  private async head(cwd: string): Promise<string> {
    const result = await this.run(["rev-parse", "HEAD"], cwd, "git head read");
    const value = result.stdout.trim();
    if (!SHA.test(value)) fail("GITHUB_WRITE_RECOVERY_REQUIRED", "git head evidence is invalid");
    return value;
  }
  private async assertRemoteOrigin(context: CodeEffectContext, cwd: string): Promise<void> {
    const result = await this.run(["remote", "get-url", "origin"], cwd, "git remote origin");
    const actual = result.stdout.trim().replace(/\/+$/u, "").replace(/\.git$/iu, "");
    const expected = `https://github.com/${context.headRepository ?? GITHUB_PR_WRITE_REPOSITORY}`;
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/iu.test(actual) || actual.toLowerCase() !== expected.toLowerCase()) {
      fail("GITHUB_WRITE_MUTATION_DENIED", "git origin must be the approved HTTPS head repository");
    }
  }

  private async applySuggestions(worktreePath: string, suggestions: Suggestion[]): Promise<string[]> {
    const byFile = new Map<string, Suggestion[]>();
    for (const suggestion of suggestions) byFile.set(suggestion.path, [...(byFile.get(suggestion.path) ?? []), suggestion]);
    const changedPaths: string[] = [];
    const worktreeReal = await realpath(worktreePath).catch(() => undefined);
    for (const [relativePath, entries] of byFile) {
      const filePath = path.join(worktreePath, relativePath);
      const resolvedFile = await realpath(filePath).catch(() => fail("GITHUB_WRITE_MUTATION_DENIED", "suggestion file is unavailable"));
      const fileStat = await lstat(filePath).catch(() => undefined);
      if (fileStat?.isSymbolicLink() || (worktreeReal !== undefined && !resolvedFile.startsWith(`${worktreeReal}${path.sep}`))) fail("GITHUB_WRITE_MUTATION_DENIED", "suggestion path must not resolve through a symlink");
      const original = await readFile(filePath, "utf8").catch(() => fail("GITHUB_WRITE_MUTATION_DENIED", "suggestion file is unavailable"));
      const lines = original.split("\n");
      const sorted = [...entries].sort((left, right) => right.startLine - left.startLine);
      for (const entry of sorted) {
        const actual = lines.slice(entry.startLine - 1, entry.endLine).join("\n");
        if (digest(actual) !== entry.expectedDigest) fail("GITHUB_WRITE_MUTATION_DENIED", "suggestion precondition does not match");
        lines.splice(entry.startLine - 1, entry.endLine - entry.startLine + 1, ...entry.replacement.split("\n"));
      }
      const updated = lines.join("\n");
      if (updated === original) fail("GITHUB_WRITE_INVALID_INPUT", "suggestion has no change");
      await writeFile(filePath, updated, "utf8");
      changedPaths.push(relativePath);
    }
    return changedPaths.sort();
  }

  async execute(context: CodeEffectContext, effect: CodeEffect): Promise<Record<string, unknown>> {
    this.validateContext(context);
    if (effect.operation === "push_prepared_worktree" && (!DIGEST.test(effect.verificationReceiptId) || !DIGEST.test(effect.verificationProofDigest))) fail("GITHUB_WRITE_INVALID_INPUT", "exact verification proof is required for push");
    await this.freshRemoteEvidence(context);
    const worktreePath = this.worktree(context, effect.worktreePath);
    const worktreeReal = await realpath(worktreePath).catch(() => undefined);
    if (worktreeReal !== undefined) {
      const worktreeStat = await lstat(worktreePath).catch(() => undefined);
      if (!worktreeStat?.isDirectory() || worktreeStat.isSymbolicLink()) fail("GITHUB_WRITE_MUTATION_DENIED", "worktree must be a real directory");
    }
    await this.assertRemoteOrigin(context, worktreePath);
    const initialHead = await this.head(worktreePath);
    if (initialHead.toLowerCase() !== context.expectedHead.toLowerCase()) fail("GITHUB_WRITE_MUTATION_DENIED", "worktree head does not match fresh evidence");
    const clean = await this.run(["status", "--porcelain=v1", "--untracked-files=all"], worktreePath, "git worktree status");
    if (clean.stdout.trim() !== "") fail("GITHUB_WRITE_MUTATION_DENIED", "worktree must be clean before an approved code effect");
    if (effect.operation === "apply_suggestions") {
      this.validateSuggestions(effect.suggestions);
      const changedPaths = await this.applySuggestions(worktreePath, effect.suggestions);
      const status = await this.run(["status", "--porcelain=v1", "--untracked-files=no"], worktreePath, "git status");
      const actualPaths = status.stdout.split("\n").filter(Boolean).map((line) => line.slice(3)).sort();
      if (actualPaths.some((item) => !changedPaths.includes(item))) fail("GITHUB_WRITE_MUTATION_DENIED", "worktree contains unexpected changes");
      await this.run(["diff", "--check", "--", ...changedPaths], worktreePath, "git diff check");
      await this.run(["add", "--", ...changedPaths], worktreePath, "git add");
      const message = typeof effect.message === "string" && effect.message.length > 0 && effect.message.length <= 120 && !/[\0\r\n]/u.test(effect.message) ? effect.message : "Apply authored review suggestions";
      await this.run(["commit", "-m", message], worktreePath, "git commit");
      const committedHead = await this.head(worktreePath);
      const commitDigest = digest(committedHead);
      const verificationProofDigest = digest(JSON.stringify({ operation: effect.operation, repository: context.repository, prNumber: context.prNumber, expectedHead: context.expectedHead, commitDigest, changedPaths }));
      return { operation: effect.operation, status: "completed", effectIdentity: effect.effectIdentity, commitDigest, verificationProofDigest, changedPaths };
    }
    if (!REF.test(effect.headRef) || effect.headRef.split("/").some((part) => part === "." || part === "..")) fail("GITHUB_WRITE_INVALID_INPUT", "head ref is invalid");
    const remote = await this.run(["ls-remote", "origin", `refs/heads/${effect.headRef}`], worktreePath, "git remote head read");
    const remoteHead = remote.stdout.trim().split(/\s+/u)[0] ?? "";
    if (remoteHead.toLowerCase() !== context.expectedHead.toLowerCase()) fail("GITHUB_WRITE_MUTATION_DENIED", "remote head changed before push");
    await this.run(["push", "origin", `HEAD:refs/heads/${effect.headRef}`], worktreePath, "git push");
    const pushedHead = await this.head(worktreePath);
    const postPush = await this.run(["ls-remote", "origin", `refs/heads/${effect.headRef}`], worktreePath, "git remote head verification");
    if ((postPush.stdout.trim().split(/\s+/u)[0] ?? "").toLowerCase() !== pushedHead.toLowerCase()) fail("GITHUB_WRITE_RECOVERY_REQUIRED", "remote head after push is ambiguous");
    return { operation: effect.operation, status: "completed", effectIdentity: effect.effectIdentity, commitDigest: digest(pushedHead), headRef: effect.headRef, verificationReceiptId: effect.verificationReceiptId, verificationProofDigest: effect.verificationProofDigest, noForce: true };
  }
}
