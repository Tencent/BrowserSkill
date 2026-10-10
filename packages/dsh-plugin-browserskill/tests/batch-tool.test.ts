import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyedExecutor } from "../src/queue";
import type { BskRunOptions, BskRunResult } from "../src/runner";
import { SessionRegistry } from "../src/sessions";
import { createBrowserOperationDefinitions, type ToolDeps } from "../src/tools";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const ok = (value: unknown = { tab_id: 7, ok: true }): BskRunResult => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: "",
  aborted: false,
  timedOut: false,
});
const fail = (code: string, effect = "unknown"): BskRunResult => ({
  ...ok({ code, message: "action stopped", data: { effect_state: effect } }),
  code: 1,
});
function fixture(run = async (_args: string[], _options?: BskRunOptions) => ok()) {
  const registry = new SessionRegistry(5);
  registry.completeStart({ sessionId: "owned", startedAtMs: Date.now() });
  const release = vi.fn();
  const deps = {
    registry,
    queue: new KeyedExecutor(),
    runner: { run: vi.fn(run) },
    observation: {
      acquireForeground: vi.fn(() => release),
      beginAction: vi.fn(),
      endAction: vi.fn(),
    },
    config: { defaultTimeoutMs: 120_000 },
  } as unknown as ToolDeps;
  const definitions = new Map(
    createBrowserOperationDefinitions(deps).map((tool) => [tool.name, tool]),
  );
  const execute = (name: string, args: object, signal = new AbortController().signal) =>
    definitions.get(name)!.execute(args as never, { signal } as ToolRunContext);
  return { deps, release, execute };
}
const plan = {
  session: "owned",
  tabId: 7,
  steps: [
    { action: "fill", target: "@e1", value: "private input" },
    { action: "click", target: "@e2" },
  ],
};

afterEach(() => vi.useRealTimers());

