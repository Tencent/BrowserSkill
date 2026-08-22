import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { ObservationService } from "../src/observation";
import { KeyedExecutor } from "../src/queue";
import type { BskRunner, BskRunOptions, BskRunResult } from "../src/runner";
import { SessionRegistry } from "../src/sessions";
import { type PluginConfig, registerTools } from "../src/tools";

const CONFIG: PluginConfig = {
  bskPath: "bsk",
  defaultTimeoutMs: 120_000,
  maxSessions: 5,
  observationEnabled: false,
  thumbnailIntervalMs: 1500,
  idleIntervalMs: 8000,
  lazyTools: false,
};

/** An observation service with the feature off: instrumentation becomes a no-op. */
function disabledObservation(deps: { ctx: unknown; runner: BskRunner; registry: SessionRegistry }) {
  return new ObservationService({
    ctx: deps.ctx as never,
    runner: deps.runner,
    registry: deps.registry,
    queue: new KeyedExecutor(),
    options: { enabled: false, thumbnailIntervalMs: 1500, idleIntervalMs: 8000 },
  });
}

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
      killFor: () => 0,
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
  const config = { ...CONFIG, maxSessions };
  registerTools({
    ctx: ctx as never,
    runner: runner as BskRunner,
    registry,
    config,
    observation: disabledObservation({ ctx, runner: runner as BskRunner, registry }),
    queue: new KeyedExecutor(),
  });
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
      "browser_console",
      "browser_emulate",
      "browser_fill",
      "browser_get_html",
      "browser_hover",
      "browser_navigate",
      "browser_navigate_back",
      "browser_navigate_forward",
      "browser_network",
      "browser_observe",
      "browser_press",
      "browser_reload",
      "browser_request_help",
      "browser_screenshot",
      "browser_select",
      "browser_session_list",
      "browser_session_start",
      "browser_session_stop",
      "browser_snapshot",
      "browser_tab_borrow",
      "browser_tab_close",
      "browser_tab_create",
      "browser_tab_list",
      "browser_tab_return",
      "browser_tab_select",
      "browser_wait_for_navigation",
      "browser_window_resize",
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

  it("browser_hover and browser_select map their structured arguments", async () => {
    const { tools, calls } = setup({
      "session start": START_REPLY("s1"),
      hover: { tab_id: 7, used_ref: "@e3", x: 12, y: 24 },
      select: {
        tab_id: 7,
        used_ref: "@e4",
        multiple: true,
        selected_values: ["a", "b"],
        selected_labels: ["Alpha", "Beta"],
      },
    });
    await startSession(tools);
    const hovered = (await tools
      .get("browser_hover")
      ?.execute(
        { target: "@e3", modifiers: ["shift"], settleMs: 250, timeoutMs: 2000 },
        makeExec(),
      )) as { x: number; y: number };
    expect(hovered).toMatchObject({ x: 12, y: 24 });
    expect(calls[1].args).toEqual([
      "hover",
      "--session",
      "s1",
      "--modifiers",
      "shift",
      "--settle",
      "250ms",
      "--timeout",
      "2000ms",
      "@e3",
    ]);

    const selected = (await tools
      .get("browser_select")
      ?.execute({ target: "@e4", values: ["a", "b"], tabId: 7 }, makeExec())) as {
      selectedValues: string[];
      selectedLabels: string[];
    };
    expect(selected).toMatchObject({
      selectedValues: ["a", "b"],
      selectedLabels: ["Alpha", "Beta"],
    });
    expect(calls[2].args).toEqual([
      "select",
      "--session",
      "s1",
      "--tab-id",
      "7",
      "--value",
      "a",
      "--value",
      "b",
      "@e4",
    ]);
  });
});

