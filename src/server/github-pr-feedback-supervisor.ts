import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createDirectWriteActionClient, type DirectMonitorWriteTool } from "./direct-action-client.js";
import type { GhCommand } from "./github-pr-write-effects.js";
import { GithubPrWriteAuthority } from "./github-pr-write-authority.js";
import {
  GITHUB_PR_WRITE_ACCOUNT,
  canonicalJson,
  digest,
  type WriteOperation,
} from "./github-pr-write-contract.js";
import type { Config, ToolContext } from "../types.js";

const SUPERVISOR_STATE_VERSION = 1 as const;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_STATE_BYTES = 512 * 1024;
const MAX_FEEDBACK_ITEMS = 24;
const MAX_LLM_FEEDBACK_ITEMS = 8;
const MAX_FEEDBACK_BODY_BYTES = 8 * 1024;
const MAX_FEEDBACK_RESPONSE_BYTES = 1 * 1024 * 1024;
const MAX_PROMPT_BYTES = 48 * 1024;
const MAX_LLM_RESPONSE_BYTES = 64 * 1024;
const LLM_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 30_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/iu;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/u;
const EXCLUDED_REPOSITORIES = new Set(["yeachan-heo/gajae-code", "twoimo/gajae-code"]);
const execFileAsync = promisify(execFile);
const supervisorGhCommand: GhCommand = async (argv, timeoutMs) => {
  try {
    const result = await execFileAsync("gh", [...argv], {
      timeout: timeoutMs,
      maxBuffer: MAX_FEEDBACK_RESPONSE_BYTES,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return {
      stdout: typeof value.stdout === "string" ? value.stdout : "",
      stderr: typeof value.stderr === "string" ? value.stderr : "",
      exitCode: typeof value.code === "number" ? value.code : 1,
      timedOut: value.killed === true,
    };
  }
};

export interface GithubPrFeedbackSupervisorOptions {
  readonly stateDir: string;
  readonly workspaceRoot: string;
  readonly intervalMs?: number;
  readonly once?: boolean;
  readonly gh?: GhCommand;
  readonly chatgptCdpUrl?: string;
}

export interface GithubPrFeedbackSupervisor {
  close(): Promise<void>;
}

type SupervisorState = {
  version: typeof SUPERVISOR_STATE_VERSION;
  processed: Record<string, Record<string, string>>;
  terminal: Record<string, "approved" | "merged" | "closed" | "stopped">;
  lastRunAt?: string;
};

type FeedbackItem = {
  id: string;
  kind: "review" | "issue_comment" | "review_comment";
  author: string;
  body: string;
  path?: string;
  line?: number;
  threadId?: string;
  digest: string;
};

type PrEvidence = {
  repository: string;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  reviewDecision: string | null;
  author: string;
  expectedHead: string;
  baseRepository: string;
  headRepository: string;
  headRef: string;
  baseRepositoryId: number;
  headRepositoryId: number;
  repositoryId: number;
  accountId: number;
  accountNodeId: string;
  authorId: number;
  authorNodeId: string;
  authorActorType: "User" | "Bot" | "Team" | "App" | "Unknown";
  permission: "NONE" | "READ" | "TRIAGE" | "WRITE" | "MAINTAIN" | "ADMIN";
  canPush: boolean;
};

type LlmDecision =
  | { action: "reply"; body: string; rationale: string }
  | { action: "fix"; body?: string; rationale: string; commitMessage: string; suggestions: Array<{ path: string; startLine: number; endLine: number; oldText: string; replacement: string }> }
  | { action: "wait"; rationale: string; retryable?: boolean }
  | { action: "stop"; rationale: string };

type CdpSocket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "error" | "message", listener: (event: { data?: string }) => void, options?: { once?: boolean }): void;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} is invalid or too large`);
  return value;
}
function truncateText(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes ? value : `${bytes.subarray(0, maxBytes).toString("utf8")}…`;
}
function safeRepository(value: unknown): string {
  if (typeof value !== "string" || !REPOSITORY_PATTERN.test(value)) throw new Error("repository identity is invalid");
  return value.toLowerCase();
}
function safeSha(value: unknown): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) throw new Error("head identity is invalid");
  return value.toLowerCase();
}
function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 300 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function safeGithubNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error("supervisor aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function defaultStatePath(stateDir: string): string { return path.join(stateDir, "github-pr-feedback-supervisor.json"); }
function keyFor(repository: string, number: number): string { return `${repository.toLowerCase()}#${number}`; }
function bodyDigest(item: Pick<FeedbackItem, "kind" | "author" | "body" | "path" | "line">): string { return sha256(canonicalJson(item)); }

