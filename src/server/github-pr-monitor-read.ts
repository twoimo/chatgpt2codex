import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  canonicalJson, canonicalRepository, compareCodeUnit, compareLogin, compareNormalizedId,
  canonicalPullRequestUrl,
  COMMENTS_QUERY, COMMAND_TIMEOUT_MS, GITHUB_PR_VIEW_FIELDS, LATEST_REVIEWS_QUERY,
  LOGIN_PATTERN, MAX_CHECKS, MAX_CHILD_COMMENTS, MAX_CHILD_QUERY_CALLS, MAX_COMMAND_STDERR_BYTES,
  MAX_COMMAND_STDOUT_BYTES, MAX_FEEDBACK, MAX_FEEDBACK_PAGES, MAX_PR_BYTES, MAX_PAYLOAD_BYTES,
  MAX_QUERY_BYTES, MAX_REVIEW_REQUEST_PAGES, MAX_REVIEW_REQUESTS, MAX_SEARCH_ISSUES,
  MAX_SEARCH_PAGES, MAX_THREADS, MAX_THREAD_PAGES, MAX_UNIQUE_CANDIDATES, MAX_WIRE_BYTES,
  OID_PATTERN, READ_DEADLINE_MS, REVIEW_REQUESTS_QUERY, REVIEW_THREADS_QUERY, REVIEWS_QUERY,
  SEARCH_PAGE_SIZE, SEARCH_QUERY, THREAD_COMMENTS_QUERY, SNAPSHOT_WORKERS, type Actor, type ActorType,
  type CiSummary, type Discovery, type DiscoveryRole, type Feedback, type GithubPrMonitorErrorResult,
  type GithubPrMonitorReadInput, type GithubPrMonitorReadResult, type GithubPrMonitorRole,
  type GithubPrSnapshot, type MonitorErrorCode, type RepositoryIdentity, type ReviewThread,
  makeToolCallProof, monitorRequestDigest, safeErrorMessage, parseGithubPrMonitorReadInput,
  ephemeralReceiptId,
  isSafeId,
  isSafeCursor,
  equalActor, type DirectMonitorCycleSummary,
} from "./github-pr-monitor-contract.js";

export interface GhCommandOptions { signal?: AbortSignal; timeoutMs?: number }
export interface GhCommandResult { stdout: string; stderr?: string; code?: number | null }
export type GhCommand = (args: string[], options?: GhCommandOptions) => Promise<GhCommandResult | string>;
export interface GithubPrMonitorReadOptions {
  gh?: GhCommand;
  command?: GhCommand;
  runGh?: GhCommand;
  ghCommand?: GhCommand;
  signal?: AbortSignal;
  now?: () => Date;
  nonce?: () => string;
  deadlineMs?: number;
}

class MonitorFailure extends Error {
  constructor(readonly monitorCode: MonitorErrorCode) { super(monitorCode); this.name = "MonitorFailure"; }
}
function failure(code: MonitorErrorCode): never { throw new MonitorFailure(code); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function stringValue(value: unknown, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  return value;
}
function jsonOutput(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return undefined; }
}
function commandResult(value: GhCommandResult | string): { stdout: string; stderr: string; code: number | null } {
  if (typeof value === "string") return { stdout: value, stderr: "", code: 0 };
  if (!value || typeof value.stdout !== "string") failure("GITHUB_MONITOR_UNAVAILABLE");
  return { stdout: value.stdout, stderr: typeof value.stderr === "string" ? value.stderr : "", code: value.code === undefined ? 0 : value.code };
}
function parseGhJson(value: GhCommandResult | string): unknown {
  const result = commandResult(value);
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_STDOUT_BYTES || Buffer.byteLength(result.stderr, "utf8") > MAX_COMMAND_STDERR_BYTES) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
  if (result.code !== null && result.code !== 0) failure("GITHUB_MONITOR_UNAVAILABLE");
  const parsed = jsonOutput(result.stdout);
  if (parsed === undefined) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  return parsed;
}

export const COMMAND_CLEANUP_GRACE_MS = 250;
const COMMAND_REAP_WATCHDOG_MS = Math.min(COMMAND_CLEANUP_GRACE_MS, 100);

function spawnGh(args: readonly string[], options: GhCommandOptions = {}): Promise<GhCommandResult> {
  if (args.some((arg) => typeof arg !== "string" || Buffer.byteLength(arg, "utf8") > MAX_QUERY_BYTES) || Buffer.byteLength(args.join("\0"), "utf8") > MAX_QUERY_BYTES) return Promise.reject(new MonitorFailure("GITHUB_MONITOR_OUTPUT_LIMIT"));
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("gh", args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        ...(process.platform === "win32" ? {} : { detached: true }),
      });
    } catch {
      reject(new MonitorFailure("GITHUB_MONITOR_UNAVAILABLE"));
      return;
    }
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let stdoutBytes = 0; let stderrBytes = 0; let settled = false; let closed = false;
    let closeCode: number | null = null; let failureReason: MonitorFailure | undefined;
    let timer: NodeJS.Timeout | undefined; let reapTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (reapTimer) clearTimeout(reapTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout.removeListener("data", onStdoutData);
      child.stderr.removeListener("data", onStderrData);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    const finalize = (code: number | null) => {
      if (settled || !closed) return;
      settled = true; cleanup();
      if (failureReason || code !== 0) { reject(failureReason ?? new MonitorFailure("GITHUB_MONITOR_UNAVAILABLE")); return; }
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code });
    };
    const reapAfterCleanup = () => {
      if (settled) return;
      settled = true; cleanup();
      reject(failureReason ?? new MonitorFailure("GITHUB_MONITOR_TIMEOUT"));
    };
    const killProcessGroup = () => {
      if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
        try {
          if (process.kill(-child.pid, "SIGKILL")) return;
        } catch { /* process already gone */ }
      }
      try { child.kill("SIGKILL"); } catch { /* process already gone */ }
    };
    const fail = (error: MonitorFailure) => {
      if (settled || failureReason) return;
      failureReason = error;
      if (timer) { clearTimeout(timer); timer = undefined; }
      killProcessGroup();
      if (closed) {
        finalize(closeCode);
      } else if (!reapTimer) {
        reapTimer = setTimeout(reapAfterCleanup, COMMAND_REAP_WATCHDOG_MS);
      }
    };
    const onAbort = () => fail(new MonitorFailure(
      options.signal?.reason === "external" || options.signal?.reason === "fatal"
        ? "GITHUB_MONITOR_ABORTED"
        : "GITHUB_MONITOR_TIMEOUT",
    ));
    const onStdoutData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); stdoutBytes += buffer.byteLength;
      if (stdoutBytes > MAX_COMMAND_STDOUT_BYTES) fail(new MonitorFailure("GITHUB_MONITOR_OUTPUT_LIMIT")); else if (!failureReason) stdout.push(buffer);
    };
    const onStderrData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); stderrBytes += buffer.byteLength;
      if (stderrBytes > MAX_COMMAND_STDERR_BYTES) fail(new MonitorFailure("GITHUB_MONITOR_OUTPUT_LIMIT")); else if (!failureReason) stderr.push(buffer);
    };
    const onError = () => fail(new MonitorFailure("GITHUB_MONITOR_UNAVAILABLE"));
    const onClose = (code: number | null) => { closed = true; closeCode = code; finalize(code); };
    child.stdout.on("data", onStdoutData);
    child.stderr.on("data", onStderrData);
    child.once("error", onError);
    child.once("close", onClose);
    timer = setTimeout(() => fail(new MonitorFailure("GITHUB_MONITOR_TIMEOUT")), options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    }
  });
}
export const defaultGhCommand: GhCommand = spawnGh;
export const createGhRunner = (): GhCommand => spawnGh;

