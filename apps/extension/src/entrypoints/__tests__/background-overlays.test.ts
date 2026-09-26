import { afterEach, expect, it, vi } from "vitest";
import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { OverlayController, shouldShowAgentControlOverlay } from "@/content/overlay-controller";
import { watchDaemonConnection } from "@/lib/daemon-connection-preference";
import { OVERLAY_AGENT_STATE, type OverlayAgentStateMessage } from "@/lib/overlay-bridge";
import { attachSessionsLiveFlag } from "@/lib/sessions-live-flag";
import { isAgentControlledTab } from "@/session-manager/manager";
import { ToolDispatcher } from "@/tools/dispatcher";

vi.hoisted(() => {
  Object.assign(globalThis, { defineBackground: (main: unknown) => main });
});

// Keep background's real overlay wiring and SessionManager; isolate unrelated
// startup services so no transport, storage or browser connection is opened.
vi.mock("@/browser-driver/chromium-cdp");
vi.mock("@/debug/archive");
vi.mock("@/debug/bridge");
vi.mock("@/debug/manager");
vi.mock("@/lib/audit");
vi.mock("@/lib/audit-bridge");
vi.mock("@/lib/connection-controller");
vi.mock("@/lib/daemon-connection-preference");
vi.mock("@/lib/heartbeat");
vi.mock("@/lib/instance-id");
vi.mock("@/lib/interaction-preferences");
vi.mock("@/lib/keepalive");
vi.mock("@/lib/recording/frame-coordinator");
vi.mock("@/lib/sessions-live-flag");
vi.mock("@/long-screenshot/background");
vi.mock("@/session-manager/event-handler");
vi.mock("@/session-manager/agent-window", () => ({
  AGENT_WINDOW_HOME: "about:blank",
  chromeAgentWindowApi: {
    create: async () => ({ windowId: 10, initialTabIds: [10] }),
    ensureActiveTab: async () => 10,
  },
}));
vi.mock("@/tools/borrow-confirmation");
vi.mock("@/tools/dispatcher");
vi.mock("@/tools/record");
vi.mock("@/transport/handshake");
vi.mock("@/transport/remote-authorization");
vi.mock("@/transport/ws-transport");

import background from "@/entrypoints/background";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function event<T extends unknown[] = []>() {
  const listeners: Array<(...args: T) => void> = [];
  return {
    addListener: (listener: (...args: T) => void) => listeners.push(listener),
    emit: (...args: T) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

async function fixture() {
  const overlay = new OverlayController();
  const onDetached = event<[number]>();
  const sendMessage = vi.fn(async (_tabId: number, message: OverlayAgentStateMessage) => {
    overlay.applyAgentControlMode(message.sessionId, message.mode);
  });
  vi.stubGlobal("chrome", {
    tabs: {
      sendMessage,
      onDetached,
      onActivated: event(),
      onUpdated: event(),
      onCreated: event(),
      onAttached: event(),
      onRemoved: event(),
    },
    debugger: { onDetach: event() },
    runtime: { onMessage: event(), onConnect: event() },
    notifications: { onClicked: event(), onButtonClicked: event() },
  });
  vi.mocked(watchDaemonConnection).mockReturnValue({ ready: Promise.resolve(), dispose() {} });
  vi.mocked(attachSessionsLiveFlag).mockReturnValue({
    refresh: vi.fn(async () => {}),
    syncFromManager: vi.fn(async () => {}),
  });
  vi.mocked(ChromiumCdp.prototype.releaseSessionTab).mockResolvedValue();
  (background as unknown as () => void)();
  const deps = vi.mocked(ToolDispatcher).mock.calls.at(-1)![0];
  const task = await deps.sessions.start("one");
  return { overlay, onDetached, sendMessage, deps, task };
}

it.each([false, true])("hides an observed tab after detachment, remote=%s", async (remote) => {
  const f = await fixture();
  f.task.remote = remote;
  f.task.observedTabs = new Set([20]);
  f.deps.onAgentTabClaimed?.(20, 10);
  expect(shouldShowAgentControlOverlay(f.overlay.snapshot())).toBe(true);
  f.onDetached.emit(20);
  expect(isAgentControlledTab(f.task, 20)).toBe(false);
  expect(f.sendMessage).toHaveBeenLastCalledWith(20, {
    type: OVERLAY_AGENT_STATE,
    sessionId: null,
    mode: "hidden",
    generation: 0,
  });
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
