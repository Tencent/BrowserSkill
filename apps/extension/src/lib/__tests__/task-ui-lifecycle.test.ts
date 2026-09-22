import { afterEach, expect, it, vi } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { createDisconnectCleanup } from "@/session-manager/disconnect-cleanup";
import { SessionManager } from "@/session-manager/manager";
import { handleSessionStop } from "@/tools/session";
import { handleTabReturn } from "@/tools/tabs";
import { captureTaskPreview, focusTask } from "../task-preview";

const drivers: ChromiumCdp[] = [];
afterEach(() => {
  for (const d of drivers.splice(0)) d.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function event() {
  return { addListener: vi.fn(), removeListener: vi.fn() };
}
async function fixture() {
  let next = 10;
  const manager = new SessionManager({
    remote: () => true,
    agentWindow: {
      create: async () => ({ windowId: next++, initialTabIds: [] }),
      remove: vi.fn(async () => {}),
      ensureActiveTab: async (id) => id,
    },
  });
  const task = await manager.start("one");
  task.borrowedTabs.set(5, { tabId: 5, originalWindowId: 500, originalIndex: 0 });
  const tabs = new Map<number, chrome.tabs.Tab>([
    [5, { id: 5, windowId: 10, active: true, title: "fixture" } as chrome.tabs.Tab],
    [10, { id: 10, windowId: 10, active: false } as chrome.tabs.Tab],
  ]);
  const attached = new Set<number>();
  const focus = new Map<number, boolean>();
  const api = {
    attach: vi.fn(async ({ tabId }: { tabId: number }) => {
      attached.add(tabId);
    }),
    detach: vi.fn(async ({ tabId }: { tabId: number }) => {
      attached.delete(tabId);
      focus.set(tabId, false);
    }),
    sendCommand: vi.fn(async (target: { tabId: number }, method: string, params: any) => {
      if (method === "Emulation.setFocusEmulationEnabled") focus.set(target.tabId, params.enabled);
      return method === "Page.captureScreenshot" ? { data: btoa("jpeg") } : {};
    }),
    onEvent: event(),
    onDetach: event(),
  };
  const cdp = new ChromiumCdp(api as unknown as CdpDebuggerApi);
  drivers.push(cdp);
  const tabApi = {
    get: vi.fn(async (id: number) => {
      const tab = tabs.get(id);
      if (!tab) throw new Error("missing tab");
      return { ...tab };
    }),
    query: vi.fn(async (query: { windowId?: number }) =>
      [...tabs.values()].filter(
        (t) => query.windowId === undefined || t.windowId === query.windowId,
      ),
    ),
    update: vi.fn(async (id: number, props: object) => Object.assign(tabs.get(id)!, props)),
    move: vi.fn(async (id: number, props: object) => Object.assign(tabs.get(id)!, props)),
    remove: vi.fn(async (id: number) => {
      tabs.delete(id);
    }),
    create: vi.fn(),
    sendMessage: vi.fn(async () => ({ ok: true })),
  };
  const windows = {
    get: vi.fn(async (id: number) => ({ id }) as chrome.windows.Window),
    getLastFocused: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(async () => ({}) as chrome.windows.Window),
  };
  vi.stubGlobal("chrome", { tabs: tabApi, windows });
  const bitmap = { width: 1280, height: 720, close: vi.fn() };
  const decode = vi.fn(async () => bitmap);
  const encode = vi.fn(async () => new Blob(["small"]));
  vi.stubGlobal("createImageBitmap", decode);
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return { drawImage: vi.fn() };
      }
      convertToBlob = encode;
    },
  );
  const tabManagement = {
    tabs: tabApi,
    windows,
    cdp,
    agentOverlayReset: { resetAgentOverlays: vi.fn(async () => {}) },
  };
  const stopDeps = { cdp, tabManagement, tabsQuery: tabApi };
  return {
    manager,
    task,
    tabs,
    cdp,
    api,
    attached,
    focus,
    tabApi,
    windows,
    bitmap,
    decode,
    encode,
    tabManagement,
    stopDeps,
  };
}

