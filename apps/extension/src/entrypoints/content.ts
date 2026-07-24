import { i18n } from "@browser-skill/i18n";
import { I18nextProvider } from "@browser-skill/i18n/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { BorrowConfirmationOverlay } from "@/content/BorrowConfirmationOverlay";
import { ControlOverlay } from "@/content/ControlOverlay";
import { HelpRequestOverlay } from "@/content/HelpRequestOverlay";
import overlayCss from "@/content/overlay.css?inline";
import { OverlayController, shouldShowAgentControlOverlay } from "@/content/overlay-controller";
import { RecordOverlay } from "@/content/RecordOverlay";
import {
  handleRecordContentMessage,
  isRecordContentMessage,
  type RecordCaptureController,
} from "@/content/record-capture";
import {
  HELP_ACK,
  HELP_FINISH,
  HELP_QUERY,
  type HelpAckMessage,
  type HelpCancelMessage,
  type HelpFinishMessage,
  type HelpQueryResponse,
  type HelpRequestMessage,
  isHelpCancelMessage,
  isHelpRequestMessage,
} from "@/lib/help-bridge";
import {
  isOverlayAgentOverlayResetMessage,
  OVERLAY_AUTOMATION_BYPASS,
  OVERLAY_HOST_MARKER_ATTR,
  OVERLAY_HOST_NAME,
  OVERLAY_MSG_WHO_AM_I,
  type OverlayAgentOverlayResetMessage,
  type OverlayAutomationBypassMessage,
  type OverlayWhoAmIResponse,
} from "@/lib/overlay-bridge";
import { sendInterrupt } from "@/lib/overlay-interrupt-client";
import {
  RECORD_FINISH,
  RECORD_QUERY,
  type RecordStartAck,
  type RecordStopAck,
} from "@/lib/record-bridge";
import { SESSIONS_LIVE_FLAG_KEY } from "@/lib/sessions-live-flag";
import type {
  BorrowCancelMessage,
  BorrowRequestMessage,
  BorrowResponseMessage,
} from "@/tools/borrow-confirmation";

