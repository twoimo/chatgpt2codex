import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import {
  clickAtPoint,
  clickAxElement,
  getAppWindowRegion,
  preflightPermissions,
  pressAxElement,
  pressKey,
  resolveAxElement,
  resolveFrontmostApp,
  resolveWindowPoint,
  setAxValue,
  typeText,
} from "./mac-input.js";

/**
 * These synthetic-input primitives must be entirely unavailable off macOS.
 * The CI/dev box this suite runs on is darwin, so platform is stubbed per
 * test rather than relying on the host OS.
 */
function withNonDarwinPlatform<T>(fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("control/mac-input (non-darwin)", () => {
  let restore: () => void;

  beforeEach(() => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    restore = () => Object.defineProperty(process, "platform", original);
  });

  afterEach(() => {
    restore();
  });

  it("resolveFrontmostApp throws NOT_IMPLEMENTED", async () => {
    await expect(resolveFrontmostApp()).rejects.toMatchObject({ code: ErrorCode.NOT_IMPLEMENTED });
  });

  it("getAppWindowRegion throws NOT_IMPLEMENTED", async () => {
    await expect(getAppWindowRegion("TextEdit")).rejects.toMatchObject({ code: ErrorCode.NOT_IMPLEMENTED });
  });

  it("resolveWindowPoint throws NOT_IMPLEMENTED", async () => {
    await expect(resolveWindowPoint("TextEdit", 0.5, 0.5)).rejects.toMatchObject({ code: ErrorCode.NOT_IMPLEMENTED });
  });

  it("clickAtPoint throws NOT_IMPLEMENTED", async () => {
    await expect(clickAtPoint("TextEdit", 10, 10)).rejects.toMatchObject({ code: ErrorCode.NOT_IMPLEMENTED });
  });

  it("clickAxElement throws NOT_IMPLEMENTED", async () => {
    await expect(clickAxElement("TextEdit", { role: "button", title: "OK" })).rejects.toMatchObject({
      code: ErrorCode.NOT_IMPLEMENTED,
    });
  });

  it("typeText throws NOT_IMPLEMENTED", async () => {
    await expect(typeText("TextEdit", "hello")).rejects.toMatchObject({ code: ErrorCode.NOT_IMPLEMENTED });
  });

  it("pressKey throws NOT_IMPLEMENTED", async () => {
    await expect(pressKey("TextEdit", 36)).rejects.toMatchObject({ code: ErrorCode.NOT_IMPLEMENTED });
  });

  it("resolveAxElement throws NOT_IMPLEMENTED (dry-run preview is also darwin-only)", async () => {
    await expect(resolveAxElement("TextEdit", { role: "button", title: "OK" })).rejects.toMatchObject({
      code: ErrorCode.NOT_IMPLEMENTED,
    });
  });

  it("pressAxElement throws NOT_IMPLEMENTED", async () => {
    await expect(pressAxElement("TextEdit", { role: "button", title: "OK" })).rejects.toMatchObject({
      code: ErrorCode.NOT_IMPLEMENTED,
    });
  });

  it("setAxValue throws NOT_IMPLEMENTED", async () => {
    await expect(setAxValue("TextEdit", { role: "textField", title: "Name" }, "hello")).rejects.toMatchObject({
      code: ErrorCode.NOT_IMPLEMENTED,
    });
  });

  it("preflightPermissions throws NOT_IMPLEMENTED", async () => {
    await expect(preflightPermissions()).rejects.toMatchObject({ code: ErrorCode.NOT_IMPLEMENTED });
  });

  it("errors are DomainError instances, not raw strings", async () => {
    await expect(resolveFrontmostApp()).rejects.toBeInstanceOf(DomainError);
  });
});

/**
 * darwin-only behavior of the new AX semantic-targeting primitives. The
 * native `chatgpt2codex-ax` helper never exists next to source/test-run
 * files (it only ships inside the packaged .app bundle), so these exercise
 * the read-only osascript/System Events fallback path end-to-end against a
 * deliberately nonexistent app/process — proving (a) resolve never throws,
 * always returning a found:false preview instead, and (b) press/setvalue
 * exhaust every fallback and raise a typed, catchable error rather than
 * silently doing nothing or crashing.
 *
 * The System Events query against a nonexistent process is slow (measured
 * 3-5s warm); activate-based fallback legs fail fast in roughly 60ms. A single
 * query therefore already approaches vitest's old 5s default and crosses it
 * under desktop load. The 90s ceiling provides headroom above the observed
 * contention range: one query measured 39s against a cold System Events daemon
 * and 37-69s while four concurrent System Events loops were running. A vitest
 * timeout is a ceiling, not a sleep, so the warm path still finishes in seconds;
 * the only cost is slower detection of a real hang. It only widens the clock;
 * every assertion still runs. The remaining cases carry none
 * because they reject before any osascript is built at all:
 * the missing-title report, the unbuilt-helper preflight, and the two
 * role-injection guards, each measured at 1-2ms.
 */
