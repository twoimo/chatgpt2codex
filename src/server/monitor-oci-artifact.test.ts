import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createVerifiedMonitorArtifact,
  pushVerifiedMonitorArtifact,
  verifyMonitorArtifact,
  type MonitorOciArtifactTask,
} from "./monitor-oci-artifact.js";

const execFileAsync = promisify(execFile);
const originalPath = process.env.PATH;
const cleanup: string[] = [];

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, ...env },
  });
  return result.stdout.trim();
}

async function fixture(forgedMetadata = false): Promise<{
  root: string;
  repository: string;
  artifactDir: string;
  task: MonitorOciArtifactTask;
}> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "monitor-oci-artifact-test-")));
  cleanup.push(root);
  const repository = path.join(root, "repository");
  const artifactDir = path.join(root, "artifact");
  await mkdir(path.join(repository, "packages", "fixture"), { recursive: true });
  await mkdir(artifactDir);
  await git(repository, ["init", "--quiet"]);
  await writeFile(path.join(repository, "packages", "fixture", "value.ts"), "old\n", "utf8");
  await git(repository, ["add", "-A"]);
  await git(repository, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base"]);
  const expectedHeadSha = await git(repository, ["rev-parse", "HEAD"]);
  const expectedTreeSha = await git(repository, ["rev-parse", "HEAD^{tree}"]);
  const logicalIdentity = "1".repeat(64);
  const taskDigest = "2".repeat(64);
  const task: MonitorOciArtifactTask = {
    expectedHeadSha,
    expectedTreeSha,
    logicalIdentity,
    taskDigest,
    suggestions: [{
      threadId: "thread",
      commentId: "comment",
      path: "packages/fixture/value.ts",
      startLine: 1,
      line: 1,
      replacement: "new",
      sourceDigest: createHash("sha256").update("old").digest("hex"),
    }],
  };

  await writeFile(path.join(repository, "packages", "fixture", "value.ts"), "new\n", "utf8");
  await git(repository, ["add", "--", "packages/fixture/value.ts"]);
  const treeSha = await git(repository, ["write-tree"]);
  const message = `Apply authorized PR suggestions\n\nGJC-Logical-Identity: ${logicalIdentity}\nGJC-Plan-Digest: ${taskDigest}`;
  const seed = createHash("sha256").update(`${logicalIdentity}:${taskDigest}`).digest();
  const timestamp = 946_684_800 + (seed.readUInt32BE(0) % 946_080_000);
  const headSha = await git(repository, ["commit-tree", treeSha, "-p", expectedHeadSha, "-m", message], {
    GIT_AUTHOR_NAME: forgedMetadata ? "test" : "gajae-code[bot]",
    GIT_AUTHOR_EMAIL: forgedMetadata ? "test@example.invalid" : "gajae-code[bot]@users.noreply.github.com",
    GIT_AUTHOR_DATE: forgedMetadata ? "@1000000000 +0000" : `@${timestamp} +0000`,
    GIT_COMMITTER_NAME: forgedMetadata ? "test" : "gajae-code[bot]",
    GIT_COMMITTER_EMAIL: forgedMetadata ? "test@example.invalid" : "gajae-code[bot]@users.noreply.github.com",
    GIT_COMMITTER_DATE: forgedMetadata ? "@1000000000 +0000" : `@${timestamp} +0000`,
  });
  await git(repository, ["update-ref", "refs/heads/artifact", headSha]);
  const bundlePath = path.join(artifactDir, "result.bundle");
  await git(repository, ["bundle", "create", bundlePath, "refs/heads/artifact", `^${expectedHeadSha}`]);
  const bundleSha256 = createHash("sha256").update(await readFile(bundlePath)).digest("hex");
  await writeFile(path.join(artifactDir, "manifest.json"), `${JSON.stringify({
    version: 1,
    headSha,
    treeSha,
    baseHeadSha: expectedHeadSha,
    changedPaths: ["packages/fixture/value.ts"],
    taskDigest,
    logicalIdentity,
    bundleSha256,
  })}\n`, "utf8");
  await git(repository, ["reset", "--hard", expectedHeadSha]);
  return { root, repository, artifactDir, task };
}

