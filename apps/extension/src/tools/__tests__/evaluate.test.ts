import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { type CdpRunner, createStubCdpRunner } from "@/tools/shared";
import type { Transport } from "@/transport/transport";
import type { ProtocolFrame, ResponseFrame } from "@/transport/types";
import { ToolDispatcher } from "../dispatcher";
import { handleEvaluate } from "../evaluate";

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  return {
    create: vi.fn(async () => {
      const id = ids[i++];
      if (id === undefined) throw new Error("ran out of fake ids");
      return { windowId: id, initialTabIds: [] };
    }),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => 1),
  };
}

interface FakeCdpOptions {
  windowId?: number;
  evaluate?: (params: unknown) => unknown;
  onDialogOpening?: () => void;
  dialogBlocking?: boolean;
}

function makeFakeCdp(opts: FakeCdpOptions = {}) {
  const sent: Array<{ tabId: number; method: string; params?: object }> = [];
  let dialogBlocking = opts.dialogBlocking ?? false;
  const dialogRecords: Array<{
    tab_id: number;
    type: "alert";
    message: string;
    handled: "accepted";
    sequence: number;
  }> = [];
  let sequence = 0;
  const sendImpl = async (tabId: number, method: string, params?: object) => {
    sent.push({ tabId, method, params });
    if (method === "Runtime.evaluate") {
      if (dialogBlocking) {
        opts.onDialogOpening?.();
        dialogBlocking = false;
        sequence += 1;
        dialogRecords.push({
          tab_id: tabId,
          type: "alert",
          message: "blocked",
          handled: "accepted",
          sequence,
        });
        if (opts.evaluate) return opts.evaluate(params);
        return { result: { type: "number", value: 2 } };
      }
      if (opts.evaluate) return opts.evaluate(params);
      return { result: { type: "number", value: 2 } };
    }
    if (method === "Runtime.releaseObject") {
      return {};
    }
    throw new Error(`unexpected CDP call ${method}`);
  };
  const send = vi.fn(sendImpl);
  const cdp: CdpRunner = createStubCdpRunner({
    send: send as unknown as <T = unknown>(
      tabId: number,
      method: string,
      params?: object,
    ) => Promise<T>,
    trackSessionTab: vi.fn(),
    dialogCursor: vi.fn(() => 0),
    dialogsSince: vi.fn((_tabId: number, cursor: number) =>
      dialogRecords.filter((d) => d.sequence > cursor),
    ),
  });
  const windowId = opts.windowId ?? 100;
  const tabsApi = {
    get: vi.fn(async (tabId: number) => ({ id: tabId, windowId, active: true }) as chrome.tabs.Tab),
    query: vi.fn(async () => [{ id: 4, windowId, active: true } as chrome.tabs.Tab]),
  };
  return { cdp, tabsApi, sent };
}