describe("phase-one tab tools", () => {
  it("maps list/create/close/select/borrow/return through the owned session", async () => {
    const { tools, calls } = setup({
      "session start": START_REPLY("s1"),
      "tab list": {
        tabs: [
          {
            tab_id: 7,
            title: "Example",
            url: "https://example.test",
            window_id: 2,
            active: true,
            scope: "agent",
          },
        ],
      },
      "tab create": { tab_id: 8, window_id: 2, url: "https://new.test" },
      "tab close": { tab_id: 8 },
      "tab select": { tab_id: 7, window_id: 2 },
      "tab borrow": {
        tab_id: 20,
        original_window_id: 9,
        original_index: 1,
        agent_window_id: 2,
      },
      "tab return": {
        tab_id: 20,
        returned_to_window_id: 9,
        returned_to_index: 1,
        fallback: false,
      },
    });
    await startSession(tools);

    const listed = (await tools
      .get("browser_tab_list")
      ?.execute({ scope: "agent" }, makeExec())) as { tabs: { tabId: number }[] };
    expect(listed.tabs[0].tabId).toBe(7);
    const created = (await tools
      .get("browser_tab_create")
      ?.execute({ url: "https://new.test", active: false, index: 1 }, makeExec())) as {
      tabId: number;
    };
    expect(created.tabId).toBe(8);
    await tools.get("browser_tab_close")?.execute({ tabId: 8 }, makeExec());
    await tools.get("browser_tab_select")?.execute({ tabId: 7 }, makeExec());
    const borrowed = (await tools
      .get("browser_tab_borrow")
      ?.execute({ tabId: 20 }, makeExec())) as { originalWindowId: number };
    expect(borrowed.originalWindowId).toBe(9);
    const returned = (await tools
      .get("browser_tab_return")
      ?.execute({ tabId: 20 }, makeExec())) as { fallback: boolean };
    expect(returned.fallback).toBe(false);

    expect(calls.slice(1).map((call) => call.args)).toEqual([
      ["tab", "list", "--session", "s1", "--scope", "agent"],
      [
        "tab",
        "create",
        "--session",
        "s1",
        "--url",
        "https://new.test",
        "--no-active",
        "--index",
        "1",
      ],
      ["tab", "close", "8", "--session", "s1"],
      ["tab", "select", "7", "--session", "s1"],
      ["tab", "borrow", "20", "--session", "s1"],
      ["tab", "return", "20", "--session", "s1"],
    ]);
  });
});

describe("phase-one navigation tools", () => {
  it("maps back/forward/reload/wait and preserves timeout budgets", async () => {
    const { tools, calls } = setup({
      "session start": START_REPLY("s1"),
      "navigate-back": {
        tab_id: 7,
        previous_url: "https://b.test",
        final_url: "https://a.test",
        reached: "load",
      },
      "navigate-forward": {
        tab_id: 7,
        previous_url: "https://a.test",
        final_url: "https://b.test",
        reached: "load",
      },
      reload: {
        tab_id: 7,
        previous_url: "https://b.test",
        final_url: "https://b.test",
        reached: "networkidle",
      },
      "wait-for-navigation": { tab_id: 7, reached: "timeout", error_text: "no navigation" },
    });
    await startSession(tools);
    await tools
      .get("browser_navigate_back")
      ?.execute({ tabId: 7, waitUntil: "commit", timeoutMs: 1000 }, makeExec());
    await tools.get("browser_navigate_forward")?.execute({}, makeExec());
    await tools
      .get("browser_reload")
      ?.execute({ hard: true, waitUntil: "networkidle" }, makeExec());
    const waited = (await tools
      .get("browser_wait_for_navigation")
      ?.execute({ timeoutMs: 2500 }, makeExec())) as { reached: string; errorText: string };
    expect(waited).toMatchObject({ reached: "timeout", errorText: "no navigation" });
    expect(calls[1].args).toEqual([
      "navigate-back",
      "--session",
      "s1",
      "--tab-id",
      "7",
      "--wait-until",
      "commit",
      "--timeout",
      "1000ms",
    ]);
    expect(calls[2].args).toEqual(["navigate-forward", "--session", "s1"]);
    expect(calls[3].args).toEqual([
      "reload",
      "--session",
      "s1",
      "--wait-until",
      "networkidle",
      "--hard",
    ]);
    expect(calls[4].args).toEqual([
      "wait-for-navigation",
      "--session",
      "s1",
      "--timeout",
      "2500ms",
    ]);
    expect(calls[4].options.timeoutMs).toBe(120_000);
  });
});

