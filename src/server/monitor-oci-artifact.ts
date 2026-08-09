import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DomainError, ErrorCode } from "../types.js";

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const IMAGE = /^sha256:[0-9a-f]{64}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u;
const FIXED_PUSH_ENDPOINT = "git@github.com:Yeachan-Heo/gajae-code.git";
const FIXED_GITHUB_OWNER = "Yeachan-Heo";
const FIXED_GITHUB_REPOSITORY = "gajae-code";
const ZERO_SHA = "0".repeat(40);
const GITHUB_TIMEOUT_MS = 30_000;
const STAGING_REF_PREFIX = "refs/heads/gajae-code-monitor/";
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const OCI_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_SOURCE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const RENEW_INTERVAL_MS = 10_000;
const HOST_PROCESS_TIMEOUT_MS = 120_000;
const PROCESS_KILL_GRACE_MS = 2_000;
const BOT_NAME = "gajae-code[bot]";
const BOT_EMAIL = "gajae-code[bot]@users.noreply.github.com";
const GIT_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=never"] as const;
const rawExecFileAsync = promisify(execFile);
const execFileAsync = async (
  file: string,
  args: readonly string[],
  options: Parameters<typeof rawExecFileAsync>[2] = {},
): Promise<{ stdout: string; stderr: string }> => {
  const result = await rawExecFileAsync(file, [...args], {
    ...options,
    timeout: (options as { timeout?: number }).timeout ?? HOST_PROCESS_TIMEOUT_MS,
    killSignal: (options as { killSignal?: NodeJS.Signals }).killSignal ?? "SIGKILL",
  });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};
const MAX_DURABLE_ARTIFACTS = 8;
const MAX_DURABLE_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_DURABLE_ARTIFACT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface MonitorOciSuggestion {
  readonly threadId: string;
  readonly commentId: string;
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly replacement: string;
  readonly sourceDigest: string;
}

export interface MonitorOciArtifactTask {
  readonly expectedHeadSha: string;
  readonly expectedTreeSha: string;
  readonly logicalIdentity: string;
  readonly taskDigest: string;
  readonly suggestions: readonly MonitorOciSuggestion[];
}

export interface VerifiedMonitorArtifact {
  readonly artifactDir: string;
  readonly bundlePath: string;
  readonly bundleSha256: string;
  readonly baseHeadSha: string;
  readonly headSha: string;
  readonly treeSha: string;
  readonly changedPaths: readonly string[];
  readonly taskDigest: string;
  readonly logicalIdentity: string;
}

interface Manifest {
  readonly version: 1;
  readonly headSha: string;
  readonly treeSha: string;
  readonly baseHeadSha: string;
  readonly changedPaths: string[];
  readonly taskDigest: string;
  readonly logicalIdentity: string;
  readonly bundleSha256: string;
}

function denied(message: string): DomainError {
  return new DomainError(ErrorCode.APPROVAL_REQUIRED, message);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw denied("OCI artifact binding only accepts finite numbers");
      return JSON.stringify(value);
    case "string": return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
    default: throw denied("OCI artifact binding is not canonical JSON");
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw denied(`${label} has an invalid exact schema`);
  }
}

async function cleanupDurableArtifacts(root: string, preserve?: string): Promise<void> {
  const now = Date.now();
  const candidates: Array<{ path: string; mtimeMs: number; bytes: number }> = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(root, entry.name);
    if (directory === preserve) continue;
    const stat = await fs.stat(directory).catch(() => undefined);
    if (!stat || !stat.isDirectory()) continue;
    let bytes = 0;
    for (const file of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!file.isFile() || file.isSymbolicLink()) continue;
      bytes += (await fs.stat(path.join(directory, file.name)).catch(() => ({ size: 0 }))).size;
    }
    candidates.push({ path: directory, mtimeMs: stat.mtimeMs, bytes });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let kept = 0;
  let total = 0;
  for (const candidate of candidates) {
    const expired = now - candidate.mtimeMs > MAX_DURABLE_ARTIFACT_AGE_MS;
    if (expired || kept >= MAX_DURABLE_ARTIFACTS || total + candidate.bytes > MAX_DURABLE_ARTIFACT_BYTES) {
      await fs.rm(candidate.path, { recursive: true, force: true });
      continue;
    }
    kept += 1;
    total += candidate.bytes;
  }
}
function safeHeadRef(value: string): boolean {
  return SAFE_REF.test(value) && !value.startsWith("-") && !value.includes("..") && !value.endsWith("/") && !value.includes("//");
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "/usr/bin/ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=no -o HostName=github.com -o HostKeyAlias=github.com -o User=git -o StrictHostKeyChecking=yes",
  };
}