// Run at document_end so the overlay does not block first paint. Only attach
// in the top-level frame so iframes do not double-render overlays.
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  allFrames: false,
  cssInjectionMode: "ui",

  async main(ctx) {
    if (window.top !== window) return;

    const overlays = new OverlayController();
    let recordCapture: RecordCaptureController | null = null;
    let activeRecordRequestId: string | null = null;
    let reactRoot: ReactDOM.Root | null = null;
    let overlayHost: HTMLElement | null = null;
    let hostLossReported = false;
    let remountInProgress = false;

    const ui = await createShadowRootUi(ctx, {
      name: OVERLAY_HOST_NAME,
      position: "inline",
      anchor: "html",
      css: overlayCss,
      onMount(container, _shadow, shadowHost) {
        shadowHost.setAttribute("aria-hidden", "true");
        shadowHost.setAttribute(OVERLAY_HOST_MARKER_ATTR, "");
        overlayHost = shadowHost;
        hostLossReported = false;
        const app = document.createElement("div");
        app.className = "bsk-overlay-root";
        container.append(app);
        reactRoot = ReactDOM.createRoot(app);
        renderOverlay();
        return reactRoot;
      },
      onRemove(root) {
        overlayHost = null;
        root?.unmount();
        reactRoot = null;
      },
    });

    function renderOverlay() {
      const overlayState = overlays.snapshot();
      reactRoot?.render(
        React.createElement(
          I18nextProvider,
          { i18n },
          React.createElement(
            React.Fragment,
            null,
            React.createElement(BorrowConfirmationOverlay, {
              requests: overlayState.borrowRequests,
            }),
            React.createElement(ControlOverlay, {
              visible: shouldShowAgentControlOverlay(overlayState),
              interrupting: overlayState.interrupting,
              automationBypass: overlayState.automationBypassCount > 0,
              onInterrupt: handleInterrupt,
            }),
            React.createElement(HelpRequestOverlay, { request: overlayState.activeHelp }),
            React.createElement(RecordOverlay, { request: overlayState.activeRecord }),
          ),
        ),
      );
    }

    function resetAgentOverlayState(sessionId: string) {
      const previousHelp = overlays.resetAgentOverlays(sessionId);
      if (previousHelp) {
        void sendHelpFinish(previousHelp.id, "cancelled");
      }
      recordCapture?.dispose();
      recordCapture = null;
      activeRecordRequestId = null;
      renderOverlay();
    }

    function handleInterrupt() {
      const state = overlays.snapshot();
      if (state.interrupting) return;
      const sessionId = state.activeSessionId;
      if (!sessionId) {
        console.warn("[bsk overlay] interrupt requested with no active session id");
        return;
      }
      overlays.setInterrupting(true);
      renderOverlay();
      void sendInterrupt((msg) => chrome.runtime.sendMessage(msg), sessionId).then((reply) => {
        // Always retract the mask after the round trip resolves
        // (success, failure, or timeout). Cancellation is fire-and-
        // forget on the daemon side; the user must not be stuck
        // behind a transient issue. The Agent Window stays open.
        resetAgentOverlayState(sessionId);
        if (!reply.ok) {
          console.warn("[bsk overlay] interrupt did not get a clean ack from daemon");
        }
      });
    }

    const onMessage = (
      message:
        | BorrowRequestMessage
        | BorrowCancelMessage
        | HelpRequestMessage
        | HelpCancelMessage
        | OverlayAgentOverlayResetMessage
        | OverlayAutomationBypassMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: BorrowResponseMessage | HelpAckMessage) => void,
    ) => {
      if (isRecordContentMessage(message)) {
        const needsAsync = handleRecordContentMessage(
          message,
          {
            activeRequestId: activeRecordRequestId,
            capture: recordCapture,
            setActiveRequestId: (id) => {
              activeRecordRequestId = id;
            },
            setCapture: (capture) => {
              recordCapture = capture;
            },
            onStart: (requestId) => {
              overlays.setAgentRecordRequest({
                id: requestId,
                onFinish: () => {
                  void chrome.runtime.sendMessage({
                    type: RECORD_FINISH,
                    requestId,
                  });
                },
              });
              renderOverlay();
            },
            onStop: () => {
              overlays.clearAgentRecordRequest(activeRecordRequestId ?? undefined);
              renderOverlay();
            },
          },
          sendResponse as unknown as
            | ((response: RecordStartAck | RecordStopAck) => void)
            | undefined,
        );
        return needsAsync;
      }

      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === OVERLAY_AUTOMATION_BYPASS
      ) {
        const bypassMsg = message as OverlayAutomationBypassMessage;
        overlays.setAutomationBypass(bypassMsg.enabled);
        renderOverlay();
        return false;
      }

      if (isOverlayAgentOverlayResetMessage(message)) {
        resetAgentOverlayState(message.sessionId);
        return false;
      }

      if (message.type === "borrow-cancel") {
        overlays.removeBorrowRequest(message.requestId);
        renderOverlay();
        return false;
      }

      if (isHelpCancelMessage(message)) {
        const state = overlays.snapshot();
        if (state.activeHelp && state.activeHelp.id === message.requestId) {
          overlays.clearAgentHelpRequest(message.requestId);
          renderOverlay();
        }
        return false;
      }

      if (isHelpRequestMessage(message)) {
        const helpMsg = message as HelpRequestMessage;
        const previousHelp = overlays.setAgentHelpRequest({
          id: helpMsg.requestId,
          prompt: helpMsg.prompt,
          ...(helpMsg.title ? { title: helpMsg.title } : {}),
          ...(helpMsg.displayMode ? { displayMode: helpMsg.displayMode } : {}),
          selectors: helpMsg.selectors,
          onContinue: (note: string) =>
            void sendHelpFinish(helpMsg.requestId, "continued", note.trim() ? note : undefined),
          onCancel: () => void sendHelpFinish(helpMsg.requestId, "cancelled"),
        });
        if (previousHelp && previousHelp.id !== helpMsg.requestId) {
          void sendHelpFinish(previousHelp.id, "cancelled");
        }
        renderOverlay();
        sendResponse({ type: HELP_ACK, ok: true });
        return false;
      }

      if (message.type === "borrow-request") {
        let responded = false;
        const respond = (allowed: boolean) => {
          if (responded) return;
          responded = true;
          sendResponse({ type: "borrow-response", allowed });
          overlays.removeBorrowRequest(message.requestId);
          renderOverlay();
        };

        overlays.addBorrowRequest({
          id: message.requestId,
          isActiveTab: message.isActiveTab,
          tabTitle: message.tabTitle,
          timeoutMs: message.timeoutMs,
          onAllow: () => respond(true),
          onDeny: () => respond(false),
        });
        renderOverlay();
        return true;
      }

      return false;
    };

    async function sendHelpFinish(
      requestId: string,
      outcome: "continued" | "cancelled",
      note?: string,
    ): Promise<void> {
      const msg: HelpFinishMessage = {
        type: HELP_FINISH,
        requestId,
        outcome,
        ...(note ? { note } : {}),
      };
      overlays.clearAgentHelpRequest(requestId);
      renderOverlay();
      await chrome.runtime.sendMessage(msg).catch((err) => {
        console.debug("[bsk overlay] help finish failed", err);
      });
    }

    function mountHelpRequest(helpMsg: Omit<HelpRequestMessage, "type">): void {
      overlays.setAgentHelpRequest({
        id: helpMsg.requestId,
        prompt: helpMsg.prompt,
        ...(helpMsg.title ? { title: helpMsg.title } : {}),
        ...(helpMsg.displayMode ? { displayMode: helpMsg.displayMode } : {}),
        selectors: helpMsg.selectors,
        onContinue: (note: string) =>
          void sendHelpFinish(helpMsg.requestId, "continued", note.trim() ? note : undefined),
        onCancel: () => void sendHelpFinish(helpMsg.requestId, "cancelled"),
      });
    }

    async function queryActiveHelpWithRetry(): Promise<boolean> {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const helpQuery = (await chrome.runtime.sendMessage({
            type: HELP_QUERY,
          })) as HelpQueryResponse | undefined;
          if (helpQuery?.active && helpQuery.request) {
            mountHelpRequest(helpQuery.request);
            renderOverlay();
            return true;
          }
        } catch (err) {
          console.debug("[bsk overlay] help query failed", err);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
      return false;
    }

    async function syncAgentOverlay(): Promise<void> {
      if (!(await anySessionLive())) return;
      try {
        const helpActive = await queryActiveHelpWithRetry();
        const reply = (await chrome.runtime.sendMessage({
          kind: OVERLAY_MSG_WHO_AM_I,
        })) as OverlayWhoAmIResponse | undefined;
        if (!reply?.sessionId) return;

        // Query / re-arm recording *before* activating the control overlay so
        // record start (navigate → content load) does not flash
        // 「Agent 正在控制」before RecordOverlay mounts.
        let recordQuery: { active?: boolean; requestId?: string } | undefined;
        try {
          recordQuery = (await chrome.runtime.sendMessage({
            type: RECORD_QUERY,
          })) as { active?: boolean; requestId?: string } | undefined;
        } catch (err) {
          console.debug("[bsk overlay] record query failed", err);
        }

        if (
          recordQuery?.active &&
          typeof recordQuery.requestId === "string" &&
          overlays.snapshot().activeRecord === null
        ) {
          const requestId = recordQuery.requestId;
          overlays.setAgentRecordRequest({
            id: requestId,
            onFinish: () => {
              void chrome.runtime.sendMessage({
                type: RECORD_FINISH,
                requestId,
              });
            },
          });
        }

        if (!helpActive && overlays.snapshot().activeHelp === null) {
          void queryActiveHelpWithRetry();
        }

        overlays.activateAgentSession(reply.sessionId);
        renderOverlay();
      } catch (err) {
        console.debug("[bsk overlay] syncAgentOverlay failed", err);
      }
    }

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void syncAgentOverlay();
    };

    ui.mount();
    chrome.runtime.onMessage.addListener(onMessage);
    void syncAgentOverlay();

    window.addEventListener("pageshow", onPageShow);

    const hostObserver = new MutationObserver(() => {
      const connected = overlayHost?.isConnected ?? false;
      if (overlays.isControlVisible() && !connected && !hostLossReported) {
        hostLossReported = true;
        if (!remountInProgress) {
          remountInProgress = true;
          try {
            ui.mount();
            void syncAgentOverlay();
          } finally {
            remountInProgress = false;
          }
        }
      }
      if (connected) {
        hostLossReported = false;
      }
    });
    hostObserver.observe(document.documentElement, { childList: true, subtree: false });

    ctx.onInvalidated(() => {
      hostObserver.disconnect();
      chrome.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener("pageshow", onPageShow);
      // Restore history hooks / remove capture listeners before the CS unloads.
      recordCapture?.dispose();
      recordCapture = null;
      activeRecordRequestId = null;
    });
  },
});

async function anySessionLive(): Promise<boolean> {
  if (!chrome.storage?.session?.get) return true;
  try {
    const result = (await chrome.storage.session.get({
      [SESSIONS_LIVE_FLAG_KEY]: false,
    })) as Record<string, unknown> | undefined;
    return Boolean(result?.[SESSIONS_LIVE_FLAG_KEY]);
  } catch (err) {
    console.debug("[bsk overlay] sessions-live flag read failed", err);
    return true;
  }
}
