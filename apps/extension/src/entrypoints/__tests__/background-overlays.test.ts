import { afterEach, expect, it, vi } from "vitest";
import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { OverlayController, shouldShowAgentControlOverlay } from "@/content/overlay-controller";
import { watchDaemonConnection } from "@/lib/daemon-connection-preference";
import { OVERLAY_AGENT_STATE, type OverlayAgentStateMessage } from "@/lib/overlay-bridge";
import {
  COOPERATION_CONTENT_SCRIPT_FILE,
  OVERLAY_CONTENT_SCRIPT_FILE,
  resetOverlayInjectionCacheForTests,
} from "@/lib/runtime-content-scripts";
import { chromeAgentWindowApi } from "@/session-manager/agent-window";
import { isAgentControlledTab } from "@/session-manager/manager";
import { AgentWindowRouting } from "@/session-manager/window-routing";
import { ToolDispatcher } from "@/tools/dispatcher";
import { hasActiveHelp } from "@/tools/human-loop";
import {
  activeRecordingCount,
  hasActiveRecording,
  subscribeActiveRecordings,
} from "@/tools/record";
import { handleTabCreate } from "@/tools/tabs";
import { WSTransport } from "@/transport/ws-transport";
import { VideoManager } from "@/video/manager";

vi.hoisted(() => {
  Object.assign(globalThis, { defineBackground: (main: unknown) => main });
});

// Keep background's real overlay wiring and SessionManager; isolate unrelated
// startup services so no transport, storage or browser connection is opened.
vi.mock("@/browser-driver/chromium-cdp");
vi.mock("@/debug/archive");
vi.mock("@/debug/bridge");
vi.mock("@/debug/manager");
vi.mock("@/video/manager");
vi.mock("@/video/bridge");
vi.mock("@/video/host");
vi.mock("@/lib/audit");
vi.mock("@/lib/audit-bridge");
vi.mock("@/lib/connection-controller");
vi.mock("@/lib/daemon-connection-preference");
vi.mock("@/lib/daemon-upgrade-notice");
vi.mock("@/lib/heartbeat");
vi.mock("@/lib/instance-id");
vi.mock("@/lib/interaction-preferences");
vi.mock("@/lib/keepalive");
vi.mock("@/lib/local-pairing-bridge");
vi.mock("@/lib/recording/frame-coordinator");
vi.mock("@/long-screenshot/background");
vi.mock("@/session-manager/event-handler");
vi.mock("@/session-manager/window-routing");
vi.mock("@/session-manager/agent-window", () => ({
  AGENT_WINDOW_HOME: "about:blank",
  chromeAgentWindowApi: {
    create: async () => ({ windowId: 10, initialTabIds: [10] }),
    ensureActiveTab: async () => 10,
  },
}));
vi.mock("@/tools/borrow-confirmation");
vi.mock("@/tools/dispatcher");
vi.mock("@/tools/human-loop");
vi.mock("@/tools/record");
vi.mock("@/transport/handshake");
vi.mock("@/transport/remote-authorization");
vi.mock("@/transport/ws-transport");

import background from "@/entrypoints/background";

afterEach(() => {
  resetOverlayInjectionCacheForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.mocked(hasActiveHelp).mockReset();
  vi.mocked(hasActiveRecording).mockReset();
  vi.useRealTimers();
});

function event<T extends unknown[] = []>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    addListener: (listener: (...args: T) => void) => listeners.add(listener),
    removeListener: (listener: (...args: T) => void) => listeners.delete(listener),
    emit: (...args: T) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

