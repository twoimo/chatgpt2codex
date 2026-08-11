import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DomainError, ErrorCode } from "../types.js";

/**
 * Command metadata as discovered from project manifests. `argv` is the
 * literal argv array used by `execFile` — never a shell string — so
 * discovered commands can be executed without ever invoking a shell.
 */
interface DiscoveredCommand {
  commandId: string;
  display: string;
  source: string;
  riskTier: string;
  argv: string[];
}

const MAX_TIMEOUT_SEC = 300;
const DEFAULT_TIMEOUT_SEC = 30;
/** Head+tail bytes kept per stream when truncating output. */
const OUTPUT_HEAD_BYTES = 4000;
const OUTPUT_TAIL_BYTES = 2000;
const isGithubMutationIntent = (argv: readonly string[]): boolean => {
  const text = argv.join(" ").toLowerCase();
  return /(^|[\s;&|])(?:gh|hub)(?:[\s;&|]|$)/.test(text)
    || /git\s+(?:push|commit|update-ref|send-pack|receive-pack|fetch|pull|clone)\b/.test(text)
    || /(?:graphql|api\.github\.com|github\.com)[^\n]*(?:mutation|post|put|patch|delete|push)/.test(text);
};

/** Env vars allowed to reach the child process (PRD §8.5 execution tools). */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "LOCALAPPDATA",
  "APPDATA",
];

export function buildSafeChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Script/target name -> risk tier heuristics (PRD §8.5, §9.5). */
const VERIFY_NAME_PATTERN = /^(test|tests|typecheck|type-check|lint|analyze|analyse|check|verify|quick)$/i;
const BUILD_NAME_PATTERN = /^(build|compile|bundle)$/i;
const DESTRUCTIVE_NAME_PATTERN = /(deploy|release|publish|destroy|clean|reset)/i;
const NETWORK_NAME_PATTERN = /(install|deps|dependencies|fetch|pull)/i;