async function loadState(statePath: string): Promise<SupervisorState> {
  const info = await lstat(statePath).catch(() => undefined);
  if (!info) return { version: SUPERVISOR_STATE_VERSION, processed: {}, terminal: {} };
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) throw new Error("supervisor state file is invalid");
  const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  const value = record(parsed, "supervisor state is invalid");
  if (value.version !== SUPERVISOR_STATE_VERSION || !record(value.processed, "supervisor processed state is invalid") || !record(value.terminal, "supervisor terminal state is invalid")) throw new Error("supervisor state version is invalid");
  return {
    version: SUPERVISOR_STATE_VERSION,
    processed: value.processed as Record<string, Record<string, string>>,
    terminal: value.terminal as Record<string, "approved" | "merged" | "closed" | "stopped">,
    ...(typeof value.lastRunAt === "string" ? { lastRunAt: value.lastRunAt } : {}),
  };
}
async function saveState(statePath: string, state: SupervisorState): Promise<void> {
  const parent = path.dirname(statePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) throw new Error("supervisor state exceeds its bound");
  await writeFile(temporary, serialized, { mode: 0o600 });
  await rename(temporary, statePath);
  await chmod(statePath, 0o600);
}

async function ghJson(gh: GhCommand, argv: readonly string[], label: string, maxBytes = 128 * 1024): Promise<unknown> {
  const result = await gh(argv, GH_TIMEOUT_MS);
  if (result.timedOut || result.exitCode !== 0 || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout, "utf8") > maxBytes) throw new Error(`${label} is unavailable`);
  try { return JSON.parse(result.stdout); } catch { throw new Error(`${label} returned invalid JSON`); }
}
function flattenPages(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [value];
  return value.flatMap((item) => Array.isArray(item) ? flattenPages(item) : [item]);
}
async function ghApiPages(gh: GhCommand, endpoint: string, label: string): Promise<Record<string, unknown>[]> {
  const value = await ghJson(gh, ["api", endpoint, "--hostname", "github.com", "--paginate", "--slurp"], label, MAX_FEEDBACK_RESPONSE_BYTES);
  return flattenPages(value).filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
}

async function collectPrEvidence(gh: GhCommand, repository: string, number: number): Promise<PrEvidence> {
  const view = record(await ghJson(gh, ["pr", "view", String(number), "--repo", repository, "--json", "number,title,body,state,reviewDecision,author,headRefName,headRefOid,headRepository"], "pull request evidence"), "pull request evidence");
  const user = record(await ghJson(gh, ["api", "user", "--hostname", "github.com"], "authenticated user evidence"), "authenticated user evidence");
  const authorRecord = record(view.author, "pull request author evidence");
  const head = record(view.headRepository, "head repository evidence");
  const baseName = safeRepository(repository);
  const headName = safeRepository(head.nameWithOwner);
  const repoName = baseName;
  const accountLogin = safeId(user.login, "authenticated login");
  const authorLogin = safeId(authorRecord.login, "author login");
  if (accountLogin !== GITHUB_PR_WRITE_ACCOUNT) throw new Error("authenticated account is not the configured operator");
  if (repoName !== baseName) throw new Error("pull request repository evidence is mismatched");
  const baseRepoInfo = record(await ghJson(gh, ["api", `repos/${baseName}`, "--hostname", "github.com"], "base repository permissions"), "base repository permissions");
  const headRepoInfo = headName === baseName ? baseRepoInfo : record(await ghJson(gh, ["api", `repos/${headName}`, "--hostname", "github.com"], "head repository permissions"), "head repository permissions");
  let authorInfo: Record<string, unknown>;
  if (authorLogin === accountLogin) {
    authorInfo = user;
  } else {
    try {
      authorInfo = record(await ghJson(gh, ["api", `users/${encodeURIComponent(authorLogin)}`, "--hostname", "github.com"], "author identity"), "author identity");
    } catch {
      const appName = authorLogin.startsWith("app/") ? authorLogin.slice(4) : undefined;
      if (!appName) throw new Error("author identity is unavailable");
      authorInfo = record(await ghJson(gh, ["api", `apps/${encodeURIComponent(appName)}`, "--hostname", "github.com"], "author app identity"), "author app identity");
    }
  }
  const permissions = record(baseRepoInfo.permissions, "base repository permissions");
  const headPermissions = record(headRepoInfo.permissions, "head repository permissions");
  const permission = permissions.push === true ? "WRITE" : permissions.admin === true ? "ADMIN" : permissions.maintain === true ? "MAINTAIN" : permissions.triage === true ? "TRIAGE" : permissions.pull === true ? "READ" : "NONE";
  const authorType = authorInfo.type === "User" || authorInfo.type === "Bot" || authorInfo.type === "Team" || authorInfo.type === "App" ? authorInfo.type : "Unknown";
  const baseRepositoryId = safeGithubNumber(baseRepoInfo.id, "base repository id");
  const headRepositoryId = safeGithubNumber(headRepoInfo.id, "head repository id");
  const accountId = safeGithubNumber(user.id, "account id");
  const authorId = safeGithubNumber(authorInfo.id, "author id");
  return {
    repository: repoName, number, title: boundedText(view.title, 512, "pull request title"), body: truncateText(view.body ?? "", 12 * 1024, "pull request body"),
    state: view.state === "MERGED" || view.state === "CLOSED" || view.state === "OPEN" ? view.state : (() => { throw new Error("pull request state is invalid"); })(),
    reviewDecision: view.reviewDecision === null || typeof view.reviewDecision === "string" ? view.reviewDecision : null,
    author: authorLogin, expectedHead: safeSha(view.headRefOid), baseRepository: baseName, headRepository: headName,
    headRef: boundedText(view.headRefName, 200, "head ref"),
    baseRepositoryId, headRepositoryId, repositoryId: baseRepositoryId,
    accountId, accountNodeId: safeId(user.node_id, "account node id"), authorId, authorNodeId: safeId(authorInfo.node_id, "author node id"), authorActorType: authorType,
    permission, canPush: headPermissions.push === true,
  };
}