function parseLoginOutput(value: GhCommandResult | string): string {
  const result = commandResult(value);
  if (result.code !== null && result.code !== 0) failure("GITHUB_MONITOR_AUTH");
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_STDOUT_BYTES || Buffer.byteLength(result.stderr, "utf8") > MAX_COMMAND_STDERR_BYTES) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
  const parsed = jsonOutput(result.stdout);
  if (parsed !== undefined && typeof parsed !== "string") failure("GITHUB_MONITOR_AUTH");
  const login = typeof parsed === "string" ? parsed.trim() : result.stdout.trim();
  if (!LOGIN_PATTERN.test(login)) failure("GITHUB_MONITOR_AUTH");
  return login;
}

function graphQlOutput(value: GhCommandResult | string): Record<string, unknown> {
  const parsed = parseGhJson(value);
  if (!isRecord(parsed) || (parsed.errors !== undefined && (!Array.isArray(parsed.errors) || parsed.errors.length > 0)) || !isRecord(parsed.data)) failure("GITHUB_MONITOR_UNAVAILABLE");
  return parsed.data;
}
function pageInfo(value: unknown, invalidCode: MonitorErrorCode = "GITHUB_MONITOR_DISCOVERY_INVALID"): { hasNextPage: boolean; endCursor: string | null } {
  if (!isRecord(value) || typeof value.hasNextPage !== "boolean") failure(invalidCode);
  if (value.hasNextPage) {
    if (!isSafeCursor(value.endCursor)) failure(invalidCode);
    return { hasNextPage: true, endCursor: value.endCursor };
  }
  if (value.endCursor !== null && value.endCursor !== undefined) failure(invalidCode);
  return { hasNextPage: false, endCursor: null };
}
function rootCheck(value: unknown, candidate: Candidate): Record<string, unknown> {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || value.id.length > 300 || /[\u0000-\u001f\u007f]/.test(value.id) || typeof value.nameWithOwner !== "string") failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  let name: string;
  try { name = canonicalRepository(value.nameWithOwner); } catch { failure("GITHUB_MONITOR_SNAPSHOT_INVALID"); }
  if (name !== candidate.baseRepository.nameWithOwner || value.id !== candidate.baseRepository.id) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  return value;
}
interface Candidate { key: string; number: number; baseRepository: RepositoryIdentity; roles: Set<GithubPrMonitorRole> }
interface DiscoveryData { role: DiscoveryRole; candidates: Candidate[] }

async function invokeGh(gh: GhCommand, args: string[], signal: AbortSignal): Promise<GhCommandResult | string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let abortError: MonitorFailure | undefined;
    let timer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: MonitorFailure, value?: GhCommandResult | string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value!);
    };
    const armCleanupGrace = () => {
      if (cleanupTimer || settled) return;
      cleanupTimer = setTimeout(
        () => finish(abortError ?? new MonitorFailure("GITHUB_MONITOR_TIMEOUT")),
        COMMAND_CLEANUP_GRACE_MS,
      );
    };
    const onAbort = () => {
      if (abortError || settled) return;
      abortError = new MonitorFailure(
        signal.reason === "external" || signal.reason === "fatal" || signal.reason === "discovery-fatal"
          ? "GITHUB_MONITOR_ABORTED"
          : "GITHUB_MONITOR_TIMEOUT",
      );
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      armCleanupGrace();
    };
    if (signal.aborted) {
      onAbort();
      finish(abortError);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      if (abortError || settled) return;
      abortError = new MonitorFailure("GITHUB_MONITOR_TIMEOUT");
      timer = undefined;
      armCleanupGrace();
    }, COMMAND_TIMEOUT_MS);
    let underlying: Promise<GhCommandResult | string>;
    try {
      underlying = Promise.resolve(gh(args, { signal, timeoutMs: COMMAND_TIMEOUT_MS }));
    } catch {
      finish(new MonitorFailure("GITHUB_MONITOR_UNAVAILABLE"));
      return;
    }
    underlying.then(
      (value) => finish(abortError, value),
      (error: unknown) => finish(
        abortError
          ?? (error instanceof MonitorFailure ? error : new MonitorFailure("GITHUB_MONITOR_UNAVAILABLE")),
      ),
    );
  });
}
async function graphQl(gh: GhCommand, query: string, params: Array<[string, string | number]>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const args: string[] = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of params) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  if (Buffer.byteLength(args.join("\0"), "utf8") > MAX_QUERY_BYTES) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
  let result: GhCommandResult | string;
  try { result = await invokeGh(gh, args, signal); } catch (error) {
    if (error instanceof MonitorFailure) throw error;
    failure("GITHUB_MONITOR_UNAVAILABLE");
  }
  return graphQlOutput(result);
}