describe("handleEvaluate", () => {
  it("rejects empty expression as invalid_params", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp();
    const res = await handleEvaluate(
      sm,
      { session_id: "aa11", expression: "" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({ code: "invalid_params" });
  });

  it("evaluates 1+1 and returns ok with value 2", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      evaluate: () => ({ result: { type: "number", value: 2 } }),
    });
    const res = await handleEvaluate(
      sm,
      { session_id: "aa11", expression: "1+1" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.ok).toBe(true);
    expect(res.value).toBe(2);
    expect(res.tab_id).toBe(4);
    expect(res.error).toBeUndefined();
  });

  it("forwards await_promise/return_by_value with their defaults filled in", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    let observed: Record<string, unknown> | undefined;
    const fake = makeFakeCdp({
      evaluate: (params) => {
        observed = params as Record<string, unknown>;
        return { result: { type: "string", value: "ok" } };
      },
    });
    await handleEvaluate(
      sm,
      { session_id: "aa11", expression: "Promise.resolve('ok')" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(observed).toMatchObject({
      expression: "Promise.resolve('ok')",
      awaitPromise: true,
      returnByValue: true,
      throwOnSideEffect: false,
    });
  });

  it("respects explicit await_promise=false and return_by_value=false overrides", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    let observed: Record<string, unknown> | undefined;
    const fake = makeFakeCdp({
      evaluate: (params) => {
        observed = params as Record<string, unknown>;
        return { result: { type: "string", value: "kept" } };
      },
    });
    await handleEvaluate(
      sm,
      {
        session_id: "aa11",
        expression: "'kept'",
        await_promise: false,
        return_by_value: false,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(observed).toMatchObject({
      awaitPromise: false,
      returnByValue: false,
    });
  });

  it("returns a JSON-safe RemoteObject descriptor when return_by_value=false", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      evaluate: () => ({
        result: {
          type: "object",
          subtype: "promise",
          className: "Promise",
          objectId: "remote-object-1",
          description: "Promise",
        },
      }),
    });
    const res = await handleEvaluate(
      sm,
      {
        session_id: "aa11",
        expression: "Promise.resolve(1)",
        await_promise: false,
        return_by_value: false,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({
      type: "object",
      subtype: "promise",
      className: "Promise",
      objectId: "remote-object-1",
      description: "Promise",
    });
  });

  it("returns ok=false with error text when the expression throws", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      evaluate: () => ({
        result: { type: "object", subtype: "error" },
        exceptionDetails: {
          text: "Uncaught Error",
          lineNumber: 2,
          columnNumber: 8,
          exception: {
            description: "Error: boom\n    at <anonymous>:1:7",
          },
        },
      }),
    });
    const res = await handleEvaluate(
      sm,
      { session_id: "aa11", expression: 'throw new Error("boom")' },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.ok).toBe(false);
    expect(res.value).toBeUndefined();
    expect(res.error?.text).toContain("boom");
    expect(res.error?.line).toBe(3);
    expect(res.error?.column).toBe(8);
  });

  it.each([
    [{ type: "string", value: "connection token expired" }, "Uncaught connection token expired"],
    [{ type: "boolean", value: false }, "Uncaught false"],
    [{ type: "object", subtype: "null", value: null }, "Uncaught null"],
    [{ type: "number", value: 0, description: "0" }, "0"],
  ])("preserves a thrown primitive %j ahead of the generic header", async (exception, text) => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      evaluate: () => ({
        result: exception,
        exceptionDetails: { text: "Uncaught", lineNumber: 0, columnNumber: 0, exception },
      }),
    });
    const res = await handleEvaluate(
      sm,
      { session_id: "aa11", expression: "throw value" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({ ok: false, error: { text, line: 1, column: 0 } });
  });

  it("stringifies unserializableValue (Infinity / NaN / BigInt)", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      evaluate: () => ({
        result: { type: "number", unserializableValue: "Infinity" },
      }),
    });
    const res = await handleEvaluate(
      sm,
      { session_id: "aa11", expression: "1/0" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.ok).toBe(true);
    expect(res.value).toBe("Infinity");
  });

  it("allows evaluating against a borrowed tab inside the Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 0 });
    const fake = makeFakeCdp();
    fake.tabsApi.get = vi.fn(
      async () => ({ id: 7, windowId: 100, active: true }) as chrome.tabs.Tab,
    );
    const res = await handleEvaluate(
      sm,
      { session_id: "aa11", expression: "1+1", tab_id: 7 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.ok).toBe(true);
  });

  it("returns dialogs observed during evaluate", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({ dialogBlocking: true });
    const res = await handleEvaluate(
      sm,
      { session_id: "aa11", expression: "alert('hi'); 1+1" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.ok).toBe(true);
    expect(res.dialogs).toHaveLength(1);
    expect(res.dialogs?.[0]?.message).toBe("blocked");
    expect(res.dialogs?.[0]?.type).toBe("alert");
  });

  it("rejects tabs outside the Agent Window with permission_denied", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp();
    fake.tabsApi.get = vi.fn(
      async () => ({ id: 11, windowId: 200, active: true }) as chrome.tabs.Tab,
    );
    const res = await handleEvaluate(
      sm,
      { session_id: "aa11", expression: "1+1", tab_id: 11 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({
      code: "permission_denied",
      data: { reason: "agent_window_scope" },
    });
  });

  it("deterministically releases V8 RemoteObjects via Runtime.releaseObject when return_by_value=false", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const abort = new AbortController();
    const fake = makeFakeCdp({
      evaluate: () => {
        abort.abort();
        return {
          result: {
            type: "object",
            className: "HTMLDivElement",
            objectId: "leaked-node-handle-9",
            description: "div#app",
          },
        };
      },
    });
    const res = await handleEvaluate(
      sm,
      {
        session_id: "aa11",
        expression: "document.getElementById('app')",
        return_by_value: false,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );
    expect(res).toMatchObject({
      code: "cancelled",
      data: { effect_state: "unknown" },
    });
    expect(fake.sent).toContainEqual({
      tabId: 4,
      method: "Runtime.releaseObject",
      params: { objectId: "leaked-node-handle-9" },
    });
  });

  it("does not resurrect a detached tab or mask the result when releasing RemoteObjects on exit", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const detachListeners = new Set<(source: chrome.debugger.Debuggee, reason: string) => void>();
    const api: CdpDebuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(
        async (target: Parameters<CdpDebuggerApi["sendCommand"]>[0], method: string) => {
          if (method === "Runtime.evaluate") {
            for (const listener of detachListeners) {
              listener({ tabId: target.tabId }, "target_closed");
            }
            return {
              result: {
                type: "object",
                className: "HTMLDivElement",
                objectId: "detached-node-1",
                description: "div#gone",
              },
            };
          }
          return {};
        },
      ),
      // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() } as any,
      onDetach: {
        addListener: vi.fn((cb) => detachListeners.add(cb)),
        removeListener: vi.fn((cb) => detachListeners.delete(cb)),
        // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
      } as any,
    };
    const realCdp = new ChromiumCdp(api);
    const tabsApi = {
      get: vi.fn(
        async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
      ),
      query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
    };

    const res = await handleEvaluate(
      sm,
      {
        session_id: "aa11",
        expression: "document.getElementById('gone')",
        return_by_value: false,
      },
      { cdp: realCdp, tabsApi },
    );
    expect(res).toMatchObject({
      ok: true,
      tab_id: 4,
      value: {
        type: "object",
        className: "HTMLDivElement",
        objectId: "detached-node-1",
        description: "div#gone",
      },
    });
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(realCdp.getAttachmentId(4)).toBeUndefined();
  });

  it("reports effect_state='none' and skips CDP dispatch when aborted before dispatch", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const abort = new AbortController();
    abort.abort();
    const fake = makeFakeCdp();

    const res = await handleEvaluate(
      sm,
      { session_id: "aa11", expression: "window.mutated = true" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );
    expect(res).toEqual({
      code: "cancelled",
      message: "evaluate cancelled before dispatch",
      data: {
        reason: "cancelled_before_dispatch",
        dispatched: false,
        effect_state: "none",
        phase: "precondition",
      },
    });
    expect(fake.sent).toEqual([]);
  });

  it("unblocks hanging evaluate via ToolDispatcher cancel, releases activeDialogOperations, and silences late CDP rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          windowId: 100,
          active: true,
          url: "https://example.test/",
        })),
        query: vi.fn(async () => [
          { id: 4, windowId: 100, active: true, url: "https://example.test/" },
        ]),
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
    });
    let rejectHanging!: (err: Error) => void;
    let firstEval = true;
    const api: CdpDebuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_target, method) => {
        if (method === "Runtime.evaluate") {
          if (firstEval) {
            firstEval = false;
            return new Promise((_resolve, reject) => {
              rejectHanging = reject;
            });
          }
          return { result: { type: "number", value: 42 } };
        }
        return {};
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() } as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() } as any,
    };
    const realCdp = new ChromiumCdp(api);
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");

    const sent: ProtocolFrame[] = [];
    let onMessage: ((frame: ProtocolFrame) => void) | null = null;
    const transport: Transport = {
      state: "connected",
      connect: async () => {},
      disconnect: async () => {},
      send: (frame) => sent.push(frame),
      onMessage: (cb) => {
        onMessage = cb;
        return { dispose: () => (onMessage = null) };
      },
      onConnectionStateChange: () => ({ dispose: () => {} }),
    };
    const dispatcher = new ToolDispatcher({ transport, sessions: sm, cdp: realCdp });
    dispatcher.start();
    try {
      onMessage!({
        id: "eval-hang",
        operation_id: "op-1",
        method: "tool.evaluate",
        params: { session_id: "aa11", tab_id: 4, expression: "new Promise(() => {})" },
      });
      await vi.waitFor(() => expect(rejectHanging).toBeDefined());

      onMessage!({ id: "cancel-1", method: "cancel", params: { rpc_id: "eval-hang" } });
      await vi.waitFor(() =>
        expect(
          sent.find((f): f is ResponseFrame => "id" in f && f.id === "eval-hang"),
        ).toBeDefined(),
      );
      expect(sent.find((f) => "id" in f && f.id === "eval-hang")).toMatchObject({
        id: "eval-hang",
        error: {
          code: "cancelled",
          data: { effect_state: "unknown", phase: "execution", tab_id: 4 },
        },
      });

      // Next operation_id request on the same session succeeds immediately (no deadlock / no blocked read gate).
      onMessage!({
        id: "eval-next",
        operation_id: "op-2",
        method: "tool.evaluate",
        params: { session_id: "aa11", tab_id: 4, expression: "40 + 2" },
      });
      await vi.waitFor(() =>
        expect(
          sent.find((f): f is ResponseFrame => "id" in f && f.id === "eval-next"),
        ).toBeDefined(),
      );
      expect(sent.find((f) => "id" in f && f.id === "eval-next")).toMatchObject({
        id: "eval-next",
        result: { ok: true, tab_id: 4, value: 42 },
      });

      // Late rejection of the abandoned CDP command (e.g. tab detach) must not trigger unhandledRejection.
      rejectHanging(new Error("Detached while handling command"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      dispatcher.stop();
      realCdp.dispose();
      vi.unstubAllGlobals();
      process.off("unhandledRejection", unhandled);
    }
  });

  it("aborts in-flight ChromiumCdp.send() on signal without unhandled rejection on late detach", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let rejectCmd!: (err: Error) => void;
    const api: CdpDebuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_target, method) => {
        if (method === "Runtime.evaluate") {
          return new Promise((_resolve, reject) => {
            rejectCmd = reject;
          });
        }
        return {};
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() } as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() } as any,
    };
    const realCdp = new ChromiumCdp(api);
    const ac = new AbortController();
    try {
      const pending = realCdp.send(
        4,
        "Runtime.evaluate",
        { expression: "new Promise(() => {})", awaitPromise: true },
        ac.signal,
      );
      await vi.waitFor(() => expect(rejectCmd).toBeDefined());
      ac.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      rejectCmd(new Error("Target closed"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      realCdp.dispose();
      process.off("unhandledRejection", unhandled);
    }
  });

  it("unblocks evaluate cancelled during initial Page.enable attach with effect_state='none' and recovers", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          windowId: 100,
          active: true,
          url: "https://example.test/",
        })),
        query: vi.fn(async () => [
          { id: 4, windowId: 100, active: true, url: "https://example.test/" },
        ]),
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
    });
    let resolvePageEnable!: (v: object) => void;
    let evalCalls = 0;
    const api: CdpDebuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_target, method) => {
        if (method === "Page.enable") {
          return new Promise<object>((resolve) => {
            resolvePageEnable = resolve;
          });
        }
        if (method === "Runtime.evaluate") {
          evalCalls += 1;
          return { result: { type: "number", value: 7 } };
        }
        return {};
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() } as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() } as any,
    };
    const realCdp = new ChromiumCdp(api);
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");

    const sent: ProtocolFrame[] = [];
    let onMessage: ((frame: ProtocolFrame) => void) | null = null;
    const transport: Transport = {
      state: "connected",
      connect: async () => {},
      disconnect: async () => {},
      send: (frame) => sent.push(frame),
      onMessage: (cb) => {
        onMessage = cb;
        return { dispose: () => (onMessage = null) };
      },
      onConnectionStateChange: () => ({ dispose: () => {} }),
    };
    const dispatcher = new ToolDispatcher({ transport, sessions: sm, cdp: realCdp });
    dispatcher.start();
    try {
      onMessage!({
        id: "eval-attach",
        operation_id: "op-attach-1",
        method: "tool.evaluate",
        params: { session_id: "aa11", tab_id: 4, expression: "window.x = 1" },
      });
      await vi.waitFor(() => expect(resolvePageEnable).toBeDefined());

      onMessage!({ id: "cancel-attach", method: "cancel", params: { rpc_id: "eval-attach" } });
      await vi.waitFor(() =>
        expect(
          sent.find((f): f is ResponseFrame => "id" in f && f.id === "eval-attach"),
        ).toBeDefined(),
      );
      expect(sent.find((f) => "id" in f && f.id === "eval-attach")).toMatchObject({
        id: "eval-attach",
        error: {
          code: "cancelled",
          data: {
            reason: "cancelled_before_dispatch",
            dispatched: false,
            effect_state: "none",
            phase: "precondition",
          },
        },
      });
      expect(evalCalls).toBe(0);

      // Once shared attach completes, the next operation_id RPC succeeds immediately.
      resolvePageEnable({});
      onMessage!({
        id: "eval-after-attach",
        operation_id: "op-attach-2",
        method: "tool.evaluate",
        params: { session_id: "aa11", tab_id: 4, expression: "7" },
      });
      await vi.waitFor(() =>
        expect(
          sent.find((f): f is ResponseFrame => "id" in f && f.id === "eval-after-attach"),
        ).toBeDefined(),
      );
      expect(sent.find((f) => "id" in f && f.id === "eval-after-attach")).toMatchObject({
        id: "eval-after-attach",
        result: { ok: true, tab_id: 4, value: 7 },
      });
    } finally {
      dispatcher.stop();
      realCdp.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("bounds hung Runtime.releaseObject cleanup and unblocks aborted getFrameDocuments", async () => {
    vi.useFakeTimers();
    let releaseSent = 0;
    let frameTreeStarted = false;
    const api: CdpDebuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_target, method) => {
        if (method === "Runtime.evaluate") {
          return {
            result: { type: "object", objectId: "hung-obj-1", description: "Object" },
          };
        }
        if (method === "Runtime.releaseObject") {
          releaseSent += 1;
          return new Promise(() => {});
        }
        if (method === "Page.getFrameTree") {
          frameTreeStarted = true;
          return new Promise(() => {});
        }
        return {};
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() } as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() } as any,
    };
    const realCdp = new ChromiumCdp(api);
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabsApi = {
      get: vi.fn(
        async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
      ),
      query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
    };
    try {
      const pendingEval = handleEvaluate(
        sm,
        { session_id: "aa11", tab_id: 4, expression: "({})", return_by_value: false },
        { cdp: realCdp, tabsApi },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pendingEval).toMatchObject({ ok: true, tab_id: 4 });
      expect(releaseSent).toBe(1);

      // Aborting getFrameDocuments during a hanging Page.getFrameTree exits immediately.
      const frameAc = new AbortController();
      const pendingGraph = realCdp.getFrameDocuments(4, frameAc.signal);
      const rejected = expect(pendingGraph).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(25);
      expect(frameTreeStarted).toBe(true);
      frameAc.abort();
      await rejected;
    } finally {
      realCdp.dispose();
      vi.useRealTimers();
    }
  });
});
