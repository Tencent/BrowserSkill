import { i18n } from "@browser-skill/i18n";
import { I18nextProvider } from "@browser-skill/i18n/react";
import React from "react";
import { flushSync } from "react-dom";
import ReactDOM from "react-dom/client";
import { BorrowConfirmationOverlay } from "@/content/BorrowConfirmationOverlay";
import { ControlOverlay } from "@/content/ControlOverlay";
import { createCaptureSuppressController } from "@/content/capture-suppress";
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
  type CaptureSuppressAck,
  type CaptureSuppressMessage,
  isCaptureSuppressMessage,
} from "@/lib/capture-suppress-bridge";
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
import { getControlHintsHidden, STORAGE_KEYS } from "@/lib/instance-id";
import {
  isOverlayAgentOverlayResetMessage,
  isOverlayAgentStateMessage,
  OVERLAY_AUTOMATION_BYPASS,
  OVERLAY_MSG_READY,
  type OverlayAgentOverlayResetMessage,
  type OverlayAgentStateMessage,
  type OverlayAutomationBypassMessage,
} from "@/lib/overlay-bridge";
import { sendInterrupt } from "@/lib/overlay-interrupt-client";
import {
  RECORD_FINISH,
  RECORD_QUERY,
  type RecordQueryResponse,
  type RecordStartAck,
  type RecordStopAck,
} from "@/lib/record-bridge";
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
    let overlayContainer: HTMLElement | null = null;
    let activeAgentState: OverlayAgentStateMessage | null = null;
    let hostLossReported = false;
    let remountInProgress = false;

    // Load the user's control-hints preference up front so an already-active
    // Agent session does not flash the overlay before the stored value lands.
    try {
      overlays.setControlHintsHidden(await getControlHintsHidden());
    } catch (err) {
      console.debug("[bsk overlay] control-hints preference read failed", err);
    }

    const captureSuppress = createCaptureSuppressController(() => overlayHost);

    const ui = await createShadowRootUi(ctx, {
      name: "browser-skill-overlay",
      position: "inline",
      anchor: "html",
      css: overlayCss,
      onMount(container, _shadow, shadowHost) {
        shadowHost.setAttribute("aria-hidden", "true");
        shadowHost.setAttribute("data-bsk-overlay", "");
        overlayHost = shadowHost;
        overlayContainer = container;
        hostLossReported = false;
        // A host rebuilt mid-capture must stay hidden until `end` arrives.
        captureSuppress.onHostMounted(shadowHost);
        const app = document.createElement("div");
        app.className = "bsk-overlay-root";
        container.append(app);
        reactRoot = ReactDOM.createRoot(app);
        renderAll();
        void requestOverlayState();
        return reactRoot;
      },
      onRemove(root) {
        overlayHost = null;
        overlayContainer = null;
        root?.unmount();
        reactRoot = null;
      },
    });

    function setOverlaySurfaceState(active: boolean, blocking: boolean): void {
      const host = overlayHost;
      const container = overlayContainer;
      if (!host || !container) return;

      if (active) {
        host.setAttribute("data-bsk-overlay-surface", "");
        if (blocking) {
          host.setAttribute("data-bsk-overlay-blocking", "");
        } else {
          host.removeAttribute("data-bsk-overlay-blocking");
        }
        Object.assign(container.style, {
          position: "fixed",
          inset: "0",
          pointerEvents: "none",
        });
        return;
      }

      host.removeAttribute("data-bsk-overlay-surface");
      host.removeAttribute("data-bsk-overlay-blocking");
      container.style.removeProperty("position");
      container.style.removeProperty("inset");
      container.style.removeProperty("pointer-events");
    }

    function setOverlayHostHiddenFromAccessibility(hidden: boolean): void {
      const host = overlayHost;
      if (!host) return;

      if (!hidden) {
        host.removeAttribute("aria-hidden");
        return;
      }

      const focusedInShadow = host.shadowRoot?.activeElement;
      if (focusedInShadow instanceof HTMLElement) {
        focusedInShadow.blur();
      }
      if (document.activeElement === host) {
        host.blur();
      }
      host.setAttribute("aria-hidden", "true");
    }

    function renderReactOverlays(): void {
      const overlayState = overlays.snapshot();
      const controlOverlayVisible = shouldShowAgentControlOverlay(overlayState);
      const interactiveOverlayVisible =
        overlayState.borrowRequests.length > 0 ||
        overlayState.activeHelp !== null ||
        overlayState.activeRecord !== null;
      setOverlayHostHiddenFromAccessibility(!interactiveOverlayVisible);
      setOverlaySurfaceState(
        controlOverlayVisible,
        controlOverlayVisible && overlayState.automationBypassCount === 0,
      );
      const root = reactRoot;
      if (!root) return;
      flushSync(() => {
        root.render(
          React.createElement(
            I18nextProvider,
            { i18n },
            React.createElement(
              React.Fragment,
              null,
              React.createElement(BorrowConfirmationOverlay, {
                requests: overlayState.borrowRequests,
              }),
              React.createElement(HelpRequestOverlay, { request: overlayState.activeHelp }),
              React.createElement(RecordOverlay, { request: overlayState.activeRecord }),
              React.createElement(ControlOverlay, {
                visible: controlOverlayVisible,
                interrupting: overlayState.interrupting,
                automationBypass: overlayState.automationBypassCount > 0,
                onInterrupt: handleInterrupt,
              }),
            ),
          ),
        );
      });
    }

    function renderAll(): void {
      renderReactOverlays();
    }

    async function waitForRenderedOverlayUpdate(): Promise<void> {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }

    function clearCurrentAgentSession(): void {
      const sessionId = overlays.snapshot().activeSessionId;
      if (!sessionId) return;
      resetAgentOverlayState(sessionId);
    }

    function applyOverlayState(state: OverlayAgentStateMessage): void {
      activeAgentState = state;
      overlays.applyAgentControlMode(state.sessionId, state.mode);
      renderAll();
    }

    function resetAgentOverlayState(sessionId: string) {
      const previousHelp = overlays.resetAgentOverlays(sessionId);
      if (previousHelp) {
        void sendHelpFinish(previousHelp.id, "cancelled");
      }
      recordCapture?.dispose();
      recordCapture = null;
      activeRecordRequestId = null;
      renderAll();
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
      renderAll();
      void sendInterrupt((msg) => chrome.runtime.sendMessage(msg), sessionId).then((reply) => {
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
        | CaptureSuppressMessage
        | OverlayAgentOverlayResetMessage
        | OverlayAgentStateMessage
        | OverlayAutomationBypassMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: BorrowResponseMessage | HelpAckMessage | CaptureSuppressAck) => void,
    ) => {
      if (isCaptureSuppressMessage(message)) {
        return captureSuppress.handleMessage(message, sendResponse);
      }

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
            onStart: (requestId, startedAtMs) => {
              overlays.setAgentRecordRequest({
                id: requestId,
                ...(typeof startedAtMs === "number" ? { startedAtMs } : {}),
                onFinish: () => {
                  void chrome.runtime.sendMessage({
                    type: RECORD_FINISH,
                    requestId,
                  });
                },
              });
              renderAll();
            },
            onStop: () => {
              overlays.clearAgentRecordRequest(activeRecordRequestId ?? undefined);
              renderAll();
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
        renderAll();
        return false;
      }

      if (isOverlayAgentStateMessage(message)) {
        applyOverlayState(message);
        return false;
      }

      if (isOverlayAgentOverlayResetMessage(message)) {
        resetAgentOverlayState(message.sessionId);
        return false;
      }

      if (message.type === "borrow-cancel") {
        overlays.removeBorrowRequest(message.requestId);
        renderAll();
        return false;
      }

      if (isHelpCancelMessage(message)) {
        const state = overlays.snapshot();
        if (state.activeHelp && state.activeHelp.id === message.requestId) {
          overlays.clearAgentHelpRequest(message.requestId);
          renderAll();
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
        renderAll();
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
          renderAll();
        };

        overlays.addBorrowRequest({
          id: message.requestId,
          isActiveTab: message.isActiveTab,
          tabTitle: message.tabTitle,
          timeoutMs: message.timeoutMs,
          onAllow: () => respond(true),
          onDeny: () => respond(false),
        });
        renderAll();
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
      renderAll();
      await waitForRenderedOverlayUpdate();
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

    async function queryActiveHelpWithRetry(): Promise<void> {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const helpQuery = (await chrome.runtime.sendMessage({
            type: HELP_QUERY,
          })) as HelpQueryResponse | undefined;
          if (helpQuery?.active && helpQuery.request) {
            mountHelpRequest(helpQuery.request);
            renderAll();
            return;
          }
        } catch (err) {
          console.debug("[bsk overlay] help query failed", err);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
    }

    async function queryActiveRecord(): Promise<void> {
      try {
        const recordQuery = (await chrome.runtime.sendMessage({
          type: RECORD_QUERY,
        })) as RecordQueryResponse | undefined;
        if (
          recordQuery?.active &&
          typeof recordQuery.requestId === "string" &&
          overlays.snapshot().activeRecord === null
        ) {
          const requestId = recordQuery.requestId;
          const startedAtMs = recordQuery.startedAtMs;
          overlays.setAgentRecordRequest({
            id: requestId,
            ...(typeof startedAtMs === "number" ? { startedAtMs } : {}),
            onFinish: () => {
              void chrome.runtime.sendMessage({
                type: RECORD_FINISH,
                requestId,
              });
            },
          });
          renderAll();
        }
      } catch (err) {
        console.debug("[bsk overlay] record query failed", err);
      }
    }

    async function refreshAuxiliaryOverlayState(): Promise<void> {
      await Promise.all([queryActiveHelpWithRetry(), queryActiveRecord()]);
    }

    async function requestOverlayState(): Promise<void> {
      try {
        const state = (await chrome.runtime.sendMessage({
          kind: OVERLAY_MSG_READY,
        })) as OverlayAgentStateMessage | undefined;
        if (state && isOverlayAgentStateMessage(state)) {
          applyOverlayState(state);
        }
        void refreshAuxiliaryOverlayState();
      } catch (err) {
        console.debug("[bsk overlay] overlay.ready failed", err);
      }
    }

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void requestOverlayState();
    };

    // Live-apply popup toggles of the control-hints preference.
    const onStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "local") return;
      const change = changes[STORAGE_KEYS.CONTROL_HINTS_HIDDEN];
      if (!change) return;
      overlays.setControlHintsHidden(change.newValue === true);
      renderAll();
    };
    chrome.storage.onChanged.addListener(onStorageChange);

    ui.mount();
    chrome.runtime.onMessage.addListener(onMessage);
    void requestOverlayState();

    window.addEventListener("pageshow", onPageShow);

    const hostObserver = new MutationObserver(() => {
      const connected = overlayHost?.isConnected ?? false;
      if (overlays.isControlVisible() && !connected && !hostLossReported) {
        hostLossReported = true;
        if (!remountInProgress) {
          remountInProgress = true;
          try {
            ui.mount();
            if (activeAgentState) applyOverlayState(activeAgentState);
            void requestOverlayState();
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
      chrome.storage.onChanged.removeListener(onStorageChange);
      window.removeEventListener("pageshow", onPageShow);
      // Restore history hooks / remove capture listeners before the CS unloads.
      recordCapture?.dispose();
      recordCapture = null;
      activeRecordRequestId = null;
    });
  },
});
