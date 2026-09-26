import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { ClickResult } from "@/transport/types";
import { handleDownload } from "../download";
import { captureBrowserDownload, type DownloadsApi } from "../download-capture";
import type { CdpRunner } from "../shared";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function event<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener: vi.fn((listener: T) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: T) => {
      listeners.delete(listener);
    }),
    emit: (...args: Parameters<T>) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

function fixture() {
  const onCreated = event<(item: chrome.downloads.DownloadItem) => void>();
  const onChanged = event<(delta: chrome.downloads.DownloadDelta) => void>();
  const onDeterminingFilename =
    event<
      (
        item: chrome.downloads.DownloadItem,
        suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
      ) => void | true
    >();
  const downloads: DownloadsApi = {
    onCreated,
    onChanged,
    onDeterminingFilename,
    search: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
  };
  let listener!: Parameters<NonNullable<CdpRunner["onEvent"]>>[0];
  const dispose = vi.fn();
  const cdp: CdpRunner = {
    send: vi.fn(async () => ({})) as CdpRunner["send"],
    onEvent: (callback) => {
      listener = callback;
      return { dispose };
    },
  };
  const item = {
    id: 9,
    url: "https://example.test/report",
    finalUrl: "https://example.test/report",
    filename: "report.csv",
    state: "in_progress",
    fileSize: -1,
    totalBytes: 4,
  } as chrome.downloads.DownloadItem;
  const offer = () => {
    listener({ tabId: 7 }, "Page.downloadWillBegin", {
      url: item.url,
      suggestedFilename: item.filename,
    });
    onDeterminingFilename.emit(item, vi.fn());
  };
  return { downloads, cdp, dispose, item, offer, onCreated, onChanged, onDeterminingFilename };
}

afterEach(() => vi.useRealTimers());