async function discoverRole(gh: GhCommand, login: string, role: GithubPrMonitorRole, signal: AbortSignal): Promise<DiscoveryData> {
  const query = role === "authored" ? `is:pr is:open author:${login}` : `is:pr is:open review-requested:${login}`;
  let cursor: string | null = null; let firstCount: number | undefined; let fetchedCount = 0; let pageCount = 0;
  const candidates: Candidate[] = []; const seen = new Set<string>();
  for (;;) {
    if (pageCount >= MAX_SEARCH_PAGES) failure("GITHUB_MONITOR_DISCOVERY_LIMIT");
    const params: Array<[string, string | number]> = [["q", query], ["first", SEARCH_PAGE_SIZE]];
    if (cursor !== null) params.push(["after", cursor]);
    const data = await graphQl(gh, SEARCH_QUERY, params, signal);
    if (!isRecord(data.search)) failure("GITHUB_MONITOR_DISCOVERY_INVALID");
    const search = data.search;
    const issueCount = search.issueCount;
    if (typeof issueCount !== "number" || !Number.isInteger(issueCount) || issueCount < 0) failure("GITHUB_MONITOR_DISCOVERY_INVALID");
    if (firstCount === undefined) firstCount = issueCount;
    if (firstCount !== issueCount) failure("GITHUB_MONITOR_DISCOVERY_INVALID");
    if (issueCount > MAX_SEARCH_ISSUES) failure("GITHUB_MONITOR_DISCOVERY_LIMIT");
    if (!Array.isArray(search.nodes) || search.nodes.length > SEARCH_PAGE_SIZE) failure("GITHUB_MONITOR_DISCOVERY_INVALID");
    for (const node of search.nodes) {
      if (!isRecord(node) || node.__typename !== "PullRequest" || typeof node.number !== "number" || !Number.isInteger(node.number) || node.number < 1 || node.number > 2_147_483_647 || !isRecord(node.repository) || typeof node.repository.id !== "string") failure("GITHUB_MONITOR_DISCOVERY_INVALID");
      let base: string; try { base = canonicalRepository(node.repository.nameWithOwner); } catch { failure("GITHUB_MONITOR_DISCOVERY_INVALID"); }
      if (node.repository.id.length === 0 || node.repository.id.length > 300 || /[\u0000-\u001f\u007f]/.test(node.repository.id) || seen.has(`${base}#${node.number}`)) failure("GITHUB_MONITOR_DISCOVERY_INVALID");
      seen.add(`${base}#${node.number}`); fetchedCount++;
      candidates.push({ key: `${base}#${node.number}`, number: node.number, baseRepository: { id: node.repository.id, nameWithOwner: base }, roles: new Set([role]) });
    }
    pageCount++;
    const info = pageInfo(search.pageInfo);
    if (!info.hasNextPage) break;
    if (pageCount >= MAX_SEARCH_PAGES || firstCount! > MAX_SEARCH_ISSUES) failure("GITHUB_MONITOR_DISCOVERY_LIMIT");
    if (!info.endCursor || info.endCursor === cursor) failure("GITHUB_MONITOR_DISCOVERY_INVALID");
    cursor = info.endCursor;
  }
  if (firstCount === undefined) failure("GITHUB_MONITOR_DISCOVERY_INVALID");
  if (fetchedCount !== firstCount) failure("GITHUB_MONITOR_DISCOVERY_LIMIT");
  if (fetchedCount > MAX_SEARCH_ISSUES) failure("GITHUB_MONITOR_DISCOVERY_LIMIT");
  return { role: { issueCount: firstCount, fetchedCount, pageCount, complete: true }, candidates };
}