async function git(cwd: string, args: readonly string[], maxBuffer = MAX_BUNDLE_BYTES): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...GIT_CONFIG, ...args], { env: gitEnv(), maxBuffer });
  return result.stdout;
}

async function writeBoundedProcessFile(
  command: string,
  args: readonly string[],
  destination: string,
  limit: number,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const file = await fs.open(destination, "wx", 0o600);
  const child = spawn(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    detached: process.platform !== "win32",
  });
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let terminalError: Error | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = (error: Error) => {
    if (terminalError) return;
    terminalError = error;
    if (process.platform !== "win32" && child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    } else child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        if (process.platform !== "win32" && child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        } else child.kill("SIGKILL");
      }
    }, PROCESS_KILL_GRACE_MS);
    killTimer.unref();
  };
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
  });
  child.once("error", (error) => terminate(denied(`${command} process could not start: ${error.message}`)));
  const timeout = setTimeout(() => terminate(denied(`${command} process timed out after ${HOST_PROCESS_TIMEOUT_MS}ms`)), HOST_PROCESS_TIMEOUT_MS);
  timeout.unref();
  try {
    for await (const value of child.stdout) {
      if (terminalError) throw terminalError;
      const chunk = value as Buffer;
      const size = (await file.stat()).size;
      if (size + chunk.length > limit) {
        terminate(denied(`${command} output exceeded its ${limit}-byte storage bound`));
        throw terminalError;
      }
      await file.write(chunk);
    }
    const result = await completion;
    if (terminalError) throw terminalError;
    if (result.code !== 0 || result.signal !== null || (await file.stat()).size < 1) {
      throw denied(`${command} did not produce a complete bounded file: ${Buffer.concat(stderr).toString("utf8").slice(-4000)}`);
    }
  } catch (error: unknown) {
    terminate(error instanceof Error ? error : denied(`${command} process failed`));
    await completion.catch(() => undefined);
    await fs.rm(destination, { force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
    if (killTimer !== undefined) clearTimeout(killTimer);
    await file.close();
  }
}

async function sha256File(file: string): Promise<string> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BUNDLE_BYTES) {
    throw denied("OCI artifact bundle is missing, linked, empty, or oversized");
  }
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
async function authorizedTree(worktreePath: string, task: MonitorOciArtifactTask): Promise<string> {
  const scratch = await fs.mkdtemp(path.join(path.dirname(worktreePath), ".authorized-"));
  const index = path.join(scratch, "index");
  try {
    await execFileAsync("git", ["-C", worktreePath, ...GIT_CONFIG, "read-tree", task.expectedHeadSha], { env: { ...gitEnv(), GIT_INDEX_FILE: index }, maxBuffer: 1024 * 1024 });
    for (const relative of [...new Set(task.suggestions.map((item) => item.path))].sort()) {
      const mode = (await git(worktreePath, ["ls-tree", task.expectedHeadSha, "--", relative], 1024 * 1024)).split(/\s+/u)[0];
      if (mode !== "100644" && mode !== "100755") throw denied("Authorized suggestion target is not a regular tracked file");
      let content = await git(worktreePath, ["show", `${task.expectedHeadSha}:${relative}`], 1024 * 1024);
      const suggestions = task.suggestions.filter((item) => item.path === relative).sort((left, right) => right.startLine - left.startLine || right.line - left.line);
      for (const suggestion of suggestions) {
        const starts = [0];
        for (let offset = content.indexOf("\n"); offset !== -1; offset = content.indexOf("\n", offset + 1)) starts.push(offset + 1);
        const lineCount = content.endsWith("\n") ? starts.length - 1 : starts.length;
        if (suggestion.startLine < 1 || suggestion.line < suggestion.startLine || suggestion.line > lineCount) throw denied("Authorized suggestion line range is not current");
        const start = starts[suggestion.startLine - 1]!;
        const end = suggestion.line >= starts.length ? content.length : starts[suggestion.line]! - 1;
        const source = content.slice(start, end);
        if (createHash("sha256").update(source, "utf8").digest("hex") !== suggestion.sourceDigest) throw denied("Authorized suggestion source digest does not match");
        content = `${content.slice(0, start)}${suggestion.replacement}${content.slice(end)}`;
      }
      const blobFile = path.join(scratch, "blob");
      await fs.writeFile(blobFile, content, { encoding: "utf8", mode: 0o600 });
      const blob = (await git(worktreePath, ["hash-object", "-w", "--no-filters", blobFile], 1024 * 1024)).trim();
      const result = await execFileAsync("git", ["-C", worktreePath, ...GIT_CONFIG, "update-index", "--cacheinfo", `${mode},${blob},${relative}`], { env: { ...gitEnv(), GIT_INDEX_FILE: index }, maxBuffer: 1024 * 1024 });
      void result;
    }
    return (await execFileAsync("git", ["-C", worktreePath, ...GIT_CONFIG, "write-tree"], { env: { ...gitEnv(), GIT_INDEX_FILE: index }, maxBuffer: 1024 * 1024 })).stdout.trim();
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

function artifactMessage(task: MonitorOciArtifactTask): string {
  return `Apply authorized PR suggestions\n\nGJC-Logical-Identity: ${task.logicalIdentity}\nGJC-Plan-Digest: ${task.taskDigest}`;
}

async function authorizedCommit(
  worktreePath: string,
  task: MonitorOciArtifactTask,
  treeSha: string,
): Promise<string> {
  const seed = createHash("sha256").update(`${task.logicalIdentity}:${task.taskDigest}`, "utf8").digest();
  const timestamp = 946_684_800 + (seed.readUInt32BE(0) % 946_080_000);
  const gitDate = `@${timestamp} +0000`;
  const result = await execFileAsync(
    "git",
    ["-C", worktreePath, ...GIT_CONFIG, "commit-tree", treeSha, "-p", task.expectedHeadSha, "-m", `${artifactMessage(task)}\n`],
    {
      env: {
        ...gitEnv(),
        GIT_AUTHOR_NAME: BOT_NAME,
        GIT_AUTHOR_EMAIL: BOT_EMAIL,
        GIT_AUTHOR_DATE: gitDate,
        GIT_COMMITTER_NAME: BOT_NAME,
        GIT_COMMITTER_EMAIL: BOT_EMAIL,
        GIT_COMMITTER_DATE: gitDate,
      },
      maxBuffer: 1024 * 1024,
    },
  );
  return result.stdout.trim();
}

function dockerArgs(imageDigest: string, taskDir: string, containerName: string, mode: "execute" | "package"): string[] {
  if (!IMAGE.test(imageDigest)) throw denied("OCI image must be pinned by sha256 digest");
  if (!path.isAbsolute(taskDir) || path.resolve(taskDir) !== taskDir || /[\u0000-\u001f\u007f,]/u.test(taskDir)) {
    throw denied("OCI task directory must be an absolute clean path");
  }
  return [
    "run", `--name=${containerName}`, "--pull=never", "--network=none", "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=4g", "--cpus=2",
    "--user=65532:65532", "--stop-timeout=2",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=256m,mode=1777",
    "--tmpfs=/workspace:rw,exec,nosuid,size=2g,mode=1777",
    ...(mode === "package" ? ["--mount=type=volume,dst=/output"] : []),
    `--mount=type=bind,src=${taskDir},dst=/task,readonly`,
    imageDigest, mode,
  ];
}

async function terminateContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["stop", "--time=2", name], { env: { PATH: process.env.PATH ?? "" }, timeout: 5_000, maxBuffer: MAX_OUTPUT_BYTES }).catch(() => undefined);
  await execFileAsync("docker", ["rm", "-fv", name], { env: { PATH: process.env.PATH ?? "" }, timeout: 10_000, maxBuffer: MAX_OUTPUT_BYTES });
}