describe("download deadlines", () => {
  it.each([
    "timeout",
    "abort",
  ])("settles a pending trigger on %s and ignores its late rejection", async (boundary) => {
    vi.useFakeTimers();
    const f = fixture();
    const trigger = deferred<ClickResult>();
    const abort = new AbortController();
    let signal!: AbortSignal;
    let settled = false;
    const pending = captureBrowserDownload({
      ...f,
      target: { tabId: 7 },
      browserRelativeDir: "BrowserSkill/deadline",
      timeoutMs: 100,
      signal: abort.signal,
      trigger: async (mark, operationSignal) => {
        signal = operationSignal;
        mark();
        return trigger.promise;
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    if (boundary === "abort") abort.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.onChanged.removeListener).toHaveBeenCalledOnce();
    expect(await pending).toMatchObject({ data: { effect_state: "unknown" } });
    trigger.reject(new Error("late debugger failure"));
    await vi.advanceTimersByTimeAsync(0);
    // A callback already queued before dispose must not arm another download.
    f.offer();
    expect(f.downloads.cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not invoke a trigger for an already cancelled request", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const trigger = vi.fn();
    const result = await captureBrowserDownload({
      ...f,
      target: { tabId: 7 },
      browserRelativeDir: "BrowserSkill/deadline",
      timeoutMs: 100,
      signal: controller.signal,
      trigger,
    });
    expect(trigger).not.toHaveBeenCalled();
    expect(result).toMatchObject({ data: { effect_state: "none" } });
  });

  it.each([
    "search",
    "cancel",
    "removeFile",
  ] as const)("bounds a stalled %s during claimed-download cleanup", async (method) => {
    vi.useFakeTimers();
    const f = fixture();
    const item = {
      ...f.item,
      state: method === "removeFile" ? "complete" : "in_progress",
    } as chrome.downloads.DownloadItem;
    vi.mocked(f.downloads.search).mockResolvedValue([item]);
    const stalled = deferred<never>();
    vi.mocked(f.downloads[method]).mockImplementation(() => stalled.promise);
    let settled = false;
    const pending = captureBrowserDownload({
      ...f,
      target: { tabId: 7 },
      browserRelativeDir: "BrowserSkill/deadline",
      timeoutMs: 100,
      trigger: async (mark) => {
        mark();
        f.offer();
        return { tab_id: 7, x: 10, y: 10 };
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({
      data: { effect_state: "committed", cleanup_state: "failed" },
    });
    stalled.reject(new Error("late cleanup failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still bounds the trigger after the file has already completed", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const stalled = deferred<ClickResult>();
    const completed = {
      ...f.item,
      state: "complete",
      fileSize: 4,
    } as chrome.downloads.DownloadItem;
    vi.mocked(f.downloads.search).mockResolvedValue([completed]);
    let settled = false;
    const pending = captureBrowserDownload({
      ...f,
      target: { tabId: 7 },
      browserRelativeDir: "BrowserSkill/deadline",
      timeoutMs: 100,
      trigger: async (mark) => {
        mark();
        f.offer();
        f.onCreated.emit(completed);
        return stalled.promise;
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ data: { effect_state: "committed" } });
    expect(f.downloads.removeFile).toHaveBeenCalledWith(9);
    stalled.resolve({ tab_id: 7, x: 10, y: 10 });
  });

  it("bounds trigger cleanup itself", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let settled = false;
    const pending = captureBrowserDownload({
      ...f,
      target: { tabId: 7 },
      browserRelativeDir: "BrowserSkill/deadline",
      timeoutMs: 100,
      trigger: async () => ({ code: "cancelled", message: "cancelled" }),
      cleanupTrigger: async () => new Promise(() => {}),
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ data: { cleanup_state: "failed" } });
  });

  it.each([
    ["timeout", "mouseMoved"],
    ["abort", "mouseMoved"],
    ["timeout", "mousePressed"],
    ["abort", "mousePressed"],
  ])("releases the global gate after %s at %s without resuming late input", async (boundary, heldType) => {
    vi.useFakeTimers();
    const f = fixture();
    const sessions = new SessionManager({
      agentWindow: {
        create: async () => ({ windowId: 100, initialTabIds: [7] }),
        remove: async () => {},
        ensureActiveTab: async () => 7,
      },
    });
    const first = await sessions.start("first");
    const second = await sessions.start("second");
    first.refStore.set("e1", 123, { tabId: 7 });
    const input = deferred<object>();
    const inputs: string[] = [];
    f.cdp.send = (async (_tabId, method, params) => {
      if (method === "Runtime.evaluate") return { result: { value: "absent" } };
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === "DOM.getContentQuads") return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
      if (method === "Input.dispatchMouseEvent") {
        const type = (params as { type: string }).type;
        inputs.push(type);
        if (type === heldType) return input.promise;
      }
      return {};
    }) as CdpRunner["send"];
    const tab = { id: 7, windowId: 100, active: true } as chrome.tabs.Tab;
    const tabsApi = { get: async () => tab, query: async () => [tab] };
    const abort = new AbortController();
    let settled = false;
    const pending = handleDownload(
      sessions,
      {
        session_id: first.sessionId,
        ref: "e1",
        browser_relative_dir: "BrowserSkill/first",
        timeout_ms: 100,
      },
      {
        ...f,
        tabsApi,
        signal: abort.signal,
        navigationTargets: { onCreatedNavigationTarget: event() },
      },
    ).then((result) => {
      settled = true;
      return result;
    });
    try {
      for (let n = 0; n < 100 && !inputs.includes(heldType); n++) await Promise.resolve();
      expect(inputs).toContain(heldType);
      if (boundary === "abort") abort.abort();
      await vi.advanceTimersByTimeAsync(1_100);
      expect(settled).toBe(true);
      const next = await handleDownload(
        sessions,
        { session_id: second.sessionId },
        { ...f, tabsApi },
      );
      expect(next).toMatchObject({ message: "download requires a daemon capability directory" });
      const beforeLateReply = [...inputs];
      expect(beforeLateReply).toEqual(
        heldType === "mousePressed"
          ? ["mouseMoved", "mousePressed", "mouseReleased"]
          : ["mouseMoved"],
      );
      input.resolve({});
      await vi.advanceTimersByTimeAsync(0);
      expect(inputs).toEqual(beforeLateReply);
      expect(f.onChanged.removeListener).toHaveBeenCalledOnce();
    } finally {
      input.resolve({});
      await pending;
    }
  });
});