const SECRET_SCRIPT_PATTERN =
  /(^|[\s/"'])\.(env|ssh|npmrc)([\s/"'.]|$)|id_rsa|id_ed25519|private[_-]?key|security\s+find-(generic|internet)-password|keychain/i;
// `rm -rf`/`rm -fr` in either flag order, with or without a trailing slash
// on the target (the previous pattern required a literal `/` after the
// flags, so `rm -rf *`/`rm -rf .`/`rm -rf $DIR` all slipped past it into a
// non-destructive riskTier). Also cover `find -delete` and `git clean`.
const DESTRUCTIVE_SCRIPT_PATTERN =
  /\bsudo\b|\brm\s+-\w*r\w*f\w*\b|\brm\s+-\w*f\w*r\w*\b|\bfind\b[^\n]*-delete\b|\bgit\s+clean\b|\bgit\s+(?:push|commit|update-ref|send-pack|receive-pack)\b|\b(?:gh|hub)\b|\b(?:graphql|api\.github\.com)[^\n]*(?:mutation|post|put|patch|delete)\b|\bdiskutil\s+erase|\bmkfs\b|\bshutdown\b|\breboot\b/i;
const NETWORK_SCRIPT_PATTERN = /\b(npm|pnpm|yarn|bun)\s+(install|add|update)|\b(curl|wget)\b|\bgit\s+(pull|fetch|clone|push)\b|\b(?:github\.com|api\.github\.com)\b/i;

function classifyByName(name: string): string {
  if (DESTRUCTIVE_NAME_PATTERN.test(name)) return "destructive";
  if (NETWORK_NAME_PATTERN.test(name)) return "network";
  if (VERIFY_NAME_PATTERN.test(name)) return "verify";
  if (BUILD_NAME_PATTERN.test(name)) return "verify";
  return "read";
}

function classifyManifestCommand(name: string, script: string): string {
  if (SECRET_SCRIPT_PATTERN.test(script) || DESTRUCTIVE_SCRIPT_PATTERN.test(script)) return "destructive";
  if (NETWORK_SCRIPT_PATTERN.test(script)) return "network";
  return classifyByName(name);
}

async function discoverPackageJsonCommands(root: string): Promise<DiscoveredCommand[]> {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    return Object.entries(scripts).map(([name, script]) => ({
      commandId: `npm:${name}`,
      display: `npm run ${name}`,
      source: "package.json",
      riskTier: classifyManifestCommand(name, script),
      argv: npmRunArgv(name),
    }));
  } catch {
    return [];
  }
}

function npmRunArgv(name: string): string[] {
  const npmExecPath = process.env.npm_execpath;
  // Bun exposes its own executable as `npm_execpath`; passing that binary to
  // Node as a script makes the child exit before command-runner's timeout.
  if (
    npmExecPath &&
    existsSync(npmExecPath) &&
    !/(?:^|[/\\])bun(?:\.exe)?$/i.test(npmExecPath)
  ) {
    return [process.execPath, npmExecPath, "run", name];
  }
  return [process.platform === "win32" ? "npm.cmd" : "npm", "run", name];
}

async function discoverMakefileCommands(root: string): Promise<DiscoveredCommand[]> {
  const makePath = join(root, "Makefile");
  if (!existsSync(makePath)) return [];
  try {
    const raw = await readFile(makePath, "utf8");
    const lines = raw.split("\n");
    const targets: DiscoveredCommand[] = [];
    const seen = new Set<string>();
    // Match top-level Makefile targets: `name:` (not indented, not a variable
    // assignment, not a special `.PHONY`-style target).
    const targetPattern = /^([A-Za-z0-9_.\-]+)\s*:(?!=)/gm;
    let match: RegExpExecArray | null;
    while ((match = targetPattern.exec(raw)) !== null) {
      const name = match[1];
      if (!name || name.startsWith(".") || seen.has(name)) continue;
      seen.add(name);
      // Package.json script discovery classifies by scanning the script
      // *body* (classifyManifestCommand), not just the script name, so a
      // secret/destructive/network recipe hiding under an innocuous script
      // name (e.g. "check") still gets a `destructive`/`network` riskTier.
      // Makefile targets previously only classified by target name
      // (classifyByName), so a target named `verify`/`test`/`check` whose
      // recipe ran `curl ... | sh` or `rm -rf /...` was tiered "verify" and
      // ran with no APPROVAL_REQUIRED gate. Collect the recipe body (the
      // tab-indented lines following the target line, skipping blank
      // lines, stopping at the first non-indented/non-blank line) and
      // classify on it exactly like package.json scripts do.
      const startLine = raw.slice(0, match.index).split("\n").length - 1;
      const recipeLines: string[] = [];
      for (let i = startLine + 1; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line.trim().length === 0) continue;
        if (!line.startsWith("\t")) break;
        recipeLines.push(line.slice(1));
      }
      const recipeBody = recipeLines.join("\n");
      targets.push({
        commandId: `make:${name}`,
        display: `make ${name}`,
        source: "Makefile",
        riskTier: classifyManifestCommand(name, recipeBody),
        argv: ["make", name],
      });
    }
    return targets;
  } catch {
    return [];
  }
}

async function discoverPubspecCommands(root: string): Promise<DiscoveredCommand[]> {
  const pubspecPath = join(root, "pubspec.yaml");
  if (!existsSync(pubspecPath)) return [];
  return [
    {
      commandId: "flutter:test",
      display: "flutter test",
      source: "pubspec.yaml",
      riskTier: "verify",
      argv: ["flutter", "test"],
    },
    {
      commandId: "flutter:analyze",
      display: "flutter analyze",
      source: "pubspec.yaml",
      riskTier: "verify",
      argv: ["flutter", "analyze"],
    },
  ];
}

async function discoverAllCommands(root: string): Promise<DiscoveredCommand[]> {
  const [pkg, make, pubspec] = await Promise.all([
    discoverPackageJsonCommands(root),
    discoverMakefileCommands(root),
    discoverPubspecCommands(root),
  ]);
  return [...pkg, ...make, ...pubspec];
}

/**
 * Detect safe, allowlist-eligible commands from project manifests
 * (package.json scripts, Makefile, pubspec.yaml, etc.) (PRD §8.5 command_list).
 */
export async function listCommands(
  root: string,
): Promise<{ commandId: string; display: string; source: string; riskTier: string }[]> {
  const commands = await discoverAllCommands(root);
  return commands.map(({ commandId, display, source, riskTier }) => ({
    commandId,
    display,
    source,
    riskTier,
  }));
}

function buildChildEnv(): NodeJS.ProcessEnv {
  return buildSafeChildEnv();
}