async function runDockerWithRenewal(
  imageDigest: string,
  taskDir: string,
  mode: "execute" | "package",
  outputDir: string | undefined,
  renew: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  await renew();
  if (signal?.aborted) throw denied("OCI artifact execution was cancelled before start");
  const containerName = `gajae-monitor-${randomUUID()}`;
  const args = dockerArgs(imageDigest, taskDir, containerName, mode);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "" },
        detached: process.platform !== "win32",
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let renewalRunning = false;
      let terminalError: Error | undefined;

      const kill = (error: Error) => {
        if (terminalError) return;
        terminalError = error;
        if (process.platform !== "win32" && child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        } else child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) {
            if (process.platform !== "win32" && child.pid !== undefined) {
              try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
            } else child.kill("SIGKILL");
          }
        }, 2_000).unref();
      };
      const consume = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) kill(denied("OCI artifact process output exceeded 1MiB"));
        else target.push(chunk);
      };
      child.stdout.on("data", consume(stdout));
      child.stderr.on("data", consume(stderr));
      child.once("error", (error) => kill(denied(`OCI artifact process could not start: ${error.message}`)));
      const renewal = setInterval(() => {
        if (renewalRunning || terminalError) return;
        renewalRunning = true;
        void renew().catch((error: unknown) => {
          kill(denied(`OCI artifact lease renewal failed: ${error instanceof Error ? error.message : "unknown error"}`));
        }).finally(() => { renewalRunning = false; });
      }, RENEW_INTERVAL_MS);
      const timeout = setTimeout(() => kill(denied(`OCI artifact process timed out after ${OCI_TIMEOUT_MS}ms`)), OCI_TIMEOUT_MS);
      const abort = () => kill(denied("OCI artifact execution was cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      child.once("close", (code, closeSignal) => {
        if (settled) return;
        settled = true;
        clearInterval(renewal);
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (terminalError) reject(terminalError);
        else if (closeSignal) reject(denied(`OCI artifact process was terminated by ${closeSignal}`));
        else if (code !== 0) reject(denied(`OCI artifact process failed: ${Buffer.concat(stderr).toString("utf8").slice(-4000)}`));
        else resolve();
      });
    });
    if (mode === "package") {
      if (outputDir === undefined) throw denied("OCI package execution omitted its output directory");
      const archive = path.join(path.dirname(outputDir), "artifact.tar");
      await writeBoundedProcessFile(
        "docker",
        ["cp", `${containerName}:/output/.`, "-"],
        archive,
        MAX_BUNDLE_BYTES + 64 * 1024,
        { PATH: process.env.PATH ?? "" },
      );
      try {
        const listing = (await execFileAsync("tar", ["-tf", archive], {
          env: { PATH: process.env.PATH ?? "" },
          timeout: 10_000,
          maxBuffer: MAX_OUTPUT_BYTES,
        })).stdout.split("\n").filter(Boolean).map((entry) => entry.replace(/^\.\//u, "")).filter(Boolean).sort();
        const verboseListing = (await execFileAsync("tar", ["-tvf", archive], {
          env: { PATH: process.env.PATH ?? "" },
          timeout: 10_000,
          maxBuffer: MAX_OUTPUT_BYTES,
        })).stdout.split("\n").filter(Boolean);
        if (verboseListing.length !== listing.length || verboseListing.some((entry) => !entry.startsWith("-"))) {
          throw denied("OCI artifact archive contains a symlink, hardlink, or non-regular entry");
        }
        if (canonicalJson(listing) !== canonicalJson(["manifest.json", "result.bundle"])) {
          throw denied("OCI artifact archive contains unexpected entries");
        }
        await writeBoundedProcessFile(
          "tar",
          ["-xOf", archive, "manifest.json"],
          path.join(outputDir, "manifest.json"),
          16 * 1024,
          { PATH: process.env.PATH ?? "" },
        );
        await writeBoundedProcessFile(
          "tar",
          ["-xOf", archive, "result.bundle"],
          path.join(outputDir, "result.bundle"),
          MAX_BUNDLE_BYTES,
          { PATH: process.env.PATH ?? "" },
        );
      } finally {
        await fs.rm(archive, { force: true });
      }
    }
    await renew();
  } finally {
    await terminateContainer(containerName);
  }
}