async function collectFeedback(gh: GhCommand, evidence: PrEvidence): Promise<FeedbackItem[]> {
  const [reviews, issueComments, reviewComments] = await Promise.all([
    ghApiPages(gh, `repos/${evidence.repository}/pulls/${evidence.number}/reviews`, "pull request reviews"),
    ghApiPages(gh, `repos/${evidence.repository}/issues/${evidence.number}/comments`, "issue comments"),
    ghApiPages(gh, `repos/${evidence.repository}/pulls/${evidence.number}/comments`, "review comments"),
  ]);
  const items: FeedbackItem[] = [];
  const add = (value: Record<string, unknown>, kind: FeedbackItem["kind"]) => {
    const authorValue = value.user;
    const author = authorValue && typeof authorValue === "object" && !Array.isArray(authorValue) ? (authorValue as Record<string, unknown>).login : undefined;
    if (typeof author !== "string" || author === evidence.author || author === GITHUB_PR_WRITE_ACCOUNT) return;
    const body = typeof value.body === "string" ? value.body : "";
    if (body.trim().length === 0 || Buffer.byteLength(body, "utf8") > MAX_FEEDBACK_BODY_BYTES) return;
    const pathValue = typeof value.path === "string" ? value.path : undefined;
    const line = typeof value.line === "number" && Number.isSafeInteger(value.line) ? value.line : undefined;
    const base = { kind, author: safeId(author, "feedback author"), body, ...(pathValue ? { path: boundedText(pathValue, 240, "feedback path") } : {}), ...(line ? { line } : {}) } as const;
    const feedbackId = typeof value.id === "number" || typeof value.id === "string" ? String(value.id) : undefined;
    if (!feedbackId) return;
    const nodeId = kind === "review_comment" && typeof value.node_id === "string" ? value.node_id : undefined;
    items.push({ id: safeId(feedbackId, "feedback id"), ...base, ...(nodeId ? { threadId: safeId(nodeId, "review comment node id") } : {}), digest: bodyDigest(base) });
  };
  for (const value of reviews) add(value, "review");
  for (const value of issueComments) add(value, "issue_comment");
  for (const value of reviewComments) add(value, "review_comment");
  const unique = new Map<string, FeedbackItem>();
  for (const item of items) unique.set(`${item.kind}:${item.id}`, item);
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_FEEDBACK_ITEMS);
}

async function resolveReviewThreadId(gh: GhCommand, evidence: PrEvidence, commentNodeId: string): Promise<string | undefined> {
  const [owner, repo] = evidence.repository.split("/", 2);
  const threadValue = await ghJson(gh, [
    "api", "graphql", "--hostname", "github.com",
    "-f", "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id comments(first:100){nodes{id}}}}}}}",
    "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${evidence.number}`,
  ], "review thread evidence").catch(() => undefined);
  const value = threadValue && typeof threadValue === "object" && !Array.isArray(threadValue) ? threadValue as Record<string, unknown> : undefined;
  const data = value?.data && typeof value.data === "object" && !Array.isArray(value.data) ? value.data as Record<string, unknown> : undefined;
  const repositoryValue = data?.repository && typeof data.repository === "object" && !Array.isArray(data.repository) ? data.repository as Record<string, unknown> : undefined;
  const pullRequest = repositoryValue?.pullRequest && typeof repositoryValue.pullRequest === "object" && !Array.isArray(repositoryValue.pullRequest) ? repositoryValue.pullRequest as Record<string, unknown> : undefined;
  const reviewThreads = pullRequest?.reviewThreads && typeof pullRequest.reviewThreads === "object" && !Array.isArray(pullRequest.reviewThreads) ? pullRequest.reviewThreads as Record<string, unknown> : undefined;
  const nodes = Array.isArray(reviewThreads?.nodes) ? reviewThreads.nodes : [];
  for (const rawThread of nodes) {
    if (!rawThread || typeof rawThread !== "object" || Array.isArray(rawThread)) continue;
    const thread = rawThread as Record<string, unknown>;
    const comments = thread.comments && typeof thread.comments === "object" && !Array.isArray(thread.comments)
      ? thread.comments as Record<string, unknown>
      : undefined;
    if (typeof thread.id !== "string" || !Array.isArray(comments?.nodes)) continue;
    if (comments.nodes.some((rawComment) => rawComment && typeof rawComment === "object" && !Array.isArray(rawComment) && (rawComment as Record<string, unknown>).id === commentNodeId)) {
      return safeId(thread.id, "review thread id");
    }
  }
  return undefined;
}