function quoteCmdArg(value: string): string {
  if (!/[\s"&|<>^%]/.test(value)) return value;
  return '"' + value.replace(/(["&|<>^])/g, "^$1").replace(/%/g, "%%") + '"';
}

function buildExecFileInvocation(cmd: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === "win32" && /\.cmd$/i.test(cmd)) {
    const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    return {
      file: comspec,
      args: ["/d", "/s", "/c", [cmd, ...args].map(quoteCmdArg).join(" ")],
    };
  }
  return { file: cmd, args };
}

function killProcessTree(pid: number | undefined, done: () => void): void {
  if (!pid) {
    done();
    return;
  }
  if (process.platform === "win32") {
    execFile("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }, () => done());
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may already have exited.
  }
  done();
}

/** Truncate a buffer to head+tail, returning text and whether it was cut. */
function truncateOutput(buf: Buffer): { text: string; truncated: boolean } {
  const limit = OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES;
  if (buf.length <= limit) {
    return { text: buf.toString("utf8"), truncated: false };
  }
  const head = buf.subarray(0, OUTPUT_HEAD_BYTES).toString("utf8");
  const tail = buf.subarray(buf.length - OUTPUT_TAIL_BYTES).toString("utf8");
  return {
    text: `${head}\n...[truncated ${buf.length - limit} bytes]...\n${tail}`,
    truncated: true,
  };
}

/**
 * Run an allowlisted command by id (never an arbitrary shell string) with a
 * hard timeout and output truncation (PRD §8.5 command_run, §9.5 Two-key).
 *
 * @throws {DomainError} COMMAND_NOT_ALLOWED, ARBITRARY_SHELL_DENIED,
 *   APPROVAL_REQUIRED, TIMEOUT
 */
export async function runCommand(
  root: string,
  commandId: string,
  args?: string[],
  timeoutSec?: number,
): Promise<{
  exitCode: number;
  stdoutSummary: string;
  stderrSummary: string;
  durationMs: number;
  outputTruncated: boolean;
}> {
  const discovered = await discoverAllCommands(root);
  const found = discovered.find((c) => c.commandId === commandId);
  if (!found) {
    // Any commandId not produced by discovery is treated as an arbitrary
    // shell invocation attempt and denied outright — never shell-executed.
    throw new DomainError(
      ErrorCode.ARBITRARY_SHELL_DENIED,
      `commandId "${commandId}" is not an allowlisted discovered command`,
      { commandId },
    );
  }

  if (found.riskTier === "destructive" || found.riskTier === "network") {
    throw new DomainError(
      ErrorCode.APPROVAL_REQUIRED,
      `command "${commandId}" requires explicit human approval (riskTier=${found.riskTier})`,
      { commandId, riskTier: found.riskTier },
    );
  }

  const requestedTimeout = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const effectiveTimeoutSec = Math.min(Math.max(requestedTimeout, 1), MAX_TIMEOUT_SEC);

  const [cmd, ...baseArgs] = found.argv;
  if (!cmd) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `commandId "${commandId}" has no argv`, {
      commandId,
    });
  }
  const extraArgs = args ?? [];
  const fullArgs = [...baseArgs, ...extraArgs];
  if (isGithubMutationIntent([cmd, ...fullArgs])) {
    throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "GitHub mutation commands require the dedicated write workflow");
  }
  const invocation = buildExecFileInvocation(cmd, fullArgs);

  const start = Date.now();

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      fn();
    };

    const child = execFile(
      invocation.file,
      invocation.args,
      {
        cwd: root,
        env: buildChildEnv(),
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (timedOut) return;
        const durationMs = Date.now() - start;
        const stdoutBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "", "utf8");
        const stderrBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "", "utf8");

        const outStd = truncateOutput(stdoutBuf);
        const outErr = truncateOutput(stderrBuf);
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;

        finish(() =>
          resolve({
            exitCode,
            stdoutSummary: outStd.text,
            stderrSummary: outErr.text,
            durationMs,
            outputTruncated: outStd.truncated || outErr.truncated,
          }),
        );
      },
    );

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, () => {
        finish(() =>
          reject(
            new DomainError(ErrorCode.TIMEOUT, `command "${commandId}" timed out after ${effectiveTimeoutSec}s`, {
              commandId,
              timeoutSec: effectiveTimeoutSec,
            }),
          ),
        );
      });
    }, effectiveTimeoutSec * 1000);
  });
}