async function prepareTask(worktreePath: string, taskDir: string, task: MonitorOciArtifactTask): Promise<void> {
  const taskDocument = {
    version: 1,
    expectedHeadSha: task.expectedHeadSha,
    expectedTreeSha: task.expectedTreeSha,
    logicalIdentity: task.logicalIdentity,
    taskDigest: task.taskDigest,
    suggestions: task.suggestions,
  };
  await fs.writeFile(path.join(taskDir, "task.json"), `${canonicalJson(taskDocument)}\n`, { mode: 0o444, flag: "wx" });
  const sourceArchive = path.join(taskDir, "source.tar");
  await writeBoundedProcessFile(
    "git",
    ["-C", worktreePath, ...GIT_CONFIG, "archive", "--format=tar", task.expectedHeadSha],
    sourceArchive,
    MAX_SOURCE_ARCHIVE_BYTES,
    gitEnv(),
  );
  const sourceStat = await fs.lstat(sourceArchive);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size < 1 || sourceStat.size > MAX_SOURCE_ARCHIVE_BYTES) throw denied("OCI task source archive is invalid or oversized");
  const parent = await git(worktreePath, ["cat-file", "commit", task.expectedHeadSha], 1024 * 1024);
  await fs.writeFile(path.join(taskDir, "parent.commit"), parent, { mode: 0o444, flag: "wx" });
  await fs.chmod(sourceArchive, 0o444);
  await fs.chmod(taskDir, 0o555);
}