describe("known actions through existing commands", () => {
  it("pins the observed tab and preserves per-action instrumentation", async () => {
    const f = fixture();
    const result = await f.execute("interact.batch", plan);
    expect(result).toMatchObject({
      status: "completed",
      steps: [
        { status: "completed", effect_state: "committed" },
        { status: "completed", effect_state: "committed" },
      ],
    });
    const calls = vi.mocked(f.deps.runner.run).mock.calls;
    expect(calls.map(([args]) => args[0])).toEqual(["fill", "click", "observe"]);
    for (const [args, options] of calls) {
      expect(args).toContain("--tab-id");
      expect(args[args.indexOf("--tab-id") + 1]).toBe("7");
      expect(options?.tag).toBe("owned");
    }
    expect(f.deps.observation.acquireForeground).toHaveBeenCalledTimes(1);
    expect(f.deps.observation.beginAction).toHaveBeenCalledTimes(3);
    expect(f.deps.observation.endAction).toHaveBeenCalledTimes(3);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...plan, steps: [] },
    { ...plan, steps: Array(21).fill(plan.steps[0]) },
    { ...plan, tabId: undefined },
    { ...plan, timeoutMs: 0 },
    { ...plan, steps: [plan.steps[0], { action: "click", target: "#selector" }] },
    { ...plan, steps: [plan.steps[0], { action: "evaluate", target: "@e2" }] },
    { ...plan, steps: [plan.steps[0], { action: "click", target: "@e2", value: "ignored?" }] },
    { ...plan, steps: [plan.steps[0], { action: "select", target: "@e2", values: [] }] },
    { ...plan, steps: [{ ...plan.steps[0], value: "x".repeat(65_536) }] },
  ])("rejects the whole invalid plan before starting commands", async (input) => {
    const f = fixture();
    await expect(f.execute("interact.batch", input)).rejects.toThrow();
    expect(f.deps.runner.run).not.toHaveBeenCalled();
  });

  it("preserves partial results, never replays and allows single-action recovery", async () => {
    let attempts = 0;
    const f = fixture(async (args) =>
      args[0] === "click" && attempts++ === 0 ? fail("not_found", "none") : ok(),
    );
    const result = await f.execute("interact.batch", {
      ...plan,
      steps: [...plan.steps, plan.steps[0]],
    });
    expect(result).toMatchObject({
      status: "stopped",
      steps: [
        { status: "completed", effect_state: "committed" },
        { status: "failed", effect_state: "none" },
        { status: "not_run", effect_state: "none" },
      ],
    });
    expect(JSON.stringify(result)).toContain("single actions");
    expect(vi.mocked(f.deps.runner.run).mock.calls.map(([args]) => args[0])).toEqual([
      "fill",
      "click",
    ]);
    await f.execute("inspect.observe", { session: "owned", tabId: 7 });
    await f.execute("interact.click", { session: "owned", tabId: 7, target: "@e2" });
    expect(attempts).toBe(2);
  });

  it("does not start another step or observation after cancellation", async () => {
    const controller = new AbortController();
    const f = fixture(async () => {
      controller.abort();
      return { ...ok(), code: null, aborted: true };
    });
    const result = await f.execute("interact.batch", plan, controller.signal);
    expect(result).toMatchObject({
      status: "stopped",
      steps: [{ status: "failed", effect_state: "unknown" }, { status: "not_run" }],
    });
    expect(f.deps.runner.run).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("leaves transport loss and UI interruption uncertain without retrying", async () => {
    const f = fixture(async () => ({ ...ok(), code: null }));
    const result = await f.execute("interact.batch", plan);
    expect(result).toMatchObject({
      status: "stopped",
      steps: [{ effect_state: "unknown" }, { status: "not_run" }],
    });
    expect(f.deps.runner.run).toHaveBeenCalledTimes(1);
  });

  it("holds the same queue across steps and releases it after failure", async () => {
    const first = deferred();
    const began = deferred();
    const f = fixture(async (args) => {
      if (args[0] === "fill") {
        began.resolve();
        await first.promise;
        return fail("not_found");
      }
      return ok({ text: "fresh refs", ref_count: 2, tab_id: 7 });
    });
    const batch = f.execute("interact.batch", plan);
    await began.promise;
    const observe = f.execute("inspect.observe", { session: "owned" });
    await Promise.resolve();
    expect(f.deps.runner.run).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.all([batch, observe]);
    expect(vi.mocked(f.deps.runner.run).mock.calls.map(([args]) => args[0])).toEqual([
      "fill",
      "observe",
    ]);
  });

  it("uses one total budget across commands and waits for cancellation settlement", async () => {
    vi.useFakeTimers();
    const f = fixture(
      async (_args, options) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(ok()), 7);
          options?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              setTimeout(() => resolve({ ...ok(), code: null, aborted: true }), 2);
            },
            { once: true },
          );
        }),
    );
    const promise = f.execute("interact.batch", { ...plan, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(f.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(await promise).toMatchObject({
      status: "stopped",
      steps: [{ status: "completed" }, { status: "failed" }],
    });
    expect(f.deps.runner.run).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("maps optional parameters to existing CLI syntax without a plan file", async () => {
    const f = fixture();
    await f.execute("interact.batch", {
      ...plan,
      steps: [
        { action: "fill", target: "@e1", value: "", noClear: true },
        { action: "select", target: "@e2", values: ["one", "two"] },
        { action: "press", target: "@e1", key: "Enter", modifiers: ["shift"], holdMs: 4 },
        { action: "click", target: "@e2", button: "right", clickCount: 2 },
      ],
    });
    const args = vi.mocked(f.deps.runner.run).mock.calls.map(([args]) => args);
    expect(args[0].slice(0, 5)).toEqual(["fill", "@e1", "--value", "", "--no-clear"]);
    expect(args[1].slice(0, 6)).toEqual(["select", "@e2", "--value", "one", "--value", "two"]);
    expect(args[2].slice(0, 8)).toEqual([
      "press",
      "Enter",
      "--ref",
      "@e1",
      "--hold-ms",
      "4",
      "--modifiers",
      "shift",
    ]);
    expect(args[3].slice(0, 6)).toEqual([
      "click",
      "@e2",
      "--button",
      "right",
      "--click-count",
      "2",
    ]);
  });
});
