import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import type { BskRunOptions, BskRunResult } from "../src/runner";
import { SessionRegistry } from "../src/sessions";
import { type PluginConfig, registerTools } from "../src/tools";

const CONFIG: PluginConfig = { bskPath: "bsk", defaultTimeoutMs: 120_000, maxSessions: 5 };

interface FakeCall {
  args: string[];
  options: BskRunOptions;
}

/** Mark a canned answer as a per-call sequence (each call shifts one reply). */
function seq(items: unknown[]): { __seq: unknown[] } {
  return { __seq: items };
}

/** A runner that answers canned JSON per command prefix and records calls. */
function fakeRunner(responses: Record<string, unknown>) {
  const calls: FakeCall[] = [];
  return {
    calls,
    runner: {
      async run(args: string[], options: BskRunOptions = {}): Promise<BskRunResult> {
        calls.push({ args, options });
        if (options.signal?.aborted) {
          return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
        }
        for (const [prefix, response] of Object.entries(responses)) {
          if (args.join(" ").startsWith(prefix)) {
            if (response instanceof Error) throw response;
            const reply =
              typeof response === "object" && response !== null && "__seq" in response
                ? (response as { __seq: unknown[] }).__seq.shift()
                : response;
            return {
              code: 0,
              stdout: JSON.stringify(reply),
              stderr: "",
              timedOut: false,
              aborted: false,
            };
          }
        }
        return {
          code: 2,
          stdout: JSON.stringify({
            code: "unexpected",
            message: `no canned response for: ${args.join(" ")}`,
          }),
          stderr: "",
          timedOut: false,
          aborted: false,
        };
      },
      killAll() {},
    },
  };
}

function makeCtx(services: Record<string, unknown> = {}) {
  const tools = new Map<string, ToolDefinition>();
  const ctx = {
    tools: { register: (def: ToolDefinition) => tools.set(def.name, def) },
    get: (key: string) => services[key],
  };
  return { ctx, tools };
}

function makeExec(overrides: Record<string, unknown> = {}): ToolRunContext {
  return {
    callId: "test-call",
    name: "test",
    signal: new AbortController().signal,
    ...overrides,
  } as unknown as ToolRunContext;
}

const SNAPSHOT_REPLY = {
  text: '- button "OK" [ref=@e1]',
  ref_count: 1,
  tab_id: 7,
  truncated: false,
};

function setup(
  responses: Record<string, unknown>,
  services: Record<string, unknown> = {},
  maxSessions = 5,
) {
  const { ctx, tools } = makeCtx(services);
  const { runner, calls } = fakeRunner(responses);
  const registry = new SessionRegistry(maxSessions);
  registerTools({ ctx: ctx as never, runner, registry, config: { ...CONFIG, maxSessions } });
  return { tools, calls, registry };
}

async function startSession(tools: Map<string, ToolDefinition>, sessionId = "s1") {
  const tool = tools.get("browser_session_start");
  if (tool === undefined) throw new Error("browser_session_start not registered");
  return tool.execute({}, makeExec()) as Promise<{ sessionId: string }>;
}

const START_REPLY = (id: string) => ({ session_id: id, browser_instance_id: "chrome-1" });

describe("tool registration", () => {
  it("registers the full browser tool suite", () => {
    const { tools } = setup({});
    expect([...tools.keys()].sort()).toEqual([
      "browser_click",
      "browser_emulate",
      "browser_fill",
      "browser_navigate",
      "browser_observe",
      "browser_press",
      "browser_screenshot",
      "browser_session_list",
      "browser_session_start",
      "browser_session_stop",
      "browser_snapshot",
    ]);
  });

  it("validates model args through defineTool (missing required param)", async () => {
    const { tools } = setup({});
    const navigate = tools.get("browser_navigate");
    await expect(navigate?.execute({}, makeExec())).rejects.toThrow(/invalid arguments/);
  });
});

