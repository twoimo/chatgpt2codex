import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GithubPrWriteAuthority } from "./github-pr-write-authority.js";
import { SECURE_ENCLAVE_OPERATOR_PROFILE, WRITE_HELPER_PROTOCOL, approvalPayloadDigest } from "./github-pr-write-attestation.js";
import { GITHUB_PR_WRITE_ACCOUNT, GITHUB_PR_WRITE_REPOSITORY, canonicalJson } from "./github-pr-write-contract.js";
import { registerGithubPrMonitorWriteTools } from "./github-pr-monitor-write";
const fakeContext = {} as never;
const head = "0123456789abcdef0123456789abcdef01234567";
function proof(challengeId: string) {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const payload = canonicalJson({ challengeId, profile: SECURE_ENCLAVE_OPERATOR_PROFILE });
  const signature = sign("sha256", Buffer.from(payload, "utf8"), { key: pair.privateKey, dsaEncoding: "der" });
  return {
    protocol: WRITE_HELPER_PROTOCOL,
    challengeId,
    helperUid: process.getuid?.() ?? -1,
    userPresence: true as const,
    profile: SECURE_ENCLAVE_OPERATOR_PROFILE,
    payloadDigest: approvalPayloadDigest(challengeId),
    publicKeyDerBase64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    signatureDerBase64: signature.toString("base64"),
  };
}

type Registered = { name: string; config: Record<string, unknown>; handler: (input: unknown) => Promise<Record<string, unknown>> };

function fakeServer() {
  const registered: Registered[] = [];
  return {
    registered,
    registerTool(name: string, config: Record<string, unknown>, handler: (input: unknown) => Promise<Record<string, unknown>>) {
      registered.push({ name, config, handler });
    },
  };
}

