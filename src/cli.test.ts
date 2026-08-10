import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("CLI Actions mode startup", () => {
  it("rejects an unknown mode before scanning the workspace or saving projects", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-cli-mode-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });

    const cliPath = path.resolve("src/cli.ts");
    const stateDir = path.join(home, ".local", "share", "chatgpt2codex");
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx/esm", cliPath, "serve", "--http", "--workspace", workspace],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CHATGPT2CODEX_ACTIONS_MODE: "unrecognized-mode",
        },
        timeout: 10_000,
      },
    ).catch((error: unknown) => error as { stderr?: string; stdout?: string; code?: number });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      'CHATGPT2CODEX_ACTIONS_MODE must be either "general" or "github-pr-monitor".',
    );
    await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