describe("browser_session_start", () => {
  it("maps the start reply and tracks the session as current", async () => {
    const { tools, registry } = setup({ "session start": START_REPLY("s1") });
    const value = await startSession(tools);
    expect(value.sessionId).toBe("s1");
    expect(registry.current()).toBe("s1");
  });

  it("passes window size and opens the initial URL and device preset", async () => {
    const { tools, calls } = setup({
      "session start": START_REPLY("s1"),
      emulate: { tab_id: 7, cleared: false },
      navigate: { tab_id: 7, url: "https://example.com", reached: "load" },
    });
    const tool = tools.get("browser_session_start");
    const value = (await tool?.execute(
      { width: 1280, height: 800, url: "https://example.com", device: "iphone-14", noFocus: true },
      makeExec(),
    )) as { sessionId: string; url: string; device: string };
    expect(value).toMatchObject({
      sessionId: "s1",
      url: "https://example.com",
      device: "iphone-14",
    });
    expect(calls[0].args).toEqual([
      "session",
      "start",
      "--width",
      "1280",
      "--height",
      "800",
      "--no-focus",
    ]);
    expect(calls[1].args).toEqual(["emulate", "--session", "s1", "--device", "iphone-14"]);
    expect(calls[2].args).toEqual(["navigate", "--session", "s1", "https://example.com"]);
  });

  it("requires width and height together", async () => {
    const { tools } = setup({ "session start": START_REPLY("s1") });
    const tool = tools.get("browser_session_start");
    await expect(tool?.execute({ width: 1280 }, makeExec())).rejects.toThrow(/together/);
  });

  it("cleans up a half-initialized session when the initial navigate fails", async () => {
    const { tools, calls, registry } = setup({
      "session start": START_REPLY("s1"),
      "session stop": {},
    });
    // navigate has no canned response -> non-zero exit -> error.
    const tool = tools.get("browser_session_start");
    await expect(tool?.execute({ url: "https://example.com" }, makeExec())).rejects.toThrow(
      /navigate/,
    );
    expect(calls.some((c) => c.args.join(" ") === "session stop s1")).toBe(true);
    expect(registry.current()).toBeUndefined();
  });
});