async function fixture() {
  const overlay = new OverlayController();
  const onDetached = event<[number]>();
  const onAttached = event<[number, chrome.tabs.TabAttachInfo]>();
  const onCreated = event<[chrome.tabs.Tab]>();
  const onCommitted = event<[chrome.webNavigation.WebNavigationTransitionCallbackDetails]>();
  const onCreatedNavigationTarget = event<[{ tabId: number; sourceTabId: number }]>();
  let registeredScripts: chrome.scripting.RegisteredContentScript[] = [];
  const executeScript = vi.fn(async (_injection: unknown) => []);
  const getRegisteredContentScripts = vi.fn(async () => [...registeredScripts]);
  const registerContentScripts = vi.fn(
    async (scripts: chrome.scripting.RegisteredContentScript[]) => {
      registeredScripts.push(...scripts);
    },
  );
  const unregisterContentScripts = vi.fn(async (filter?: chrome.scripting.ContentScriptFilter) => {
    if (!filter?.ids) {
      registeredScripts = [];
      return;
    }
    const ids = new Set(filter.ids);
    registeredScripts = registeredScripts.filter((script) => !ids.has(script.id));
  });
  const sendMessage = vi.fn(
    async (_tabId: number, message: OverlayAgentStateMessage): Promise<unknown> => {
      overlay.applyAgentControlMode(message.sessionId, message.mode, message.controller);
      return undefined;
    },
  );
  vi.stubGlobal("chrome", {
    scripting: {
      executeScript,
      getRegisteredContentScripts,
      registerContentScripts,
      unregisterContentScripts,
    },
    tabs: {
      sendMessage,
      get: vi.fn(async () => ({ url: "https://example.test" })),
      query: vi.fn(async () => []),
      group: vi.fn(async () => 100),
      ungroup: vi.fn(async () => {}),
      onDetached,
      onActivated: event(),
      onUpdated: event(),
      onCreated,
      onAttached,
      onRemoved: event(),
    },
    tabGroups: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: 100, windowId: 10 })),
      update: vi.fn(async () => {}),
      onRemoved: event(),
      onMoved: event(),
    },
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(),
      onEvent: event(),
      onDetach: event(),
    },
    webNavigation: {
      onBeforeNavigate: event(),
      onCommitted,
      onCompleted: event(),
      onErrorOccurred: event(),
      onCreatedNavigationTarget,
    },
    runtime: {
      onMessage: event(),
      onConnect: event(),
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    notifications: { onClicked: event(), onButtonClicked: event() },
  });
  vi.mocked(watchDaemonConnection).mockReturnValue({ ready: Promise.resolve(), dispose() {} });
  vi.mocked(ChromiumCdp.prototype.releaseSessionTab).mockResolvedValue();
  vi.mocked(VideoManager.prototype.stopTab).mockResolvedValue();
  (background as unknown as () => void)();
  const deps = vi.mocked(ToolDispatcher).mock.calls.at(-1)![0];
  const task = await deps.sessions.start("one");
  return {
    overlay,
    onDetached,
    onAttached,
    onCreated,
    onCommitted,
    onCreatedNavigationTarget,
    executeScript,
    getRegisteredContentScripts,
    registerContentScripts,
    unregisterContentScripts,
    sendMessage,
    deps,
    task,
  };
}

it.each([
  { name: "missing", debuggerApi: undefined },
  {
    name: "incomplete",
    debuggerApi: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(), onDetach: event() },
  },
])("skips browser service startup when chrome.debugger is $name", ({ debuggerApi }) => {
  vi.stubGlobal("chrome", {
    debugger: debuggerApi,
    runtime: { getURL: vi.fn((path: string) => `chrome-extension://test/${path}`) },
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    (background as unknown as () => void)();
    expect(WSTransport).not.toHaveBeenCalled();
    expect(ChromiumCdp).not.toHaveBeenCalled();
    expect(watchDaemonConnection).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("chrome.debugger"));
  } finally {
    warn.mockRestore();
  }
});