async function discoverCandidates(gh: GhCommand): Promise<Array<{ repository: string; number: number }>> {
  const [authored, requested] = await Promise.all([
    ghJson(gh, ["search", "prs", "--author", GITHUB_PR_WRITE_ACCOUNT, "--state", "open", "--limit", "100", "--json", "repository,number"], "authored PR discovery"),
    ghJson(gh, ["search", "prs", "--review-requested", GITHUB_PR_WRITE_ACCOUNT, "--state", "open", "--limit", "100", "--json", "repository,number"], "review-requested PR discovery"),
  ]);
  const candidates = new Map<string, { repository: string; number: number }>();
  for (const value of [...flattenPages(authored), ...flattenPages(requested)]) {
    try {
      const item = record(value, "PR discovery item is invalid");
      const repositoryValue = record(item.repository, "PR discovery repository is invalid");
      const repository = safeRepository(repositoryValue.nameWithOwner);
      const number = item.number;
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) throw new Error("PR discovery number is invalid");
      const key = keyFor(repository, number);
      if (!EXCLUDED_REPOSITORIES.has(repository)) candidates.set(key, { repository, number });
    } catch {
      continue;
    }
  }
  return [...candidates.values()].sort((left, right) => left.repository.localeCompare(right.repository) || left.number - right.number);
}