describe("multi-session behavior", () => {
  const responses = {
    "session start": START_REPLY("s1"),
    snapshot: SNAPSHOT_REPLY,
  };

  it("operation tools default to the current session and echo it back", async () => {
    const { tools, calls } = setup(responses);
    await startSession(tools);
    const snapshot = tools.get("browser_snapshot");
    const value = (await snapshot?.execute({}, makeExec())) as {
      session: string;
      refCount: number;
    };
    expect(value).toMatchObject({ session: "s1", refCount: 1 });
    expect(calls[1].args).toEqual(["snapshot", "--session", "s1"]);
  });

  it("an explicit owned session wins and becomes the new current session", async () => {
    const { tools, calls, registry } = setup({
      "session start": seq([START_REPLY("s1"), START_REPLY("s2")]),
      snapshot: SNAPSHOT_REPLY,
    });
    await startSession(tools, "s1");
    await startSession(tools, "s2");
    const snapshot = tools.get("browser_snapshot");
    const value = (await snapshot?.execute({ session: "s1" }, makeExec())) as {
      session: string;
    };
    expect(value.session).toBe("s1");
    expect(calls[2].args).toEqual(["snapshot", "--session", "s1"]);
    expect(registry.current()).toBe("s1");
  });

  it("rejects an explicit foreign session without touching the daemon", async () => {
    const { tools, calls } = setup(responses);
    await startSession(tools);
    const callsBefore = calls.length;
    const snapshot = tools.get("browser_snapshot");
    await expect(snapshot?.execute({ session: "other" }, makeExec())).rejects.toThrow(
      /does not belong to this plugin/,
    );
    expect(calls.length).toBe(callsBefore);
  });

  it("fails with guidance when no session exists", async () => {
    const { tools } = setup(responses);
    const snapshot = tools.get("browser_snapshot");
    await expect(snapshot?.execute({}, makeExec())).rejects.toThrow(/browser_session_start/);
  });

  it("enforces the configured session cap before spawning", async () => {
    const { tools, calls } = setup(
      { "session start": seq([START_REPLY("s1"), START_REPLY("s2")]) },
      {},
      1,
    );
    await startSession(tools);
    const start = tools.get("browser_session_start");
    await expect(start?.execute({}, makeExec())).rejects.toThrow(/session limit/);
    // A rejected start must not spawn another bsk session (no leaked session).
    expect(calls.filter((c) => c.args.join(" ").startsWith("session start"))).toHaveLength(1);
  });

  it("shares the cap atomically across concurrent starts (reservation race)", async () => {
    const { tools, calls } = setup(
      { "session start": seq([START_REPLY("s1"), START_REPLY("s2")]) },
      {},
      1,
    );
    const start = tools.get("browser_session_start");
    if (start === undefined) throw new Error("not registered");
    // Two truly concurrent starts against a cap of 1: exactly one may spawn.
    const outcomes = await Promise.allSettled([
      start.execute({}, makeExec()),
      start.execute({}, makeExec()),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/session limit/);
    expect(calls.filter((c) => c.args.join(" ").startsWith("session start"))).toHaveLength(1);
  });

  it("refuses to stop a session the plugin did not create", async () => {
    const { tools, calls } = setup(responses);
    await startSession(tools);
    const stop = tools.get("browser_session_stop");
    await expect(stop?.execute({ session: "ext7" }, makeExec())).rejects.toThrow(
      /does not belong to this plugin/,
    );
    // No stop command may reach the daemon for a foreign session.
    expect(calls.some((c) => c.args.join(" ").startsWith("session stop"))).toBe(false);
  });
});

describe("browser_session_stop / list", () => {
  it("stops the current session and clears the registry", async () => {
    const { tools, calls, registry } = setup({
      "session start": START_REPLY("s1"),
      "session stop": {},
    });
    await startSession(tools);
    const stop = tools.get("browser_session_stop");
    const value = (await stop?.execute({}, makeExec())) as { stopped: string };
    expect(value.stopped).toBe("s1");
    expect(calls[1].args).toEqual(["session", "stop", "s1"]);
    expect(registry.current()).toBeUndefined();
  });

  it("lists only plugin-owned sessions with the current marker (no daemon view)", async () => {
    const { tools, calls } = setup({
      "session start": seq([START_REPLY("s1"), START_REPLY("s2")]),
    });
    await startSession(tools);
    await startSession(tools);
    const list = tools.get("browser_session_list");
    const value = (await list?.execute({}, makeExec())) as {
      sessions: { sessionId: string; current: boolean }[];
    };
    expect(value.sessions).toEqual([
      { sessionId: "s1", browserInstanceId: "chrome-1", current: false },
      { sessionId: "s2", browserInstanceId: "chrome-1", current: true },
    ]);
    // Registry-only: listing must not call the daemon at all.
    expect(calls.some((c) => c.args.join(" ").startsWith("session list"))).toBe(false);
  });
});

describe("interaction tools", () => {
  const responses = {
    "session start": START_REPLY("s1"),
    click: { tab_id: 7, used_ref: "@e1", x: 10, y: 20 },
    fill: { tab_id: 7, used_ref: "@e2", value_length: 5 },
    press: { tab_id: 7, key: "Enter", code: "Enter", modifiers: [] },
    navigate: { tab_id: 7, url: "https://a.test", final_url: "https://b.test", reached: "load" },
    emulate: { tab_id: 7, cleared: false },
  };

  it("browser_click maps target, button, and click count", async () => {
    const { tools, calls } = setup(responses);
    await startSession(tools);
    const click = tools.get("browser_click");
    const value = (await click?.execute(
      { target: "@e1", button: "right", clickCount: 2 },
      makeExec(),
    )) as { session: string; x: number; y: number };
    expect(value).toMatchObject({ session: "s1", x: 10, y: 20 });
    expect(calls[1].args).toEqual([
      "click",
      "--session",
      "s1",
      "--button",
      "right",
      "--click-count",
      "2",
      "@e1",
    ]);
  });

  it("browser_fill passes value and --no-clear", async () => {
    const { tools, calls } = setup(responses);
    await startSession(tools);
    const fill = tools.get("browser_fill");
    await fill?.execute({ target: "e2", value: "hello", noClear: true }, makeExec());
    expect(calls[1].args).toEqual([
      "fill",
      "--session",
      "s1",
      "--value",
      "hello",
      "--no-clear",
      "e2",
    ]);
  });

  it("browser_press picks --ref for snapshot refs and --selector otherwise", async () => {
    const { tools, calls } = setup(responses);
    await startSession(tools);
    const press = tools.get("browser_press");
    await press?.execute({ key: "Enter", target: "@e3" }, makeExec());
    expect(calls[1].args).toEqual(["press", "--session", "s1", "--ref", "@e3", "Enter"]);
    await press?.execute({ key: "Ctrl+A", target: "#field" }, makeExec());
    expect(calls[2].args).toEqual(["press", "--session", "s1", "--selector", "#field", "Ctrl+A"]);
  });

  it("browser_navigate converts waitUntil and timeoutMs", async () => {
    const { tools, calls } = setup(responses);
    await startSession(tools);
    const navigate = tools.get("browser_navigate");
    const value = (await navigate?.execute(
      { url: "https://a.test", waitUntil: "networkidle", timeoutMs: 1500 },
      makeExec(),
    )) as { finalUrl: string; reached: string };
    expect(value).toMatchObject({ finalUrl: "https://b.test", reached: "load" });
    expect(calls[1].args).toEqual([
      "navigate",
      "--session",
      "s1",
      "--wait-until",
      "networkidle",
      "--timeout",
      "1500ms",
      "https://a.test",
    ]);
  });

  it("browser_emulate rejects off combined with overrides", async () => {
    const { tools } = setup(responses);
    await startSession(tools);
    const emulate = tools.get("browser_emulate");
    await expect(emulate?.execute({ off: true, device: "iphone-14" }, makeExec())).rejects.toThrow(
      /mutually exclusive/,
    );
  });
});

describe("browser_screenshot", () => {
  function pngFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "bsk-test-"));
    const path = join(dir, "shot.png");
    // Minimal PNG header bytes are enough: the plugin never decodes the image.
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    return path;
  }

  it("returns the PNG path when no attachment store is mounted", async () => {
    const path = pngFile();
    const { tools, calls } = setup({
      "session start": START_REPLY("s1"),
      screenshot: { tab_id: 7, width: 800, height: 600, format: "png", path, byte_size: 8 },
    });
    await startSession(tools);
    const screenshot = tools.get("browser_screenshot");
    const value = (await screenshot?.execute({ ref: "@e1" }, makeExec())) as {
      path: string;
      image?: unknown;
    };
    expect(value.path).toBe(path);
    expect(value.image).toBeUndefined();
    expect(calls[1].args.slice(0, 3)).toEqual(["screenshot", "--session", "s1"]);
    expect(calls[1].args).toContain("--ref");
    const rendered = screenshot?.output.render({ session: "s1" }, value as never);
    expect(rendered?.every((block) => block.type === "text")).toBe(true);
  });

  it("commits the image through the attachment store on an image-capable route", async () => {
    const path = pngFile();
    const services = {
      attachments: {
        imageLimits: {
          mediaTypes: ["image/png"],
          maxImageBytes: 10_000_000,
          maxMessageImageBytes: 10_000_000,
        },
        saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => ({
          attachmentId: "att-1",
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 800,
          height: 600,
          name: input.name,
        }),
      },
      llm: {
        resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }),
      },
    };
    const { tools } = setup(
      {
        "session start": START_REPLY("s1"),
        screenshot: { tab_id: 7, width: 800, height: 600, format: "png", path, byte_size: 8 },
      },
      services,
    );
    await startSession(tools);
    const exec = makeExec({
      agent: {
        session: { requestHeader: () => ({ config: { provider: "deepseek", model: "vl" } }) },
        options: {},
      },
    });
    const screenshot = tools.get("browser_screenshot");
    const value = (await screenshot?.execute({}, exec)) as {
      image?: { attachmentId: string; mediaType: string };
    };
    expect(value.image).toMatchObject({ attachmentId: "att-1", mediaType: "image/png" });
    const rendered = screenshot?.output.render({}, value as never) as { type: string }[];
    expect(rendered.map((block) => block.type)).toEqual(["text", "image"]);
  });

  it("stays path-only when the model route is text-only", async () => {
    const path = pngFile();
    const services = {
      attachments: {
        imageLimits: { mediaTypes: ["image/png"], maxImageBytes: 1e7, maxMessageImageBytes: 1e7 },
        saveImage: async () => {
          throw new Error("must not be called");
        },
      },
      llm: { resolveModelInfo: async () => ({ inputModalities: ["text"] }) },
    };
    const { tools } = setup(
      {
        "session start": START_REPLY("s1"),
        screenshot: { tab_id: 7, width: 1, height: 1, format: "png", path, byte_size: 8 },
      },
      services,
    );
    await startSession(tools);
    const exec = makeExec({
      agent: {
        session: { requestHeader: () => ({ config: { provider: "p", model: "m" } }) },
        options: {},
      },
    });
    const screenshot = tools.get("browser_screenshot");
    const value = (await screenshot?.execute({}, exec)) as { image?: unknown; path: string };
    expect(value.image).toBeUndefined();
    expect(value.path).toBe(path);
  });
});