it("keeps task tabs ungrouped while showing controls after creation and attachment", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const home = { id: 10, windowId: 10, groupId: -1, pinned: false } as chrome.tabs.Tab;
  const created = { ...home, id: 20, url: "https://example.test" };
  const tabs = [home];
  Object.assign(chrome.tabs, {
    query: vi.fn(async () => tabs),
    get: vi.fn(async (id: number) => tabs.find((tab) => tab.id === id)),
    create: vi.fn(async (props: chrome.tabs.CreateProperties) => {
      const next = { ...created, active: props.active ?? true };
      tabs.push(next);
      f.onCreated.emit(next);
      return next;
    }),
    update: vi.fn(async (id: number, props: chrome.tabs.UpdateProperties) => {
      const tab = tabs.find((entry) => entry.id === id);
      if (tab && props.active !== undefined) tab.active = props.active;
      return tab;
    }),
  });

  f.deps.onSessionsChanged?.();
  const result = await handleTabCreate(f.deps.sessions, {
    session_id: f.task.sessionId,
    url: created.url,
  });
  expect(result).toMatchObject({ tab_id: created.id, window_id: home.windowId });
  if ("code" in result) throw new Error(result.message);
  // Use the real background callbacks invoked by the dispatcher and browser.
  f.deps.onAgentTabClaimed?.(result.tab_id, result.window_id);
  f.onAttached.emit(created.id, { newWindowId: home.windowId, newPosition: 1 });
  await vi.advanceTimersByTimeAsync(0);

  expect(isAgentControlledTab(f.task, created.id)).toBe(true);
  for (const tab of tabs) {
    expect(tab.groupId).toBe(-1);
    expect(f.sendMessage).toHaveBeenCalledWith(
      tab.id,
      expect.objectContaining({ sessionId: f.task.sessionId, mode: "control" }),
    );
  }
  expect(chrome.tabs.group).not.toHaveBeenCalled();
  expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
  expect(chrome.tabGroups.update).not.toHaveBeenCalled();
});

it("routes identities by tab ownership and restores or clears them on state refresh", async () => {
  const f = await fixture();
  f.task.controller = { name: "Codex", project: "Search" };
  vi.spyOn(chromeAgentWindowApi, "create").mockResolvedValueOnce({
    windowId: 20,
    initialTabIds: [20],
  });
  vi.spyOn(chromeAgentWindowApi, "ensureActiveTab").mockResolvedValueOnce(20);
  const second = await f.deps.sessions.start("two", {
    controller: { name: "Claude", project: "Payments" },
  });
  const assertClaim = async (tabId: number, windowId: number, sessionId: string, name: string) => {
    f.deps.onAgentTabClaimed?.(tabId, windowId);
    await vi.waitFor(() => {
      expect(f.sendMessage).toHaveBeenLastCalledWith(
        tabId,
        expect.objectContaining({ sessionId, controller: expect.objectContaining({ name }) }),
      );
    });
    expect(f.overlay.snapshot().controller?.name).toBe(name);
  };
  await assertClaim(10, 10, "one", "Codex");
  await assertClaim(20, 20, second.sessionId, "Claude");
  f.overlay.resetAgentOverlays(second.sessionId);
  await assertClaim(10, 10, "one", "Codex");
  f.deps.sessions.release("one");
  f.deps.onAgentTabClaimed?.(10, 10);
  await vi.waitFor(() => {
    expect(f.overlay.snapshot().activeSessionId).toBeNull();
  });
  expect(f.overlay.snapshot().controller).toBeUndefined();
  expect(f.deps.sessions.get("two")?.controller?.name).toBe("Claude");
  vi.restoreAllMocks();
});

it("refreshes released-page controls after attachment completes", async () => {
  const f = await fixture();
  f.overlay.applyAgentControlMode("one", "control");
  f.deps.sessions.release("one");
  f.onAttached.emit(10, { newWindowId: 90, newPosition: 0 });
  await Promise.resolve();
  expect(f.overlay.snapshot().controlVisible).toBe(false);
  expect(f.sendMessage).toHaveBeenCalledWith(
    10,
    expect.objectContaining({ sessionId: null, mode: "hidden" }),
  );
});

it.each([false, true])("hides an observed tab after detachment, remote=%s", async (remote) => {
  const f = await fixture();
  f.task.remote = remote;
  f.task.observedTabs = new Set([20]);
  f.deps.onAgentTabClaimed?.(20, 10);
  await vi.waitFor(() => {
    expect(shouldShowAgentControlOverlay(f.overlay.snapshot())).toBe(true);
  });
  const claimed = f.sendMessage.mock.lastCall![1];
  f.onDetached.emit(20);
  expect(isAgentControlledTab(f.task, 20)).toBe(false);
  const [tabId, released] = f.sendMessage.mock.lastCall!;
  expect(tabId).toBe(20);
  expect(released).toMatchObject({
    type: OVERLAY_AGENT_STATE,
    sessionId: null,
    mode: "hidden",
  });
  // The release is ordered after the claim, although no session changed.
  expect(released.epoch).toEqual(expect.any(String));
  expect(released.epoch).toBe(claimed.epoch);
  expect(released.generation).toBeGreaterThan(claimed.generation);
  expect(shouldShowAgentControlOverlay(f.overlay.snapshot())).toBe(false);
  expect(f.deps.cdp?.releaseSessionTab).toHaveBeenCalledWith("one", 20);
});