describe("github-pr-monitor-write transport", () => {
  it("registers only the dedicated preview/request/status and operation tools", () => {
    const server = fakeServer();
    registerGithubPrMonitorWriteTools(server as never, fakeContext);
    expect(server.registered.map((entry) => entry.name)).toEqual([
      "github_pr_monitor_write_preview",
      "github_pr_monitor_write_request",
      "github_pr_monitor_write_status",
      "github_pr_monitor_write_post_comment",
      "github_pr_monitor_write_post_reply",
      "github_pr_monitor_write_resolve_thread",
      "github_pr_monitor_write_rerequest_reviewer",
      "github_pr_monitor_write_approve",
      "github_pr_monitor_write_merge",
      "github_pr_monitor_write_apply_suggestions",
      "github_pr_monitor_write_push_prepared_worktree",
    ]);
  });

  it("fails closed when the host authority is unavailable", async () => {
    const server = fakeServer();
    registerGithubPrMonitorWriteTools(server as never, fakeContext);
    const result = await server.registered[0]!.handler({
      sessionId: "session-1",
      operation: "post_comment",
      request: { body: "hello" },
    });
    expect(result).toMatchObject({ isError: true, structuredContent: { ok: false, protocolVersion: 5, schemaVersion: 5 } });
  });

  it("rejects remote authority fields before any effect", async () => {
    const server = fakeServer();
    registerGithubPrMonitorWriteTools(server as never, fakeContext);
    const result = await server.registered[0]!.handler({
      sessionId: "session-1",
      operation: "post_comment",
      request: { body: "hello" },
      confirm: true,
    });
    expect(result).toMatchObject({ isError: true, structuredContent: { ok: false, error: { code: "GITHUB_WRITE_INVALID_INPUT" } } });
  });
  it("does not let an unattended remote context inherit a process-wide allowlist", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "github-write-allowlist-"));
    const previousUnattended = process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
    const previousRollout = process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = "enabled";
    const authority = await GithubPrWriteAuthority.open(stateDir);
    const capability = authority.issueCapability(GITHUB_PR_WRITE_ACCOUNT);
    const session = authority.openSession(capability.capabilityId, capability.generation);
    const server = fakeServer();
    registerGithubPrMonitorWriteTools(server as never, {
      githubPrWriteRepositoryAllowlist: [],
    } as never, authority);
    const result = await server.registered.find((entry) => entry.name === "github_pr_monitor_write_preview")!.handler({
      sessionId: session.sessionId,
      operation: "post_comment",
      request: {
        repository: "twoimo/tzudong",
        prNumber: 7,
        expectedHead: head,
        baseRepository: "twoimo/tzudong",
        headRepository: "twoimo/tzudong",
        body: "hello",
      },
    });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "GITHUB_WRITE_MUTATION_DENIED" } } });
    if (previousUnattended === undefined) delete process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
    else process.env.CHATGPT2CODEX_UNATTENDED_WRITE = previousUnattended;
    if (previousRollout === undefined) delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
    else process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = previousRollout;
    authority.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  it("requires the explicit supervisor operator transport for unattended writes", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "github-write-transport-boundary-"));
    const previousUnattended = process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
    const previousRollout = process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = "enabled";
    const authority = await GithubPrWriteAuthority.open(stateDir);
    const capability = authority.issueCapability(GITHUB_PR_WRITE_ACCOUNT);
    const session = authority.openSession(capability.capabilityId, capability.generation);
    const server = fakeServer();
    registerGithubPrMonitorWriteTools(server as never, {
      githubPrWriteRepositoryAllowlist: ["twoimo/tzudong"],
    } as never, authority);
    try {
      const result = await server.registered.find((entry) => entry.name === "github_pr_monitor_write_preview")!.handler({
        sessionId: session.sessionId,
        operation: "post_comment",
        request: {
          repository: "twoimo/tzudong",
          prNumber: 7,
          expectedHead: head,
          baseRepository: "twoimo/tzudong",
          headRepository: "twoimo/tzudong",
          body: "hello",
        },
      });
      expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "GITHUB_WRITE_MUTATION_DENIED" } } });
    } finally {
      if (previousUnattended === undefined) delete process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
      else process.env.CHATGPT2CODEX_UNATTENDED_WRITE = previousUnattended;
      if (previousRollout === undefined) delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
      else process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = previousRollout;
      authority.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
  it("executes a reviewed comment only after authority approval and records a redacted outcome", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "github-write-transport-"));
    const previousRollout = process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
    process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = "enabled";
    const authority = await GithubPrWriteAuthority.open(stateDir);
    const calls: string[][] = [];
    const gh = async (argv: readonly string[]) => {
      calls.push([...argv]);
      if (calls.length === 1) return { stdout: GITHUB_PR_WRITE_ACCOUNT, exitCode: 0 };
      if (calls.length === 2) return {
        stdout: JSON.stringify({
          state: "OPEN",
          author: { login: "alice" },
          headRefOid: head,
          repository: { nameWithOwner: GITHUB_PR_WRITE_REPOSITORY },
          baseRepository: { nameWithOwner: GITHUB_PR_WRITE_REPOSITORY },
          headRepository: { nameWithOwner: GITHUB_PR_WRITE_REPOSITORY },
        }),
        exitCode: 0,
      };
      return { stdout: "{\"id\":123}", exitCode: 0 };
    };
    const context = { githubPrWriteGh: gh } as never;
    const server = fakeServer();
    registerGithubPrMonitorWriteTools(server as never, context, authority);
    const previewInput = {
      sessionId: "",
      operation: "post_comment",
      request: {
        repository: GITHUB_PR_WRITE_REPOSITORY,
        prNumber: 7,
        expectedHead: head,
        baseRepository: GITHUB_PR_WRITE_REPOSITORY,
        headRepository: GITHUB_PR_WRITE_REPOSITORY,
        body: "hello",
      },
    };
    const capability = authority.issueCapability(GITHUB_PR_WRITE_ACCOUNT);
    const session = authority.openSession(capability.capabilityId, capability.generation);
    previewInput.sessionId = session.sessionId;
    const preview = await server.registered.find((entry) => entry.name === "github_pr_monitor_write_preview")!.handler(previewInput);
    const previewId = String((preview.structuredContent as { preview: { previewId: string } }).preview.previewId);
    const challenge = authority.createChallenge(previewId);
    const approval = authority.approve(challenge.challengeId, proof(challenge.challengeId));
    const evidence = {
      account: { login: GITHUB_PR_WRITE_ACCOUNT, id: 1, nodeId: "U1", actorType: "User" },
      author: { login: "alice", id: 1, nodeId: "U1", actorType: "User" },
      baseRepositoryId: 1,
      headRepositoryId: 1,
      repositoryId: 1,
      permission: "WRITE",
      canPush: true,
      expectedHead: head,
    } as const;
    const result = await server.registered.find((entry) => entry.name === "github_pr_monitor_write_post_comment")!.handler({
      ...previewInput,
      previewId,
      approvalId: approval.approvalId,
      idempotencyKey: "effect-1",
      evidence,
    });
    expect(result).toMatchObject({ isError: false, structuredContent: { ok: true, effect: { status: "completed", operation: "post_comment" } } });
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain(GITHUB_PR_WRITE_REPOSITORY);
    if (previousRollout === undefined) delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
    else process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = previousRollout;
    authority.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("rejects completed-only checks in the registered merge handler before recording an effect", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "github-write-merge-checks-"));
    const previousUnattended = process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
    const previousRollout = process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
    process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
    process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = "enabled";
    const repository = "twoimo/tzudong";
    const mergeHead = head;
    let pullRequestReads = 0;
    const calls: string[][] = [];
    const approveView = JSON.stringify({
      state: "OPEN",
      author: { login: "alice" },
      headRefOid: mergeHead,
      headRepository: { nameWithOwner: repository },
    });
    const mergeView = JSON.stringify({
      state: "OPEN",
      author: { login: "alice" },
      headRefOid: mergeHead,
      headRepository: { nameWithOwner: repository },
      isDraft: false,
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [{ status: "COMPLETED" }],
    });
    const gh = async (argv: readonly string[]) => {
      calls.push([...argv]);
      if (argv[0] === "api" && argv[1] === "user") return { stdout: GITHUB_PR_WRITE_ACCOUNT, exitCode: 0 };
      if (argv[0] === "pr" && argv[1] === "view") {
        pullRequestReads += 1;
        return { stdout: pullRequestReads === 1 ? approveView : mergeView, exitCode: 0 };
      }
      if (argv[0] === "api" && argv[1] === `repos/${repository}/pulls/7/reviews`) {
        return { stdout: JSON.stringify({ id: 123, state: "APPROVED" }), exitCode: 0 };
      }
      throw new Error(`unexpected gh command: ${argv.join(" ")}`);
    };
    const authority = await GithubPrWriteAuthority.open(stateDir);
    const capability = authority.issueCapability(GITHUB_PR_WRITE_ACCOUNT);
    const session = authority.openSession(capability.capabilityId, capability.generation);
    const server = fakeServer();
    registerGithubPrMonitorWriteTools(server as never, {
      githubPrWriteGh: gh,
      githubPrWriteRepositoryAllowlist: [repository],
      remote: false,
      transportKind: "operator",
      writeSessionId: session.sessionId,
    } as never, authority);
    const evidence = {
      account: { login: GITHUB_PR_WRITE_ACCOUNT, id: 1, nodeId: "U1", actorType: "User" },
      author: { login: "alice", id: 2, nodeId: "U2", actorType: "User" },
      baseRepositoryId: 3,
      headRepositoryId: 3,
      repositoryId: 3,
      permission: "WRITE",
      canPush: true,
      expectedHead: mergeHead,
    } as const;
    const baseRequest = {
      repository,
      prNumber: 7,
      expectedHead: mergeHead,
      baseRepository: repository,
      headRepository: repository,
    };
    try {
      const approveInput = { sessionId: session.sessionId, operation: "approve" as const, request: baseRequest };
      const approvePreview = await server.registered.find((entry) => entry.name === "github_pr_monitor_write_preview")!.handler(approveInput);
      const approvePreviewValue = (approvePreview.structuredContent as { preview: { previewId: string; challengeId: string } }).preview;
      const approveChallenge = authority.createChallenge(approvePreviewValue.previewId);
      const approveApproval = authority.approve(approveChallenge.challengeId, proof(approveChallenge.challengeId));
      const approveResult = await server.registered.find((entry) => entry.name === "github_pr_monitor_write_approve")!.handler({
        ...approveInput,
        previewId: approvePreviewValue.previewId,
        approvalId: approveApproval.approvalId,
        idempotencyKey: "approve-merge-check",
        evidence,
      });
      expect(approveResult).toMatchObject({ isError: false, structuredContent: { ok: true, operation: "approve" } });
      const approvalReceiptId = String((approveResult.structuredContent as { outcomeDigest: string }).outcomeDigest);

      const mergeRequest = { ...baseRequest, approvalReceiptId };
      const mergeInput = { sessionId: session.sessionId, operation: "merge" as const, request: mergeRequest };
      const mergePreview = await server.registered.find((entry) => entry.name === "github_pr_monitor_write_preview")!.handler(mergeInput);
      const mergePreviewValue = (mergePreview.structuredContent as { preview: { previewId: string; challengeId: string } }).preview;
      const mergeChallenge = authority.createChallenge(mergePreviewValue.previewId);
      const mergeApproval = authority.approve(mergeChallenge.challengeId, proof(mergeChallenge.challengeId));
      const mergeResult = await server.registered.find((entry) => entry.name === "github_pr_monitor_write_merge")!.handler({
        ...mergeInput,
        previewId: mergePreviewValue.previewId,
        approvalId: mergeApproval.approvalId,
        idempotencyKey: "merge-completed-only-check",
        evidence,
      });
      expect(mergeResult).toMatchObject({ isError: true, structuredContent: { error: { code: "GITHUB_WRITE_MUTATION_DENIED" } } });
      expect(calls.some((argv) => argv[0] === "api" && typeof argv[1] === "string" && argv[1].includes("/merge"))).toBe(false);
      expect(authority.recover().pendingEffectIds).toHaveLength(0);
    } finally {
      if (previousUnattended === undefined) delete process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
      else process.env.CHATGPT2CODEX_UNATTENDED_WRITE = previousUnattended;
      if (previousRollout === undefined) delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
      else process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = previousRollout;
      authority.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