function actorType(value: unknown): ActorType {
  if (!isRecord(value)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  const typename = value.__typename;
  const login = value.login;
  if (typename === null) {
    if (login !== null) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    return "Deleted";
  }
  if (typename === undefined) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  if (typeof typename !== "string" || typename.length === 0 || typename.length > 128 || /[^A-Za-z0-9_]/.test(typename)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  if (typeof login !== "string" || !LOGIN_PATTERN.test(login)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  if (typename === "User" || typename === "Bot" || typename === "Mannequin" || typename === "Organization" || typename === "EnterpriseUserAccount") return typename;
  return "Unknown";
}
function mapActor(value: unknown): Actor {
  if (value === undefined) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  if (value === null) return { login: null, actorType: "Deleted" };
  if (!isRecord(value)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  const type = actorType(value); const login = value.login;
  return { login: type === "Deleted" ? null : login as string, actorType: type };
}
function reviewerActor(value: unknown): Actor | null {
  if (value === undefined) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  if (value === null) return null;
  if (!isRecord(value) || typeof value.__typename !== "string") failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  const typename = value.__typename;
  if (typename === "Bot" || typename === "EnterpriseTeam" || typename === "Mannequin" || typename === "Team") {
    if (value.login !== undefined && value.login !== null && (typeof value.login !== "string" || !LOGIN_PATTERN.test(value.login))) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    return null;
  }
  if (typename !== "User") {
    failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  }
  if (typeof value.login !== "string" || !LOGIN_PATTERN.test(value.login)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  return { login: value.login, actorType: "User" };
}
function typedAuthor(value: unknown): Actor {
  if (!isRecord(value)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  return mapActor(value);
}
function viewAuthorLogin(value: unknown): string {
  if (!isRecord(value) || typeof value.login !== "string" || !LOGIN_PATTERN.test(value.login)) {
    failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  }
  return value.login;
}
function validateRef(value: unknown): string {
  const ref = stringValue(value, 241);
  if (ref.startsWith("-") || ref.includes("..") || ref.includes("//")) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  return ref;
}
function validateId(value: unknown): string { return stringValue(value, 300); }
function feedbackIdentityFromBody(body: unknown): string {
  if (body !== null && body !== undefined && typeof body !== "string") failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  const text = body ?? "";
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
  return sha256(text);
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
const INVALID_INPUT_REQUEST_DIGEST = sha256("invalid-input");
function feedback(value: unknown, threadComment = false): Feedback {
  if (!isRecord(value)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  const id = validateId(value.id); const identity = feedbackIdentityFromBody(value.body);
  const result: Feedback = { id, author: mapActor(value.author), feedbackIdentity: identity };
  if (value.authorAssociation !== undefined && value.authorAssociation !== null) result.authorAssociation = stringValue(value.authorAssociation);
  if (value.state !== undefined && value.state !== null) result.state = stringValue(value.state).toUpperCase();
  if (threadComment) {
    if (value.path !== undefined && value.path !== null) result.path = stringValue(value.path, 240);
    for (const field of ["line", "startLine"] as const) if (value[field] !== undefined && value[field] !== null) {
      if (typeof value[field] !== "number" || !Number.isInteger(value[field]) || value[field] < 1) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
      result[field] = value[field];
    }
    if (value.outdated !== undefined) { if (typeof value.outdated !== "boolean") failure("GITHUB_MONITOR_SNAPSHOT_INVALID"); result.outdated = value.outdated; }
    if (value.commit !== undefined && value.commit !== null) { if (!isRecord(value.commit) || !OID_PATTERN.test(String(value.commit.oid))) failure("GITHUB_MONITOR_SNAPSHOT_INVALID"); result.commitOid = String(value.commit.oid).toLowerCase(); }
  }
  return result;
}
function checkCi(value: unknown): { checks: Array<{ status: string; conclusion: string | null }>; summary: CiSummary } {
  if (value !== null && value !== undefined && !Array.isArray(value)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  const checks: Array<{ status: string; conclusion: string | null }> = [];
  const summary: CiSummary = { total: 0, success: 0, failure: 0, pending: 0, cancelled: 0, neutral: 0, unknown: 0 };
  for (const item of (value ?? []) as unknown[]) {
    if (!isRecord(item)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    if (summary.total >= MAX_CHECKS) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
    const pick = item.status ?? item.state ?? item.bucket;
    if (pick !== null && pick !== undefined && (typeof pick !== "string" || pick.length > 128 || /[\u0000-\u001f\u007f]/.test(pick))) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    const conclusion = item.conclusion;
    if (conclusion !== null && conclusion !== undefined && (typeof conclusion !== "string" || conclusion.length > 128 || /[\u0000-\u001f\u007f]/.test(conclusion))) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    const status = String(pick ?? "UNKNOWN").toUpperCase(); const normalizedConclusion = conclusion == null ? null : conclusion.toUpperCase();
    checks.push({ status, conclusion: normalizedConclusion }); summary.total++;
    if (status === "SUCCESS" || status === "SUCCESSFUL") summary.success++;
    else if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(status)) summary.failure++;
    else if (["QUEUED", "IN_PROGRESS", "PENDING"].includes(status)) summary.pending++;
    else if (["CANCELLED", "CANCELED"].includes(status)) summary.cancelled++;
    else if (["NEUTRAL", "SKIPPED"].includes(status)) summary.neutral++;
    else summary.unknown++;
  }
  checks.sort((a, b) => compareCodeUnit(a.status, b.status) || compareCodeUnit(a.conclusion ?? "", b.conclusion ?? ""));
  return { checks, summary };
}


async function reviewerAndAuthor(gh: GhCommand, candidate: Candidate, account: string, signal: AbortSignal): Promise<{ author: Actor; reviewers: Actor[]; reviewerRole: boolean }> {
  let cursor: string | null = null; let pages = 0; let requestCount = 0; const reviewers: Actor[] = []; let author: Actor | undefined;
  for (;;) {
    if (pages >= MAX_REVIEW_REQUEST_PAGES) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    const params: Array<[string, string | number]> = [["owner", candidate.baseRepository.nameWithOwner.split("/")[0]!], ["repo", candidate.baseRepository.nameWithOwner.split("/")[1]!], ["number", candidate.number]];
    if (cursor !== null) params.push(["after", cursor]);
    const data = await graphQl(gh, REVIEW_REQUESTS_QUERY, params, signal); const root = rootCheck(data.repository, candidate); const pr = root.pullRequest;
    if (!isRecord(pr) || !isRecord(pr.reviewRequests)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    const typed = typedAuthor(pr.author); if (!author) author = typed; else if (!equalActor(author, typed)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    const conn = pr.reviewRequests; if (!Array.isArray(conn.nodes) || conn.nodes.length > 100) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    for (const node of conn.nodes) {
      if (!isRecord(node)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
      if (++requestCount > MAX_REVIEW_REQUESTS) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
      const reviewer = reviewerActor(node.requestedReviewer); if (reviewer) reviewers.push(reviewer);
    }
    pages++;
    const info = pageInfo(conn.pageInfo, "GITHUB_MONITOR_SNAPSHOT_INVALID"); if (!info.hasNextPage) break;
    if (pages >= MAX_REVIEW_REQUEST_PAGES || !info.endCursor || info.endCursor === cursor) failure("GITHUB_MONITOR_SNAPSHOT_INVALID"); cursor = info.endCursor;
  }
  if (!author) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  const dedup = new Map<string, Actor>();
  for (const reviewer of reviewers) {
    const key = reviewer.login!.toLowerCase(); const previous = dedup.get(key);
    if (!previous || compareLogin(reviewer.login!, previous.login!) < 0) dedup.set(key, reviewer);
  }
  const sorted = [...dedup.values()].sort((a, b) => compareLogin(a.login!, b.login!));
  return { author, reviewers: sorted, reviewerRole: sorted.some((r) => r.login!.toLowerCase() === account.toLowerCase()) };
}

async function threadsAndComments(gh: GhCommand, candidate: Candidate, signal: AbortSignal): Promise<{ threads: ReviewThread[]; comments: Feedback[] }> {
  let cursor: string | null = null; let pages = 0; const entries: Array<{ id: string; isResolved: boolean; isOutdated: boolean }> = [];
  const seenThreadIds = new Set<string>();
  for (;;) {
    if (pages >= MAX_THREAD_PAGES) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    const params: Array<[string, string | number]> = [["owner", candidate.baseRepository.nameWithOwner.split("/")[0]!], ["repo", candidate.baseRepository.nameWithOwner.split("/")[1]!], ["number", candidate.number]];
    if (cursor !== null) params.push(["after", cursor]);
    const data = await graphQl(gh, REVIEW_THREADS_QUERY, params, signal); const root = rootCheck(data.repository, candidate); const pr = root.pullRequest;
    if (!isRecord(pr) || !isRecord(pr.reviewThreads)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    const conn = pr.reviewThreads; if (!Array.isArray(conn.nodes) || conn.nodes.length > 100) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    for (const node of conn.nodes) {
      if (!isRecord(node) || typeof node.id !== "string" || typeof node.isResolved !== "boolean" || typeof node.isOutdated !== "boolean") failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
      const threadId = validateId(node.id);
      if (seenThreadIds.has(threadId)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
      seenThreadIds.add(threadId);
      entries.push({ id: threadId, isResolved: node.isResolved, isOutdated: node.isOutdated });
    }
    if (entries.length > MAX_THREADS) failure("GITHUB_MONITOR_OUTPUT_LIMIT"); pages++;
    const info = pageInfo(conn.pageInfo, "GITHUB_MONITOR_SNAPSHOT_INVALID"); if (!info.hasNextPage) break;
    if (pages >= MAX_THREAD_PAGES || !info.endCursor || info.endCursor === cursor) failure("GITHUB_MONITOR_SNAPSHOT_INVALID"); cursor = info.endCursor;
  }
  const allComments: Feedback[] = []; let aggregateComments = 0; let childCalls = 0;
  const threads: ReviewThread[] = [];
  for (const entry of entries) {
    const comments: Feedback[] = []; let childCursor: string | null = null; let childPages = 0;
    for (;;) {
      if (++childCalls > MAX_CHILD_QUERY_CALLS) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
      const params: Array<[string, string | number]> = [["threadId", entry.id]]; if (childCursor !== null) params.push(["after", childCursor]);
      const data = await graphQl(gh, THREAD_COMMENTS_QUERY, params, signal); const node = data.node;
      if (!isRecord(node) || node.__typename !== "PullRequestReviewThread" || node.id !== entry.id || node.isResolved !== entry.isResolved || node.isOutdated !== entry.isOutdated || !isRecord(node.comments)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
      const conn = node.comments; if (!Array.isArray(conn.nodes) || conn.nodes.length > 100) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
      if (aggregateComments + conn.nodes.length > MAX_FEEDBACK) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
      const pageComments = conn.nodes.map((v) => feedback(v, true));
      aggregateComments += pageComments.length;
      comments.push(...pageComments); if (comments.length > MAX_CHILD_COMMENTS) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
      childPages++; const info = pageInfo(conn.pageInfo, "GITHUB_MONITOR_SNAPSHOT_INVALID"); if (!info.hasNextPage) break;
      if (childPages >= MAX_THREAD_PAGES || !info.endCursor || info.endCursor === childCursor) failure("GITHUB_MONITOR_SNAPSHOT_INVALID"); childCursor = info.endCursor;
    }
    comments.sort(compareNormalizedId); allComments.push(...comments); threads.push({ id: entry.id, isResolved: entry.isResolved, isOutdated: entry.isOutdated, comments: { nodes: comments } });
  }
  threads.sort((a, b) => compareNormalizedId(a, b)); allComments.sort(compareNormalizedId);
  if (allComments.length > MAX_FEEDBACK) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
  return { threads, comments: allComments };
}

async function snapshot(gh: GhCommand, candidate: Candidate, account: string, signal: AbortSignal): Promise<{ snapshot?: GithubPrSnapshot; races?: Array<"prClosed" | "authoredRoleLost" | "reviewerRequestLost"> }> {
  const args = ["pr", "view", String(candidate.number), "--repo", candidate.baseRepository.nameWithOwner, "--json", GITHUB_PR_VIEW_FIELDS];
  let raw: GhCommandResult | string; try { raw = await invokeGh(gh, args, signal); } catch (error) { if (error instanceof MonitorFailure) throw error; failure("GITHUB_MONITOR_UNAVAILABLE"); }
  const view = parseGhJson(raw); if (!isRecord(view)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  if (typeof view.state !== "string" || !["OPEN", "CLOSED", "MERGED"].includes(view.state) || /[\u0000-\u001f\u007f]/.test(view.state)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  if (view.state !== "OPEN") return { races: ["prClosed"] };
  if (typeof view.number !== "number" || view.number !== candidate.number || typeof view.url !== "string") failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  let url: string;
  try { url = canonicalPullRequestUrl(view.url); } catch { failure("GITHUB_MONITOR_SNAPSHOT_INVALID"); }
  if (url !== `https://github.com/${candidate.baseRepository.nameWithOwner}/pull/${candidate.number}`) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  const viewAuthorLoginValue = viewAuthorLogin(view.author);
  const baseRefName = validateRef(view.baseRefName); const headRefName = validateRef(view.headRefName);
  if (typeof view.baseRefOid !== "string" || !OID_PATTERN.test(view.baseRefOid) || typeof view.headRefOid !== "string" || !OID_PATTERN.test(view.headRefOid)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  if (!isRecord(view.headRepository) || typeof view.headRepository.id !== "string" || typeof view.headRepository.name !== "string" || typeof view.headRepository.nameWithOwner !== "string") failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  let headName: string; try { headName = canonicalRepository(view.headRepository.nameWithOwner); } catch { failure("GITHUB_MONITOR_SNAPSHOT_INVALID"); }
  const headOwnerAndName = headName.split("/");
  const headRepoName = stringValue(view.headRepository.name, 100);
  if (headOwnerAndName[1]!.toLowerCase() !== headRepoName.toLowerCase() || view.headRepository.id.length === 0 || view.headRepository.id.length > 300 || /[\u0000-\u001f\u007f]/.test(view.headRepository.id)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  const headRepository = { id: view.headRepository.id, name: headOwnerAndName[1]!, nameWithOwner: headName };
  const reviewerData = await reviewerAndAuthor(gh, candidate, account, signal);
  if (candidate.roles.has("authored")) {
    if (viewAuthorLoginValue !== account || reviewerData.author.actorType !== "User" || reviewerData.author.login !== account) {
      failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    }
  } else if (reviewerData.author.login === null || reviewerData.author.login !== viewAuthorLoginValue) {
    failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  }
  const reviewerRoleLost = candidate.roles.has("requested_reviewer") && !reviewerData.reviewerRole;
  if (reviewerRoleLost && !candidate.roles.has("authored")) return { races: ["reviewerRequestLost"] };
  const author = candidate.roles.has("authored") ? { login: account, actorType: "User" as const } : reviewerData.author;
  const branchController = new AbortController();
  let firstBranchError: unknown;
  let branchFailed = false;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let cleanupResolve: (() => void) | undefined;
  let branchesSettled = false;
  const cleanupGrace = new Promise<void>((resolve) => { cleanupResolve = resolve; });
  const armCleanupGrace = () => {
    if (cleanupTimer || branchesSettled) return;
    cleanupTimer = setTimeout(() => cleanupResolve?.(), COMMAND_CLEANUP_GRACE_MS);
  };
  const abortBranchController = () => {
    if (!branchController.signal.aborted) branchController.abort(signal.reason);
    armCleanupGrace();
  };
  if (signal.aborted) abortBranchController();
  else signal.addEventListener("abort", abortBranchController, { once: true });
  const branch = async <T>(operation: (branchSignal: AbortSignal) => Promise<T>): Promise<T> => {
    try {
      return await operation(branchController.signal);
    } catch (error) {
      if (!branchFailed) {
        branchFailed = true;
        firstBranchError = error;
        branchController.abort("fatal");
        armCleanupGrace();
      }
      throw error;
    }
  };
  const allBranches = Promise.allSettled([
    branch((branchSignal) => pagedFeedback(gh, candidate, "reviews", REVIEWS_QUERY, reviewerData.author, branchSignal)),
    branch((branchSignal) => pagedFeedback(gh, candidate, "comments", COMMENTS_QUERY, reviewerData.author, branchSignal)),
    branch((branchSignal) => pagedFeedback(gh, candidate, "latestReviews", LATEST_REVIEWS_QUERY, reviewerData.author, branchSignal)),
    branch((branchSignal) => threadsAndComments(gh, candidate, branchSignal)),
  ]);
  type BranchResults = [
    PromiseSettledResult<Feedback[]>,
    PromiseSettledResult<Feedback[]>,
    PromiseSettledResult<Feedback[]>,
    PromiseSettledResult<{ threads: ReviewThread[]; comments: Feedback[] }>,
  ];
  const settledResults = await Promise.race<BranchResults | undefined>([allBranches, cleanupGrace.then(() => undefined)]);
  branchesSettled = settledResults !== undefined;
  if (cleanupTimer) clearTimeout(cleanupTimer);
  signal.removeEventListener("abort", abortBranchController);
  if (!settledResults) {
    if (branchFailed) throw firstBranchError;
    if (signal.aborted) throw new MonitorFailure(signal.reason === "external" ? "GITHUB_MONITOR_ABORTED" : "GITHUB_MONITOR_TIMEOUT");
    throw new MonitorFailure("GITHUB_MONITOR_TIMEOUT");
  }
  if (branchFailed) throw firstBranchError;
  const [reviewsResult, commentsResult, latestReviewsResult, threadResult] = settledResults;
  if (reviewsResult.status === "rejected") throw reviewsResult.reason;
  if (commentsResult.status === "rejected") throw commentsResult.reason;
  if (latestReviewsResult.status === "rejected") throw latestReviewsResult.reason;
  if (threadResult.status === "rejected") throw threadResult.reason;
  const reviews = reviewsResult.value;
  const comments = commentsResult.value;
  const latestReviews = latestReviewsResult.value;
  const threadData = threadResult.value;
  const totalFeedback = reviews.length + comments.length + latestReviews.length + threadData.comments.length;
  if (totalFeedback > MAX_FEEDBACK) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
  validateFeedbackSets(reviews, comments, latestReviews, threadData.comments);
  const check = checkRollup(view.statusCheckRollup);
  const roles: GithubPrMonitorRole[] = []; if (candidate.roles.has("authored")) roles.push("authored"); if (candidate.roles.has("requested_reviewer") && !reviewerRoleLost) roles.push("requested_reviewer");
  const result: GithubPrSnapshot = {
    number: candidate.number, url, state: "OPEN", author, roles,
    baseRepository: candidate.baseRepository, headRepository, baseRefName, headRefName,
    baseRefOid: view.baseRefOid.toLowerCase(), headRefOid: view.headRefOid.toLowerCase(),
    reviewRequests: reviewerData.reviewers, reviews, comments, latestReviews,
    reviewThreads: threadData.threads, statusCheckRollup: check.checks, ciSummary: check.summary,
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PR_BYTES) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
  return { snapshot: result, ...(reviewerRoleLost ? { races: ["reviewerRequestLost" as const] } : {}) };
}

async function pagedFeedback(gh: GhCommand, candidate: Candidate, connection: "reviews" | "comments" | "latestReviews", query: string, expectedAuthor: Actor, signal: AbortSignal): Promise<Feedback[]> {
  let cursor: string | null = null; let pages = 0; const result: Feedback[] = [];
  for (;;) {
    if (pages >= MAX_FEEDBACK_PAGES) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    const params: Array<[string, string | number]> = [["owner", candidate.baseRepository.nameWithOwner.split("/")[0]!], ["repo", candidate.baseRepository.nameWithOwner.split("/")[1]!], ["number", candidate.number]];
    if (cursor !== null) params.push(["after", cursor]);
    const data = await graphQl(gh, query, params, signal); const root = rootCheck(data.repository, candidate); const pr = root.pullRequest;
    if (!isRecord(pr) || !isRecord(pr[connection])) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    if (!isRecord(pr.author)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    const connectionAuthor = typedAuthor(pr.author); if (!equalActor(connectionAuthor, expectedAuthor)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    const conn = pr[connection]; if (!Array.isArray(conn.nodes) || conn.nodes.length > 100) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    result.push(...conn.nodes.map((v) => feedback(v))); if (result.length > MAX_FEEDBACK) failure("GITHUB_MONITOR_OUTPUT_LIMIT"); pages++;
    const info = pageInfo(conn.pageInfo, "GITHUB_MONITOR_SNAPSHOT_INVALID"); if (!info.hasNextPage) break;
    if (pages >= MAX_FEEDBACK_PAGES || !info.endCursor || info.endCursor === cursor) failure("GITHUB_MONITOR_SNAPSHOT_INVALID"); cursor = info.endCursor;
  }
  result.sort(compareNormalizedId); return result;
}

function checkRollup(value: unknown): { checks: Array<{ status: string; conclusion: string | null }>; summary: CiSummary } {
  if (Array.isArray(value) && value.length > MAX_CHECKS) failure("GITHUB_MONITOR_OUTPUT_LIMIT");
  return checkCi(value);
}
function validateFeedbackSets(reviews: Feedback[], comments: Feedback[], latestReviews: Feedback[], threadComments: Feedback[]): void {
  const reviewById = new Map<string, Feedback>();
  for (const item of reviews) {
    if (reviewById.has(item.id)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    reviewById.set(item.id, item);
  }
  const latestById = new Map<string, Feedback>();
  for (const item of latestReviews) {
    const previous = latestById.get(item.id);
    if (previous && canonicalJson(previous) !== canonicalJson(item)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    latestById.set(item.id, item);
    const review = reviewById.get(item.id);
    if (review && canonicalJson(review) !== canonicalJson(item)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
  }
  const other = new Set<string>();
  for (const item of [...comments, ...threadComments]) {
    if (other.has(item.id) || reviewById.has(item.id) || latestById.has(item.id)) failure("GITHUB_MONITOR_SNAPSHOT_INVALID");
    other.add(item.id);
  }
}

function mergeCandidates(a: DiscoveryData, b: DiscoveryData): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const candidate of [...a.candidates, ...b.candidates]) {
    const existing = map.get(candidate.key);
    if (!existing) map.set(candidate.key, { ...candidate, roles: new Set(candidate.roles) });
    else {
      if (existing.baseRepository.id !== candidate.baseRepository.id) failure("GITHUB_MONITOR_DISCOVERY_INVALID");
      for (const role of candidate.roles) existing.roles.add(role);
    }
  }
  if (map.size > MAX_UNIQUE_CANDIDATES) failure("GITHUB_MONITOR_DISCOVERY_LIMIT");
  return [...map.values()].sort((x, y) => compareCodeUnit(x.baseRepository.nameWithOwner, y.baseRepository.nameWithOwner) || x.number - y.number);
}

function asFailure(error: unknown): MonitorErrorCode {
  if (error instanceof MonitorFailure) return error.monitorCode;
  if (error instanceof Error && error.name === "AbortError") return "GITHUB_MONITOR_ABORTED";
  return "GITHUB_MONITOR_UNAVAILABLE";
}
function safeInput(value: unknown): GithubPrMonitorReadInput | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const runId = value.runId;
    const actionPlanId = value.actionPlanId;
    return isSafeId(runId) && isSafeId(actionPlanId) ? { runId, actionPlanId } : undefined;
  } catch {
    return undefined;
  }
}

export async function runGithubPrMonitorRead(value: unknown, options: GithubPrMonitorReadOptions = {}): Promise<GithubPrMonitorReadResult | GithubPrMonitorErrorResult> {
  const input = (() => { try { return parseGithubPrMonitorReadInput(value); } catch { return undefined; } })();
  const safe = safeInput(value);
  const digest = input ? monitorRequestDigest(input) : (safe ? monitorRequestDigest(safe) : INVALID_INPUT_REQUEST_DIGEST);
  if (!input) {
    return {
      monitorPayloadVersion: 1, protocolVersion: 1, schemaVersion: 4,
      requestDigest: digest, namespace: "ChatGPT_To_Codex", tool: "github_pr_monitor_read", operation: "read", ok: false,
      ...(safe ?? {}), code: "GITHUB_MONITOR_INVALID_INPUT", error: safeErrorMessage("GITHUB_MONITOR_INVALID_INPUT"),
      chatgpt2codexToolCall: makeToolCallProof(safe, false),
    };
  }
  const gh = options.gh ?? options.command ?? options.runGh ?? options.ghCommand ?? defaultGhCommand;
  const controller = new AbortController(); const external = options.signal; let deadline: NodeJS.Timeout | undefined;
  const abortFromExternal = () => controller.abort("external");
  if (external) { if (external.aborted) return { monitorPayloadVersion: 1, protocolVersion: 1, schemaVersion: 4, requestDigest: digest, namespace: "ChatGPT_To_Codex", tool: "github_pr_monitor_read", operation: "read", ok: false, runId: input.runId, actionPlanId: input.actionPlanId, code: "GITHUB_MONITOR_ABORTED", error: safeErrorMessage("GITHUB_MONITOR_ABORTED"), chatgpt2codexToolCall: makeToolCallProof(input, false) }; external.addEventListener("abort", abortFromExternal, { once: true }); }
  deadline = setTimeout(() => controller.abort("deadline"), options.deadlineMs ?? READ_DEADLINE_MS);
  try {
    let identityRaw: GhCommandResult | string; try { identityRaw = await invokeGh(gh, ["api", "user", "--jq", ".login"], controller.signal); } catch (error) { throw error instanceof MonitorFailure ? error : new MonitorFailure("GITHUB_MONITOR_AUTH"); }
    const login = parseLoginOutput(identityRaw);
    let firstDiscoveryFailure: unknown;
    let discoveryFailed = false;
    const discover = async (role: GithubPrMonitorRole): Promise<DiscoveryData> => {
      try {
        return await discoverRole(gh, login, role, controller.signal);
      } catch (error) {
        if (!discoveryFailed) {
          discoveryFailed = true;
          firstDiscoveryFailure = error;
          controller.abort("discovery-fatal");
        }
        throw error;
      }
    };
    const discoverySettled = await Promise.allSettled([
      discover("authored"),
      discover("requested_reviewer"),
    ]);
    if (discoveryFailed) throw firstDiscoveryFailure;
    const [authoredResult, requestedReviewerResult] = discoverySettled;
    if (authoredResult.status === "rejected") throw authoredResult.reason;
    if (requestedReviewerResult.status === "rejected") throw requestedReviewerResult.reason;
    const authored = authoredResult.value;
    const requestedReviewer = requestedReviewerResult.value;
    const candidates = mergeCandidates(authored, requestedReviewer);
    const snapshots: GithubPrSnapshot[] = []; const races = { prClosed: 0, authoredRoleLost: 0, reviewerRequestLost: 0 };
    let next = 0; let fatal: unknown; let fatalSet = false;
    const latchSnapshotFatal = (error: unknown): void => {
      if (fatalSet) return;
      fatalSet = true;
      fatal = error;
      controller.abort("fatal");
    };
    const worker = async () => {
      while (!fatalSet) {
        const index = next++;
        if (index >= candidates.length) return;
        try {
          const result = await snapshot(gh, candidates[index]!, login, controller.signal);
          if (result.snapshot) snapshots.push(result.snapshot);
          for (const race of result.races ?? []) races[race]++;
        } catch (error) {
          latchSnapshotFatal(error);
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SNAPSHOT_WORKERS, Math.max(1, candidates.length)) }, worker));
    if (controller.signal.aborted && !fatalSet) throw new MonitorFailure(external?.aborted ? "GITHUB_MONITOR_ABORTED" : "GITHUB_MONITOR_TIMEOUT");
    if (fatalSet) throw fatal;
    snapshots.sort((x, y) => compareCodeUnit(x.baseRepository.nameWithOwner, y.baseRepository.nameWithOwner) || x.number - y.number);
    const discovery: Discovery = {
      authored: authored.role, requestedReviewer: requestedReviewer.role, uniqueCandidateCount: candidates.length,
      snapshotAttemptCount: candidates.length, snapshotCount: snapshots.length, races,
      complete: authored.role.complete && requestedReviewer.role.complete && Object.values(races).every((n) => n === 0) && snapshots.length === candidates.length,
    };
    const observedAt = (options.now ?? (() => new Date()))().toISOString();
    const payload = { monitorPayloadVersion: 1 as const, protocolVersion: 1 as const, schemaVersion: 4 as const, requestDigest: digest, namespace: "ChatGPT_To_Codex" as const, tool: "github_pr_monitor_read" as const, operation: "read" as const, ok: true as const, runId: input.runId, actionPlanId: input.actionPlanId, account: { login }, discovery, prs: snapshots, observedAt };
    if (Buffer.byteLength(canonicalJson(payload), "utf8") > MAX_PAYLOAD_BYTES) throw new MonitorFailure("GITHUB_MONITOR_OUTPUT_LIMIT");
    const nonce = options.nonce?.() ?? randomUUID(); const receiptId = ephemeralReceiptId({ tool: payload.tool, monitorPayloadVersion: payload.monitorPayloadVersion, requestDigest: digest, observedAt, nonce, payload });
    const result: GithubPrMonitorReadResult = {
      monitorPayloadVersion: payload.monitorPayloadVersion, protocolVersion: payload.protocolVersion, schemaVersion: payload.schemaVersion,
      requestDigest: payload.requestDigest, receiptId, namespace: payload.namespace, tool: payload.tool, operation: payload.operation,
      ok: payload.ok, runId: payload.runId, actionPlanId: payload.actionPlanId, account: payload.account,
      discovery: payload.discovery, prs: payload.prs, observedAt: payload.observedAt, chatgpt2codexToolCall: makeToolCallProof(input, true),
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_WIRE_BYTES) throw new MonitorFailure("GITHUB_MONITOR_OUTPUT_LIMIT");
    return result;
  } catch (error) {
    const code = controller.signal.aborted && !external?.aborted && !(error instanceof MonitorFailure) ? "GITHUB_MONITOR_TIMEOUT" : asFailure(error);
    return { monitorPayloadVersion: 1, protocolVersion: 1, schemaVersion: 4, requestDigest: digest, namespace: "ChatGPT_To_Codex", tool: "github_pr_monitor_read", operation: "read", ok: false, runId: input.runId, actionPlanId: input.actionPlanId, code, error: safeErrorMessage(code), chatgpt2codexToolCall: makeToolCallProof(input, false) };
  } finally {
    if (deadline) clearTimeout(deadline); if (external) external.removeEventListener("abort", abortFromExternal);
  }
}

export function createGithubPrMonitorRead(options: GithubPrMonitorReadOptions = {}): (input: unknown) => Promise<GithubPrMonitorReadResult | GithubPrMonitorErrorResult> {
  return async (input) => runGithubPrMonitorRead(input, options);
}

export function directMonitorCycleSummary(result: GithubPrMonitorReadResult): DirectMonitorCycleSummary {
  return {
    cyclePayloadVersion: 1, runId: result.runId, actionPlanId: result.actionPlanId, account: result.account,
    discovery: result.discovery,
    prs: result.prs.map((pr) => ({ number: pr.number, url: pr.url, roles: pr.roles, baseRepository: pr.baseRepository, headRepository: pr.headRepository, headRefName: pr.headRefName, headRefOid: pr.headRefOid, reviewCount: pr.reviews.length, commentCount: pr.comments.length, threadCount: pr.reviewThreads.length, unresolvedThreadCount: pr.reviewThreads.filter((thread) => !thread.isResolved).length, ciSummary: pr.ciSummary })),
    observedAt: result.observedAt,
  };
}