it("still releases control and CDP when the content script cannot receive hidden", async () => {
  const f = await fixture();
  f.task.observedTabs = new Set([20]);
  f.sendMessage.mockRejectedValueOnce(new Error("Receiving end does not exist"));
  f.onDetached.emit(20);
  await Promise.resolve();
  expect(isAgentControlledTab(f.task, 20)).toBe(false);
  expect(f.deps.cdp?.releaseSessionTab).toHaveBeenCalledWith("one", 20);
});

it("does not reset tabs without an observed claim", async () => {
  const f = await fixture();
  f.onDetached.emit(10);
  f.onDetached.emit(30);
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(f.deps.cdp?.releaseSessionTab).not.toHaveBeenCalled();
  expect(isAgentControlledTab(f.task, 10)).toBe(true);
});

it("accepts an absent video listener but preserves real overlay replies and errors", async () => {
  const f = await fixture();
  const video = vi.mocked(VideoManager).mock.calls.at(-1)![0];
  for (const reply of [undefined, null, { interactive: true }]) {
    f.sendMessage.mockResolvedValueOnce(reply);
    await expect(video.overlay(10, "video")).resolves.toEqual(reply ?? {});
  }
  f.sendMessage.mockRejectedValueOnce(new Error("Overlay paint failed"));
  await expect(video.overlay(10, "video")).rejects.toThrow("Overlay paint failed");
});

// Exercise the background's actual routing predicate with real cooperation and
// routing controllers. Module-only routing tests cannot catch wiring regressions.
it.each([
  "cooperation",
  "help",
  "recording",
])("respects external-tab routing and task pages during %s", async (mode) => {
  vi.useFakeTimers();
  const f = await fixture();
  vi.mocked(hasActiveHelp).mockReturnValue(mode === "help");
  vi.mocked(hasActiveRecording).mockReturnValue(mode === "recording");
  const tabs = new Map<number, chrome.tabs.Tab>();
  const add = (id: number) => {
    const tab = { id, windowId: 10, active: false, incognito: false } as chrome.tabs.Tab;
    tabs.set(id, tab);
    return tab;
  };
  add(10);
  Object.assign(chrome.tabs, {
    get: vi.fn(async (id: number) => ({ ...tabs.get(id)! })),
    query: vi.fn(async ({ windowId }: chrome.tabs.QueryInfo) =>
      [...tabs.values()].filter((tab) => tab.windowId === windowId),
    ),
    move: vi.fn(async (id: number, { windowId }: chrome.tabs.MoveProperties) => {
      f.onDetached.emit(id);
      const tab = tabs.get(id)!;
      tab.windowId = windowId!;
      return { ...tab };
    }),
    update: vi.fn(),
  });
  Object.assign(chrome, {
    windows: {
      getAll: vi.fn(async () => [
        { id: 1, type: "normal", incognito: false, focused: false },
        { id: 10, type: "normal", incognito: false, focused: false },
      ]),
      update: vi.fn(),
      onFocusChanged: event(),
      onRemoved: event(),
    },
  });
  const { AgentWindowRouting: RealRouting } = await vi.importActual<
    typeof import("@/session-manager/window-routing")
  >("@/session-manager/window-routing");
  const router = new RealRouting(...vi.mocked(AgentWindowRouting).mock.calls.at(-1)!);
  try {
    f.deps.cooperation!.startSession(f.task.sessionId);
    expect(f.deps.cooperation!.hasSession(f.task.sessionId)).toBe(true);
    router.sync();
    await vi.advanceTimersByTimeAsync(0);
    f.onCreated.emit(add(20));
    f.onCreatedNavigationTarget.emit({ tabId: 20, sourceTabId: 10 });
    f.onCreated.emit(add(30));
    await vi.advanceTimersByTimeAsync(150);
    expect(tabs.get(10)!.windowId).toBe(10);
    expect(tabs.get(20)!.windowId).toBe(10);
    expect(isAgentControlledTab(f.task, 20)).toBe(false);
    expect(isAgentControlledTab(f.task, 30)).toBe(false);
    if (mode === "cooperation") {
      expect(chrome.tabs.move).toHaveBeenCalledExactlyOnceWith(30, { windowId: 1, index: -1 });
      expect(tabs.get(30)!.windowId).toBe(1);
    } else {
      expect(chrome.tabs.move).not.toHaveBeenCalled();
      expect(tabs.get(30)!.windowId).toBe(10);
    }
    expect(chrome.windows.update).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  } finally {
    router.dispose();
  }
});