async function createDockerArchiveFixture(value: Awaited<ReturnType<typeof fixture>>, kind: "symlink" | "hardlink" | "duplicate"): Promise<{
  stateDir: string;
  logPath: string;
}> {
  const stateDir = path.join(value.root, `state-${kind}`);
  const binDir = path.join(value.root, `bin-${kind}`);
  const logPath = path.join(value.root, `docker-${kind}.log`);
  const archiveRoot = path.join(value.root, `archive-${kind}`);
  const archivePath = path.join(value.root, `${kind}.tar`);
  await mkdir(stateDir);
  await mkdir(binDir);
  await mkdir(archiveRoot);
  await writeFile(path.join(archiveRoot, "result.bundle"), await readFile(path.join(value.artifactDir, "result.bundle")));
  if (kind === "symlink") {
    await symlink("result.bundle", path.join(archiveRoot, "manifest.json"));
    await execFileAsync("tar", ["-cf", archivePath, "-C", archiveRoot, "manifest.json", "result.bundle"]);
  } else if (kind === "hardlink") {
    await link(path.join(archiveRoot, "result.bundle"), path.join(archiveRoot, "manifest.json"));
    await execFileAsync("tar", ["-cf", archivePath, "-C", archiveRoot, "manifest.json", "result.bundle"]);
  } else {
    await writeFile(path.join(archiveRoot, "manifest.json"), await readFile(path.join(value.artifactDir, "manifest.json")));
    await execFileAsync("tar", ["-cf", archivePath, "-C", archiveRoot, "manifest.json", "manifest.json", "result.bundle"]);
  }
  const docker = path.join(binDir, "docker");
  await writeFile(docker, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "cp") {
  process.stdout.write(fs.readFileSync(${JSON.stringify(archivePath)}));
  process.exit(0);
}
process.exit(0);
`, "utf8");
  await chmod(docker, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return { stateDir, logPath };
}
async function createCasHarness(
  value: Awaited<ReturnType<typeof fixture>>,
  mode: "success" | "conflict" | "malformed" | "invalid-sha" | "wrong-ref" | "extra-fields" | "missing-row" | "multiple-rows" = "success",
  staging?: string,
): Promise<{
  gitLog: string;
  ghLog: string;
  statePath: string;
}> {
  const binDir = path.join(value.root, `cas-bin-${mode}-${staging ?? "empty"}`);
  const gitLog = path.join(value.root, `cas-git-${mode}.log`);
  const ghLog = path.join(value.root, `cas-gh-${mode}.log`);
  const statePath = path.join(value.root, `cas-state-${mode}.json`);
  await mkdir(binDir);
  const manifest = JSON.parse(await readFile(path.join(value.artifactDir, "manifest.json"), "utf8")) as { headSha: string };
  await writeFile(statePath, JSON.stringify({ target: value.task.expectedHeadSha, staging: staging ?? null }), "utf8");
  const fakeGit = path.join(binDir, "git");
  await writeFile(fakeGit, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(args) + "\\n");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
if (args.includes("ls-remote")) {
  const ref = args[args.length - 1];
  const sha = ref.startsWith("refs/heads/gajae-code-monitor/") ? state.staging : state.target;
  const lsRemoteMode = ${JSON.stringify(mode)};
  if (lsRemoteMode === "missing-row") process.exit(0);
  if (lsRemoteMode === "invalid-sha") process.stdout.write("not-a-sha\\t" + ref + "\\n");
  else if (lsRemoteMode === "wrong-ref") process.stdout.write((sha ?? "a".repeat(40)) + "\\trefs/heads/wrong\\n");
  else if (lsRemoteMode === "extra-fields") process.stdout.write((sha ?? "a".repeat(40)) + "\\t" + ref + "\\textra\\n");
  else if (lsRemoteMode === "multiple-rows") process.stdout.write((sha ?? "a".repeat(40)) + "\\t" + ref + "\\n" + (sha ?? "a".repeat(40)) + "\\t" + ref + "\\n");
  else if (sha) process.stdout.write(sha + "\\t" + ref + "\\n");
  process.exit(0);
}
if (args.includes("push")) {
  const spec = args[args.length - 1];
  state.staging = spec.slice(0, 40);
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write("  " + spec + " [new branch]\\n");
  process.exit(0);
}
const result = spawnSync("/usr/bin/git", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`, "utf8");
  await chmod(fakeGit, 0o755);
  const fakeGh = path.join(binDir, "gh");
  await writeFile(fakeGh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args) + "\\n");
