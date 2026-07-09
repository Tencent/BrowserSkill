import { i18n } from "@browser-skill/i18n";
import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { ConnectionController } from "@/lib/connection-controller";
import {
  getConnectionEnabled,
  setConnectionEnabled as persistConnectionEnabled,
  setLabel,
} from "@/lib/instance-id";
import { startKeepalive } from "@/lib/keepalive";
import {
  OVERLAY_MSG_INTERRUPT,
  OVERLAY_MSG_WHO_AM_I,
  type OverlayInterruptRequest,
  type OverlayInterruptResponse,
  type OverlayMessage,
} from "@/lib/overlay-bridge";
import { POPUP_PORT_NAME, type PopupInbound, type PopupOutbound } from "@/lib/popup-bridge";
import { attachSessionsLiveFlag } from "@/lib/sessions-live-flag";
import { attachSessionEventHandler } from "@/session-manager/event-handler";
import { SessionManager } from "@/session-manager/manager";
import {
  attachBorrowNotificationButtonHandler,
  attachBorrowNotificationClickHandler,
  type BorrowNotificationCopy,
  defaultBorrowChromeNotifications,
  defaultBorrowChromeWindows,
  requestBorrowConfirmation,
} from "@/tools/borrow-confirmation";
import { ToolDispatcher } from "@/tools/dispatcher";
import { detectBrowserMeta } from "@/transport/handshake";
import type { Transport } from "@/transport/transport";
import { WSTransport } from "@/transport/ws-transport";

export const DEFAULT_DAEMON_PORT = 52800;

export default defineBackground(() => {
  const port = DEFAULT_DAEMON_PORT;
  const controller = new ConnectionController();
  const transport = new WSTransport({ url: `ws://127.0.0.1:${port}` });
  const sessions = new SessionManager();
  const cdp = new ChromiumCdp();
  const sessionsLive = attachSessionsLiveFlag({ manager: sessions });
  // Re-sync the storage.session flag on SW startup so a previous SW's
  // stale `true` does not keep waking us on every page load until the
  // first mutation (review M4/M5 round 3 m-R3-1).
  void sessionsLive.refresh();
  const dispatcher = new ToolDispatcher({
    transport,
    sessions,
    cdp,
    onSessionsChanged: () => {
      void sessionsLive.syncFromManager();
    },
    approveBorrow: (ctx) =>
      requestBorrowConfirmation(ctx.tabId, {
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        deps: {
          // Skip every Agent Window when choosing where to render the
          // overlay — Agent Windows boot on about:blank, which has no
          // content script, so sendMessage would fail-open and silently
          // allow the borrow without any UI shown.
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
  // Without this listener those button clicks would land nowhere and we'd
  // be back to fail-open-after-sendMessage-failure.
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
    onSessionsChanged: () => {
      void sessionsLive.syncFromManager();
    },
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

  void (async () => {
    const connectionEnabled = await getConnectionEnabled();
    await controller.attach(transport, detectBrowserMeta(), connectionEnabled);
  })().catch((err) => {
    console.error("[browser-skill] controller failed to attach", err);
  });

  chrome.runtime.onMessage.addListener((rawMsg, sender, sendResponse) => {
    const msg = rawMsg as OverlayMessage | undefined;
    if (!msg || typeof msg !== "object" || !("kind" in msg)) return false;

    if (msg.kind === OVERLAY_MSG_WHO_AM_I) {
      const windowId = sender.tab?.windowId;
      const ctx = typeof windowId === "number" ? sessions.findByWindowId(windowId) : null;
      sendResponse({ sessionId: ctx?.sessionId ?? null });
      return false;
    }

    if (msg.kind === OVERLAY_MSG_INTERRUPT) {
      const req = msg as OverlayInterruptRequest;
      void handleOverlayInterrupt(transport, req.sessionId).then((reply) => {
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