describe("error and cancellation semantics", () => {
  it("surfaces the bsk JSON error envelope with code and hint", async () => {
    const { tools } = setup({
      "session start": START_REPLY("s1"),
    });
    await startSession(tools);
    const snapshot = tools.get("browser_snapshot");
    await expect(snapshot?.execute({}, makeExec())).rejects.toThrow(/no canned response/);
  });

  it("turns an aborted child into an AbortError", async () => {
    const { tools } = setup({ "session start": START_REPLY("s1") });
    await startSession(tools);
    const snapshot = tools.get("browser_snapshot");
    const controller = new AbortController();
    controller.abort();
    const exec = makeExec({ signal: controller.signal });
    await expect(snapshot?.execute({}, exec)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("maps a missing bsk binary onto install guidance", async () => {
    const { ctx, tools } = makeCtx();
    const registry = new SessionRegistry(5);
    const runner = {
      async run(): Promise<BskRunResult> {
        throw Object.assign(new Error("spawn bsk ENOENT"), { code: "ENOENT" });
      },
      killAll() {},
    };
    registerTools({ ctx: ctx as never, runner, registry, config: CONFIG });
    const start = tools.get("browser_session_start");
    await expect(start?.execute({}, makeExec())).rejects.toThrow(/BrowserSkill must be installed/);
  });
});

describe("presentation", () => {
  it("presents calls as terminal cards with the bsk command line", () => {
    const { tools } = setup({});
    const click = tools.get("browser_click");
    const view = click?.presentCall?.({ target: "@e1" }) as {
      card: string;
      title: string;
    };
    expect(view.card).toBe("terminal");
    expect(view.title).toContain("bsk click @e1");
  });

  it("presents results as terminal cards carrying the rendered text", () => {
    const { tools } = setup({});
    const click = tools.get("browser_click");
    const view = click?.presentResult?.({ target: "@e1" }, {
      content: [{ type: "text", text: "clicked" }],
      isError: false,
    } as never) as { card: string; output: string; exitCode: number };
    expect(view).toMatchObject({ card: "terminal", output: "clicked", exitCode: 0 });
  });

  it("projects the text block of multi-block results (screenshot text + image)", () => {
    const { tools } = setup({});
    const screenshot = tools.get("browser_screenshot");
    const view = screenshot?.presentResult?.({}, {
      content: [
        { type: "text", text: "[session s1] screenshot of tab 7" },
        { type: "image", attachment: { attachmentId: "a1" } },
      ],
      isError: false,
    } as never) as { card: string; output: string };
    expect(view).toMatchObject({ card: "terminal", output: "[session s1] screenshot of tab 7" });
  });
});
