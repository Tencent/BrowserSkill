import { afterEach, expect, it, vi } from "vitest";
import { type CdpDebuggee, type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { InputPassthroughMessage } from "@/lib/input-passthrough-bridge";
import { SessionManager } from "@/session-manager/manager";
import { handleDownload } from "../download";
import { fileTransferTriggerDeps } from "../file-transfer-trigger";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function event<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    listeners,
    addListener: (listener: (...args: T) => void) => listeners.add(listener),
    removeListener: (listener: (...args: T) => void) => listeners.delete(listener),
    fire: (...args: T) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

async function fixture() {
  const onEvent = event<[CdpDebuggee, string, unknown]>();
  const onDetach = event<[chrome.debugger.Debuggee, string]>();
  const inputs: string[] = [];
  const api: CdpDebuggerApi = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async (_target, method, params) => {
      if (method === "Runtime.evaluate")
        return {
          result: {
            value:
              (params as { expression?: string })?.expression === "document.visibilityState"
                ? "visible"
                : "absent",
          },
        };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === "DOM.getContentQuads") return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
      if (method === "Input.dispatchMouseEvent") inputs.push((params as { type: string }).type);
      return {};
    }),
    onEvent: onEvent as unknown as CdpDebuggerApi["onEvent"],
    onDetach: onDetach as unknown as CdpDebuggerApi["onDetach"],
  };
  const cdp = new ChromiumCdp(api);
  const sessions = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  const ctx = await sessions.start("download-lifecycle");
  ctx.refStore.set("e1", 123, { tabId: 7 });
  const tab = { id: 7, windowId: 100, active: true } as chrome.tabs.Tab;
  const downloads = {
    onCreated: event<[chrome.downloads.DownloadItem]>(),
    onChanged: event<[chrome.downloads.DownloadDelta]>(),
    onDeterminingFilename:
      event<
        [
          chrome.downloads.DownloadItem,
          (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
        ]
      >(),
    search: async () => [],
    cancel: async () => {},
    removeFile: async () => {},
  };
  return {
    api,
    cdp,
    onDetach,
    inputs,
    sessions,
    params: {
      session_id: ctx.sessionId,
      ref: "e1",
      browser_relative_dir: "BrowserSkill/lifecycle",
      timeout_ms: 10_000,
    },
    deps: {
      cdp,
      downloads,
      tabsApi: { get: async () => tab, query: async () => [tab] },
      navigationTargets: { onCreatedNavigationTarget: event<[]>() },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("does not detach the replacement attachment when an old cleanup release times out", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const abort = new AbortController();
  const scope = fileTransferTriggerDeps(f.deps, abort.signal);
  const release = deferred<object>();
  const releasing = deferred<void>();
  const send = vi.mocked(f.api.sendCommand).getMockImplementation()!;
  vi.spyOn(f.api, "sendCommand").mockImplementation(async (target, method, params) => {
    const reply = await send(target, method, params);
    if (
      method === "Input.dispatchMouseEvent" &&
      (params as { type: string }).type === "mouseReleased"
    ) {
      releasing.resolve();
      return release.promise;
    }
    return reply;
  });
  try {
    await scope.deps.cdp.send(7, "Input.dispatchMouseEvent", { type: "mousePressed" });
    const original = f.cdp.getAttachmentId(7);
    abort.abort();
    const cleanup = scope.cleanup(Date.now() + 1_000);
    const failed = expect(cleanup).rejects.toThrow("timed out");
    await releasing.promise;
    await f.cdp.detach(7);
    await f.cdp.ensureAttached(7);
    const replacement = f.cdp.getAttachmentId(7);
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(original);
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    expect(f.cdp.getAttachmentId(7)).toBe(replacement);
    expect(f.api.detach).toHaveBeenCalledTimes(1);
    release.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(f.cdp.getAttachmentId(7)).toBe(replacement);
    expect(f.inputs).toEqual(["mousePressed", "mouseReleased"]);
  } finally {
    release.resolve({});
    f.cdp.dispose();
  }
});

it.each([
  "mouseMoved",
  "mousePressed",
])("does not dispatch %s after cancellation during reattachment", async (type) => {
  vi.useFakeTimers();
  const f = await fixture();
  const abort = new AbortController();
  const attach = deferred<void>();
  const attaching = deferred<void>();
  let probes = 0;
  const send = vi.mocked(f.api.sendCommand).getMockImplementation()!;
  vi.spyOn(f.api, "sendCommand").mockImplementation(async (target, method, params) => {
    const reply = await send(target, method, params);
    if (
      method === "Runtime.evaluate" &&
      (params as { expression?: string })?.expression !== "document.visibilityState" &&
      ++probes === (type === "mouseMoved" ? 1 : 2)
    ) {
      f.onDetach.fire({ tabId: 7 }, "connection_lost");
      vi.mocked(f.api.attach).mockImplementationOnce(() => {
        attaching.resolve();
        return attach.promise;
      });
    }
    return reply;
  });
  const pending = handleDownload(f.sessions, f.params, { ...f.deps, signal: abort.signal });
  try {
    await attaching.promise;
    abort.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({
      code: "cdp_failed",
      message: expect.stringMatching(/abort/),
    });
    expect(f.deps.downloads.onChanged.listeners.size).toBe(0);
    const before = [...f.inputs];
    expect(before).toEqual(type === "mouseMoved" ? [] : ["mouseMoved"]);
    attach.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.inputs).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    abort.abort();
    attach.resolve();
    await pending;
    f.cdp.dispose();
  }
});

it.each([
  undefined,
  "child-session",
])("checks cancellation at native dispatch for target %s", async (sessionId) => {
  const f = await fixture();
  const abort = new AbortController();
  const attach = deferred<void>();
  const attaching = deferred<void>();
  vi.mocked(f.api.attach).mockImplementationOnce(() => {
    attaching.resolve();
    return attach.promise;
  });
  const scope = fileTransferTriggerDeps(f.deps, abort.signal);
  const pending = scope.deps.cdp.sendToTarget!(
    { tabId: 7, sessionId },
    "Input.dispatchMouseEvent",
    { type: "mousePressed" },
  );
  const failed = expect(pending).rejects.toThrow(/abort/i);
  try {
    await attaching.promise;
    abort.abort();
    await scope.cleanup(Date.now() + 1_000);
    expect(f.inputs).toEqual([]);
    attach.resolve();
    await failed;
    expect(f.inputs).toEqual([]);
    expect(f.api.detach).not.toHaveBeenCalled();
  } finally {
    attach.resolve();
    await failed;
    f.cdp.dispose();
  }
});

it("refuses guarded cleanup sends and detaches for a replaced attachment without reconnecting", async () => {
  const f = await fixture();
  try {
    await f.cdp.ensureAttached(7);
    const attachmentId = f.cdp.getAttachmentId(7)!;
    await f.cdp.detach(7);
    const cleanup = () =>
      f.cdp.sendGuarded(
        { tabId: 7 },
        "Input.dispatchMouseEvent",
        { type: "mouseReleased" },
        { attachmentId },
      );
    await expect(cleanup()).rejects.toThrow("attachment changed");
    expect(f.api.attach).toHaveBeenCalledTimes(1);
    await f.cdp.ensureAttached(7);
    const replacement = f.cdp.getAttachmentId(7);
    await expect(cleanup()).rejects.toThrow("attachment changed");
    await f.cdp.detach(7, attachmentId);
    expect(f.cdp.getAttachmentId(7)).toBe(replacement);
    expect(f.api.detach).toHaveBeenCalledTimes(1);
    expect(f.inputs).toEqual([]);
  } finally {
    f.cdp.dispose();
  }
});

it.each([
  "released",
  "pending-end",
  "rejected-end",
])("releases overlay resources before a held press reply and preserves the next operation's ownership: %s", async (mode) => {
  vi.useFakeTimers();
  const f = await fixture();
  const abort = new AbortController();
  const nextAbort = new AbortController();
  const press = [deferred<object>(), deferred<object>()];
  const pressed = [deferred<void>(), deferred<void>()];
  let pressIndex = 0;
  let bypassCount = 1; // An unrelated retained hover owns this reference.
  const leases = new Set<string>();
  const endReply = deferred<void>();
  let endCount = 0;
  const bypassOverlay = vi.fn(async (_tabId: number, enabled: boolean) => {
    bypassCount += enabled ? 1 : -1;
  });
  const sendInputPassthrough = vi.fn(async (_tabId: number, message: InputPassthroughMessage) => {
    if (message.phase === "begin") leases.add(message.id);
    else {
      leases.delete(message.id);
      if (++endCount === 1) {
        if (mode === "pending-end") await endReply.promise;
        if (mode === "rejected-end") throw new Error("passthrough end failed");
      }
    }
  });
  const send = vi.mocked(f.api.sendCommand).getMockImplementation()!;
  vi.spyOn(f.api, "sendCommand").mockImplementation(async (target, method, params) => {
    if (
      method === "Runtime.evaluate" &&
      (params as { expression?: string })?.expression !== "document.visibilityState"
    )
      return { result: { value: leases.size ? "clear" : "covered" } };
    const reply = await send(target, method, params);
    if (
      method === "Input.dispatchMouseEvent" &&
      (params as { type: string }).type === "mousePressed"
    ) {
      const index = pressIndex++;
      pressed[index].resolve();
      return press[index].promise;
    }
    return reply;
  });
  const deps = { ...f.deps, bypassOverlay, sendInputPassthrough };
  const pending = handleDownload(f.sessions, f.params, { ...deps, signal: abort.signal });
  let next: ReturnType<typeof handleDownload> | undefined;
  try {
    await pressed[0].promise;
    expect(bypassCount).toBe(2);
    expect(leases.size).toBe(1);
    abort.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    if (mode !== "released") expect(await pending).toHaveProperty("data.cleanup_state", "failed");
    expect(await pending).toMatchObject({
      code: "cdp_failed",
      message: expect.stringMatching(/abort/),
    });
    expect(f.deps.downloads.onChanged.listeners.size).toBe(0);
    expect(bypassCount).toBe(1);
    expect(leases.size).toBe(0);

    next = handleDownload(f.sessions, f.params, { ...deps, signal: nextAbort.signal });
    await pressed[1].promise;
    const nextLease = [...leases];
    expect(nextLease).toHaveLength(1);
    const before = [...f.inputs];
    press[0].resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(bypassCount).toBe(2);
    expect([...leases]).toEqual(nextLease);
    expect(f.inputs).toEqual(before);
    endReply.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(bypassCount).toBe(2);
    expect([...leases]).toEqual(nextLease);

    nextAbort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await next).toMatchObject({
      code: "cdp_failed",
      message: expect.stringMatching(/abort/),
    });
    expect(bypassCount).toBe(1);
    expect(leases.size).toBe(0);
    press[1].resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(bypassOverlay.mock.calls.map((call) => call[1])).toEqual([true, false, true, false]);
  } finally {
    abort.abort();
    nextAbort.abort();
    endReply.resolve();
    for (const held of press) held.resolve({});
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([pending, next]);
    f.cdp.dispose();
  }
});
