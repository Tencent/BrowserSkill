import { i18n } from "@browser-skill/i18n";
import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { ConnectionController } from "@/lib/connection-controller";
import { startHeartbeat } from "@/lib/heartbeat";
import {
  getConnectionEnabled,
  setConnectionEnabled as persistConnectionEnabled,
  setLabel,
} from "@/lib/instance-id";
import { startKeepalive } from "@/lib/keepalive";
import {
  OVERLAY_AGENT_STATE,
  OVERLAY_AUTOMATION_BYPASS,
  OVERLAY_MSG_INTERRUPT,
  OVERLAY_MSG_READY,
  OVERLAY_MSG_WHO_AM_I,
  type OverlayAgentStateMessage,
  type OverlayInterruptRequest,
  type OverlayInterruptResponse,
  type OverlayMessage,
  type OverlayMode,
} from "@/lib/overlay-bridge";
import { POPUP_PORT_NAME, type PopupInbound, type PopupOutbound } from "@/lib/popup-bridge";
import { recordFrameCoordinator } from "@/lib/recording/frame-coordinator";
import { attachSessionsLiveFlag } from "@/lib/sessions-live-flag";
import { createDisconnectCleanup } from "@/session-manager/disconnect-cleanup";
import { attachSessionEventHandler } from "@/session-manager/event-handler";
import { isAgentControlledTab, SessionManager } from "@/session-manager/manager";
import {
  attachBorrowNotificationButtonHandler,
  attachBorrowNotificationClickHandler,
  type BorrowNotificationCopy,
  defaultBorrowChromeNotifications,
  defaultBorrowChromeWindows,
  requestBorrowConfirmation,
} from "@/tools/borrow-confirmation";
import { ToolDispatcher } from "@/tools/dispatcher";
import {
  attachRecordFinishListener,
  attachRecordQueryListener,
  attachRecordStepListener,
  type RecordRuntimeDeps,
} from "@/tools/record";
import { chromeTabsApi } from "@/tools/shared";
import { chromeTabMutationApi } from "@/tools/tabs";
import { detectBrowserMeta } from "@/transport/handshake";
import type { Transport } from "@/transport/transport";
import { WSTransport } from "@/transport/ws-transport";

