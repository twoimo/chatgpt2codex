import { describe, expect, it } from "vitest";
import { AuthorityClock, WRITE_TTL_MS, canonicalJson, assertNoAuthorityFields, summarizeGithubCheckRollup } from "./github-pr-write-contract";
import { assertSafeBody, isGithubMutationIntent, renderComment } from "./github-pr-write-policy";

describe("github PR write v5 contract", () => {
  it("uses deterministic canonical JSON and fixed TTLs", () => {
    expect(canonicalJson({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
    expect(WRITE_TTL_MS).toMatchObject({ capability: 1_800_000, session: 900_000, preview: 300_000, challenge: 120_000, approval: 90_000, statusHandle: 600_000, skew: 30_000 });
  });
  it("expires at the boundary and rejects caller authority", () => {
    const clock = new AuthorityClock(() => 1000, () => 50);
    expect(clock.isExpired(1000, 1000)).toBe(true);
    expect(() => assertNoAuthorityFields({ confirm: true })).toThrow("confirm");
  });
  it("detects generic GitHub mutation before execution", () => {
    expect(isGithubMutationIntent(["git", "push", "origin", "HEAD"])).toBe(true);
    expect(isGithubMutationIntent("make test")).toBe(false);
    expect(isGithubMutationIntent("npm run github-pr-write -- --status")).toBe(true);
  });
  it("requires an explicit successful check result", () => {
    expect(summarizeGithubCheckRollup([{ status: "COMPLETED" }])).toBe("unknown");
    expect(summarizeGithubCheckRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("passing");
    expect(summarizeGithubCheckRollup([{ status: "COMPLETED", conclusion: "FAILURE" }])).toBe("failing");
  });
  it("renders complete UTF-8 body with deterministic marker", () => {
    const result = renderComment("héllo", "effect-1");
    expect(result.body).toBe("héllo\n<!-- gjc:auto-response:v2:effect-1 -->");
    expect(result.bytes).toBe(Buffer.byteLength(result.body, "utf8"));
    expect(result.contentDigest).toHaveLength(64);
  });
  it("rejects controls and oversized content", () => {
    expect(() => assertSafeBody("bad\0body")).toThrow();
    expect(() => assertSafeBody("x".repeat(6001))).toThrow();
  });
});
