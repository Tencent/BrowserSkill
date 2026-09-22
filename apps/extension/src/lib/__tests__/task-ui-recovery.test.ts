import type { Transport } from "@/transport/transport";
import { ConnectionController } from "../connection-controller";

vi.mock("../instance-id", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../instance-id")>()),
  getOrCreateInstanceId: async () => "review-instance",
  getLabel: async () => "review-browser",
}));

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

// Full lifecycle regression coverage for slow UI operations and recovery.
it("disconnect cleanup finishes despite an unsettled focus mutation", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const gate = deferred<chrome.tabs.Tab>();
  f.tabApi.update.mockReturnValueOnce(gate.promise);
  const focusing = focusTask(f.manager, "one");
  const cancelled = expect(focusing).rejects.toMatchObject({ code: "cancelled" });
  await vi.advanceTimersByTimeAsync(0);
  const clean = createDisconnectCleanup({ manager: f.manager, sessionStopDeps: f.stopDeps });
  const cleanup = clean();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await cleanup).toMatchObject({ stoppedSessionIds: ["one"], failures: [] });
  expect(f.manager.has("one")).toBe(false);
  expect(f.task.borrowedTabs.has(5)).toBe(false);
  expect(f.tabApi.move).toHaveBeenCalled();
  gate.resolve({ id: 5, windowId: 10 } as chrome.tabs.Tab);
  await cancelled;
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.manager.has("one")).toBe(false);
  expect(f.tabApi.move).toHaveBeenCalled();
  expect(await clean()).toMatchObject({ stoppedSessionIds: [], failures: [] });
});

it("releases a moved tab even when the deadline expires during authority recheck", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const shot = deferred<{ data: string }>();
  const recheck = deferred<chrome.tabs.Tab>();
  const original = f.api.sendCommand.getMockImplementation()!;
  f.api.sendCommand.mockImplementation((t, m, p) =>
    m === "Page.captureScreenshot" ? shot.promise : original(t, m, p),
  );
  const frame = captureTaskPreview(f.manager, f.cdp, "one");
  const timedOut = expect(frame).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(2900);
  expect(f.attached.has(5)).toBe(true);
  expect(f.focus.get(5)).toBe(true);
  f.tabs.get(5)!.windowId = 500;
  f.tabApi.get.mockResolvedValueOnce({ ...f.tabs.get(5)! }).mockReturnValueOnce(recheck.promise);
  shot.resolve({ data: btoa("jpeg") });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.tabApi.get).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(100);
  await timedOut;
  recheck.resolve({ ...f.tabs.get(5)! });
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.attached.has(5)).toBe(false);
  expect(f.focus.get(5)).toBe(false);
  expect(f.api.detach).toHaveBeenCalled();
});

it("reconnects after bounded cleanup without waiting for focus completion or a wake event", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const gate = deferred<chrome.tabs.Tab>();
  f.tabApi.update.mockReturnValueOnce(gate.promise);
  const focusing = focusTask(f.manager, "one");
  const cancelled = expect(focusing).rejects.toMatchObject({ code: "cancelled" });
  await vi.advanceTimersByTimeAsync(0);
  const clean = createDisconnectCleanup({ manager: f.manager, sessionStopDeps: f.stopDeps });
  const cleanup = vi.fn(async () => {
    const result = await clean();
    if (result.failures.length) throw new Error("Session cleanup incomplete");
  });
  const transport = {
    state: "disconnected",
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    onConnectionStateChange: vi.fn(),
  };
  const controller = new ConnectionController();
  await controller.attach(
    transport as unknown as Transport,
    { name: "Chrome", version: "test" },
    true,
    { onDisconnected: cleanup },
  );
  const transition = controller.reconfigureTransport("changed", () => {});
  await vi.advanceTimersByTimeAsync(1000);
  await transition;
  expect(controller.snapshot().lastError).toBeNull();
  expect(f.manager.has("one")).toBe(false);
  expect(transport.connect).toHaveBeenCalledTimes(2);
  gate.resolve({ id: 5, windowId: 10 } as chrome.tabs.Tab);
  await cancelled;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.windows.update).not.toHaveBeenCalled();
});

it("does not release a newer tool claim when an old authority lookup finishes late", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const shot = deferred<{ data: string }>(),
    lookup = deferred<chrome.tabs.Tab>();
  const original = f.api.sendCommand.getMockImplementation()!;
  f.api.sendCommand.mockImplementation((t, m, p) =>
    m === "Page.captureScreenshot" ? shot.promise : original(t, m, p),
  );
  const frame = captureTaskPreview(f.manager, f.cdp, "one");
  const rejected = expect(frame).rejects.toMatchObject({ code: "not_found" });
  await vi.advanceTimersByTimeAsync(0);
  f.tabs.get(5)!.windowId = 500;
  f.tabApi.get.mockResolvedValueOnce({ ...f.tabs.get(5)! }).mockReturnValueOnce(lookup.promise);
  shot.resolve({ data: btoa("jpeg") });
  await vi.advanceTimersByTimeAsync(0);
  f.tabs.get(5)!.windowId = 10;
  await f.cdp.acquireBackgroundExecution("one", 5);
  lookup.resolve({ id: 5, windowId: 500 } as chrome.tabs.Tab);
  await rejected;
  expect(f.attached.has(5)).toBe(true);
  expect(f.focus.get(5)).toBe(true);
});

it("serializes a new enable behind an already-issued disable across reattachment", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.cdp.acquireBackgroundExecution("one", 5);
  const gate = deferred<void>();
  const original = f.api.sendCommand.getMockImplementation()!;
  f.api.sendCommand.mockImplementation(async (t, m, p) => {
    if (m === "Emulation.setFocusEmulationEnabled" && !p.enabled) await gate.promise;
    return original(t, m, p);
  });
  const release = f.cdp.releaseSessionTab("one", 5);
  const timedOut = expect(release).rejects.toThrow("cleanup timed out");
  await vi.advanceTimersByTimeAsync(1000);
  await timedOut;
  let acquired = false;
  const next = f.cdp.acquireBackgroundExecution("one", 5).then(() => {
    acquired = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(acquired).toBe(false);
  expect(
    f.api.sendCommand.mock.calls.filter(
      ([, m, p]) => m === "Emulation.setFocusEmulationEnabled" && p.enabled,
    ),
  ).toHaveLength(1);
  gate.resolve();
  await next;
  expect(f.focus.get(5)).toBe(true);
});