export default defineBackground(() => {
  const controller = new ConnectionController();
  const transport = new WSTransport({ url: __BSK_DAEMON_WS_URL__ });
  const sessions = new SessionManager();
  const cdp = new ChromiumCdp();
  const sessionsLive = attachSessionsLiveFlag({ manager: sessions });
  let overlayGeneration = 0;
  const controlModes = new Map<string, OverlayMode>();

  function setControlMode(sessionId: string, mode: OverlayMode): void {
    if (controlModes.get(sessionId) === mode) return;
    controlModes.set(sessionId, mode);
    overlayGeneration += 1;
    const ctx = sessions.get(sessionId);
    if (ctx) void pushOverlayStateForWindow(ctx.agentWindowId);
  }

  function overlayStateForWindow(windowId?: number): OverlayAgentStateMessage {
    const ctx = typeof windowId === "number" ? sessions.findByWindowId(windowId) : null;
    if (!ctx) {
      return {
        type: OVERLAY_AGENT_STATE,
        sessionId: null,
        mode: "hidden",
        generation: overlayGeneration,
      };
    }
    return {
      type: OVERLAY_AGENT_STATE,
      sessionId: ctx.sessionId,
      mode: controlModes.get(ctx.sessionId) ?? "control",
      generation: overlayGeneration,
    };
  }

  /**
   * Authoritative overlay state for a specific tab. Agent Window tabs are
   * free by default; only tabs explicitly claimed through session startup,
   * `tab_create`, or `tab_borrow` receive the control overlay.
   */
  function overlayStateForTab(tabId?: number, windowId?: number): OverlayAgentStateMessage {
    if (typeof tabId === "number" && typeof windowId === "number") {
      const ctx = sessions.findByWindowId(windowId);
      if (ctx && isAgentControlledTab(ctx, tabId)) return overlayStateForWindow(windowId);
    }
    return {
      type: OVERLAY_AGENT_STATE,
      sessionId: null,
      mode: "hidden",
      generation: overlayGeneration,
    };
  }

  async function pushOverlayStateToTab(
    tabId: number,
    state: OverlayAgentStateMessage,
  ): Promise<void> {
    try {
      await chrome.tabs.sendMessage(tabId, state);
    } catch {
      // Restricted pages and not-yet-loaded content scripts cannot receive messages.
    }
  }

  async function pushOverlayStateForTab(tabId: number, windowId?: number): Promise<void> {
    const state = overlayStateForTab(tabId, windowId);
    await pushOverlayStateToTab(tabId, state);
  }

  async function pushOverlayStateForWindow(windowId: number): Promise<void> {
    const tabs = await chrome.tabs.query({ windowId });
    await Promise.all(
      tabs.map((tab) => {
        if (typeof tab.id !== "number") return Promise.resolve();
        return pushOverlayStateForTab(tab.id, windowId);
      }),
    );
  }

  function pushAllAgentOverlayStates(): void {
    const windowIds = new Set(sessions.list().map((ctx) => ctx.agentWindowId));
    for (const windowId of windowIds) {
      void pushOverlayStateForWindow(windowId);
    }
  }

  function onOverlaySessionStateChanged(): void {
    void sessionsLive.syncFromManager();
    const liveSessionIds = new Set(sessions.list().map((ctx) => ctx.sessionId));
    for (const sessionId of controlModes.keys()) {
      if (!liveSessionIds.has(sessionId)) controlModes.delete(sessionId);
    }
    overlayGeneration += 1;
    pushAllAgentOverlayStates();
  }

  function onBrowserControlResumed(sessionId: string): void {
    const ctx = sessions.get(sessionId);
    if (!ctx) return;
    setControlMode(sessionId, "control");
  }

  function pushOverlayStateForAgentWindow(windowId: number): void {
    if (!sessions.findByWindowId(windowId)) return;
    void pushOverlayStateForWindow(windowId);
  }
  chrome.tabs.onActivated.addListener((activeInfo) => {
    pushOverlayStateForAgentWindow(activeInfo.windowId);
  });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") return;
    if (typeof tab.windowId !== "number") return;
    pushOverlayStateForAgentWindow(tab.windowId);
  });
  // Newly observed tabs are free unless the agent's own creation path has
  // already claimed their concrete id. This listener only renders that
  // state; it never infers or mutates ownership from event ordering.
  chrome.tabs.onCreated.addListener((tab) => {
    if (typeof tab.windowId !== "number" || typeof tab.id !== "number") return;
    if (!sessions.findByWindowId(tab.windowId)) return;
    void pushOverlayStateForTab(tab.id, tab.windowId);
  });
  // Re-sync the storage.session flag on SW startup so a previous SW's
  // stale `true` does not keep waking us on every page load until the
  // first mutation (review M4/M5 round 3 m-R3-1).
  void sessionsLive.refresh();
  const cleanupAfterDisconnect = createDisconnectCleanup({
    manager: sessions,
    // Same contract as the dispatcher's `tool.session_stop`: without these
    // deps the agent-tab cleanup and the window-release path are dead code.
    sessionStopDeps: {
      cdp,
      tabManagement: { tabs: chromeTabMutationApi },
      tabsQuery: chromeTabsApi,
    },
    onSessionsChanged: () => {
      void sessionsLive.syncFromManager();
    },
  });
  const recordDeps = {
    tabsApi: chrome.tabs,
    cdp,
    frameCoordinator: recordFrameCoordinator,
    sendToTab: (tabId: number, msg: Parameters<typeof chrome.tabs.sendMessage>[1]) =>
      chrome.tabs.sendMessage(tabId, msg),
    bypassOverlay: async (tabId: number, enabled: boolean) => {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: OVERLAY_AUTOMATION_BYPASS,
          enabled,
        });
      } catch {
        // Content script may be unavailable on restricted pages.
      }
    },
  } satisfies RecordRuntimeDeps;
  recordFrameCoordinator.attach();
  attachRecordStepListener(recordDeps);
  attachRecordFinishListener(recordDeps);
  attachRecordQueryListener(recordDeps);

  const dispatcher = new ToolDispatcher({
    transport,
    sessions,
    cdp,
    recording: recordDeps,
    onSessionsChanged: onOverlaySessionStateChanged,
    onBrowserControlResumed,
    approveBorrow: (ctx) =>
      requestBorrowConfirmation(ctx.tabId, {
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        deps: {
          // Skip every Agent Window when choosing where to render the
          // overlay — Agent Windows boot on about:blank, which has no
          // content script, so they cannot surface an authorization decision.
          isAgentWindowId: (windowId) => sessions.findByWindowId(windowId) !== null,
          // Resolve i18n strings per-borrow so language switches take effect
          // without re-creating the dispatcher.
          notificationCopy: makeBorrowNotificationCopy(),
        },
      }),
    helpNotificationCopy: () => ({
      title: i18n.t("helpRequest.notificationTitle", { ns: "extension" }),
      body: "",
    }),
  });
  dispatcher.start();
  if (typeof chrome.notifications?.onClicked?.addListener === "function") {
    attachBorrowNotificationClickHandler({
      onClicked: chrome.notifications.onClicked,
      windows: defaultBorrowChromeWindows,
      notifications: defaultBorrowChromeNotifications,
    });
  } else {
    console.warn(
      "[browser-skill] chrome.notifications unavailable; borrow notifications will be skipped",
    );
  }
  // The Allow / Deny buttons on the OS notification are the *explicit*
  // authorization fallback when every candidate user window's content
  // script was missing (extension just reloaded, page in BFCache, etc.).
  // Without this listener those button clicks would land nowhere and the
  // request would only resolve via the fail-closed background timeout.
  if (typeof chrome.notifications?.onButtonClicked?.addListener === "function") {
    attachBorrowNotificationButtonHandler({
      onButtonClicked: chrome.notifications.onButtonClicked,
    });
  } else {
    console.warn(
      "[browser-skill] chrome.notifications.onButtonClicked unavailable; borrow Allow/Deny buttons will be inactive",
    );
  }
  attachSessionEventHandler({
    manager: sessions,
    transport,
    cdp,
    onSessionsChanged: onOverlaySessionStateChanged,
  });

  // MV3 service worker keepalive + reconnect supervisor (review M4/M5
  // C3 + C4). Every 30s the alarm wakes the SW; if the transport is
  // not connected we force a fresh connect attempt so we never sit on
  // a stale `disconnected` state when the setTimeout-based reconnect
  // dies with the SW. Reconnect is skipped when the user has disabled
  // the BrowserSkill connection.
  startKeepalive({
    transport,
    shouldConnect: () => controller.isConnectionEnabled,
  });

  // Application-level heartbeat (Chrome 116+): while the post-handshake
  // link is live, beat every 20s so WebSocket activity keeps the service
  // worker — and thus the daemon connection — alive during use, rather
  // than depending on the boundary-hugging 30s keepalive alarm. The
  // daemon also uses these beats to reap a silently-dead browser.
  startHeartbeat({
    send: (frame) => transport.send(frame),
    onActiveChange: (cb) =>
      controller.subscribe((snap) =>
        cb(snap.state === "connected" || snap.state === "version_skew"),
      ),
  });

  // Wake-driven reconnect (best effort). An MV3 service worker is killed
  // across OS sleep regardless of any keepalive, and the setTimeout-based
  // transport backoff dies with it. These Chrome lifecycle events revive
  // the worker and let us reconnect immediately instead of waiting for
  // the next 30s alarm tick. They only help when the daemon is actually
  // running; a cold daemon is (re)spawned by the next `bsk` command.
  const reconnectIfNeeded = () => {
    if (!controller.isConnectionEnabled) return;
    if (transport.state === "connected") return;
    void transport.connect().catch((err) => {
      console.debug("[browser-skill] wake reconnect attempt failed", err);
    });
  };
  if (typeof chrome.runtime?.onStartup?.addListener === "function") {
    chrome.runtime.onStartup.addListener(reconnectIfNeeded);
  }
  if (typeof chrome.idle?.onStateChanged?.addListener === "function") {
    chrome.idle.onStateChanged.addListener((state) => {
      // "active" fires when the user returns from idle/locked — the most
      // reliable "machine just woke" signal we get.
      if (state === "active") reconnectIfNeeded();
    });
    // Treat >60s of no input as idle so the active transition is timely.
    chrome.idle.setDetectionInterval?.(60);
  }

  void (async () => {
    const connectionEnabled = await getConnectionEnabled();
    await controller.attach(transport, detectBrowserMeta(), connectionEnabled, {
      beforeDisconnect: async () => {
        const report = await cleanupAfterDisconnect();
        if (report.failures.length > 0) {
          console.warn("[browser-skill] session cleanup before disconnect was incomplete", report);
        }
      },
      onDisconnected: async () => {
        const report = await cleanupAfterDisconnect();
        if (report.failures.length > 0) {
          console.warn("[browser-skill] session cleanup after disconnect was incomplete", report);
        }
      },
    });
  })().catch((err) => {
    console.error("[browser-skill] controller failed to attach", err);
  });

  chrome.runtime.onMessage.addListener((rawMsg, sender, sendResponse) => {
    const msg = rawMsg as OverlayMessage | undefined;
    if (!msg || typeof msg !== "object" || !("kind" in msg)) return false;

    if (msg.kind === OVERLAY_MSG_WHO_AM_I) {
      const tabId = sender.tab?.id;
      const windowId = sender.tab?.windowId;
      const ctx = typeof windowId === "number" ? sessions.findByWindowId(windowId) : null;
      const sessionId =
        ctx && typeof tabId === "number" && isAgentControlledTab(ctx, tabId) ? ctx.sessionId : null;
      sendResponse({ sessionId });
      return false;
    }

    if (msg.kind === OVERLAY_MSG_READY) {
      // Resolve from explicit tab ownership before sending so free tabs never
      // flash the control mask.
      if (typeof sender.tab?.id === "number") {
        void pushOverlayStateForTab(sender.tab.id, sender.tab.windowId);
      }
      return false;
    }

    if (msg.kind === OVERLAY_MSG_INTERRUPT) {
      const req = msg as OverlayInterruptRequest;
      const ctx = sessions.get(req.sessionId);
      if (ctx) setControlMode(req.sessionId, "interrupting");
      void handleOverlayInterrupt(transport, req.sessionId).then((reply) => {
        if (reply.ok && sessions.get(req.sessionId)) {
          setControlMode(req.sessionId, "paused");
        }
        sendResponse(reply);
      });
      return true; // keep channel open
    }
    return false;
  });

  chrome.runtime.onConnect.addListener((connection) => {
    if (connection.name !== POPUP_PORT_NAME) return;
    const post = (msg: PopupInbound) => {
      try {
        connection.postMessage(msg);
      } catch (err) {
        console.debug("[browser-skill] popup post failed", err);
      }
    };
    const unsubscribe = controller.subscribe((snap) => {
      post({ kind: "snapshot", data: snap });
    });
    connection.onMessage.addListener((raw: unknown) => {
      const msg = raw as PopupOutbound;
      if (msg && typeof msg === "object" && "kind" in msg) {
        if (msg.kind === "set_label") {
          void setLabel(msg.value).then(() => controller.refreshLabel());
        } else if (msg.kind === "set_port") {
          // Placeholder for the future custom-port UI; warn loudly so
          // any reintroduced popup control is caught instead of
          // silently doing nothing (review M4/M5 C2).
          console.warn("[browser-skill] set_port is not wired yet; ignoring", msg.value);
        } else if (msg.kind === "set_connection_enabled") {
          void controller
            .setConnectionEnabled(msg.value)
            .then(() => persistConnectionEnabled(msg.value));
        }
      }
    });
    connection.onDisconnect.addListener(() => unsubscribe());
  });

  // Stash on globalThis so the SW DevTools can poke at internals.
  // Dev-only to avoid leaking internals to inspectors in shipped builds
  // (review M4/M5 M4).
  if (import.meta.env.DEV) {
    const dbg = globalThis as unknown as {
      __bskController?: ConnectionController;
      __bhSessions?: SessionManager;
      __bhDispatcher?: ToolDispatcher;
    };
    dbg.__bskController = controller;
    dbg.__bhSessions = sessions;
    dbg.__bhDispatcher = dispatcher;
  }

  console.info("[browser-skill] background worker initialised");
});

