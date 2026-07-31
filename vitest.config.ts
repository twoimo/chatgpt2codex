import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    // vitest's 5s default is the wrong baseline for this suite. Many cases boot a real
    // HTTP action server, shell out to a fake `gh` CLI, and issue dozens of round-trips;
    // the darwin control tests pay for contention on the System Events daemon, whose cost
    // is load-dependent rather than fixed (the same call measured ~110ms idle and 10.6s
    // with two competing osascript loops). Which case crosses 5s therefore moves with
    // machine load, and per-case overrides were being added reactively as it moved. A
    // timeout is a ceiling, not a sleep: a healthy run finishes in the same wall time
    // either way, and the only cost is slower detection of a genuine hang.
    //
    // Cases with their own explicit ceiling keep it; some are tighter than this baseline
    // and some wider. A ceiling is not a substitute for an assertion -- a case that needs
    // to bound a production timeout constant must assert elapsed time itself (see the
    // stale-lock takeover case in src/server/http-actions.test.ts), because the harness
    // clock is not part of the contract under test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
