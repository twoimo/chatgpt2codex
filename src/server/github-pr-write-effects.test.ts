import { describe, expect, it } from "vitest";
import { GithubPrWriteEffects, type GhCommand } from "./github-pr-write-effects.js";

const context = { repository: "Yeachan-Heo/gajae-code", prNumber: 7, expectedHead: "0123456789abcdef0123456789abcdef01234567", actor: "twoimo", author: "alice" };
const evidence = JSON.stringify({ state: "OPEN", author: { login: "alice" }, headRefOid: context.expectedHead, repository: { nameWithOwner: context.repository }, baseRepository: { nameWithOwner: context.repository }, headRepository: { nameWithOwner: context.repository } });
const authoredEvidence = evidence.replace('"alice"', '"twoimo"');
function fake(responses: string[], calls: string[][]): GhCommand { return async (argv) => { calls.push([...argv]); return { stdout: responses.shift() ?? "{}", exitCode: 0 }; }; }

describe("GithubPrWriteEffects", () => {
  it("uses fixed host and operation argv for a comment", async () => {
    const calls: string[][] = [];
    const effect = new GithubPrWriteEffects(fake(["twoimo", evidence, "{\"id\":123}"], calls));
    const receipt = await effect.execute(context, { operation: "post_comment", body: "hello", effectIdentity: "effect-1" });
    expect(receipt.status).toBe("completed");
    expect(calls[0]).toEqual(["api", "user", "--hostname", "github.com", "--jq", ".login"]);
    expect(calls[2]).toContain("repos/Yeachan-Heo/gajae-code/issues/7/comments");
    expect(calls[2]).toContain("--hostname");
  });
  it("rejects authenticated account mismatch before mutation", async () => {
    const calls: string[][] = [];
    const effect = new GithubPrWriteEffects(fake(["mallory"], calls));
    await expect(effect.execute(context, { operation: "post_comment", body: "hello", effectIdentity: "effect-1" })).rejects.toThrow(/authenticated/);
    expect(calls).toHaveLength(1);
  });
  it("rejects closed or drifted pull requests", async () => {
    const calls: string[][] = [];
    const closed = evidence.replace('"OPEN"', '"CLOSED"');
    const effect = new GithubPrWriteEffects(fake(["twoimo", closed.replace('"alice"', '"twoimo"')], calls));
    await expect(effect.execute({ ...context, author: "twoimo" }, { operation: "rerequest_reviewer", reviewer: "bob" })).rejects.toThrow(/evidence/);
    expect(calls).toHaveLength(2);
  });
  it("denies reviewer re-requests on reviewer-only PRs", async () => {
    const calls: string[][] = [];
    const effect = new GithubPrWriteEffects(fake([], calls));
    await expect(effect.execute({ ...context, author: "alice" }, { operation: "rerequest_reviewer", reviewer: "bob" })).rejects.toThrow(/authored/);
    expect(calls).toHaveLength(0);
  });
  it("permits bounded review comments on a fork while keeping code writes separate", async () => {
    const calls: string[][] = [];
    const forkEvidence = JSON.stringify({ state: "OPEN", author: { login: "bot" }, headRefOid: context.expectedHead, repository: { nameWithOwner: context.repository }, baseRepository: { nameWithOwner: context.repository }, headRepository: { nameWithOwner: "fork/project" } });
    const effect = new GithubPrWriteEffects(fake(["twoimo", forkEvidence, "{\"id\":321}"], calls));
    const receipt = await effect.execute({ ...context, author: "bot", headRepository: "fork/project" }, { operation: "post_comment", body: "hello", effectIdentity: "effect-fork" });
    expect(receipt.status).toBe("completed");
  });
  it("does not expose hostile command output", async () => {
    const calls: string[][] = [];
    const effect = new GithubPrWriteEffects(fake(["twoimo", authoredEvidence, "User", "SECRET token stdout"], calls));
    await expect(effect.execute({ ...context, author: "twoimo" }, { operation: "rerequest_reviewer", reviewer: "bob" })).rejects.toThrow();
    expect(JSON.stringify(calls)).toContain("requested_reviewers");
  });
  it("accepts an exact direct-user reviewer response", async () => {
    const calls: string[][] = [];
    const effect = new GithubPrWriteEffects(fake(["twoimo", authoredEvidence, "User", "{\"users\":[{\"login\":\"bob\"}],\"teams\":[]}"], calls));
    const receipt = await effect.execute({ ...context, author: "twoimo" }, { operation: "rerequest_reviewer", reviewer: "bob" });
    expect(receipt.status).toBe("completed");
  });
});
