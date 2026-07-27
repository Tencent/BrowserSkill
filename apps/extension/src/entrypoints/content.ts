import { i18n } from "@browser-skill/i18n";
import { I18nextProvider } from "@browser-skill/i18n/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { BorrowConfirmationOverlay } from "@/content/BorrowConfirmationOverlay";
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
  type RecordStartAck,
  type RecordStopAck,
} from "@/lib/record-bridge";
import type {
  BorrowCancelMessage,
  BorrowRequestMessage,
  BorrowResponseMessage,
} from "@/tools/borrow-confirmation";
import logoUrl from "../../assets/logo.png";

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
    let controlRoot: HTMLElement | null = null;
    let activeAgentState: OverlayAgentStateMessage | null = null;
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
        overlayContainer = container;
        hostLossReported = false;
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
        controlRoot = null;
        root?.unmount();
        reactRoot = null;
      },
    });

    function removeControlOverlay(): void {
      controlRoot?.remove();
      controlRoot = null;
    }

    function setControlSurfaceActive(active: boolean): void {
      const host = overlayHost;
      const container = overlayContainer;
      if (!host || !container) return;

      if (active) {
        Object.assign(host.style, {
          position: "fixed",
          inset: "0",
          zIndex: "2147483647",
          pointerEvents: "auto",
        });
        Object.assign(container.style, {
          position: "fixed",
          inset: "0",
          pointerEvents: "none",
        });
        return;
      }

      host.style.removeProperty("position");
      host.style.removeProperty("inset");
      host.style.removeProperty("z-index");
      host.style.removeProperty("pointer-events");
      container.style.removeProperty("position");
      container.style.removeProperty("inset");
      container.style.removeProperty("pointer-events");
    }

    function ensureControlOverlayRoot(): HTMLElement | null {
      if (!overlayContainer) return null;
      if (!controlRoot) {
        controlRoot = document.createElement("div");
        controlRoot.className = "bsk-control-overlay";
        controlRoot.style.opacity = "0";
        controlRoot.style.transition = "opacity 300ms ease-out";
        overlayContainer.append(controlRoot);
        window.requestAnimationFrame(() => {
          if (controlRoot) controlRoot.style.opacity = "1";
        });
      }
      return controlRoot;
    }

    function createStopCircleIcon(): SVGSVGElement {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "18");
      svg.setAttribute("height", "18");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "currentColor");
      svg.setAttribute("aria-hidden", "true");
      svg.style.color = "#fff";
      svg.style.flexShrink = "0";
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(
        "d",
        "M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10-4.477 10-10 10Zm0-2a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM9 9h6v6H9V9Z",
      );
      svg.append(path);
      return svg;
    }

    function renderControlOverlay(): void {
      const overlayState = overlays.snapshot();
      if (!shouldShowAgentControlOverlay(overlayState)) {
        removeControlOverlay();
        setControlSurfaceActive(false);
        return;
      }

      const root = ensureControlOverlayRoot();
      if (!root) return;

      const pointerEvents = overlayState.automationBypassCount > 0 ? "none" : "auto";
      setControlSurfaceActive(true);
      root.innerHTML = "";
      Object.assign(root.style, {
        position: "fixed",
        inset: "0",
        pointerEvents: "none",
      });

      const style = document.createElement("style");
      style.textContent = `
        @keyframes bsk-breathe {
          0%, 100% { box-shadow: inset 0 0 20px 4px rgba(249,115,22,0.25); }
          50% { box-shadow: inset 0 0 40px 8px rgba(249,115,22,0.5); }
        }
      `;

      const border = document.createElement("div");
      border.setAttribute("data-slot", "control-overlay");
      Object.assign(border.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483646",
        pointerEvents: "none",
        animation: "bsk-breathe 3s ease-in-out infinite",
      });

      const blocker = document.createElement("div");
      blocker.setAttribute("data-slot", "control-overlay-blocker");
      Object.assign(blocker.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483646",
        pointerEvents,
        background: "transparent",
      });
      blocker.addEventListener("pointerdown", (event) => {
        if (overlayState.automationBypassCount > 0) return;
        event.preventDefault();
        event.stopPropagation();
      });
      blocker.addEventListener("click", (event) => {
        if (overlayState.automationBypassCount > 0) return;
        event.preventDefault();
        event.stopPropagation();
      });
      blocker.addEventListener(
        "wheel",
        (event) => {
          if (overlayState.automationBypassCount > 0) return;
          event.preventDefault();
          event.stopPropagation();
        },
        { passive: false },
      );
      blocker.addEventListener(
        "touchmove",
        (event) => {
          if (overlayState.automationBypassCount > 0) return;
          event.preventDefault();
          event.stopPropagation();
        },
        { passive: false },
      );

      const pill = document.createElement("div");
      pill.setAttribute("data-slot", "control-overlay-pill");
      Object.assign(pill.style, {
        position: "fixed",
        bottom: "32px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: "2147483647",
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        borderRadius: "999px",
        backgroundColor: "#fff",
        padding: "10px 10px 10px 20px",
        boxShadow: "0 8px 32px rgba(124,45,18,0.16), 0 2px 8px rgba(0,0,0,0.1)",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      });

      const logo = document.createElement("img");
      logo.src = logoUrl;
      logo.alt = "browser-skill";
      Object.assign(logo.style, {
        width: "24px",
        height: "24px",
        borderRadius: "4px",
        flexShrink: "0",
      });

      const label = document.createElement("span");
      label.textContent = i18n.t("controlOverlay.status", { ns: "extension" });
      Object.assign(label.style, {
        fontSize: "16px",
        fontWeight: "500",
        color: "#333",
        whiteSpace: "nowrap",
        userSelect: "none",
      });

      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-slot", "control-overlay-stop-all");
      button.disabled = overlayState.interrupting;
      Object.assign(button.style, {
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        gap: "6px",
        border: "none",
        borderRadius: "999px",
        padding: "8px 20px 8px 16px",
        fontSize: "15px",
        fontWeight: "600",
        color: "#fff",
        backgroundColor: overlayState.interrupting ? "#9ca3af" : "#f97316",
        cursor: overlayState.interrupting ? "default" : "pointer",
        opacity: overlayState.interrupting ? "0.7" : "1",
        transition: "background-color 150ms ease-out, opacity 150ms ease-out",
        whiteSpace: "nowrap",
        lineHeight: "1",
      });
      button.append(
        createStopCircleIcon(),
        document.createTextNode(
          overlayState.interrupting
            ? i18n.t("controlOverlay.interrupting", { ns: "extension" })
            : i18n.t("controlOverlay.interrupt", { ns: "extension" }),
        ),
      );
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleInterrupt();
      });

      pill.append(logo, label, button);
      root.append(style, border, blocker, pill);
    }

    function renderReactOverlays(): void {
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
            React.createElement(HelpRequestOverlay, { request: overlayState.activeHelp }),
            React.createElement(RecordOverlay, { request: overlayState.activeRecord }),
          ),
        ),
      );
    }

    function renderAll(): void {
      renderReactOverlays();
      renderControlOverlay();
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
        | OverlayAgentOverlayResetMessage
        | OverlayAgentStateMessage
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
        })) as { active?: boolean; requestId?: string } | undefined;
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
      window.removeEventListener("pageshow", onPageShow);
      // Restore history hooks / remove capture listeners before the CS unloads.
      recordCapture?.dispose();
      recordCapture = null;
      activeRecordRequestId = null;
    });
  },
});
