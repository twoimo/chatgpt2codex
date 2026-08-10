import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMonitorServer, createServer } from "./mcp-server.js";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";

const CONTROL_TOOL_NAMES = ["computer_screenshot", "computer_request_action", "computer_action_status", "computer_kill_switch"];

function makeCtx(): ToolContext {
  const stateDir = "/tmp/chatgpt2codex-tools-catalog-test";
  return {
    workspaceRoot: "/tmp",
    stateDir,
    registry: [],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => null,
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: "/tmp",
      stateDir,
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}


describe("tool catalog", () => {
  beforeEach(() => {
    process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = "enabled";
  });
  afterEach(() => {
    delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
  });
  it("keeps the one-shot E2E tool out of destructive/open-world routing", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { annotations?: Record<string, unknown>; inputSchema?: { shape?: Record<string, unknown> } }>;
      }
    )._registeredTools;
    const oneShot = tools?.e2e_test_and_show_screenshot;

    expect(oneShot?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(oneShot?.inputSchema?.shape?.serverCommand).toBeUndefined();
    expect(oneShot?.inputSchema?.shape?.testCommand).toBeUndefined();
    expect(oneShot?.inputSchema?.shape?.waitUrl).toBeUndefined();
  });

  it("declares the ChatGPT widget template for E2E screenshot tools", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { _meta?: Record<string, unknown> }>;
      }
    )._registeredTools;

    for (const name of ["e2e_test_and_show_screenshot", "e2e_screenshot", "e2e_open_url_screenshot", "e2e_run_command"]) {
      expect(tools?.[name]?._meta?.["openai/outputTemplate"], name).toBe("ui://widget/e2e-screenshots.html");
    }

    const resources = (
      server as unknown as {
        _registeredResources?: Record<
          string,
          {
            metadata?: { mimeType?: string; _meta?: Record<string, unknown> };
            readCallback?: (uri: URL) => Promise<{ contents: Array<{ mimeType?: string; text?: string }> }>;
          }
        >;
      }
    )._registeredResources;
    const widget = resources?.["ui://widget/e2e-screenshots.html"];
    expect(widget?.metadata?.mimeType).toBe("text/html+skybridge");
    expect(widget?.metadata?._meta?.["openai/widgetCSP"]).toBeDefined();

    const read = await widget?.readCallback?.(new URL("ui://widget/e2e-screenshots.html"));
    const content = read?.contents?.[0];
    expect(content?.mimeType).toBe("text/html+skybridge");
    expect(content?.text).toContain("chatgpt2codex/screenshots");
    expect(content?.text).toContain("openai:set_globals");
    expect(content?.text).toContain("dataUri");
  });

  it("exposes GPT Image 2 import routing and ChatGPT URL intake", async () => {
    const server = await createServer(makeCtx());
    const tools = (server as unknown as { _registeredTools?: Record<string, { description?: string; handler?: (input: unknown) => Promise<unknown> }> })
      ._registeredTools;

    expect(tools?.gpt_image_2_generate).toBeUndefined();
    expect(tools?.open_chatgpt_images_app?.description).toContain("ChatGPT Images app");
    expect(tools?.save_chatgpt_image?.description).toContain("Single app-friendly");
    expect(tools?.save_chatgpt_image_from_url?.description).toContain("ChatGPT-generated image");
    expect(tools?.save_chatgpt_image_from_url?.description).toContain("chatgpt.com/s/m_...");
    expect(tools?.save_chatgpt_screen_images).toBeUndefined();
    expect(tools?.generate_chatgpt_image).toBeUndefined();
    expect(tools?.chatgpt_image_loop).toBeUndefined();
    expect(tools?.list_pending_images).toBeUndefined();
    expect(tools?.save_image_from_pending).toBeUndefined();

    const guide = tools?.gpt_image_2_workflow;
    expect(guide?.description).toContain("import workflow");

    const result = (await guide?.handler?.({})) as {
      structuredContent?: {
        chatgpt2codexToolCall?: { namespace?: string; tool?: string; ok?: boolean };
        toolAvailabilityGate?: { namespace?: string };
        doThis?: string[];
        ifNativeImageGenerationUnavailable?: string[];
        notThis?: string[];
        saveTools?: string[];
      };
      content?: Array<{ text: string }>;
    };
    expect(result.structuredContent?.chatgpt2codexToolCall).toMatchObject({
      namespace: "ChatGPT_To_Codex",
      tool: "gpt_image_2_workflow",
      ok: true,
    });
    expect(result.structuredContent?.toolAvailabilityGate?.namespace).toBe("ChatGPT_To_Codex");
    expect(result.structuredContent?.doThis?.join(" ")).toContain("reselect ChatGPT To Codex");
    expect(result.structuredContent?.doThis?.join(" ")).toContain("Generate with ChatGPT's native image surface");
    expect(result.structuredContent?.doThis?.join(" ")).toContain("chatgpt.com/s/m_...");
    expect(result.structuredContent?.ifNativeImageGenerationUnavailable?.join(" ")).toContain("Share/Copy Link");
    expect(result.structuredContent?.notThis?.join(" ")).toContain("Do not call Codex");
    expect(result.structuredContent?.notThis?.join(" ")).toContain("python_user_visible");
    expect(result.structuredContent?.notThis?.join(" ")).toContain("automatic capture helpers");
    expect(result.structuredContent?.saveTools).toContain("open_chatgpt_images_app");
    expect(result.structuredContent?.saveTools).toContain("save_chatgpt_image");
    expect(result.structuredContent?.saveTools).toContain("save_chatgpt_image_from_url");
    expect(result.structuredContent?.saveTools).toContain("save_image_from_url");
    expect(result.content?.[0]?.text).toContain("native ChatGPT GPT Image 2 generation first");
  });

  it("keeps broad context-pack off the ChatGPT-visible tool list", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { description?: string }>;
      }
    )._registeredTools;

    expect(tools?.code_context_pack).toBeDefined();
    expect(tools?.code_context_pack?.description).toContain("ChatGPT should prefer code_search");

    const handler = (
      server.server as unknown as {
        _requestHandlers?: Map<
          string,
          (request: { method: string; params: Record<string, never> }) => Promise<{ tools: Array<{ name: string }> }>
        >;
      }
    )._requestHandlers?.get("tools/list");
    const listed = await handler?.({ method: "tools/list", params: {} });
    expect(listed?.tools.map((tool) => tool.name)).not.toContain("code_context_pack");
  });

  it("agent_guide exposes Codex-grade loop, tool surface, and safety model", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      }
    )._registeredTools;

    const result = (await tools?.agent_guide?.handler?.({})) as {
      structuredContent?: {
        codexGradeLoop?: string[];
        toolSurfaceMap?: Record<string, string[]>;
        securityModel?: string[];
        desktopControlModel?: string[];
      };
    };

    expect(result.structuredContent?.codexGradeLoop?.join(" ")).toContain("Discover");
    expect(result.structuredContent?.codexGradeLoop?.join(" ")).toContain("Verify");
    expect(result.structuredContent?.toolSurfaceMap?.modify).toEqual(
      expect.arrayContaining(["file_apply_patch", "file_create", "local_shell_run"]),
    );
    expect(result.structuredContent?.toolSurfaceMap?.verify).toEqual(
      expect.arrayContaining(["e2e_test_and_show_screenshot", "e2e_run_command"]),
    );
    expect(result.structuredContent?.securityModel?.join(" ")).toContain("current-turn ChatGPT_To_Codex tool proof");
    expect(result.structuredContent?.securityModel?.join(" ")).toContain("Prompt-injection posture");
    expect(result.structuredContent?.desktopControlModel?.join(" ")).toContain("kill switch");
    expect(result.structuredContent?.desktopControlModel?.join(" ")).toContain("sensitive apps");
  });
  describe("ChatGPT read-only exposure (CHATGPT2CODEX_CHATGPT_READ_ONLY)", () => {
    afterEach(() => {
      delete process.env.CHATGPT2CODEX_CHATGPT_READ_ONLY;
      delete process.env.CHATGPT2CODEX_CONTROL;
      delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
    });

    async function remoteToolsListNames(): Promise<string[]> {
      const server = await createServer({ ...makeCtx(), remote: true });
      const handler = (
        server.server as unknown as {
          _requestHandlers?: Map<
            string,
            (request: { method: string; params: Record<string, never> }) => Promise<{ tools: Array<{ name: string }> }>
          >;
        }
      )._requestHandlers?.get("tools/list");
      const listed = await handler?.({ method: "tools/list", params: {} });
      return listed?.tools.map((tool) => tool.name) ?? [];
    }

    it("keeps representative write tools in the default remote catalog", async () => {
      const names = await remoteToolsListNames();
      expect(names).toContain("file_apply_patch");
      expect(names).toContain("project_select");
    });

    it("lists only annotated read tools and rejects hidden write-tool calls", async () => {
      process.env.CHATGPT2CODEX_CHATGPT_READ_ONLY = "TrUe";
      const server = await createServer({ ...makeCtx(), remote: true });
      const tools = (
        server as unknown as {
          _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
        }
      )._registeredTools;
      const names = await remoteToolsListNames();

      expect(names).toContain("agent_guide");
      expect(names).toContain("project_status");
      expect(names).toContain("code_search");
      expect(names).not.toContain("file_apply_patch");
      expect(names).not.toContain("project_select");
      expect(names).not.toContain("computer_action_status");

      const denied = (await tools?.file_apply_patch?.handler?.({})) as {
        isError?: boolean;
        structuredContent?: { code?: string; error?: string };
      };
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        code: "PERMISSION_DENIED",
        error: expect.stringContaining("CHATGPT2CODEX_CHATGPT_READ_ONLY"),
      });

      const guide = (await tools?.agent_guide?.handler?.({})) as {
        isError?: boolean;
        structuredContent?: { toolAvailabilityGate?: unknown };
      };
      expect(guide.isError).not.toBe(true);
      expect(guide.structuredContent?.toolAvailabilityGate).toBeDefined();
    });
    it("keeps all control tools unavailable when control exposure and read-only mode are both enabled", async () => {
      process.env.CHATGPT2CODEX_CONTROL = "1";
      process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "true";
      process.env.CHATGPT2CODEX_CHATGPT_READ_ONLY = "on";
      const server = await createServer({ ...makeCtx(), remote: true });
      const tools = (
        server as unknown as {
          _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
        }
      )._registeredTools;
      const handler = (
        server.server as unknown as {
          _requestHandlers?: Map<
            string,
            (request: { method: string; params: Record<string, never> }) => Promise<{ tools: Array<{ name: string }> }>
          >;
        }
      )._requestHandlers?.get("tools/list");
      const listed = await handler?.({ method: "tools/list", params: {} });
      const names = listed?.tools.map((tool) => tool.name) ?? [];

      for (const name of CONTROL_TOOL_NAMES) {
        expect(names, name).not.toContain(name);
      }

      const denied = (await tools?.computer_action_status?.handler?.({})) as {
        isError?: boolean;
        structuredContent?: { code?: string; error?: string };
      };
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        code: "PERMISSION_DENIED",
        error: expect.stringContaining("CHATGPT2CODEX_CHATGPT_READ_ONLY"),
      });
    });

    it.each(["0", "false", "off", ""])("does not enable read-only filtering for falsey values (%s)", async (value) => {
      process.env.CHATGPT2CODEX_CHATGPT_READ_ONLY = value;
      const names = await remoteToolsListNames();
      expect(names).toContain("file_apply_patch");
    });
  });
  it("retains a valid registered monitor worktree through refresh and selection", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-monitor-worktree-"));
    const headSha = "a".repeat(40);
    const worktreeRoot = path.join(
      workspaceRoot,
      "gajae-code-pr-monitor-pr-worktrees",
      "Yeachan-Heo--gajae-code",
      `pr-42-${headSha}`,
    );
    const entry: ProjectRegistryEntry = {
      projectId: `pr-42-${headSha}`,
      name: `pr-42-${headSha}`,
      root: worktreeRoot,
      aliases: [`pr-42-${headSha}`, worktreeRoot],
      branch: "(detached)",
      dirty: false,
      hasAgentsMd: false,
      hasCodeBrain: false,
      packageHints: [],
      lastSeenAt: new Date().toISOString(),
    };
    const stale: ProjectRegistryEntry = {
      ...entry,
      projectId: "stale",
      name: "stale",
      root: path.join(workspaceRoot, "missing"),
      aliases: ["stale"],
    };
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const ctx = makeCtx();
    const saved: ProjectRegistryEntry[][] = [];
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [entry, stale];
    ctx.store = {
      loadProjects: async () => [],
      saveProjects: async (projects) => { saved.push(projects); },
      getSession: async () => null,
      setSession: async () => undefined,
    };

    try {
      await mkdir(repositoryRoot, { recursive: true });
      await writeFile(path.join(repositoryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await mkdir(worktreeRoot, { recursive: true });
      const canonicalWorktreeRoot = await realpath(worktreeRoot);
      await writeFile(path.join(worktreeRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;

      await tools?.workspace_refresh_index?.handler?.({});
      const listed = (await tools?.workspace_list_projects?.handler?.({
        query: canonicalWorktreeRoot,
        limit: 20,
      })) as {
        structuredContent?: { projects?: ProjectRegistryEntry[] };
      };
      const project = listed.structuredContent?.projects?.find(
        (candidate) => candidate.root === canonicalWorktreeRoot,
      );
      expect(project?.projectId).toBe(entry.projectId);
      expect(listed.structuredContent?.projects?.map((candidate) => candidate.projectId)).not.toContain(stale.projectId);

      const selected = (await tools?.project_select?.handler?.({
        projectId: project?.projectId,
        reason: "monitor review",
        preset: "full-write",
      })) as { isError?: boolean; structuredContent?: { lease?: { projectId?: string } } };
      expect(selected.isError).toBeUndefined();
      expect(selected.structuredContent?.lease?.projectId).toBe(entry.projectId);
      expect(saved.at(-1)?.map((project) => project.projectId)).toContain(entry.projectId);
      expect(saved.at(-1)?.map((project) => project.projectId)).not.toContain(stale.projectId);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
  it("excludes arbitrary nested registrations from saved and live refresh registries", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-refresh-"));
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const arbitraryRoot = path.join(workspaceRoot, "unrelated", "nested");
    const arbitrary: ProjectRegistryEntry = {
      projectId: "nested",
      name: "nested",
      root: arbitraryRoot,
      aliases: [arbitraryRoot],
      dirty: false,
      hasAgentsMd: false,
      hasCodeBrain: false,
      packageHints: [],
      lastSeenAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    const saved: ProjectRegistryEntry[][] = [];
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [arbitrary];
    ctx.store = {
      loadProjects: async () => [],
      saveProjects: async (projects) => { saved.push(projects); },
      getSession: async () => null,
      setSession: async () => undefined,
    };

    try {
      await mkdir(arbitraryRoot, { recursive: true });
      await writeFile(path.join(arbitraryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await mkdir(repositoryRoot, { recursive: true });
      await writeFile(path.join(repositoryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");

      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const refreshed = (await tools?.workspace_refresh_index?.handler?.({})) as { isError?: boolean };

      expect(refreshed.isError).toBeUndefined();
      expect(ctx.registry.map((project) => project.projectId)).not.toContain(arbitrary.projectId);
      expect(saved.at(-1)?.map((project) => project.projectId)).not.toContain(arbitrary.projectId);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects duplicate refresh identities without changing the live registry", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-refresh-"));
    const headSha = "b".repeat(40);
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const monitorRoot = path.join(
      workspaceRoot,
      "gajae-code-pr-monitor-pr-worktrees",
      "Yeachan-Heo--gajae-code",
      `pr-7-${headSha}`,
    );
    const monitor: ProjectRegistryEntry = {
      projectId: `pr-7-${headSha}`,
      name: `pr-7-${headSha}`,
      root: monitorRoot,
      aliases: [monitorRoot],
      branch: "(detached)",
      dirty: false,
      hasAgentsMd: false,
      hasCodeBrain: false,
      packageHints: [],
      lastSeenAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [monitor, { ...monitor, aliases: ["duplicate"] }];
    const before = structuredClone(ctx.registry);
    const saved: ProjectRegistryEntry[][] = [];
    ctx.store = {
      loadProjects: async () => [],
      saveProjects: async (projects) => { saved.push(projects); },
      getSession: async () => null,
      setSession: async () => undefined,
    };

    try {
      await mkdir(repositoryRoot, { recursive: true });
      await writeFile(path.join(repositoryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await mkdir(monitorRoot, { recursive: true });
      await writeFile(path.join(monitorRoot, ".git"), "gitdir: /nonexistent\n", "utf8");

      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const refreshed = (await tools?.workspace_refresh_index?.handler?.({})) as {
        isError?: boolean;
        structuredContent?: { code?: string };
      };

      expect(refreshed.isError).toBe(true);
      expect(refreshed.structuredContent?.code).toBe("AMBIGUOUS_PROJECT");
      expect(saved).toEqual([]);
      expect(ctx.registry).toEqual(before);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
  it("rejects persisted scanned-versus-retained ID collisions without publishing an empty live registry", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-refresh-"));
    const headSha = "c".repeat(40);
    const name = `pr-9-${headSha}`;
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const scannedRoot = path.join(workspaceRoot, name);
    const monitorRoot = path.join(
      workspaceRoot,
      "gajae-code-pr-monitor-pr-worktrees",
      "Yeachan-Heo--gajae-code",
      name,
    );
    const retained: ProjectRegistryEntry = {
      projectId: name,
      name,
      root: monitorRoot,
      aliases: [monitorRoot],
      dirty: false,
      hasAgentsMd: false,
      hasCodeBrain: false,
      packageHints: [],
      lastSeenAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [];
    const before = structuredClone(ctx.registry);
    const saved: ProjectRegistryEntry[][] = [];
    let loadCount = 0;
    ctx.store = {
      loadProjects: async () => {
        loadCount += 1;
        return [retained];
      },
      saveProjects: async (projects) => { saved.push(projects); },
      getSession: async () => null,
      setSession: async () => undefined,
    };

    try {
      for (const root of [repositoryRoot, scannedRoot, monitorRoot]) {
        await mkdir(root, { recursive: true });
        await writeFile(path.join(root, ".git"), "gitdir: /nonexistent\n", "utf8");
      }
      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const refreshed = (await tools?.workspace_refresh_index?.handler?.({})) as {
        isError?: boolean;
        structuredContent?: { code?: string };
      };

      expect(refreshed.isError).toBe(true);
      expect(refreshed.structuredContent?.code).toBe("AMBIGUOUS_PROJECT");
      expect(loadCount).toBe(1);
      expect(saved).toEqual([]);
      expect(ctx.registry).toEqual(before);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not publish persisted entries when saving an empty live registry refresh is rejected", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-refresh-"));
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const stale: ProjectRegistryEntry = {
      projectId: "stale",
      name: "stale",
      root: path.join(workspaceRoot, "missing"),
      aliases: ["stale"],
      dirty: false,
      hasAgentsMd: false,
      hasCodeBrain: false,
      packageHints: [],
      lastSeenAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [];
    const before = structuredClone(ctx.registry);
    let loadCount = 0;
    let saveAttempted = false;
    ctx.store = {
      loadProjects: async () => {
        loadCount += 1;
        return [stale];
      },
      saveProjects: async () => {
        saveAttempted = true;
        throw new Error("save rejected");
      },
      getSession: async () => null,
      setSession: async () => undefined,
    };

    try {
      await mkdir(repositoryRoot, { recursive: true });
      await writeFile(path.join(repositoryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");

      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const refreshed = (await tools?.workspace_refresh_index?.handler?.({})) as { isError?: boolean };

      expect(refreshed.isError).toBe(true);
      expect(loadCount).toBe(1);
      expect(saveAttempted).toBe(true);
      expect(ctx.registry).toEqual(before);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("uses canonical absolute paths as exact workspace-list queries", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-list-"));
    const root = path.join(workspaceRoot, "project");
    const otherRoot = path.join(workspaceRoot, "other");
    const symlinkRoot = path.join(workspaceRoot, "project-link");
    const entries: ProjectRegistryEntry[] = ["project", "other"].map((name, index) => ({
      projectId: name,
      name,
      root: index === 0 ? root : otherRoot,
      aliases: [root],
      dirty: false,
      hasAgentsMd: false,
      hasCodeBrain: false,
      packageHints: [],
      lastSeenAt: new Date().toISOString(),
    }));
    const ctx = makeCtx();
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = entries;

    try {
      await mkdir(root, { recursive: true });
      await mkdir(otherRoot, { recursive: true });
      await symlink(root, symlinkRoot);
      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const listed = (await tools?.workspace_list_projects?.handler?.({ query: symlinkRoot })) as {
        structuredContent?: { projects?: ProjectRegistryEntry[] };
      };

      expect(listed.structuredContent?.projects?.map((entry) => entry.projectId)).toEqual(["project"]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
  it("preserves saved and live registry state when retained monitor validation cannot access its marker", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-retained-"));
    const headSha = "d".repeat(40);
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const monitorRoot = path.join(workspaceRoot, "gajae-code-pr-monitor-pr-worktrees", "Yeachan-Heo--gajae-code", `pr-11-${headSha}`);
    const retained: ProjectRegistryEntry = {
      projectId: `pr-11-${headSha}`, name: `pr-11-${headSha}`, root: monitorRoot, aliases: [monitorRoot],
      dirty: false, hasAgentsMd: false, hasCodeBrain: false, packageHints: [], lastSeenAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    const saved: ProjectRegistryEntry[][] = [];
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [retained];
    const before = structuredClone(ctx.registry);
    ctx.store = {
      loadProjects: async () => [],
      saveProjects: async (projects) => { saved.push(projects); },
      getSession: async () => null,
      setSession: async () => undefined,
    };

    try {
      await mkdir(repositoryRoot, { recursive: true });
      await writeFile(path.join(repositoryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await mkdir(monitorRoot, { recursive: true });
      await writeFile(path.join(monitorRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await chmod(monitorRoot, 0);
      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const refreshed = (await tools?.workspace_refresh_index?.handler?.({})) as { isError?: boolean };

      expect(refreshed.isError).toBe(true);
      expect(saved).toEqual([]);
      expect(ctx.registry).toEqual(before);
    } finally {
      await chmod(monitorRoot, 0o700).catch(() => undefined);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects retained monitor symlinks instead of retaining their canonical target", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-retained-"));
    const headSha = "e".repeat(40);
    const repositoryRoot = path.join(workspaceRoot, "gajae-code");
    const targetRoot = path.join(workspaceRoot, "target");
    const monitorRoot = path.join(workspaceRoot, "gajae-code-pr-monitor-pr-worktrees", "Yeachan-Heo--gajae-code", `pr-12-${headSha}`);
    const retained: ProjectRegistryEntry = {
      projectId: `pr-12-${headSha}`, name: `pr-12-${headSha}`, root: monitorRoot, aliases: [monitorRoot],
      dirty: false, hasAgentsMd: false, hasCodeBrain: false, packageHints: [], lastSeenAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    ctx.workspaceRoot = workspaceRoot;
    ctx.config.workspaceRoot = workspaceRoot;
    ctx.registry = [retained];

    try {
      await mkdir(repositoryRoot, { recursive: true });
      await writeFile(path.join(repositoryRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await mkdir(targetRoot, { recursive: true });
      await writeFile(path.join(targetRoot, ".git"), "gitdir: /nonexistent\n", "utf8");
      await mkdir(path.dirname(monitorRoot), { recursive: true });
      await symlink(targetRoot, monitorRoot);
      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const refreshed = (await tools?.workspace_refresh_index?.handler?.({})) as { isError?: boolean };

      expect(refreshed.isError).toBeUndefined();
      expect(ctx.registry.map((entry) => entry.projectId)).not.toContain(retained.projectId);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  describe("ChatGPT confirm-model exposure (CHATGPT2CODEX_CONTROL_CHATGPT)", () => {
    beforeEach(() => {
      process.env.CHATGPT2CODEX_MONITOR_ROLLOUT = "enabled";
    });
    afterEach(() => {
      delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
      delete process.env.CHATGPT2CODEX_MONITOR_ROLLOUT;
    });

    async function toolsListNames(): Promise<string[]> {
      const server = await createServer(makeCtx());
      const handler = (
        server.server as unknown as {
          _requestHandlers?: Map<
            string,
            (request: { method: string; params: Record<string, never> }) => Promise<{
              tools: Array<{ name: string; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }>;
            }>
          >;
        }
      )._requestHandlers?.get("tools/list");
      const listed = await handler?.({ method: "tools/list", params: {} });
      return listed?.tools.map((t) => t.name) ?? [];
    }

    it("hides the 4 control tools from tools/list by default (flag unset)", async () => {
      const names = await toolsListNames();
      for (const name of CONTROL_TOOL_NAMES) {
        expect(names, name).not.toContain(name);
      }
    });

    it.each(["0", "false", "off"])("hides the 4 control tools from tools/list when explicitly opted out (%s)", async (value) => {
      process.env.CHATGPT2CODEX_CONTROL_CHATGPT = value;
      const names = await toolsListNames();
      for (const name of CONTROL_TOOL_NAMES) {
        expect(names, name).not.toContain(name);
      }
    });

    it("exposes all 4 control tools in tools/list once CHATGPT2CODEX_CONTROL_CHATGPT=1, with oauth2 securitySchemes and Confirm/Deny-driving annotations", async () => {
      process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
      const server = await createServer(makeCtx());
      const handler = (
        server.server as unknown as {
          _requestHandlers?: Map<
            string,
            (request: { method: string; params: Record<string, never> }) => Promise<{
              tools: Array<{
                name: string;
                annotations?: Record<string, unknown>;
                securitySchemes?: Array<{ type?: string; scopes?: string[] }>;
                _meta?: Record<string, unknown>;
              }>;
            }>
          >;
        }
      )._requestHandlers?.get("tools/list");
      const listed = await handler?.({ method: "tools/list", params: {} });
      const byName = new Map((listed?.tools ?? []).map((t) => [t.name, t]));

      for (const name of CONTROL_TOOL_NAMES) {
        const tool = byName.get(name);
        expect(tool, name).toBeDefined();
        expect(tool?.securitySchemes, name).toMatchObject([{ type: "oauth2", scopes: ["chatgpt2codex"] }]);
        expect(tool?._meta?.["openai/visibility"], name).toBe("public");
      }

      // request_action / kill_switch / screenshot must drive ChatGPT's
      // client-side Confirm/Deny prompt (non-read-only, destructive);
      // action_status is a pure read and must not prompt.
      expect(byName.get("computer_request_action")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("computer_kill_switch")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("computer_screenshot")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("computer_action_status")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    });
    it("registers the dynamic read-only PR monitor surface with strict two-key input", async () => {
      const server = await createMonitorServer(makeCtx());
      const tools = (server as unknown as {
        _registeredTools?: Record<string, {
          annotations?: Record<string, unknown>;
          inputSchema?: {
            shape?: Record<string, unknown>;
            safeParse?: (value: unknown) => { success: boolean };
          };
        }>;
      })._registeredTools;
      const monitorTools = Object.keys(tools ?? {}).filter((name) => name.startsWith("github_pr_monitor_"));
      expect(monitorTools).toEqual(["github_pr_monitor_read"]);
      expect(tools?.github_pr_monitor_read?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tools?.github_pr_monitor_read?.inputSchema?.shape).toEqual({
        runId: expect.anything(),
        actionPlanId: expect.anything(),
      });
      expect(tools?.github_pr_monitor_read?.inputSchema?.safeParse?.({
        runId: "run",
        actionPlanId: "plan",
      }).success).toBe(true);
      expect(tools?.github_pr_monitor_read?.inputSchema?.safeParse?.({
        runId: "run",
        actionPlanId: "plan",
        repository: "attacker/example",
      }).success).toBe(false);
      expect(tools?.github_pr_monitor_read?.inputSchema?.safeParse?.({
        runId: "run",
      }).success).toBe(false);
    });
    it("returns the shared dynamic read envelope for the strict two-key input", async () => {
      const server = await createMonitorServer(makeCtx());
      try {
        const tools = (server as unknown as {
          _registeredTools?: Record<string, {
            handler?: (input: unknown) => Promise<{
              isError?: boolean;
              structuredContent?: Record<string, unknown>;
            }>;
          }>;
        })._registeredTools;
        const result = await tools?.github_pr_monitor_read?.handler?.({
          runId: "dynamic-read-run",
          actionPlanId: "dynamic-read-plan",
          repository: "attacker/example",
        });
        const structured = result?.structuredContent;
        expect(structured).toMatchObject({
          monitorPayloadVersion: 1,
          protocolVersion: 1,
          schemaVersion: 4,
          namespace: "ChatGPT_To_Codex",
          tool: "github_pr_monitor_read",
          operation: "read",
          chatgpt2codexToolCall: {
            namespace: "ChatGPT_To_Codex",
            toolName: "github_pr_monitor_read",
          },
        });
        expect(structured?.code).toBe("GITHUB_MONITOR_INVALID_INPUT");
        expect(structured).not.toHaveProperty("repository");
        expect(structured).not.toHaveProperty("author");
        expect(typeof structured?.requestDigest).toBe("string");
        expect(typeof structured?.code === "string" || structured?.ok === true).toBe(true);
      } finally {
        await server.close();
      }
    });
  });
});