describe("phase-one support tools", () => {
  it("maps request-help targets and structured completion criteria", async () => {
    const { tools, calls } = setup({
      "session start": START_REPLY("s1"),
      "request-help": {
        outcome: "completed",
        completed_by: "system",
        note: "signed in",
        tab_id: 7,
        resolved_targets: [{ matched: true, ref: "@e3" }],
      },
    });
    await startSession(tools);
    const value = (await tools.get("browser_request_help")?.execute(
      {
        prompt: "Please sign in",
        title: "Login required",
        targets: ["@e3", "#submit"],
        timeoutMs: 300_000,
        completionCriteria: {
          any: [{ urlContains: "/dashboard" }, { selectorExists: "[data-user]" }],
          stableForMs: 1000,
        },
      },
      makeExec(),
    )) as { outcome: string; note: string };
    expect(value).toMatchObject({ outcome: "completed", note: "signed in" });
    expect(calls[1].options.timeoutMs).toBe(315_000);
    expect(calls[1].args.slice(0, 8)).toEqual([
      "request-help",
      "--session",
      "s1",
      "--prompt",
      "Please sign in",
      "--timeout",
      "300000ms",
      "--title",
    ]);
    const criteriaIndex = calls[1].args.indexOf("--completion-criteria");
    expect(JSON.parse(calls[1].args[criteriaIndex + 1])).toEqual({
      any: [{ url_contains: "/dashboard" }, { selector_exists: "[data-user]" }],
      stable_for_ms: 1000,
    });
  });

  it("maps get-html, console, and network results without raw shell access", async () => {
    const { tools, calls } = setup({
      "session start": START_REPLY("s1"),
      "get-html": { tab_id: 7, html: "<main>Hi</main>", truncated: false, byte_size: 15 },
      console: {
        tab_id: 7,
        entries: [
          {
            sequence: 3,
            kind: "exception",
            level: "error",
            text: "boom",
            stack_trace: [{ function_name: "run", url: "https://a.test/app.js", line: 4 }],
          },
        ],
        next_since: 3,
        truncated: false,
      },
      network: {
        tab_id: 7,
        entries: [
          {
            sequence: 5,
            kind: "response",
            method: "GET",
            url: "https://a.test/api",
            status: 200,
            mime_type: "application/json",
          },
        ],
        next_since: 5,
        truncated: false,
      },
    });
    await startSession(tools);
    const html = (await tools
      .get("browser_get_html")
      ?.execute({ ref: "@e2", maxBytes: 2048 }, makeExec())) as { html: string };
    expect(html.html).toBe("<main>Hi</main>");
    const consoleValue = (await tools
      .get("browser_console")
      ?.execute({ since: 1, limit: 10, includeStack: true }, makeExec())) as {
      entries: { stackTrace: { functionName: string }[] }[];
    };
    expect(consoleValue.entries[0].stackTrace[0].functionName).toBe("run");
    const networkValue = (await tools
      .get("browser_network")
      ?.execute({ tabId: 7, maxTextChars: 512 }, makeExec())) as {
      entries: { mimeType: string }[];
    };
    expect(networkValue.entries[0].mimeType).toBe("application/json");
    expect(calls.slice(1).map((call) => call.args)).toEqual([
      ["get-html", "--session", "s1", "--ref", "@e2", "--max-bytes", "2048"],
      ["console", "--session", "s1", "--since", "1", "--limit", "10", "--include-stack"],
      ["network", "--session", "s1", "--tab-id", "7", "--max-text-chars", "512"],
    ]);
  });

  it("resizes only within the CLI-supported range", async () => {
    const { tools, calls } = setup({
      "session start": START_REPLY("s1"),
      "window resize": { window_id: 2, width: 1280, height: 800 },
    });
    await startSession(tools);
    const resize = tools.get("browser_window_resize");
    const value = (await resize?.execute({ width: 1280, height: 800 }, makeExec())) as {
      windowId: number;
    };
    expect(value.windowId).toBe(2);
    expect(calls[1].args).toEqual([
      "window",
      "resize",
      "--session",
      "s1",
      "--width",
      "1280",
      "--height",
      "800",
    ]);
    await expect(resize?.execute({ width: 99, height: 800 }, makeExec())).rejects.toThrow(
      /100\.\.=7680/,
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
      killFor: () => 0,
    };
    registerTools({
      ctx: ctx as never,
      runner,
      registry,
      config: CONFIG,
      observation: disabledObservation({ ctx, runner, registry }),
      queue: new KeyedExecutor(),
    });
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

describe("screenshot scratch file lifecycle", () => {
  /** Runner that honors --out like the real bsk (writes the PNG there). */
  function outWritingRunner() {
    const calls: FakeCall[] = [];
    return {
      calls,
      runner: {
        async run(args: string[], options: BskRunOptions = {}): Promise<BskRunResult> {
          calls.push({ args, options });
          if (args[0] === "session") {
            return {
              code: 0,
              stdout: JSON.stringify({ session_id: "s1", browser_instance_id: "chrome-1" }),
              stderr: "",
              timedOut: false,
              aborted: false,
            };
          }
          if (args[0] === "screenshot") {
            const out = args[args.indexOf("--out") + 1];
            writeFileSync(out, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            return {
              code: 0,
              stdout: JSON.stringify({
                tab_id: 7,
                width: 4,
                height: 4,
                format: "png",
                path: out,
                byte_size: 4,
              }),
              stderr: "",
              timedOut: false,
              aborted: false,
            };
          }
          return { code: 2, stdout: "{}", stderr: "", timedOut: false, aborted: false };
        },
        killAll() {},
        killFor: () => 0,
      } as BskRunner,
    };
  }

  function setupWithRunner(runner: BskRunner, services: Record<string, unknown> = {}) {
    const { ctx, tools } = makeCtx(services);
    const registry = new SessionRegistry(5);
    registerTools({
      ctx: ctx as never,
      runner,
      registry,
      config: CONFIG,
      observation: disabledObservation({ ctx, runner, registry }),
      queue: new KeyedExecutor(),
    });
    return { tools, registry };
  }

  const IMAGE_SERVICES = {
    attachments: {
      imageLimits: { mediaTypes: ["image/png"], maxImageBytes: 1e7, maxMessageImageBytes: 1e7 },
      saveImage: async (input: { data: Uint8Array; mediaType: string }) => ({
        attachmentId: "att-1",
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 4,
        height: 4,
      }),
    },
    llm: { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) },
  };

  it("deletes the scratch PNG once the bytes are in the attachment store", async () => {
    const { runner, calls } = outWritingRunner();
    const { tools } = setupWithRunner(runner, IMAGE_SERVICES);
    await startSession(tools);
    const exec = makeExec({
      agent: {
        session: { requestHeader: () => ({ config: { provider: "p", model: "vl" } }) },
        options: {},
      },
    });
    const screenshot = tools.get("browser_screenshot");
    const value = (await screenshot?.execute({}, exec)) as { image?: unknown; path: string };
    expect(value.image).toBeDefined();
    const out = calls.find((c) => c.args[0] === "screenshot")?.args.at(-1);
    expect(out).toBeDefined();
    expect(existsSync(out ?? "")).toBe(false);
  });

  it("keeps the PNG only when it is the model-facing artifact (no store)", async () => {
    const { runner, calls } = outWritingRunner();
    const { tools } = setupWithRunner(runner);
    await startSession(tools);
    const screenshot = tools.get("browser_screenshot");
    const value = (await screenshot?.execute({}, makeExec())) as { image?: unknown; path: string };
    expect(value.image).toBeUndefined();
    const out = calls.find((c) => c.args[0] === "screenshot")?.args.at(-1);
    expect(existsSync(out ?? "")).toBe(true);
  });
});

describe("observation action instrumentation timing", () => {
  it("a queued call never overwrites the in-flight action label", async () => {
    const { ctx, tools } = makeCtx();
    const registry = new SessionRegistry(5);
    let releaseNavigate!: () => void;
    const navigateGate = new Promise<void>((resolve) => {
      releaseNavigate = resolve;
    });
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const runner: BskRunner = {
      async run(args: string[]): Promise<BskRunResult> {
        if (args[0] === "session") {
          return {
            code: 0,
            stdout: JSON.stringify({ session_id: "s1", browser_instance_id: "chrome-1" }),
            stderr: "",
            timedOut: false,
            aborted: false,
          };
        }
        if (args[0] === "navigate") {
          await navigateGate;
          return {
            code: 0,
            stdout: JSON.stringify({ tab_id: 7, url: "http://x" }),
            stderr: "",
            timedOut: false,
            aborted: false,
          };
        }
        if (args[0] === "snapshot") {
          await snapshotGate;
          return {
            code: 0,
            stdout: JSON.stringify({ text: "ok", ref_count: 0, tab_id: 7, truncated: false }),
            stderr: "",
            timedOut: false,
            aborted: false,
          };
        }
        // Observation captures share the session queue; fail them fast so they
        // cannot stall the action-label assertions.
        if (args[0] === "screenshot") {
          return { code: 1, stdout: "", stderr: "skip", timedOut: false, aborted: false };
        }
        return {
          code: 0,
          stdout: JSON.stringify({ text: "ok", ref_count: 0, tab_id: 7, truncated: false }),
          stderr: "",
          timedOut: false,
          aborted: false,
        };
      },
      killAll() {},
      killFor: () => 0,
    };
    const queue = new KeyedExecutor();
    const observation = new ObservationService({
      ctx: ctx as never,
      runner,
      registry,
      queue,
      options: { enabled: true, thumbnailIntervalMs: 1500, idleIntervalMs: 8000 },
    });
    registerTools({ ctx: ctx as never, runner, registry, config: CONFIG, observation, queue });

    await startSession(tools);
    const navigate = tools.get("browser_navigate");
    const snapshot = tools.get("browser_snapshot");
    const a = navigate?.execute({ url: "http://x" }, makeExec()) as Promise<unknown>;
    // A starts immediately (empty queue) and blocks on the gate.
    await vi.waitFor(() =>
      expect(observation.getState().find((s) => s.sessionId === "s1")?.action).toBe("navigating"),
    );
    // B queues behind A: the label must stay "navigating" until A settles.
    const b = snapshot?.execute({}, makeExec()) as Promise<unknown>;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(observation.getState().find((s) => s.sessionId === "s1")?.action).toBe("navigating");
    releaseNavigate();
    await a;
    await vi.waitFor(() =>
      expect(observation.getState().find((s) => s.sessionId === "s1")?.action).toBe("snapshotting"),
    );
    releaseSnapshot();
    await b;
    await vi.waitFor(() =>
      expect(observation.getState().find((s) => s.sessionId === "s1")?.action).toBe("idle"),
    );
    observation.dispose();
  });
});