const query = args.find((arg) => arg.startsWith("query="))?.slice("query=".length) ?? "";
if (query.includes("updateRefs")) {
  if (${JSON.stringify(mode)} === "conflict") {
    process.stdout.write(JSON.stringify({ errors: [{ message: "beforeOid does not match" }] }));
    process.exit(0);
  }
  if (${JSON.stringify(mode)} === "malformed") {
    process.stdout.write("not-json");
    process.exit(0);
  }
  const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
  state.target = ${JSON.stringify(manifest.headSha)};
  state.staging = null;
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ data: { repository: { id: "repo-node-id" } } }));
`, "utf8");
  await chmod(fakeGh, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return { gitLog, ghLog, statePath };
}

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("monitor OCI artifact", () => {
  it("verifies an exact bundle and removes its temporary bare repository", async () => {
    const value = await fixture();
    const verified = await verifyMonitorArtifact(value.repository, value.artifactDir, value.task);
    expect(verified).toMatchObject({
      baseHeadSha: value.task.expectedHeadSha,
      taskDigest: value.task.taskDigest,
      logicalIdentity: value.task.logicalIdentity,
      changedPaths: ["packages/fixture/value.ts"],
    });
    expect((await readdir(value.artifactDir)).sort()).toEqual(["manifest.json", "result.bundle"]);
  });
  it("uses the required gajae-code bot identity for authorized commits", async () => {
    const value = await fixture();
    await expect(git(value.repository, ["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", "refs/heads/artifact"]))
      .resolves.toBe("gajae-code[bot]\u0000gajae-code[bot]@users.noreply.github.com\u0000gajae-code[bot]\u0000gajae-code[bot]@users.noreply.github.com");
  });

  it("rejects a bundle with non-deterministic commit metadata", async () => {
    const value = await fixture(true);
    await expect(verifyMonitorArtifact(value.repository, value.artifactDir, value.task))
      .rejects.toThrow(/deterministic authorized identity/);
  });

  it("rejects a mismatched authorized parent tree and cleans verification state", async () => {
    const value = await fixture();
    await expect(verifyMonitorArtifact(value.repository, value.artifactDir, {
      ...value.task,
      expectedTreeSha: "f".repeat(40),
    })).rejects.toThrow("git history does not exactly bind");
    expect((await readdir(value.artifactDir)).sort()).toEqual(["manifest.json", "result.bundle"]);
  });
  it("rejects a forged manifest tree even when its metadata and bundle digest are valid", async () => {
    const value = await fixture();
    const manifestPath = path.join(value.artifactDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.treeSha = "f".repeat(40);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await expect(verifyMonitorArtifact(value.repository, value.artifactDir, value.task)).rejects.toThrow("tree does not match the exact authorized replacements");
  });

  it("removes the named container and anonymous output volume when execution fails", async () => {
    const value = await fixture();
    const stateDir = path.join(value.root, "state");
    const binDir = path.join(value.root, "bin");
    const logPath = path.join(value.root, "docker.log");
    await mkdir(stateDir);
    await mkdir(binDir);
    const docker = path.join(binDir, "docker");
    await writeFile(docker, `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");\nprocess.exit(args[0] === "run" ? 17 : 0);\n`, "utf8");
    await chmod(docker, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    await expect(createVerifiedMonitorArtifact({
      imageDigest: `sha256:${"a".repeat(64)}`,
      worktreePath: value.repository,
      stateDir,
      task: value.task,
      renew: async () => undefined,
    })).rejects.toThrow("OCI artifact process failed");

    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const run = calls.find((args) => args[0] === "run");
    expect(run).toBeDefined();
    const containerName = run?.find((arg) => arg.startsWith("--name="))?.slice("--name=".length);
    expect(calls).toContainEqual(["rm", "-fv", containerName]);
    expect(await readdir(stateDir)).toEqual([]);
  });
  it("stages the exact commit and applies an atomic GraphQL CAS without force-like arguments", async () => {
    const value = await fixture();
    const manifest = JSON.parse(await readFile(path.join(value.artifactDir, "manifest.json"), "utf8")) as { headSha: string; treeSha: string };
    const harness = await createCasHarness(value);
    await pushVerifiedMonitorArtifact({
      worktreePath: value.repository,
      artifact: {
        artifactDir: value.artifactDir,
        bundlePath: path.join(value.artifactDir, "result.bundle"),
        bundleSha256: createHash("sha256").update(await readFile(path.join(value.artifactDir, "result.bundle"))).digest("hex"),
        baseHeadSha: value.task.expectedHeadSha,
        headSha: manifest.headSha,
        treeSha: manifest.treeSha,
        changedPaths: ["packages/fixture/value.ts"],
        taskDigest: value.task.taskDigest,
        logicalIdentity: value.task.logicalIdentity,
      },
      expectedTask: value.task,
      headRef: "monitor",
      renew: async () => undefined,
    });

    const gitCalls = (await readFile(harness.gitLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    const push = gitCalls.find((args) => args.includes("push"));
    expect(push).toBeDefined();
    expect(push?.some((arg) => arg === "--force" || arg === "--force-with-lease" || arg.startsWith("+"))).toBe(false);
    expect(push?.at(-1)).toMatch(new RegExp(`^${manifest.headSha}:refs/heads/gajae-code-monitor/[a-f0-9]{64}$`));
    const ghCalls = (await readFile(harness.ghLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    expect(ghCalls).toHaveLength(2);
    const mutation = ghCalls.find((args) => args.some((arg) => arg.includes("updateRefs")));
    const query = mutation?.find((arg) => arg.startsWith("query=")) ?? "";
    expect(query).toContain(`beforeOid:${JSON.stringify(value.task.expectedHeadSha)}`);
    expect(query).toContain(`afterOid:${JSON.stringify(manifest.headSha)}`);
    expect(query).toContain("force:false");
    expect(query).toContain(`afterOid:${JSON.stringify("0".repeat(40))}`);
    expect(query).not.toContain("--force");
    const state = JSON.parse(await readFile(harness.statePath, "utf8")) as { target: string; staging: string | null };
    expect(state.target).toBe(manifest.headSha);
    expect(state.staging).toBeNull();
  });

  it("rejects a GraphQL CAS conflict without mutating the target and preserves staging for replay", async () => {
    const value = await fixture();
    const manifest = JSON.parse(await readFile(path.join(value.artifactDir, "manifest.json"), "utf8")) as { headSha: string; treeSha: string };
    const harness = await createCasHarness(value, "conflict");
    await expect(pushVerifiedMonitorArtifact({
      worktreePath: value.repository,
      artifact: {
        artifactDir: value.artifactDir,
        bundlePath: path.join(value.artifactDir, "result.bundle"),
        bundleSha256: createHash("sha256").update(await readFile(path.join(value.artifactDir, "result.bundle"))).digest("hex"),
        baseHeadSha: value.task.expectedHeadSha,
        headSha: manifest.headSha,
        treeSha: manifest.treeSha,
        changedPaths: ["packages/fixture/value.ts"],
        taskDigest: value.task.taskDigest,
        logicalIdentity: value.task.logicalIdentity,
      },
      expectedTask: value.task,
      headRef: "monitor",
      renew: async () => undefined,
    })).rejects.toThrow("rejected the ref CAS");
    const state = JSON.parse(await readFile(harness.statePath, "utf8")) as { target: string; staging: string | null };
    expect(state.target).toBe(value.task.expectedHeadSha);
    expect(state.staging).toBe(manifest.headSha);
    const gitCalls = (await readFile(harness.gitLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    expect(gitCalls.filter((args) => args.includes("push"))).toHaveLength(1);
    expect(gitCalls.filter((args) => args.includes("push")).every((args) => !args.some((arg) => arg.includes("refs/heads/monitor")))).toBe(true);
  });

  it("rejects stale or colliding staging refs before calling GraphQL", async () => {
    const value = await fixture();
    const manifest = JSON.parse(await readFile(path.join(value.artifactDir, "manifest.json"), "utf8")) as { headSha: string; treeSha: string };
    const harness = await createCasHarness(value, "success", "f".repeat(40));
    await expect(pushVerifiedMonitorArtifact({
      worktreePath: value.repository,
      artifact: {
        artifactDir: value.artifactDir,
        bundlePath: path.join(value.artifactDir, "result.bundle"),
        bundleSha256: createHash("sha256").update(await readFile(path.join(value.artifactDir, "result.bundle"))).digest("hex"),
        baseHeadSha: value.task.expectedHeadSha,
        headSha: manifest.headSha,
        treeSha: manifest.treeSha,
        changedPaths: ["packages/fixture/value.ts"],
        taskDigest: value.task.taskDigest,
        logicalIdentity: value.task.logicalIdentity,
      },
      expectedTask: value.task,
      headRef: "monitor",
      renew: async () => undefined,
    })).rejects.toThrow("different commit");
    expect(await readFile(harness.ghLog, "utf8").catch(() => "")).toBe("");
    const gitCalls = (await readFile(harness.gitLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    expect(gitCalls.filter((args) => args.includes("push"))).toHaveLength(0);
  });
  it("fails closed on malformed ls-remote rows while preserving staging", async () => {
    const cases = [
      { mode: "invalid-sha", error: "malformed output" },
      { mode: "wrong-ref", error: "malformed output" },
      { mode: "extra-fields", error: "malformed output" },
      { mode: "missing-row", error: "exact authorized commit" },
      { mode: "multiple-rows", error: "multiple refs" },
    ] as const;
    for (const { mode, error } of cases) {
      const value = await fixture();
      const manifest = JSON.parse(await readFile(path.join(value.artifactDir, "manifest.json"), "utf8")) as { headSha: string; treeSha: string };
      const harness = await createCasHarness(value, mode, manifest.headSha);
      await expect(pushVerifiedMonitorArtifact({
        worktreePath: value.repository,
        artifact: {
          artifactDir: value.artifactDir,
          bundlePath: path.join(value.artifactDir, "result.bundle"),
          bundleSha256: createHash("sha256").update(await readFile(path.join(value.artifactDir, "result.bundle"))).digest("hex"),
          baseHeadSha: value.task.expectedHeadSha,
          headSha: manifest.headSha,
          treeSha: manifest.treeSha,
          changedPaths: ["packages/fixture/value.ts"],
          taskDigest: value.task.taskDigest,
          logicalIdentity: value.task.logicalIdentity,
        },
        expectedTask: value.task,
        headRef: "monitor",
        renew: async () => undefined,
      })).rejects.toThrow(error);

      const state = JSON.parse(await readFile(harness.statePath, "utf8")) as { staging: string | null };
      expect(state.staging).toBe(manifest.headSha);
      expect(await readFile(harness.ghLog, "utf8").catch(() => "")).toBe("");
      const gitCalls = (await readFile(harness.gitLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
      expect(gitCalls.filter((args) => args.includes("push"))).toHaveLength(mode === "missing-row" ? 1 : 0);
    }
  });

  it("replays an already-created staging ref and cleans it in the successful CAS", async () => {
    const value = await fixture();
    const manifest = JSON.parse(await readFile(path.join(value.artifactDir, "manifest.json"), "utf8")) as { headSha: string; treeSha: string };
    const stagingRef = `refs/heads/gajae-code-monitor/${createHash("sha256").update(`Yeachan-Heo/gajae-code:monitor:${value.task.logicalIdentity}:${value.task.taskDigest}:${manifest.headSha}`, "utf8").digest("hex")}`;
    const harness = await createCasHarness(value, "success", manifest.headSha);
    await pushVerifiedMonitorArtifact({
      worktreePath: value.repository,
      artifact: {
        artifactDir: value.artifactDir,
        bundlePath: path.join(value.artifactDir, "result.bundle"),
        bundleSha256: createHash("sha256").update(await readFile(path.join(value.artifactDir, "result.bundle"))).digest("hex"),
        baseHeadSha: value.task.expectedHeadSha,
        headSha: manifest.headSha,
        treeSha: manifest.treeSha,
        changedPaths: ["packages/fixture/value.ts"],
        taskDigest: value.task.taskDigest,
        logicalIdentity: value.task.logicalIdentity,
      },
      expectedTask: value.task,
      headRef: "monitor",
      renew: async () => undefined,
    });
    const gitCalls = (await readFile(harness.gitLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    expect(gitCalls.filter((args) => args.includes("push"))).toHaveLength(0);
    const mutation = (await readFile(harness.ghLog, "utf8")).split("\n").map((line) => line && JSON.parse(line) as string[]).find((args) => args.some((arg) => arg.includes("updateRefs")));
    expect(mutation?.find((arg) => arg.startsWith("query="))).toContain(`name:${JSON.stringify(stagingRef)}`);
  });
  it("fails closed on malformed GraphQL responses while staging cleanup is uncertain", async () => {
    const value = await fixture();
    const manifest = JSON.parse(await readFile(path.join(value.artifactDir, "manifest.json"), "utf8")) as { headSha: string; treeSha: string };
    const harness = await createCasHarness(value, "malformed");
    await expect(pushVerifiedMonitorArtifact({
      worktreePath: value.repository,
      artifact: {
        artifactDir: value.artifactDir,
        bundlePath: path.join(value.artifactDir, "result.bundle"),
        bundleSha256: createHash("sha256").update(await readFile(path.join(value.artifactDir, "result.bundle"))).digest("hex"),
        baseHeadSha: value.task.expectedHeadSha,
        headSha: manifest.headSha,
        treeSha: manifest.treeSha,
        changedPaths: ["packages/fixture/value.ts"],
        taskDigest: value.task.taskDigest,
        logicalIdentity: value.task.logicalIdentity,
      },
      expectedTask: value.task,
      headRef: "monitor",
      renew: async () => undefined,
    })).rejects.toThrow("malformed GraphQL JSON");
    const state = JSON.parse(await readFile(harness.statePath, "utf8")) as { staging: string | null };
    expect(state.staging).toBe(manifest.headSha);
  });
  it("terminates oversized host process output and cleans the temporary state", async () => {
    const value = await fixture();
    const stateDir = path.join(value.root, "state");
    const binDir = path.join(value.root, "bin");
    const logPath = path.join(value.root, "docker.log");
    await mkdir(stateDir);
    await mkdir(binDir);
    const docker = path.join(binDir, "docker");
    await writeFile(docker, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "run") {
  process.stdout.write("x".repeat(1024 * 1024 + 1));
  setInterval(() => undefined, 1000);
} else process.exit(0);
`, "utf8");
    await chmod(docker, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    await expect(createVerifiedMonitorArtifact({
      imageDigest: `sha256:${"a".repeat(64)}`,
      worktreePath: value.repository,
      stateDir,
      task: value.task,
      renew: async () => undefined,
    })).rejects.toThrow("output exceeded 1MiB");

    expect(await readdir(stateDir)).toEqual([]);
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls.some((args) => args[0] === "rm")).toBe(true);
  });
  it("rejects docker cp failures and cleans its temporary state", async () => {
    const value = await fixture();
    const stateDir = path.join(value.root, "state-cp-failure");
    const binDir = path.join(value.root, "bin-cp-failure");
    const logPath = path.join(value.root, "docker-cp-failure.log");
    await mkdir(stateDir);
    await mkdir(binDir);
    const docker = path.join(binDir, "docker");
    await writeFile(docker, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "cp") {
  process.stderr.write("copy failed");
  process.exit(23);
}
process.exit(0);
`, "utf8");
    await chmod(docker, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    await expect(createVerifiedMonitorArtifact({
      imageDigest: `sha256:${"a".repeat(64)}`,
      worktreePath: value.repository,
      stateDir,
      task: value.task,
      renew: async () => undefined,
    })).rejects.toThrow("docker did not produce a complete bounded file");

    expect(await readdir(stateDir)).toEqual([]);
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls.filter((args) => args[0] === "cp")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "rm")).toHaveLength(2);
  });

  it("rejects a source archive over the bounded cap before OCI execution", async () => {
    const value = await fixture();
    const stateDir = path.join(value.root, "state-source-cap");
    const binDir = path.join(value.root, "bin-source-cap");
    await mkdir(stateDir);
    await mkdir(binDir);
    const fakeGit = path.join(binDir, "git");
    await writeFile(fakeGit, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("archive")) {
  const chunk = Buffer.alloc(1024 * 1024);
  let remaining = 257;
  const writeChunk = () => {
    while (remaining > 0) {
      remaining -= 1;
      if (!process.stdout.write(chunk)) {
        process.stdout.once("drain", writeChunk);
        return;
      }
    }
    process.stdout.end(() => process.exit(0));
  };
  writeChunk();
} else {
  const result = spawnSync("/usr/bin/git", args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`, "utf8");
    await chmod(fakeGit, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    await expect(createVerifiedMonitorArtifact({
      imageDigest: `sha256:${"a".repeat(64)}`,
      worktreePath: value.repository,
      stateDir,
      task: value.task,
      renew: async () => undefined,
    })).rejects.toThrow("output exceeded its 268435456-byte storage bound");

    expect(await readdir(stateDir)).toEqual([]);
  });
  it("rejects hostile package archives and removes their temporary state", async () => {
    for (const kind of ["symlink", "hardlink", "duplicate"] as const) {
      const value = await fixture();
      const docker = await createDockerArchiveFixture(value, kind);
      await expect(createVerifiedMonitorArtifact({
        imageDigest: `sha256:${"a".repeat(64)}`,
        worktreePath: value.repository,
        stateDir: docker.stateDir,
        task: value.task,
        renew: async () => undefined,
      })).rejects.toThrow(kind === "duplicate" ? "unexpected entries" : "symlink, hardlink, or non-regular");
      expect(await readdir(docker.stateDir)).toEqual([]);
      const calls = (await readFile(docker.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(calls.filter((args) => args[0] === "run")).toHaveLength(2);
      expect(calls.filter((args) => args[0] === "rm")).toHaveLength(2);
    }
  });
});