it("does not reacquire after actual tab return overtakes the initial tab lookup", async () => {
  const f = await fixture();
  await f.cdp.acquireBackgroundExecution("one", 5);
  const gate = deferred<chrome.tabs.Tab>();
  f.tabApi.get.mockImplementationOnce(() => gate.promise);
  const frame = captureTaskPreview(f.manager, f.cdp, "one");
  const rejected = expect(frame).rejects.toMatchObject({ code: "cancelled" });
  await vi.waitFor(() => expect(f.tabApi.get).toHaveBeenCalled());
  expect(
    await handleTabReturn(f.manager, { session_id: "one", tab_id: 5 }, f.tabManagement),
  ).toMatchObject({ tab_id: 5 });
  gate.resolve({ id: 5, windowId: 10 } as chrome.tabs.Tab);
  await rejected;
  await Promise.resolve();
  expect(f.attached.has(5)).toBe(false);
  expect(f.focus.get(5)).toBe(false);
  expect(f.api.attach).toHaveBeenCalledTimes(1);
});

it.each(["before", "during"])("rejects a target moved %s capture", async (stage) => {
  const f = await fixture();
  if (stage === "before")
    f.tabApi.get.mockImplementationOnce(async () => ({ id: 5, windowId: 500 }) as chrome.tabs.Tab);
  else {
    const original = f.api.sendCommand.getMockImplementation()!;
    f.api.sendCommand.mockImplementation(async (t, m, p) => {
      if (m === "Page.captureScreenshot") f.tabs.get(5)!.windowId = 500;
      return original(t, m, p);
    });
  }
  await expect(captureTaskPreview(f.manager, f.cdp, "one")).rejects.toMatchObject({
    code: "not_found",
  });
  if (stage === "before") expect(f.api.attach).not.toHaveBeenCalled();
  expect(f.attached.has(5)).toBe(false);
});

it("discards stale pixels without releasing a tool's session claim", async () => {
  const f = await fixture();
  await f.cdp.acquireBackgroundExecution("one", 5);
  f.decode.mockImplementationOnce(async () => {
    f.task.refStore.invalidateTab(5);
    return f.bitmap;
  });
  await expect(captureTaskPreview(f.manager, f.cdp, "one")).rejects.toMatchObject({
    code: "cancelled",
  });
  expect(f.attached.has(5)).toBe(true);
  expect(f.focus.get(5)).toBe(true);
  await handleTabReturn(f.manager, { session_id: "one", tab_id: 5 }, f.tabManagement);
  expect(f.attached.has(5)).toBe(false);
});

it.each([
  "query",
  "get",
  "attach",
  "decode",
  "encode",
  "screenshot",
])("bounds %s and lets actual multi-session cleanup proceed", async (stage) => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.manager.start("two");
  f.tabs.set(11, { id: 11, windowId: 11 } as chrome.tabs.Tab);
  const gate = deferred<any>();
  let entered = false;
  const block = () => {
    entered = true;
    return gate.promise;
  };
  if (stage === "query") f.tabApi.query.mockImplementationOnce(block);
  if (stage === "get") f.tabApi.get.mockImplementationOnce(block);
  if (stage === "attach")
    f.api.attach.mockImplementationOnce(async ({ tabId }) => {
      await block();
      f.attached.add(tabId);
    });
  if (stage === "decode") f.decode.mockImplementationOnce(block);
  if (stage === "encode") f.encode.mockImplementationOnce(block);
  if (stage === "screenshot") {
    const original = f.api.sendCommand.getMockImplementation()!;
    f.api.sendCommand.mockImplementation((t, m, p) =>
      m === "Page.captureScreenshot" ? block() : original(t, m, p),
    );
  }
  const frame = captureTaskPreview(f.manager, f.cdp, "one");
  const failed = expect(frame).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(3000);
  expect(entered).toBe(true);
  await failed;
  const cleanup = createDisconnectCleanup({ manager: f.manager, sessionStopDeps: f.stopDeps })();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await cleanup).toMatchObject({ stoppedSessionIds: ["one", "two"], failures: [] });
  const values: Record<string, unknown> = {
    query: [{ id: 5, windowId: 10, active: true }],
    get: { id: 5, windowId: 10 },
    attach: undefined,
    decode: f.bitmap,
    encode: new Blob(["late"]),
    screenshot: { data: btoa("late") },
  };
  gate.resolve(values[stage]);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.attached.size).toBe(0);
  expect(f.focus.get(5)).not.toBe(true);
  if (stage === "decode") expect(f.bitmap.close).toHaveBeenCalled();
});