it("dynamically registers Tier B scripts with persistAcrossSessions:false and unregisters at zero sessions", async () => {
  const f = await fixture();
  const recordingListener = vi.mocked(subscribeActiveRecordings).mock.calls.at(-1)?.[0];
  await f.deps.onSessionsChanged?.();
  expect(f.registerContentScripts).toHaveBeenCalledWith([
    expect.objectContaining({
      id: "bsk-tier-b-cooperation",
      js: ["content-scripts/cooperation.js"],
      allFrames: true,
      matchOriginAsFallback: true,
      runAt: "document_start",
      persistAcrossSessions: false,
    }),
  ]);

  // Starting a recording dynamically registers Tier B record-frame with persistAcrossSessions: false.
  vi.mocked(activeRecordingCount).mockReturnValue(1);
  await recordingListener?.();
  expect(f.registerContentScripts).toHaveBeenLastCalledWith([
    expect.objectContaining({
      id: "bsk-tier-b-record-frame",
      js: ["content-scripts/record-frame.js"],
      allFrames: true,
      matchOriginAsFallback: true,
      runAt: "document_start",
      persistAcrossSessions: false,
    }),
  ]);

  // Stopping both session and recording clears all dynamic content scripts.
  f.unregisterContentScripts.mockClear();
  vi.mocked(activeRecordingCount).mockReturnValue(0);
  f.deps.sessions.release(f.task.sessionId);
  await f.deps.onSessionsChanged?.();
  expect(f.unregisterContentScripts).toHaveBeenCalledWith();
});

it("injects Tier A content.js only for controlled tabs and never flashes stale control after mid-injection detach", async () => {
  const f = await fixture();
  f.executeScript.mockClear();

  // Free uncontrolled tab in the Agent Window does not receive Tier A React bundle.
  f.onCreated.emit({ id: 99, windowId: 10 } as chrome.tabs.Tab);
  await Promise.resolve();
  expect(f.executeScript).not.toHaveBeenCalledWith(
    expect.objectContaining({ files: [OVERLAY_CONTENT_SCRIPT_FILE] }),
  );

  // Mid-injection detach race: if executeScript resolves after onDetached,
  // background re-evaluates ownership and pushes `hidden` instead of stale `control`.
  let finishOverlayInject!: () => void;
  f.executeScript.mockImplementation(async (injection: unknown) => {
    const files = (injection as { files?: string[] }).files;
    if (files?.includes(OVERLAY_CONTENT_SCRIPT_FILE)) {
      await new Promise<void>((resolve) => {
        finishOverlayInject = resolve;
      });
    }
    return [];
  });
  f.task.observedTabs = new Set([55]);
  f.deps.onAgentTabClaimed?.(55, 10);
  await vi.waitFor(() => {
    expect(f.executeScript).toHaveBeenCalledWith({
      target: { tabId: 55 },
      files: [OVERLAY_CONTENT_SCRIPT_FILE],
    });
  });
  f.onDetached.emit(55);
  finishOverlayInject();
  await vi.waitFor(() => {
    expect(f.sendMessage).toHaveBeenLastCalledWith(
      55,
      expect.objectContaining({ sessionId: null, mode: "hidden" }),
    );
  });
  expect(shouldShowAgentControlOverlay(f.overlay.snapshot())).toBe(false);
});

