import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { RequestFrame, RpcError } from "@/transport/types";
import {
  type BatchDeps,
  type BatchParams,
  type BatchResult,
  handleBatch,
  handleBatchStatus,
} from "../batch";

async function fixture() {
  const manager = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  const ctx = await manager.start("s1");
  const entries = [1, 2, 3, 4].map((id) => [`e${id}`, { backendNodeId: id, tabId: 7 }] as const);
  ctx.refStore.replace(entries);
  const tab = {
    id: 7,
    windowId: 100,
    active: true,
    url: "https://example.test/form",
  } as chrome.tabs.Tab;
  const removed = new Set<number>();
  const effects: string[] = [];
  const invoke = vi.fn(async (request: RequestFrame): Promise<unknown> => {
    if (request.method === "tool.observe") {
      ctx.refStore.replace(entries);
      return {
        text: "current form",
        ref_count: 4,
        tab_id: 7,
        truncated: false,
        observation_id: ctx.refStore.observationId,
      };
    }
    effects.push(request.method);
    return { tab_id: 7 };
  });
  const deps: BatchDeps = {
    cdp: {
      send: vi.fn(async (_tab: number, method: string, params?: object) => {
        const value = params as { backendNodeId?: number; objectId?: string };
        if (method === "DOM.resolveNode")
          return { object: { objectId: String(value.backendNodeId) } };
        if (method === "Runtime.callFunctionOn")
          return { result: { value: !removed.has(Number(value.objectId)) } };
        return {};
      }) as BatchDeps["cdp"]["send"],
    },
    tabsApi: { get: async () => ({ ...tab }), query: async () => [{ ...tab }] },
    invoke,
  };
  const params: BatchParams = {
    session_id: "s1",
    request_id: "r1",
    observation_id: ctx.refStore.observationId,
    steps: [
      { action: "fill", target: "@e1", value: "company" },
      { action: "fill", target: "@e2", value: "contact" },
      { action: "select", target: "@e3", values: ["software"] },
      { action: "click", target: "@e4" },
    ],
  };
  const abort = new AbortController();
  const run = (plan = params) =>
    handleBatch(manager, plan, deps, abort.signal) as Promise<BatchResult>;
  return { manager, ctx, entries, deps, invoke, params, tab, removed, effects, abort, run };
}

afterEach(() => vi.useRealTimers());

