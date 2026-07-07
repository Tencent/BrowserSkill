import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "../chromium-cdp";

function fakeChromeEvent<TArgs extends unknown[]>() {
  const listeners = new Set<(...args: TArgs) => void>();
  return {
    listeners,
    addListener: vi.fn((cb: (...args: TArgs) => void) => listeners.add(cb)),
    removeListener: vi.fn((cb: (...args: TArgs) => void) => listeners.delete(cb)),
    fire: (...args: TArgs) => {
      for (const cb of listeners) cb(...args);
    },
  };
}

function fakeApi() {
  const onEvent = fakeChromeEvent<[chrome.debugger.Debuggee, string, unknown]>();
  const onDetach = fakeChromeEvent<[chrome.debugger.Debuggee, string]>();
  const api: CdpDebuggerApi = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async () => ({ ok: true })),
    // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
    onEvent: onEvent as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
    onDetach: onDetach as any,
  };
  return { api, onEvent, onDetach };
}

describe("ChromiumCdp", () => {
  it("coalesces concurrent attach calls for the same tab", async () => {
    const { api } = fakeApi();
    let releaseAttach!: () => void;
    const attachGate = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    (api.attach as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => attachGate);
    const cdp = new ChromiumCdp(api);

    const first = cdp.ensureAttached(7);
    const second = cdp.ensureAttached(7);
    await Promise.resolve();
    expect(api.attach).toHaveBeenCalledTimes(1);

    releaseAttach();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(cdp.isAttached(7)).toBe(true);
  });

  it("attaches lazily on first send if not attached yet", async () => {
    const { api } = fakeApi();
    const cdp = new ChromiumCdp(api);
    const out = await cdp.send<{ ok: boolean }>(9, "DOM.getDocument");
    expect(out).toEqual({ ok: true });
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "DOM.getDocument", {});
  });

  it("propagates attach failures as thrown Error", async () => {
    const { api } = fakeApi();
    (api.attach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Another debugger is already attached"),
    );
    const cdp = new ChromiumCdp(api);
    await expect(cdp.ensureAttached(5)).rejects.toThrow(/already attached/);
    expect(cdp.isAttached(5)).toBe(false);
  });

  it("send() rejects on chrome.runtime.lastError-style failures", async () => {
    const { api } = fakeApi();
    (api.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(
      async (_target, method: string) => {
        if (method === "DOM.getDocument") {
          throw "frame got detached";
        }
        return { ok: true };
      },
    );
    const cdp = new ChromiumCdp(api);
    await expect(cdp.send(1, "DOM.getDocument")).rejects.toThrow("frame got detached");
  });

  it("auto-clears the attached cache on detach event", async () => {
    const { api, onDetach } = fakeApi();
    const cdp = new ChromiumCdp(api);
    await cdp.ensureAttached(11);
    expect(cdp.isAttached(11)).toBe(true);
    onDetach.fire({ tabId: 11 }, "target_closed");
    expect(cdp.isAttached(11)).toBe(false);
  });

  it("detach() is idempotent and never throws", async () => {
    const { api } = fakeApi();
    const cdp = new ChromiumCdp(api);
    await cdp.detach(99); // not attached
    expect(api.detach).not.toHaveBeenCalled();
    await cdp.ensureAttached(7);
    (api.detach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("tab closed"));
    await expect(cdp.detach(7)).resolves.toBeUndefined();
    expect(cdp.isAttached(7)).toBe(false);
  });

  it("detachAll() iterates every cached tab", async () => {
    const { api } = fakeApi();
    const cdp = new ChromiumCdp(api);
    await cdp.ensureAttached(1);
    await cdp.ensureAttached(2);
    await cdp.detachAll();
    expect(api.detach).toHaveBeenCalledTimes(2);
    expect(cdp.isAttached(1)).toBe(false);
    expect(cdp.isAttached(2)).toBe(false);
  });

  it("attach enables Page domain on first send", async () => {
    const { api } = fakeApi();
    const cdp = new ChromiumCdp(api);
    await cdp.send(9, "DOM.getDocument");
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "Page.enable", {});
  });

  it("enables console capture domains best-effort during attach", async () => {
    const { api } = fakeApi();
    (api.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(
      async (_target, method: string) => {
        if (method === "Log.enable") throw new Error("restricted");
        return {};
      },
    );
    const cdp = new ChromiumCdp(api);
    await expect(cdp.ensureAttached(12)).resolves.toBeUndefined();
    expect(cdp.isAttached(12)).toBe(true);
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 12 }, "Runtime.enable", {});
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 12 }, "Log.enable", {});
    await cdp.ensureConsoleCapture(12);
    const enableCalls = (api.sendCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, method]) => method === "Runtime.enable" || method === "Log.enable",
    );
    expect(enableCalls).toHaveLength(2);
  });

  it("records javascriptDialogOpening and auto-accepts", async () => {
    const { api, onEvent } = fakeApi();
    const cdp = new ChromiumCdp(api);
    await cdp.ensureAttached(3);
    const cursor = cdp.dialogCursor(3);
    onEvent.fire({ tabId: 3 }, "Page.javascriptDialogOpening", {
      type: "alert",
      message: "hello",
      url: "https://example.com/",
      hasBrowserHandler: false,
    });
    await Promise.resolve();
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 3 }, "Page.handleJavaScriptDialog", {
      accept: true,
    });
    const dialogs = cdp.dialogsSince(3, cursor);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toMatchObject({
      tab_id: 3,
      type: "alert",
      message: "hello",
      handled: "accepted",
      sequence: 1,
    });
  });

  it("unblocks a pending send after dialog is handled", async () => {
    const { api, onEvent } = fakeApi();
    let releaseEvaluate!: () => void;
    const evaluateGate = new Promise<void>((resolve) => {
      releaseEvaluate = resolve;
    });
    (api.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(
      async (_target, method: string) => {
        if (method === "Runtime.evaluate") {
          await evaluateGate;
          return { result: { value: 2 } };
        }
        return {};
      },
    );
    const cdp = new ChromiumCdp(api);
    await cdp.ensureAttached(5);
    const pending = cdp.send(5, "Runtime.evaluate", { expression: "1+1" });
    await Promise.resolve();
    onEvent.fire({ tabId: 5 }, "Page.javascriptDialogOpening", {
      type: "alert",
      message: "blocked",
      url: "https://example.com/",
    });
    releaseEvaluate();
    await expect(pending).resolves.toEqual({ result: { value: 2 } });
  });

  it("clears dialog state on detach", async () => {
    const { api, onEvent } = fakeApi();
    const cdp = new ChromiumCdp(api);
    await cdp.ensureAttached(11);
    onEvent.fire({ tabId: 11 }, "Page.javascriptDialogOpening", {
      type: "alert",
      message: "x",
      url: "https://example.com/",
    });
    await Promise.resolve();
    expect(cdp.dialogsSince(11, 0)).toHaveLength(1);
    await cdp.detach(11);
    expect(cdp.dialogsSince(11, 0)).toHaveLength(0);
  });

  it("records Runtime console calls with bounded text and optional stack frames", async () => {
    const { api, onEvent } = fakeApi();
    const cdp = new ChromiumCdp(api);
    await cdp.ensureAttached(21);
    onEvent.fire({ tabId: 21 }, "Runtime.consoleAPICalled", {
      type: "warn",
      args: [{ value: "abcdefghi" }, { description: "Object { ok: true }" }],
      timestamp: 1234.5,
      stackTrace: {
        callFrames: [
          {
            functionName: "render",
            url: "https://example.test/app.js",
            lineNumber: 4,
            columnNumber: 8,
          },
        ],
      },
    });

    const withoutStack = cdp.consoleEntriesSince(21, 0, 50, 5, false);
    expect(withoutStack).toMatchObject({
      next_since: 1,
      truncated: true,
      entries: [
        {
          sequence: 1,
          kind: "console",
          level: "warn",
          text: "abcde",
          url: "https://example.test/app.js",
          line: 5,
          column: 9,
          truncated: true,
        },
      ],
    });
    expect(withoutStack.entries[0].stack_trace).toBeUndefined();

    const withStack = cdp.consoleEntriesSince(21, 0, 50, 1000, true);
    expect(withStack.entries[0].stack_trace).toEqual([
      {
        function_name: "render",
        url: "https://example.test/app.js",
        line: 5,
        column: 9,
      },
    ]);
  });

  it("records exceptions and engine log entries", async () => {
    const { api, onEvent } = fakeApi();
    const cdp = new ChromiumCdp(api);
    await cdp.ensureAttached(22);
    onEvent.fire({ tabId: 22 }, "Runtime.exceptionThrown", {
      timestamp: 2000,
      exceptionDetails: {
        text: "Uncaught",
        url: "https://example.test/app.js",
        lineNumber: 40,
        columnNumber: 6,
        exception: { description: "TypeError: boom\n    at render (app.js:41:7)" },
      },
    });
    onEvent.fire({ tabId: 22 }, "Log.entryAdded", {
      entry: {
        level: "error",
        text: "Failed to load resource: 404",
        url: "https://example.test/missing.png",
        lineNumber: 0,
        timestamp: 2100,
      },
    });

    const result = cdp.consoleEntriesSince(22, 0, 50, 1000, false);
    expect(result.next_since).toBe(2);
    expect(result.entries).toMatchObject([
      {
        sequence: 1,
        kind: "exception",
        level: "error",
        text: "TypeError: boom",
        url: "https://example.test/app.js",
        line: 41,
        column: 7,
      },
      {
        sequence: 2,
        kind: "log",
        level: "error",
        text: "Failed to load resource: 404",
        url: "https://example.test/missing.png",
      },
    ]);
  });

  it("filters console entries by cursor and caps result size", async () => {
    const { api, onEvent } = fakeApi();
    const cdp = new ChromiumCdp(api);
    await cdp.ensureAttached(23);
    for (let i = 1; i <= 3; i += 1) {
      onEvent.fire({ tabId: 23 }, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ value: `message ${i}` }],
      });
    }

    const result = cdp.consoleEntriesSince(23, 1, 1, 1000, false);
    expect(result).toMatchObject({
      next_since: 2,
      truncated: true,
      entries: [{ sequence: 2, text: "message 2" }],
    });
  });

  it("clears console state on detach", async () => {
    const { api, onEvent } = fakeApi();
    const cdp = new ChromiumCdp(api);
    await cdp.ensureAttached(24);
    onEvent.fire({ tabId: 24 }, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "x" }],
    });
    expect(cdp.consoleEntriesSince(24, 0, 50, 1000, false).entries).toHaveLength(1);
    await cdp.detach(24);
    expect(cdp.consoleEntriesSince(24, 0, 50, 1000, false).entries).toHaveLength(0);
  });

  it("detachSession only detaches tabs no other session owns", async () => {
    const { api } = fakeApi();
    const cdp = new ChromiumCdp(api);
    await cdp.ensureAttached(1);
    await cdp.ensureAttached(2);
    cdp.trackSessionTab("aa11", 1);
    cdp.trackSessionTab("bb22", 1);
    cdp.trackSessionTab("aa11", 2);

    await cdp.detachSession("aa11");
    expect(api.detach).toHaveBeenCalledTimes(1);
    expect(api.detach).toHaveBeenCalledWith({ tabId: 2 });
    expect(cdp.isAttached(1)).toBe(true);
    expect(cdp.isAttached(2)).toBe(false);

    await cdp.detachSession("bb22");
    expect(api.detach).toHaveBeenCalledTimes(2);
    expect(api.detach).toHaveBeenLastCalledWith({ tabId: 1 });
    expect(cdp.isAttached(1)).toBe(false);
  });
});