it("focus selects an owned tab, and cannot run during actual return", async () => {
  const f = await fixture();
  f.tabs.set(9, { id: 9, windowId: 10, active: true } as chrome.tabs.Tab);
  f.tabs.get(5)!.active = false;
  await expect(focusTask(f.manager, "one")).resolves.toEqual({ focused: true });
  expect(f.tabApi.update).toHaveBeenCalledWith(5, { active: true });
  const gate = deferred<chrome.tabs.Tab>();
  f.tabApi.move.mockReturnValueOnce(gate.promise);
  const returning = handleTabReturn(f.manager, { session_id: "one", tab_id: 5 }, f.tabManagement);
  await vi.waitFor(() => expect(f.tabApi.move).toHaveBeenCalled());
  await expect(focusTask(f.manager, "one")).rejects.toMatchObject({ code: "cancelled" });
  gate.resolve({ id: 5, windowId: 500 } as chrome.tabs.Tab);
  await returning;
});

it("waits for an issued focus mutation before returning a tab, and never raises the old window afterward", async () => {
  const f = await fixture();
  const gate = deferred<chrome.tabs.Tab>();
  f.tabApi.update.mockReturnValueOnce(gate.promise);
  const focusing = focusTask(f.manager, "one");
  const cancelled = expect(focusing).rejects.toMatchObject({ code: "cancelled" });
  await vi.waitFor(() => expect(f.tabApi.update).toHaveBeenCalled());
  const returning = handleTabReturn(f.manager, { session_id: "one", tab_id: 5 }, f.tabManagement);
  await Promise.resolve();
  expect(f.tabApi.move).not.toHaveBeenCalled();
  gate.resolve({ id: 5, windowId: 10 } as chrome.tabs.Tab);
  await cancelled;
  await returning;
  expect(f.windows.update).not.toHaveBeenCalled();
});

it("refuses focus during session stop and when ownership is lost during activation", async () => {
  const f = await fixture();
  f.tabApi.update.mockImplementationOnce(async () => {
    f.task.borrowedTabs.delete(5);
    f.tabs.get(5)!.windowId = 500;
    return f.tabs.get(5)!;
  });
  await expect(focusTask(f.manager, "one")).rejects.toMatchObject({ code: "not_found" });
  expect(f.windows.update).not.toHaveBeenCalled();
  const gate = deferred<void>();
  f.tabApi.remove.mockReturnValueOnce(gate.promise);
  const stopping = handleSessionStop(f.manager, { session_id: "one" }, f.stopDeps);
  await vi.waitFor(() => expect(f.tabApi.remove).toHaveBeenCalled());
  await expect(focusTask(f.manager, "one")).rejects.toMatchObject({ code: "cancelled" });
  gate.resolve();
  await stopping;
});

it("keeps tool control after a transient Chrome lookup failure", async () => {
  const f = await fixture();
  await f.cdp.acquireBackgroundExecution("one", 5);
  f.tabApi.get.mockRejectedValueOnce(new Error("Chrome temporarily unavailable"));
  await expect(captureTaskPreview(f.manager, f.cdp, "one")).rejects.toMatchObject({
    code: "cdp_failed",
    reason: "ui_lookup_failed",
  });
  expect(f.attached.has(5)).toBe(true);
  expect(f.focus.get(5)).toBe(true);
});

it("bounds teardown waiting for stuck focus and allows a safe retry", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const gate = deferred<chrome.tabs.Tab>();
  f.tabApi.update.mockReturnValueOnce(gate.promise);
  const focusing = focusTask(f.manager, "one");
  const cancelled = expect(focusing).rejects.toMatchObject({ code: "cancelled" });
  await vi.advanceTimersByTimeAsync(0);
  const stop = handleSessionStop(f.manager, { session_id: "one" }, f.stopDeps);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await stop).toMatchObject({ code: "cancelled", data: { reason: "ui_busy" } });
  expect(f.manager.has("one")).toBe(true);
  expect(f.tabApi.move).not.toHaveBeenCalled();
  gate.resolve({ id: 5, windowId: 10 } as chrome.tabs.Tab);
  await cancelled;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.windows.update).not.toHaveBeenCalled();
  await handleSessionStop(f.manager, { session_id: "one" }, f.stopDeps);
  expect(f.manager.has("one")).toBe(false);
});