describe("known action batches", () => {
  it("runs in order and observes once; duplicate delivery never repeats a submission", async () => {
    const f = await fixture();
    const result = await f.run();
    expect(f.effects).toEqual(["tool.fill", "tool.fill", "tool.select", "tool.click"]);
    expect(result.status).toBe("completed");
    expect(result.observation?.observation_id).not.toBe(f.params.observation_id);
    expect(f.invoke.mock.calls.filter(([req]) => req.method === "tool.observe")).toHaveLength(1);
    expect(await f.run()).toEqual(result);
    expect(f.effects).toHaveLength(4);
    expect(handleBatchStatus(f.manager, { session_id: "s1", request_id: "r1" })).toEqual(result);
  });

  it.each([
    { action: "fill", target: "@e2" },
    { action: "click", target: "@e2", tab_id: 8 },
    { action: "press", target: "@e2", key: "NotAKey" },
    { action: "evaluate", target: "@e2", expression: "submit()" },
    { action: "click", target: "#unobserved" },
  ])("rejects a malformed later step before the first action: %j", async (step) => {
    const f = await fixture();
    f.params.steps[2] = step as BatchParams["steps"][number];
    expect(await f.run()).toMatchObject({ code: "invalid_params", data: { effect_state: "none" } });
    expect(f.effects).toHaveLength(0);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("rejects stale observations and cross-tab refs before input", async () => {
    for (const change of ["observation", "tab"]) {
      const f = await fixture();
      if (change === "observation") f.ctx.refStore.replace(f.entries);
      else f.ctx.refStore.set("e3", 3, { tabId: 99 });
      const result = await f.run();
      expect(result.status).toBe("stopped");
      expect(result.steps.every((step) => step.status === "not_run")).toBe(true);
      expect(f.effects).toHaveLength(0);
    }
  });

  it("preserves completed steps when a later target disappears, then allows single-action recovery", async () => {
    const f = await fixture();
    f.invoke.mockImplementation(async (request) => {
      if (request.method === "tool.observe")
        return { text: "replacement field", tab_id: 7, ref_count: 1 };
      f.effects.push(request.method);
      if (f.effects.length === 2) f.removed.add(3);
      return { tab_id: 7 };
    });
    const result = await f.run();
    expect(result.steps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "not_run",
      "not_run",
    ]);
    expect(result.status).toBe("stopped");
    expect(result.observation?.text).toBe("replacement field");
    // The executor does not poison the session or claim that previous work rolled back.
    await f.deps.invoke({ id: "single-select", method: "tool.select", params: {} }, f.abort.signal);
    await f.deps.invoke({ id: "single-click", method: "tool.click", params: {} }, f.abort.signal);
    expect(f.effects).toEqual(["tool.fill", "tool.fill", "tool.select", "tool.click"]);
    expect(f.manager.get("s1")).toBe(f.ctx);
  });

  it.each([
    "navigation",
    "tab",
    "refs",
  ])("stops the suffix after an unexpected %s change", async (change) => {
    const f = await fixture();
    f.invoke.mockImplementation(async (request) => {
      if (request.method === "tool.observe") return { text: "changed", tab_id: 7, ref_count: 0 };
      f.effects.push(request.method);
      if (change === "navigation") f.tab.url = "https://example.test/next";
      else if (change === "tab") f.tab.active = false;
      else f.ctx.refStore.replace(f.entries);
      return { tab_id: 7 };
    });
    const result = await f.run();
    expect(result.status).toBe("stopped");
    expect(f.effects).toEqual(["tool.fill"]);
  });

  it("keeps uncertain effects visible and does not retry the failing step", async () => {
    const f = await fixture();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (request) =>
      request.method === "tool.select"
        ? { code: "cdp_failed", message: "connection lost after input" }
        : original(request),
    );
    const result = await f.run();
    expect(result.steps[2]).toMatchObject({ status: "failed", effect_state: "unknown" });
    expect(result.steps[3].status).toBe("not_run");
    expect(f.invoke.mock.calls.filter(([req]) => req.method === "tool.select")).toHaveLength(1);
  });

  it("cancellation stops subsequent input and skips the final read", async () => {
    const f = await fixture();
    f.invoke.mockImplementation(async (request) => {
      f.effects.push(request.method);
      f.abort.abort();
      return { tab_id: 7 };
    });
    const result = await f.run();
    expect(result.error?.code).toBe("cancelled");
    expect(f.effects).toEqual(["tool.fill"]);
    expect(result.steps[0].status).toBe("completed");
    expect(result.steps[1].status).toBe("not_run");
  });

  it("a late action completion never starts another action after the deadline", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.params.timeout_ms = 100;
    f.invoke.mockImplementation(async (request) => {
      f.effects.push(request.method);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { tab_id: 7 };
    });
    const pending = f.run();
    await vi.advanceTimersByTimeAsync(150);
    const result = await pending;
    expect(result.error?.code).toBe("timeout");
    expect(f.effects).toEqual(["tool.fill"]);
    expect(result.steps[0].status).toBe("completed");
  });

  it("a stalled target probe respects the deadline and its late reply sends no input", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.params.timeout_ms = 100;
    let resolveProbe!: (value: unknown) => void;
    const send = vi.fn((_tab: number, method: string) =>
      method === "DOM.resolveNode"
        ? new Promise((resolve) => {
            resolveProbe = resolve;
          })
        : Promise.resolve({}),
    );
    f.deps.cdp.send = send as BatchDeps["cdp"]["send"];
    const pending = f.run();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ status: "stopped", error: { code: "timeout" } });
    resolveProbe({ object: { objectId: "late" } });
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls.some(([, method]) => method === "Runtime.callFunctionOn")).toBe(false);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("does not reinterpret a ref replaced while its attachment probe is in flight", async () => {
    const f = await fixture();
    const send = f.deps.cdp.send;
    f.deps.cdp.send = (async (tab: number, method: string, params?: object) => {
      const reply = await send(tab, method, params);
      if (method === "Runtime.callFunctionOn") f.ctx.refStore.set("e1", 999, { tabId: 7 });
      return reply;
    }) as BatchDeps["cdp"]["send"];
    expect(await f.run()).toMatchObject({ status: "stopped" });
    expect(f.effects).toHaveLength(0);
  });

  it("exposes immutable progress and keeps a duplicate request from executing in parallel", async () => {
    const f = await fixture();
    let settle!: (value: unknown) => void;
    let started!: () => void;
    const inputStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
          started();
        }),
    );
    const pending = f.run();
    await inputStarted;
    const progress = handleBatchStatus(f.manager, {
      session_id: "s1",
      request_id: "r1",
    }) as BatchResult;
    expect(progress.status).toBe("running");
    expect(progress.steps[0]).toMatchObject({ status: "running", effect_state: "unknown" });
    expect(progress.steps.slice(1).every((step) => step.status === "not_run")).toBe(true);
    expect(await f.run()).toMatchObject({ status: "running" });
    expect(f.invoke).toHaveBeenCalledTimes(1);
    settle({ tab_id: 7 });
    expect(await pending).toMatchObject({ status: "completed" });
    expect(progress.steps[0].status).toBe("running");
  });

  it("a failed final observation cannot turn completed actions into retryable work", async () => {
    const f = await fixture();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (request) =>
      request.method === "tool.observe"
        ? { code: "cdp_failed", message: "read failed" }
        : original(request),
    );
    const result = await f.run();
    expect(result.status).toBe("completed");
    expect(result.observation_error?.code).toBe("cdp_failed");
    expect(result.steps.every((step) => step.status === "completed")).toBe(true);
    await f.run();
    expect(f.effects).toHaveLength(4);
  });

  it("does not leak or reuse receipts across sessions or plans", async () => {
    const f = await fixture();
    await f.run();
    const other = await f.manager.start("s2");
    expect(other).toBeDefined();
    expect(handleBatchStatus(f.manager, { session_id: "s2", request_id: "r1" })).toMatchObject({
      code: "not_found",
      data: { effect_state: "unknown" },
    });
    const result = await f.run({ ...f.params, steps: [{ action: "focus", target: "@e1" }] });
    expect(result as unknown as RpcError).toMatchObject({ code: "invalid_params" });
    expect(f.effects).toHaveLength(4);
  });
});