async function bareWithArtifact(worktreePath: string, bundlePath: string, headSha: string): Promise<{ root: string; gitDir: string }> {
  const root = await fs.mkdtemp(path.join(path.dirname(bundlePath), ".verify-"));
  const gitDir = path.join(root, "repository.git");
  try {
    await execFileAsync("git", ["init", "--bare", gitDir], { env: gitEnv(), maxBuffer: 1024 * 1024 });
    const commonRaw = (await git(worktreePath, ["rev-parse", "--git-common-dir"])).trim();
    const common = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(worktreePath, commonRaw);
    const objectDir = await fs.realpath(path.join(common, "objects"));
    const objectStat = await fs.lstat(objectDir);
    if (!objectStat.isDirectory() || objectStat.isSymbolicLink()) throw denied("Monitor source object database is not an exact directory");
    await fs.mkdir(path.join(gitDir, "objects", "info"), { recursive: true });
    await fs.writeFile(path.join(gitDir, "objects", "info", "alternates"), `${objectDir}\n`, { mode: 0o600 });
    await execFileAsync("git", ["--git-dir", gitDir, ...GIT_CONFIG, "bundle", "unbundle", bundlePath], { env: gitEnv(), maxBuffer: MAX_BUNDLE_BYTES });
    await execFileAsync("git", ["--git-dir", gitDir, ...GIT_CONFIG, "cat-file", "-e", `${headSha}^{commit}`], { env: gitEnv(), maxBuffer: 1024 * 1024 });
    await execFileAsync("git", ["--git-dir", gitDir, ...GIT_CONFIG, "update-ref", "refs/heads/artifact", headSha], { env: gitEnv(), maxBuffer: 1024 * 1024 });
    return { root, gitDir };
  } catch (error: unknown) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyMonitorArtifact(
  worktreePath: string,
  artifactDir: string,
  expected: MonitorOciArtifactTask,
): Promise<VerifiedMonitorArtifact> {
  const exactDir = await fs.realpath(artifactDir);
  if (exactDir !== artifactDir || (await fs.lstat(artifactDir)).isSymbolicLink()) throw denied("OCI artifact directory is not exact");
  const entries = (await fs.readdir(artifactDir)).sort();
  if (canonicalJson(entries) !== canonicalJson(["manifest.json", "result.bundle"])) throw denied("OCI artifact directory contains unexpected entries");
  const manifestPath = path.join(artifactDir, "manifest.json");
  const bundlePath = path.join(artifactDir, "result.bundle");
  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 16 * 1024) throw denied("OCI artifact manifest is invalid");
  let raw: unknown;
  try { raw = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch { throw denied("OCI artifact manifest is malformed"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw denied("OCI artifact manifest is not an object");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["version", "headSha", "treeSha", "baseHeadSha", "changedPaths", "taskDigest", "logicalIdentity", "bundleSha256"], "OCI artifact manifest");
  if (value.version !== 1 || !SHA.test(String(value.headSha)) || !SHA.test(String(value.treeSha)) || !SHA.test(String(value.baseHeadSha)) || !DIGEST.test(String(value.taskDigest)) || !DIGEST.test(String(value.logicalIdentity)) || !DIGEST.test(String(value.bundleSha256))) {
    throw denied("OCI artifact manifest contains an invalid identity");
  }
  if (!Array.isArray(value.changedPaths) || !value.changedPaths.every((item) => typeof item === "string")) throw denied("OCI artifact changed paths are invalid");
  const manifest = value as unknown as Manifest;
  const expectedPaths = [...new Set(expected.suggestions.map((item) => item.path))].sort();
  if (manifest.baseHeadSha !== expected.expectedHeadSha || manifest.taskDigest !== expected.taskDigest || manifest.logicalIdentity !== expected.logicalIdentity || canonicalJson(manifest.changedPaths) !== canonicalJson(expectedPaths)) {
    throw denied("OCI artifact manifest does not bind the exact authorized task");
  }
  const exactTreeSha = await authorizedTree(worktreePath, expected);
  if (manifest.treeSha !== exactTreeSha) throw denied("OCI artifact tree does not match the exact authorized replacements");
  if (manifest.headSha !== await authorizedCommit(worktreePath, expected, exactTreeSha)) {
    throw denied("OCI artifact commit does not match the exact deterministic authorized identity");
  }
  const bundleDigest = await sha256File(bundlePath);
  if (bundleDigest !== manifest.bundleSha256) throw denied("OCI artifact bundle digest does not match its manifest");
  await git(worktreePath, ["bundle", "verify", bundlePath], MAX_BUNDLE_BYTES);
  const heads = (await git(worktreePath, ["bundle", "list-heads", bundlePath], MAX_BUNDLE_BYTES)).trim().split("\n").filter(Boolean);
  if (heads.length !== 1 || !heads[0]?.startsWith(`${manifest.headSha} `)) throw denied("OCI artifact bundle does not expose exactly its manifested head");
  const temporary = await bareWithArtifact(worktreePath, bundlePath, manifest.headSha);
  try {
    const [head, tree, parent, parentTree, message, changed] = await Promise.all([
      execFileAsync("git", ["--git-dir", temporary.gitDir, ...GIT_CONFIG, "rev-parse", "refs/heads/artifact"], { env: gitEnv() }),
      execFileAsync("git", ["--git-dir", temporary.gitDir, ...GIT_CONFIG, "rev-parse", "refs/heads/artifact^{tree}"], { env: gitEnv() }),
      execFileAsync("git", ["--git-dir", temporary.gitDir, ...GIT_CONFIG, "rev-parse", "refs/heads/artifact^"], { env: gitEnv() }),
      execFileAsync("git", ["--git-dir", temporary.gitDir, ...GIT_CONFIG, "rev-parse", "refs/heads/artifact^1^{tree}"], { env: gitEnv() }),
      execFileAsync("git", ["--git-dir", temporary.gitDir, ...GIT_CONFIG, "show", "-s", "--format=%B", "refs/heads/artifact"], { env: gitEnv() }),
      execFileAsync("git", ["--git-dir", temporary.gitDir, ...GIT_CONFIG, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "refs/heads/artifact"], { env: gitEnv() }),
    ]);
    const expectedMessage = artifactMessage(expected);
    const changedPaths = changed.stdout.split("\0").filter(Boolean).sort();
    if (head.stdout.trim() !== manifest.headSha || tree.stdout.trim() !== manifest.treeSha || parent.stdout.trim() !== expected.expectedHeadSha || parentTree.stdout.trim() !== expected.expectedTreeSha || message.stdout.trimEnd() !== expectedMessage || canonicalJson(changedPaths) !== canonicalJson(expectedPaths)) {
      throw denied("OCI artifact git history does not exactly bind its authorized task");
    }
  } finally {
    await fs.rm(temporary.root, { recursive: true, force: true });
  }
  return { artifactDir, bundlePath, bundleSha256: bundleDigest, baseHeadSha: manifest.baseHeadSha, headSha: manifest.headSha, treeSha: manifest.treeSha, changedPaths: manifest.changedPaths, taskDigest: manifest.taskDigest, logicalIdentity: manifest.logicalIdentity };
}

export async function createVerifiedMonitorArtifact(input: {
  readonly imageDigest: string;
  readonly worktreePath: string;
  readonly stateDir: string;
  readonly task: MonitorOciArtifactTask;
  readonly renew: () => Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<VerifiedMonitorArtifact> {
  const root = await fs.mkdtemp(path.join(input.stateDir, "monitor-oci-"));
  const taskDir = path.join(root, "task");
  const outputDir = path.join(root, "output");
  await fs.mkdir(taskDir, { mode: 0o700 });
  await fs.mkdir(outputDir, { mode: 0o700 });
  try {
    await prepareTask(input.worktreePath, taskDir, input.task);
    const exactTaskDir = await fs.realpath(taskDir);
    await runDockerWithRenewal(input.imageDigest, exactTaskDir, "execute", undefined, input.renew, input.signal);
    await runDockerWithRenewal(input.imageDigest, exactTaskDir, "package", outputDir, input.renew, input.signal);
    const copiedEntries = (await fs.readdir(outputDir)).sort();
    if (canonicalJson(copiedEntries) !== canonicalJson(["manifest.json", "result.bundle"])) {
      throw denied("OCI artifact copy contains unexpected entries");
    }
    for (const name of copiedEntries) {
      const copied = path.join(outputDir, name);
      const stat = await fs.lstat(copied);
      const limit = name === "result.bundle" ? MAX_BUNDLE_BYTES : 16 * 1024;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit) throw denied("OCI artifact copy contains an invalid or oversized file");
      await fs.chmod(copied, 0o600);
    }
    await fs.chmod(outputDir, 0o700);
    const artifact = await verifyMonitorArtifact(input.worktreePath, outputDir, input.task);
    const durableRoot = path.join(input.stateDir, "monitor-artifacts");
    await fs.mkdir(durableRoot, { recursive: true, mode: 0o700 });
    await cleanupDurableArtifacts(durableRoot);
    const artifactKey = createHash("sha256").update(`${artifact.taskDigest}:${artifact.headSha}:${artifact.bundleSha256}`).digest("hex");
    const durableDir = path.join(durableRoot, artifactKey);
    try {
      await fs.rename(outputDir, durableDir);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await verifyMonitorArtifact(input.worktreePath, durableDir, input.task);
      if (existing.bundleSha256 !== artifact.bundleSha256 || existing.headSha !== artifact.headSha) throw denied("Durable OCI artifact identity collided");
    }
    return verifyMonitorArtifact(input.worktreePath, durableDir, input.task);
  } finally {
    await fs.chmod(taskDir, 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
}

type GithubCommand = (args: readonly string[]) => Promise<string>;

async function githubCommand(args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("gh", [...args], {
      env: { ...process.env },
      timeout: GITHUB_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return result.stdout;
  } catch (error: unknown) {
    const value = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (value?.code === "ETIMEDOUT" || value?.killed || value?.signal === "SIGKILL") {
      throw denied(`GitHub GraphQL request timed out after ${GITHUB_TIMEOUT_MS}ms`);
    }
    throw denied(`GitHub CLI request failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function requireRecordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw denied(`${label} returned a malformed response`);
  return value as Record<string, unknown>;
}

function parseGraphqlResponse(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw denied(`${label} returned malformed GraphQL JSON`);
  }
  const response = requireRecordValue(parsed, label);
  if ("errors" in response) {
    if (!Array.isArray(response.errors) || response.errors.length < 1) throw denied(`${label} returned malformed GraphQL errors`);
    const message = response.errors.map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item) && typeof (item as { message?: unknown }).message === "string") return (item as { message: string }).message;
      return "unknown GraphQL error";
    }).join("; ");
    throw denied(`${label} rejected the ref CAS: ${message}`);
  }
  return requireRecordValue(response.data, `${label} data`);
}

async function remoteRefSha(ref: string): Promise<string | undefined> {
  const result = await execFileAsync(
    "git",
    ["ls-remote", "--refs", FIXED_PUSH_ENDPOINT, ref],
    { env: gitEnv(), timeout: GITHUB_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
  );
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return undefined;
  if (lines.length !== 1) throw denied("Artifact staging ref lookup returned multiple refs");
  const fields = lines[0]!.trim().split(/\s+/u);
  if (fields.length !== 2 || fields[1] !== ref || !SHA.test(fields[0]!)) {
    throw denied("Artifact staging ref lookup returned malformed output");
  }
  return fields[0]!;
}

// The staging name is deterministic for the authorized effect, so a replay can
// reuse a ref left behind before the GraphQL mutation completed.
function stagingRefFor(headRef: string, task: MonitorOciArtifactTask, headSha: string): string {
  const operation = createHash("sha256")
    .update(`${FIXED_GITHUB_OWNER}/${FIXED_GITHUB_REPOSITORY}:${headRef}:${task.logicalIdentity}:${task.taskDigest}:${headSha}`, "utf8")
    .digest("hex");
  return `${STAGING_REF_PREFIX}${operation}`;
}

async function pushStagingWithRenewal(
  gitDir: string,
  headSha: string,
  stagingRef: string,
  renew: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  await renew();
  if (signal?.aborted) throw denied("Artifact staging push was cancelled before start");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", [
      "--git-dir", gitDir, ...GIT_CONFIG, "push", "--porcelain", FIXED_PUSH_ENDPOINT,
      `${headSha}:${stagingRef}`,
    ], { stdio: ["ignore", "pipe", "pipe"], env: gitEnv(), detached: process.platform !== "win32" });
    const output: Buffer[] = [];
    let bytes = 0;
    let terminalError: Error | undefined;
    let renewalRunning = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (error: Error) => {
      if (terminalError) return;
      terminalError = error;
      if (process.platform !== "win32" && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      } else child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          if (process.platform !== "win32" && child.pid !== undefined) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
          } else child.kill("SIGKILL");
        }
      }, PROCESS_KILL_GRACE_MS);
      killTimer.unref();
    };
    const consume = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) terminate(denied("Artifact staging push output exceeded 1MiB"));
      else output.push(chunk);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", (error) => terminate(denied(`Artifact staging push could not start: ${error.message}`)));
    const renewal = setInterval(() => {
      if (renewalRunning || terminalError) return;
      renewalRunning = true;
      void renew().catch((error: unknown) => {
        terminate(denied(`Artifact staging lease renewal failed: ${error instanceof Error ? error.message : "unknown error"}`));
      }).finally(() => { renewalRunning = false; });
    }, RENEW_INTERVAL_MS);
    const timeout = setTimeout(() => terminate(denied(`Artifact staging push timed out after ${HOST_PROCESS_TIMEOUT_MS}ms`)), HOST_PROCESS_TIMEOUT_MS);
    timeout.unref();
    const abort = () => terminate(denied("Artifact staging push was cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearInterval(renewal);
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (terminalError) reject(terminalError);
      else if (closeSignal) reject(denied(`Artifact staging push was terminated by ${closeSignal}`));
      else if (code !== 0) reject(denied(`Artifact staging push failed: ${Buffer.concat(output).toString("utf8").slice(-4000)}`));
      else if (/\[(?:remote rejected|rejected|remote failure)\]/u.test(Buffer.concat(output).toString("utf8"))) {
        reject(denied("Artifact staging ref was rejected during the normal push"));
      } else resolve();
    });
  });
  const staged = await remoteRefSha(stagingRef);
  if (staged !== headSha) throw denied("Artifact staging ref did not resolve to the exact authorized commit");
  await renew();
}

async function repositoryNodeId(command: GithubCommand): Promise<string> {
  const query = `query{repository(owner:${JSON.stringify(FIXED_GITHUB_OWNER)},name:${JSON.stringify(FIXED_GITHUB_REPOSITORY)}){id}}`;
  const data = parseGraphqlResponse(await command(["api", "graphql", "-f", `query=${query}`]), "GitHub repository query");
  const repository = requireRecordValue(data.repository, "GitHub repository query repository");
  if (typeof repository.id !== "string" || !/^[A-Za-z0-9_+/=:-]{1,256}$/u.test(repository.id)) {
    throw denied("GitHub repository query returned a malformed repository ID");
  }
  return repository.id;
}

async function updateRefsCas(
  command: GithubCommand,
  repositoryId: string,
  headRef: string,
  stagingRef: string,
  expectedHeadSha: string,
  headSha: string,
): Promise<void> {
  const targetRef = `refs/heads/${headRef}`;
  const query = [
    "mutation{updateRefs(input:{",
    `repositoryId:${JSON.stringify(repositoryId)},`,
    "refUpdates:[",
    `{name:${JSON.stringify(targetRef)},beforeOid:${JSON.stringify(expectedHeadSha)},afterOid:${JSON.stringify(headSha)},force:false},`,
    `{name:${JSON.stringify(stagingRef)},beforeOid:${JSON.stringify(headSha)},afterOid:${JSON.stringify(ZERO_SHA)},force:false}`,
    "]}){clientMutationId}}",
  ].join("");
  const data = parseGraphqlResponse(await command(["api", "graphql", "-f", `query=${query}`]), "GitHub ref CAS");
  const update = requireRecordValue(data.updateRefs, "GitHub ref CAS updateRefs");
  if (!Object.hasOwn(update, "clientMutationId") || (update.clientMutationId !== null && typeof update.clientMutationId !== "string")) {
    throw denied("GitHub ref CAS returned a malformed updateRefs payload");
  }
}

async function pushWithRenewal(
  gitDir: string,
  headSha: string,
  headRef: string,
  expectedHeadSha: string,
  task: MonitorOciArtifactTask,
  renew: () => Promise<void>,
  signal?: AbortSignal,
  command: GithubCommand = githubCommand,
): Promise<void> {
  await renew();
  if (signal?.aborted) throw denied("Artifact push was cancelled before start");
  if (!SHA.test(headSha) || !SHA.test(expectedHeadSha)) throw denied("Artifact push commits are not exact SHA-1 identities");
  if (!safeHeadRef(headRef)) throw denied("Artifact push headRef is invalid");
  const stagingRef = stagingRefFor(headRef, task, headSha);
  const existing = await remoteRefSha(stagingRef);
  if (existing !== undefined && existing !== headSha) {
    throw denied("Artifact staging ref already exists with a different commit");
  }
  if (existing === undefined) await pushStagingWithRenewal(gitDir, headSha, stagingRef, renew, signal);
  const repositoryId = await repositoryNodeId(command);
  try {
    await renew();
    if (signal?.aborted) throw denied("Artifact ref CAS was cancelled before start");
    await updateRefsCas(command, repositoryId, headRef, stagingRef, expectedHeadSha, headSha);
  } catch (error: unknown) {
    let staged: string | undefined;
    try {
      staged = await remoteRefSha(stagingRef);
    } catch {
      throw denied("Artifact ref CAS cleanup state is uncertain");
    }
    if (staged !== headSha) throw denied("Artifact ref CAS cleanup state is uncertain");
    throw error instanceof Error ? error : denied("Artifact ref CAS failed");
  }
  await renew();
}

export async function pushVerifiedMonitorArtifact(input: {
  readonly worktreePath: string;
  readonly artifact: VerifiedMonitorArtifact;
  readonly expectedTask: MonitorOciArtifactTask;
  readonly headRef: string;
  readonly renew: () => Promise<void>;
  readonly signal?: AbortSignal;
  readonly githubCommand?: GithubCommand;
}): Promise<void> {
  if (!safeHeadRef(input.headRef)) throw denied("Artifact push headRef is invalid");
  const verified = await verifyMonitorArtifact(input.worktreePath, input.artifact.artifactDir, input.expectedTask);
  if (verified.bundleSha256 !== input.artifact.bundleSha256 || verified.headSha !== input.artifact.headSha || verified.treeSha !== input.artifact.treeSha) throw denied("Artifact changed after verification");
  const temporary = await bareWithArtifact(input.worktreePath, verified.bundlePath, verified.headSha);
  try {
    await pushWithRenewal(temporary.gitDir, verified.headSha, input.headRef, input.expectedTask.expectedHeadSha, input.expectedTask, input.renew, input.signal, input.githubCommand);
  } finally {
    await fs.rm(temporary.root, { recursive: true, force: true });
  }
}
