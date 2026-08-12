import { describe, expect, it } from "vitest";
import { assertOperationAllowed, canWriteCodeUnattended, type GithubEvidence } from "./github-pr-write-policy.js";

const evidence: GithubEvidence = {
  account: { login: "twoimo", id: 1, nodeId: "account-node", actorType: "User" },
  author: { login: "twoimo", id: 1, nodeId: "author-node", actorType: "User" },
  baseRepositoryId: 10,
  headRepositoryId: 11,
  repositoryId: 10,
  permission: "WRITE",
  canPush: true,
  expectedHead: "a".repeat(40),
};
const topology = { baseRepository: "acme/project", headRepository: "twoimo/project-fork" };

describe("unattended GitHub PR write policy", () => {
  it("requires the explicit gate and accepts only an owned twoimo head", () => {
    const previous = process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
    try {
      delete process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
      expect(canWriteCodeUnattended(evidence, topology)).toBe(false);
      process.env.CHATGPT2CODEX_UNATTENDED_WRITE = "1";
      expect(canWriteCodeUnattended(evidence, topology)).toBe(true);
      expect(() => assertOperationAllowed("apply_suggestions", evidence, "enabled", topology)).not.toThrow();
      expect(canWriteCodeUnattended(evidence, { ...topology, headRepository: "someone-else/project-fork" })).toBe(false);
      expect(canWriteCodeUnattended({ ...evidence, canPush: false }, topology)).toBe(false);
      expect(canWriteCodeUnattended({ ...evidence, author: { ...evidence.author, actorType: "Bot" } }, topology)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CHATGPT2CODEX_UNATTENDED_WRITE;
      else process.env.CHATGPT2CODEX_UNATTENDED_WRITE = previous;
    }
  });
});