async function sourceSnippets(gh: GhCommand, evidence: PrEvidence, feedback: FeedbackItem[]): Promise<Array<{ path: string; content: string }>> {
  const paths = [...new Set(feedback.map((item) => item.path).filter((value): value is string => {
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 240 || value.startsWith("/") || /[\u0000-\u001f\u007f?#\\]/u.test(value)) return false;
    const parts = value.split("/");
    return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
  }))].slice(0, 2);
  const output: Array<{ path: string; content: string }> = [];
  for (const filePath of paths) {
    const encodedPath = filePath.split("/").map((part) => encodeURIComponent(part)).join("/");
    const encoded = await ghJson(gh, ["api", `repos/${evidence.headRepository}/contents/${encodedPath}?ref=${encodeURIComponent(evidence.expectedHead)}`, "--hostname", "github.com"], "source file").catch(() => undefined);
    if (!encoded || typeof encoded !== "object" || Array.isArray(encoded)) continue;
    const value = encoded as Record<string, unknown>;
    if (value.encoding !== "base64" || typeof value.content !== "string") continue;
    const content = Buffer.from(value.content.replace(/\s+/gu, ""), "base64").toString("utf8");
    if (Buffer.byteLength(content, "utf8") <= 6 * 1024) output.push({ path: filePath, content });
    else output.push({ path: filePath, content: truncateText(content, 6 * 1024, "source snippet") });
  }
  return output;
}

function parseLlmDecision(raw: string): LlmDecision {
  const bounded = boundedText(raw, MAX_LLM_RESPONSE_BYTES, "ChatGPT response").trim();
  const candidates = [bounded, bounded.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")];
  let parsed: unknown;
  for (const candidate of candidates) {
    try { parsed = JSON.parse(candidate); break; } catch { /* try next */ }
  }
  const value = record(parsed, "ChatGPT response must be a JSON object");
  const action = value.action;
  const rationale = boundedText(value.rationale ?? "", 2_000, "decision rationale");
  if (action === "reply") {
    const body = boundedText(value.body, 6_000, "reply body").trim();
    if (body.length < 6) throw new Error("ChatGPT reply body is too short");
    return { action, body, rationale };
  }
  if (action === "wait" || action === "stop") return { action, rationale };
  if (action === "fix") {
    const commitMessage = boundedText(value.commitMessage, 120, "commit message");
    if (!Array.isArray(value.suggestions) || value.suggestions.length < 1 || value.suggestions.length > 10) throw new Error("ChatGPT suggestions are invalid");
    const suggestions = value.suggestions.map((rawSuggestion) => {
      const suggestion = record(rawSuggestion, "ChatGPT suggestion is invalid");
      const filePath = boundedText(suggestion.path, 240, "suggestion path");
      const startLine = suggestion.startLine; const endLine = suggestion.endLine;
      if (typeof startLine !== "number" || typeof endLine !== "number" || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) throw new Error("ChatGPT suggestion lines are invalid");
      return {
        path: filePath,
        startLine,
        endLine,
        oldText: boundedText(suggestion.oldText, 12_000, "suggestion old text"),
        replacement: boundedText(suggestion.replacement, 12_000, "suggestion replacement"),
      };
    });
    const body = value.body === undefined ? undefined : boundedText(value.body, 6_000, "fix reply body").trim();
    return { action, ...(body ? { body } : {}), rationale, commitMessage, suggestions };
  }
  throw new Error("ChatGPT decision action is invalid");
}

class ChatGptWebClient {
  private socket?: CdpSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  constructor(private readonly endpoint: string) {}
  private async connect(): Promise<void> {
    const response = await fetch(`${this.endpoint.replace(/\/$/u, "")}/json/list`);
    const targets = await response.json() as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
    const target = targets.find((item) => item.type === "page" && typeof item.url === "string" && item.url.startsWith("https://chatgpt.com") && typeof item.webSocketDebuggerUrl === "string");
    if (!target?.webSocketDebuggerUrl) throw new Error("ChatGPT Web page target is unavailable");
    const WebSocketConstructor = (globalThis as unknown as { WebSocket: new (url: string) => CdpSocket }).WebSocket;
    const socket = new WebSocketConstructor(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("ChatGPT Web CDP connection failed")), { once: true }); });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data ?? "") as { id?: number; result?: unknown; error?: { message?: string } };
        if (message.id === undefined) return;
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "ChatGPT Web CDP error")); else pending.resolve(message.result);
      } catch { /* ignore protocol noise */ }
    });
    this.socket = socket;
  }
  private call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.socket) return Promise.reject(new Error("ChatGPT Web CDP is disconnected"));
    return new Promise<T>((resolve, reject) => { const id = ++this.nextId; this.pending.set(id, { resolve, reject }); this.socket!.send(JSON.stringify({ id, method, params })); });
  }
  private async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.call<{ result?: { value?: T } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.result?.value as T;
  }
  private async sendAndWait(prompt: string, acceptStableToken = false): Promise<string> {
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("ChatGPT prompt exceeds its bound");
    await this.connect();
    try {
      await this.call("Page.navigate", { url: "https://chatgpt.com/" });
      const pageDeadline = Date.now() + 15_000;
      while (Date.now() < pageDeadline) {
        const ready = await this.evaluate<boolean>("document.readyState === 'complete' && Boolean(document.querySelector('#prompt-textarea[contenteditable=\"true\"]'))").catch(() => false);
        if (ready) break;
        await sleep(250);
      }
      const deadline = Date.now() + LLM_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await this.evaluate<boolean>(`Boolean(document.querySelector('#prompt-textarea[contenteditable="true"]'))`)) break;
        await sleep(500);
      }
      const beforeCount = await this.evaluate<number>(`document.querySelectorAll('[data-message-author-role="assistant"]').length`);
      await this.evaluate(`(()=>{const e=document.querySelector('#prompt-textarea[contenteditable="true"]'); if(!e) throw new Error('composer missing'); e.focus(); document.execCommand('selectAll'); document.execCommand('delete'); document.execCommand('insertText', false, ${JSON.stringify(prompt)}); e.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:null})); return true})()`);
      await sleep(250);
      await this.evaluate(`(()=>{const b=document.querySelector('button[data-testid="send-button"]'); if(!b || b.disabled) throw new Error('send button unavailable'); b.click(); return true})()`);
      let previous = "";
      let stablePolls = 0;
      while (Date.now() < deadline) {
        const response = await this.evaluate<{ count: number; last: string; generating: boolean }>(`(()=>{const values=[...document.querySelectorAll('[data-message-author-role="assistant"]')].map(e=>(e.innerText||'').trim()).filter(Boolean); const stop=document.querySelector('[data-testid="stop-button"]'); return {count:values.length,last:values.at(-1)||'',generating:Boolean(stop && !(stop instanceof HTMLButtonElement) || (stop instanceof HTMLButtonElement && !stop.disabled)) || /생각 중|Thinking\\.\\.\\./iu.test(document.body?.innerText||'')}})()`);
        const tokenReady = acceptStableToken && /^(WAIT|REPLY|FIX|STOP)(?:[\\s.!,:;]|$)/iu.test(response.last);
        if (response.count > beforeCount && response.last && (tokenReady || !response.generating)) {
          stablePolls = response.last === previous ? stablePolls + 1 : 0;
          previous = response.last;
          if (stablePolls >= 4) return response.last;
        }
        await sleep(1_000);
      }
      throw new Error("ChatGPT Web response timed out");
    } finally {
      this.socket?.close();
      this.socket = undefined;
      this.pending.clear();
    }
  }
  async decide(prompt: string): Promise<LlmDecision> {
    const classification = (await this.sendAndWait(prompt, true)).trim().toUpperCase();
    const action = classification.match(/^(WAIT|REPLY|FIX|STOP)\b/u)?.[1];
    if (action === "WAIT") return { action: "wait", rationale: classification.slice(4).trim() || "ChatGPT classified the feedback as non-actionable.", retryable: true };
    if (action === "STOP") return { action: "stop", rationale: classification.slice(4).trim() || "ChatGPT classified the PR as terminal." };
    if (action !== "REPLY" && action !== "FIX") return { action: "wait", rationale: "ChatGPT returned an unrecognized classification.", retryable: true };
    const detailsPrompt = `${prompt}\n\nThe classification was ${action}. Return the exact JSON object for that action now, with no markdown. Keep rationale under 200 characters.`;
    try { return parseLlmDecision(await this.sendAndWait(detailsPrompt)); }
    catch { return { action: "wait", rationale: "ChatGPT did not return a complete bounded decision object.", retryable: true }; }
  }
}