describe("control/mac-input AX targeting (darwin fallback path)", () => {
  it("resolveAxElement returns a found:false preview (no throw) when the target can't be resolved", async () => {
    const result = await resolveAxElement("Chatgpt2CodexNoSuchApp", { role: "button", title: "Nonexistent" });
    expect(result.found).toBe(false);
    expect(result.source).toBe("system-events");
    expect(typeof result.reason).toBe("string");
  }, 90_000);

  it("resolveAxElement requires a title or description and reports so instead of throwing", async () => {
    const result = await resolveAxElement("Chatgpt2CodexNoSuchApp", { role: "button" });
    expect(result.found).toBe(false);
    expect(result.reason).toContain("title or description");
  });

  it("pressAxElement exhausts every fallback and raises a DomainError instead of a silent no-op", async () => {
    await expect(pressAxElement("Chatgpt2CodexNoSuchApp", { role: "button", title: "Nonexistent" })).rejects.toBeInstanceOf(
      DomainError,
    );
  }, 90_000);

  it("setAxValue never leaks the raw text into its error when resolution fails", async () => {
    try {
      await setAxValue("Chatgpt2CodexNoSuchApp", { role: "text field", title: "Nonexistent" }, "super-secret-value");
      throw new Error("expected setAxValue to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect(String((err as DomainError).message)).not.toContain("super-secret-value");
    }
    // "text field" (with a space) is the real System Events class name, so this
    // exhausts the same fallback chain as pressAxElement above rather than failing
    // at osascript compile time the way an invalid class ("textField") would --
    // it is the resolve path that must not leak the text, so it has to run.
  }, 90_000);

  // The native `chatgpt2codex-ax` helper never exists next to source/test-run
  // files, so preflightPermissions() must honestly report that it cannot
  // determine the live permission state instead of guessing true/false.
  it("preflightPermissions reports source:'unavailable' (never guesses trusted) when the native helper isn't built", async () => {
    const result = await preflightPermissions();
    expect(result.source).toBe("unavailable");
    expect(result.accessibilityTrusted).toBe(false);
    expect(result.screenRecordingAllowed).toBe(false);
    expect(typeof result.reason).toBe("string");
  });

  // `role` is interpolated as a raw (unquoted) AppleScript element class —
  // `every <role> of ...` / `first <role> whose ...` — never through
  // appleScriptString(), because AppleScript class names can't be quoted
  // like a string literal. An unconstrained role could therefore close the
  // enclosing `tell`/`whose` clause and inject arbitrary AppleScript,
  // including `do shell script` (osascript RCE). The MCP tool schema
  // (src/server/tools.ts controlTargetSchema) already rejects this shape
  // before it ever reaches here; these tests prove the module's own
  // re-validation (assertSafeAxRoleClass) independently refuses it at both
  // interpolation sites, so mac-input.ts is safe even if some other/future
  // caller skips the schema.
  const MALICIOUS_ROLE = 'button" of front window\n      end tell\n      do shell script "touch /tmp/chatgpt2codex-pwned"';

  it("resolveAxElement rejects an AppleScript-injecting role instead of interpolating it into osascript", async () => {
    await expect(resolveAxElement("Chatgpt2CodexNoSuchApp", { role: MALICIOUS_ROLE, title: "x" })).rejects.toMatchObject({
      code: ErrorCode.NOT_IMPLEMENTED,
    });
  });

  it("clickAxElement rejects an AppleScript-injecting role before building any osascript", async () => {
    await expect(clickAxElement("Chatgpt2CodexNoSuchApp", { role: MALICIOUS_ROLE, title: "x" })).rejects.toMatchObject({
      code: ErrorCode.NOT_IMPLEMENTED,
    });
  });

  it("still accepts ordinary AX role class names (no false-positive rejection)", async () => {
    // "text field" (with a space) is a real System Events class name and
    // must keep working; only reports found:false because the app/process
    // doesn't exist, never a role-validation error.
    const result = await resolveAxElement("Chatgpt2CodexNoSuchApp", { role: "text field", title: "x" });
    expect(result.found).toBe(false);
    expect(result.reason).not.toContain("Invalid accessibility role class");
  }, 90_000);
});

// Exercise the helper once directly so it isn't flagged as unused if the
// beforeEach/afterEach wiring above is ever refactored to use it inline.
describe("withNonDarwinPlatform helper", () => {
  it("actually flips process.platform for the duration of the callback", () => {
    const observed = withNonDarwinPlatform(() => process.platform);
    expect(observed).toBe("linux");
  });
});
