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
  HELP_RESPONSE,
  type HelpCancelMessage,
  type HelpRequestMessage,
  type HelpResponseMessage,
  isHelpCancelMessage,
  isHelpRequestMessage,
} from "@/lib/help-bridge";
import {
  isOverlayAgentOverlayResetMessage,
  OVERLAY_AUTOMATION_BYPASS,
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
    let activeHelpRespond: ((outcome: "continued" | "cancelled", note?: string) => void) | null =
      null;
    let recordCapture: RecordCaptureController | null = null;
    let activeRecordRequestId: string | null = null;
    let reactRoot: ReactDOM.Root | null = null;
    let overlayHost: HTMLElement | null = null;
    let hostLossReported = false;
    let remountInProgress = false;

    const ui = await createShadowRootUi(ctx, {
      name: "browser-skill-overlay",
      position: "inline",
      anchor: "html",
      css: overlayCss,
      onMount(container, _shadow, shadowHost) {
        shadowHost.setAttribute("aria-hidden", "true");
        shadowHost.setAttribute("data-bsk-overlay", "");
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
        activeHelpRespond?.("cancelled");
        activeHelpRespond = null;
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
      sendResponse: (response: BorrowResponseMessage | HelpResponseMessage) => void,
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
          activeHelpRespond?.("cancelled");
        }
        return false;
      }

      if (isHelpRequestMessage(message)) {
        const helpMsg = message as HelpRequestMessage;
        let responded = false;
        const respond = (outcome: "continued" | "cancelled", note?: string) => {
          if (responded) return;
          responded = true;
          const reply: HelpResponseMessage = {
            type: HELP_RESPONSE,
            outcome,
            ...(note ? { note } : {}),
          };
          sendResponse(reply);
          activeHelpRespond = null;
          overlays.clearAgentHelpRequest(helpMsg.requestId);
          renderOverlay();
        };
        const previousHelp = overlays.setAgentHelpRequest({
          id: helpMsg.requestId,
          prompt: helpMsg.prompt,
          ...(helpMsg.title ? { title: helpMsg.title } : {}),
          selectors: helpMsg.selectors,
          onContinue: (note: string) => respond("continued", note.trim() ? note : undefined),
          onCancel: () => respond("cancelled"),
        });
        if (previousHelp) {
          activeHelpRespond?.("cancelled");
        }
        activeHelpRespond = respond;
        renderOverlay();
        return true; // async sendResponse
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

    async function syncAgentOverlay(): Promise<void> {
      if (!(await anySessionLive())) return;
      try {
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