function supervisorContext(workspaceRoot: string, stateDir: string, sessionId: string, gh: GhCommand): ToolContext & { githubPrWriteGh: GhCommand } {
  const config: Config = { workspaceRoot, stateDir, maxReadBytes: 10 * 1024 * 1024, maxPatchBytes: 10 * 1024 * 1024, defaultCommandTimeoutSec: 30, defaultLeaseTtlMs: 30 * 60 * 1000 };
  return {
    workspaceRoot, stateDir, registry: [], ledger: { append: async () => undefined }, store: { loadProjects: async () => [], saveProjects: async () => undefined, getSession: async () => null, setSession: async () => undefined }, config,
    writeSessionId: sessionId, remote: false, transportKind: "operator", githubPrWriteGh: gh,
  };
}
function writeTool(operation: WriteOperation): DirectMonitorWriteTool {
  return `github_pr_monitor_write_${operation}` as DirectMonitorWriteTool;
}
function responseRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return record(value[key], `MCP response omitted ${key}`);
}

async function prepareWorktree(gh: GhCommand, evidence: PrEvidence, workspaceRoot: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const name = `${evidence.repository.replace(/[^A-Za-z0-9_.-]+/gu, "-")}-${evidence.number}-${evidence.expectedHead.slice(0, 12)}`;
  const worktree = path.join(root, ".github-pr-supervisor", name);
  await mkdir(path.dirname(worktree), { recursive: true, mode: 0o700 });
  const existing = await lstat(worktree).catch(() => undefined);
  if (!existing) {
    const result = await gh(["repo", "clone", evidence.headRepository, worktree, "--", "--filter=blob:none"], GH_TIMEOUT_MS);
    if (result.timedOut || result.exitCode !== 0) throw new Error("head repository clone failed");
  }
  try {
    await execFileAsync("git", ["checkout", "--detach", evidence.expectedHead], {
      cwd: worktree,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
  } catch {
    throw new Error("worktree checkout failed");
  }
  return worktree;
}

async function runWrite(
  client: Awaited<ReturnType<typeof createDirectWriteActionClient>>,
  authority: GithubPrWriteAuthority,
  sessionId: string,
  operation: WriteOperation,
  request: Record<string, unknown>,
  evidence: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const previewResponse = await client.call("github_pr_monitor_write_preview", { sessionId, operation, request });
  const preview = responseRecord(responseRecord(previewResponse, "structuredContent"), "preview");
  const challengeId = safeId(preview.challengeId, "challengeId");
  const previewId = safeId(preview.previewId, "previewId");
  const approval = authority.approveUnattended(challengeId, { operation, requestDigest: safeId(preview.requestDigest, "preview digest"), sessionId });
  return client.call(writeTool(operation), { sessionId, previewId, approvalId: approval.approvalId, operation, request, evidence, idempotencyKey: digest({ operation, request, evidence }) });
}

async function handleDecision(
  decision: LlmDecision,
  evidence: PrEvidence,
  feedback: FeedbackItem,
  client: Awaited<ReturnType<typeof createDirectWriteActionClient>>,
  authority: GithubPrWriteAuthority,
  sessionId: string,
  workspaceRoot: string,
  gh: GhCommand,
): Promise<void> {
  const commonEvidence = {
    account: { login: GITHUB_PR_WRITE_ACCOUNT, id: evidence.accountId, nodeId: evidence.accountNodeId, actorType: "User" },
    author: { login: evidence.author, id: evidence.authorId, nodeId: evidence.authorNodeId, actorType: evidence.authorActorType },
    baseRepositoryId: evidence.baseRepositoryId, headRepositoryId: evidence.headRepositoryId, repositoryId: evidence.repositoryId,
    permission: evidence.permission, canPush: evidence.canPush, expectedHead: evidence.expectedHead,
  };
  const baseRequest = { repository: evidence.repository, prNumber: evidence.number, expectedHead: evidence.expectedHead, baseRepository: evidence.baseRepository, headRepository: evidence.headRepository };
  if (decision.action === "reply") {
    const reviewThreadId = feedback.kind === "review_comment" && feedback.threadId
      ? await resolveReviewThreadId(gh, evidence, feedback.threadId)
      : undefined;
    const operation: WriteOperation = reviewThreadId ? "post_reply" : "post_comment";
    const request = operation === "post_reply"
      ? { ...baseRequest, body: decision.body, threadId: reviewThreadId, replyReceiptId: feedback.id }
      : { ...baseRequest, body: decision.body };
    await runWrite(client, authority, sessionId, operation, request, commonEvidence);
    return;
  }
  if (decision.action !== "fix") return;
  if (evidence.author !== GITHUB_PR_WRITE_ACCOUNT || !evidence.canPush) throw new Error("code fix is not authorized for this PR");
  const worktreePath = await prepareWorktree(gh, evidence, workspaceRoot);
  const suggestions = decision.suggestions.map((suggestion) => ({ path: suggestion.path, startLine: suggestion.startLine, endLine: suggestion.endLine, expectedDigest: sha256(suggestion.oldText), replacement: suggestion.replacement }));
  const apply = await runWrite(client, authority, sessionId, "apply_suggestions", { ...baseRequest, worktreePath, suggestions, message: decision.commitMessage }, commonEvidence);
  const applied = responseRecord(responseRecord(apply, "structuredContent"), "effect");
  const receipt = responseRecord(applied, "receipt");
  const proofDigest = safeId(receipt.verificationProofDigest, "verification proof digest");
  const commitDigest = safeId(receipt.commitDigest, "commit digest");
  if (!DIGEST_PATTERN.test(proofDigest) || !DIGEST_PATTERN.test(commitDigest)) throw new Error("code effect proof is invalid");
  await runWrite(client, authority, sessionId, "push_prepared_worktree", { ...baseRequest, worktreePath, headRef: evidence.headRef, verificationReceiptId: digest(receipt), verificationProofDigest: proofDigest, noForce: true }, commonEvidence);
  if (decision.body) await runWrite(client, authority, sessionId, "post_comment", { ...baseRequest, body: decision.body }, commonEvidence);
  void feedback;
}

function promptFor(evidence: PrEvidence, feedback: FeedbackItem[], snippets: Array<{ path: string; content: string }>): string {
  const boundedFeedback = feedback.map((item) => ({
    ...item,
    body: truncateText(item.body, 2 * 1024, "feedback body"),
  }));
  return [
    "You are the unattended GitHub PR feedback supervisor. Classify this feedback with exactly one token: WAIT, REPLY, FIX, or STOP. Do not return JSON or markdown.",
    "You may choose reply, fix, wait, or stop. Never claim tests ran unless the supplied evidence says so. For fix, use only exact oldText spans from supplied source snippets, keep changes narrowly tied to feedback, and do not change secrets, workflows, dependencies, or unrelated files.",
    "A concrete reviewer request with a path/line, a P1/P2/P3/P4 marker, or an explicit requested change is actionable even when the reviewer is a bot. Choose FIX when the supplied source supports an exact narrow edit; do not choose WAIT merely because the feedback is automated.",
    "A reply must be concise, factual, and directly address the newest feedback. Choose stop when the PR is approved/merged or feedback is not actionable. Choose wait when more CI/reviewer information is needed.",
    "Use REPLY only when a concise factual response is needed, FIX only when exact source-backed changes are required, WAIT for non-actionable notifications or pending information, and STOP for approved/merged/closed work.",
    `PR: ${JSON.stringify({ repository: evidence.repository, number: evidence.number, title: evidence.title, body: truncateText(evidence.body, 4 * 1024, "pull request body"), author: evidence.author, head: evidence.expectedHead, baseRepository: evidence.baseRepository, headRepository: evidence.headRepository, headRef: evidence.headRef })}`,
    `Feedback: ${JSON.stringify(boundedFeedback)}`,
    `Source snippets: ${JSON.stringify(snippets)}`,
  ].join("\n");
}

async function cycle(options: GithubPrFeedbackSupervisorOptions, state: SupervisorState): Promise<{ actionable: number; handled: number }> {
  if (process.env.CHATGPT2CODEX_UNATTENDED_WRITE !== "1") throw new Error("unattended supervisor requires CHATGPT2CODEX_UNATTENDED_WRITE=1");
  const statePath = defaultStatePath(options.stateDir);
  const gh = options.gh ?? supervisorGhCommand;
  const candidates = await discoverCandidates(gh);
  let authority: GithubPrWriteAuthority | undefined;
  let writeClient: Awaited<ReturnType<typeof createDirectWriteActionClient>> | undefined;
  let sessionId: string | undefined;
  let actionable = 0; let handled = 0;
  const ensureWrite = async () => {
    if (writeClient && authority && sessionId) return { writeClient, authority, sessionId };
    authority = await GithubPrWriteAuthority.open(options.stateDir);
    const capability = authority.unattendedCapability(GITHUB_PR_WRITE_ACCOUNT);
    const session = authority.openSession(capability.capabilityId, capability.generation, { transport: "github-pr-feedback-supervisor", workspace: options.workspaceRoot });
    sessionId = session.sessionId;
    writeClient = await createDirectWriteActionClient(supervisorContext(options.workspaceRoot, options.stateDir, sessionId, gh));
    return { writeClient, authority, sessionId };
  };
  try {
    for (const candidate of candidates) {
      const repository = candidate.repository;
      const key = keyFor(repository, candidate.number);
      if (state.terminal[key]) continue;
      let evidence: PrEvidence;
      try {
        evidence = await collectPrEvidence(gh, repository, candidate.number);
      } catch (error) {
        console.error(JSON.stringify({ supervisor: "github-pr-feedback", repository, number: candidate.number, skipped: error instanceof Error ? error.message : "evidence unavailable" }));
        continue;
      }
      if (evidence.state === "MERGED" || evidence.reviewDecision === "APPROVED") {
        state.terminal[key] = evidence.state === "MERGED" ? "merged" : "approved";
        continue;
      }
      if (evidence.state !== "OPEN") { state.terminal[key] = "closed"; continue; }
      let feedback: FeedbackItem[];
      try {
        feedback = await collectFeedback(gh, evidence);
      } catch (error) {
        console.error(JSON.stringify({ supervisor: "github-pr-feedback", repository, number: candidate.number, skipped: error instanceof Error ? error.message : "feedback unavailable" }));
        continue;
      }
      const processed = state.processed[key] ?? (state.processed[key] = {});
      const pending = feedback.filter((item) => processed[item.id] !== item.digest);
      if (pending.length === 0) continue;
      actionable++;
      const promptItems = pending.slice(-MAX_LLM_FEEDBACK_ITEMS);
      const selected = promptItems.at(-1)!;
      let decision: LlmDecision;
      try {
        const snippets = await sourceSnippets(gh, evidence, promptItems);
        const llm = new ChatGptWebClient(options.chatgptCdpUrl ?? "http://127.0.0.1:9229");
        decision = await llm.decide(promptFor(evidence, promptItems, snippets));
      } catch (error) {
        console.error(JSON.stringify({ supervisor: "github-pr-feedback", repository, number: candidate.number, skipped: error instanceof Error ? error.message : "ChatGPT decision unavailable" }));
        continue;
      }
      console.error(JSON.stringify({ supervisor: "github-pr-feedback", repository, number: candidate.number, decision: decision.action, rationale: truncateText(decision.rationale, 240, "decision rationale") }));
      if (decision.action === "wait" && decision.retryable) continue;
      try {
        if (decision.action === "stop") state.terminal[key] = "stopped";
        else if (decision.action === "reply" || decision.action === "fix") {
          const write = await ensureWrite();
          await handleDecision(decision, evidence, selected, write.writeClient, write.authority, write.sessionId, options.workspaceRoot, gh);
          handled++;
        }
      } catch (error) {
        console.error(JSON.stringify({ supervisor: "github-pr-feedback", repository, number: candidate.number, skipped: error instanceof Error ? error.message : "write action failed" }));
        continue;
      }
      for (const item of promptItems) processed[item.id] = item.digest;
      await saveState(statePath, state);
    }
  } finally {
    if (writeClient) await writeClient.close();
    authority?.close();
  }
  state.lastRunAt = new Date().toISOString();
  await saveState(statePath, state);
  return { actionable, handled };
}

export async function runGithubPrFeedbackSupervisor(options: GithubPrFeedbackSupervisorOptions): Promise<GithubPrFeedbackSupervisor> {
  if (process.platform !== "darwin") throw new Error("GitHub PR feedback supervisor requires Darwin");
  if (process.env.CHATGPT2CODEX_UNATTENDED_WRITE !== "1") throw new Error("set CHATGPT2CODEX_UNATTENDED_WRITE=1 to enable unattended writes");
  const statePath = defaultStatePath(options.stateDir);
  const state = await loadState(statePath);
  const intervalMs = Math.max(60_000, Math.min(options.intervalMs ?? DEFAULT_INTERVAL_MS, 24 * 60 * 60 * 1000));
  let closed = false;
  let running = false;
  const run = async () => {
    if (closed || running) return;
    running = true;
    try { const result = await cycle(options, state); console.error(JSON.stringify({ supervisor: "github-pr-feedback", ...result, at: new Date().toISOString() })); }
    catch (error) { console.error(JSON.stringify({ supervisor: "github-pr-feedback", error: error instanceof Error ? error.message : "unknown", at: new Date().toISOString() })); }
    finally { running = false; }
  };
  await run();
  if (options.once) return { async close() { closed = true; } };
  const timer = setInterval(() => { void run(); }, intervalMs);
  return {
    async close() { closed = true; clearInterval(timer); while (running) await sleep(50); },
  };
}
