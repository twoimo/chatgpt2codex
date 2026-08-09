import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../types.js";

vi.mock("../assets/images.js", () => {
  throw new Error("asset module was eagerly imported by the direct monitor entry");
});
vi.mock("../assets/image-intake.js", () => {
  throw new Error("image-intake module was eagerly imported by the direct monitor entry");
});
vi.mock("../assets/image-url.js", () => {
  throw new Error("image-url module was eagerly imported by the direct monitor entry");
});
vi.mock("../assets/chatgpt-images-app.js", () => {
  throw new Error("ChatGPT image app module was eagerly imported by the direct monitor entry");
});
vi.mock("../e2e/local-e2e.js", () => {
  throw new Error("E2E module was eagerly imported by the direct monitor entry");
});
vi.mock("../e2e/screenshot-share.js", () => {
  throw new Error("E2E screenshot-share module was eagerly imported by the direct monitor entry");
});
vi.mock("../control/tools.js", () => {
  throw new Error("desktop-control module was eagerly imported by the direct monitor entry");
});

describe("direct monitor import graph", () => {
  it("creates the actual direct entry without loading browser-capable modules", async () => {
    vi.resetModules();
    const { createDirectActionClient } = await import("./direct-action-client.js");
    expect(createDirectActionClient).toBeTypeOf("function");
    const client = await createDirectActionClient({
      workspaceRoot: "/tmp/chatgpt2codex-import-graph",
      stateDir: "/tmp/chatgpt2codex-import-graph-state",
      registry: [],
      ledger: { append: async () => undefined },
      store: {
        loadProjects: async () => [],
        saveProjects: async () => undefined,
        getSession: async () => null,
        setSession: async () => undefined,
      },
      config: {
        workspaceRoot: "/tmp/chatgpt2codex-import-graph",
        stateDir: "/tmp/chatgpt2codex-import-graph-state",
        maxReadBytes: 1024,
        maxPatchBytes: 1024,
        defaultCommandTimeoutSec: 30,
        defaultLeaseTtlMs: 30_000,
      },
    } as ToolContext);
    await client.close();
  });
});