it("arms already-loaded cooperation frames in place and injects cooperation.js only into missing-receiver frames", async () => {
  const f = await fixture();
  const getAllFrames = vi.fn(async () => [
    { frameId: 0, documentId: "doc-live", errorOccurred: false, documentLifecycle: "active" },
    {
      frameId: 2,
      documentId: "doc-overlay-only",
      errorOccurred: false,
      documentLifecycle: "active",
    },
    { frameId: 4, documentId: "doc-missing", errorOccurred: false, documentLifecycle: "active" },
  ]);
  Object.assign(chrome.webNavigation, { getAllFrames });

  const missingOnce = new Set(["doc-missing"]);
  const overlayOnlyOnce = new Set(["doc-overlay-only"]);
  f.sendMessage.mockImplementation(
    async (_tabId: number, message: unknown, options?: { documentId?: string }) => {
      if (
        message &&
        typeof message === "object" &&
        (message as { kind?: string }).kind === "cooperation.arm_frame"
      ) {
        if (options?.documentId && missingOnce.delete(options.documentId)) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        if (options?.documentId && overlayOnlyOnce.delete(options.documentId)) {
          return undefined;
        }
        return { ok: true };
      }
      return undefined;
    },
  );
  f.executeScript.mockClear();

  f.task.agentCreatedTabs.add(77);
  f.deps.onAgentTabClaimed?.(77, 10);

  await vi.waitFor(() => {
    expect(f.executeScript).toHaveBeenCalledWith({
      target: { tabId: 77, documentIds: ["doc-missing"] },
      files: [COOPERATION_CONTENT_SCRIPT_FILE],
      injectImmediately: true,
    });
    expect(f.executeScript).toHaveBeenCalledWith({
      target: { tabId: 77, documentIds: ["doc-overlay-only"] },
      files: [COOPERATION_CONTENT_SCRIPT_FILE],
      injectImmediately: true,
    });
    expect(f.executeScript).toHaveBeenCalledWith({
      target: { tabId: 77 },
      files: [OVERLAY_CONTENT_SCRIPT_FILE],
    });
  });
  // `cooperation.js` must finish injecting before `content.js` on tab claim so `content.js`'s
  // `onMessage` listener never causes `COOPERATION_READ` to resolve `undefined`.
  const claimFiles = f.executeScript.mock.calls.map(
    ([arg]) => (arg as { files?: string[] }).files?.[0],
  );
  expect(claimFiles.lastIndexOf(COOPERATION_CONTENT_SCRIPT_FILE)).toBeLessThan(
    claimFiles.indexOf(OVERLAY_CONTENT_SCRIPT_FILE),
  );
  expect(f.executeScript).not.toHaveBeenCalledWith(
    expect.objectContaining({
      target: { tabId: 77, documentIds: ["doc-live"] },
      files: [COOPERATION_CONTENT_SCRIPT_FILE],
    }),
  );
  expect(f.executeScript).not.toHaveBeenCalledWith(
    expect.objectContaining({
      target: { tabId: 77, allFrames: true },
      files: [COOPERATION_CONTENT_SCRIPT_FILE],
    }),
  );

  // Outermost-frame `onCommitted` also repairs `cooperation.js` strictly before `content.js`.
  f.executeScript.mockClear();
  missingOnce.add("doc-committed-nav");
  f.onCommitted.emit({
    tabId: 77,
    frameId: 0,
    frameType: "outermost_frame",
    documentId: "doc-committed-nav",
  } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
  await vi.waitFor(() => {
    expect(f.executeScript).toHaveBeenCalledWith({
      target: { tabId: 77, documentIds: ["doc-committed-nav"] },
      files: [OVERLAY_CONTENT_SCRIPT_FILE],
    });
  });
  expect(f.executeScript.mock.calls.map(([arg]) => arg)).toEqual([
    {
      target: { tabId: 77, documentIds: ["doc-committed-nav"] },
      files: [COOPERATION_CONTENT_SCRIPT_FILE],
      injectImmediately: true,
    },
    {
      target: { tabId: 77, documentIds: ["doc-committed-nav"] },
      files: [OVERLAY_CONTENT_SCRIPT_FILE],
    },
  ]);
});