/**
 * Push a `session.user_interrupt` event to the daemon for `sessionId`.
 * Returns `{ ok: true }` when `transport.send` accepts the frame and
 * `{ ok: false }` when it throws (sink closed, transport not yet
 * connected, etc.). The daemon-side cancellation is fire-and-forget
 * — a failure here just means the user will need to retry the
 * interrupt; no daemon state is left half-updated.
 */
export async function handleOverlayInterrupt(
  transport: Pick<Transport, "send">,
  sessionId: string,
): Promise<OverlayInterruptResponse> {
  try {
    transport.send({
      event: "session.user_interrupt",
      payload: { session_id: sessionId },
    });
    return { ok: true };
  } catch (err) {
    console.warn("[browser-skill] failed to send session.user_interrupt", err);
    return { ok: false };
  }
}

function makeBorrowNotificationCopy(): BorrowNotificationCopy {
  return {
    title: i18n.t("borrowConfirmation.notificationTitle", { ns: "extension" }),
    body: (tabTitle: string) =>
      i18n.t("borrowConfirmation.notificationBody", { ns: "extension", tabTitle }),
    iconUrl: "icon/logo.png",
    allowButton: i18n.t("borrowConfirmation.allow", { ns: "extension" }),
    denyButton: i18n.t("borrowConfirmation.deny", { ns: "extension" }),
  };
}
