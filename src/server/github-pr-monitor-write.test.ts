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
});
