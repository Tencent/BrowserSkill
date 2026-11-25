import { i18n } from "@browser-skill/i18n";
import { I18nextProvider } from "@browser-skill/i18n/react";
import React from "react";
import { flushSync } from "react-dom";
import ReactDOM from "react-dom/client";
import { BorrowConfirmationOverlay } from "@/content/BorrowConfirmationOverlay";
import { ControlOverlay } from "@/content/ControlOverlay";
import { createCaptureSuppressController } from "@/content/capture-suppress";
import { claimIdempotentContentScript } from "@/content/dom-primitives";
import { HelpRequestOverlay } from "@/content/HelpRequestOverlay";
import { createHelpRequestData } from "@/content/help-request";
import { createInputPassthroughController } from "@/content/input-passthrough";
import overlayCss from "@/content/overlay.css?inline";
import { OverlayController, shouldShowAgentControlOverlay } from "@/content/overlay-controller";
import { RecordOverlay } from "@/content/RecordOverlay";
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
import {
  type InputPassthroughAck,
  type InputPassthroughMessage,
  isInputPassthroughMessage,
} from "@/lib/input-passthrough-bridge";
import { getControlHintsHidden, STORAGE_KEYS } from "@/lib/instance-id";
import {
  isOverlayAgentOverlayResetMessage,
  isOverlayAgentStateMessage,
  OVERLAY_AUTOMATION_BYPASS,
  OVERLAY_MSG_READY,
  OVERLAY_MSG_SET_MINIMIZED,
  type OverlayAgentOverlayResetMessage,
  type OverlayAgentStateMessage,
  type OverlayAutomationBypassMessage,
  OverlayVersionGate,
} from "@/lib/overlay-bridge";
import { sendInterrupt } from "@/lib/overlay-interrupt-client";
import {
  isRecordCancelMessage,
  isRecordStartMessage,
  isRecordStopMessage,
  RECORD_FINISH,
  RECORD_QUERY,
  type RecordCancelMessage,
  type RecordQueryResponse,
  type RecordStartAck,
  type RecordStartMessage,
  type RecordStopAck,
  type RecordStopMessage,
} from "@/lib/record-bridge";
import { waitForDocumentElement } from "@/lib/recording/document-marker";
import type {
  BorrowCancelMessage,
  BorrowRequestMessage,
  BorrowResponseMessage,
} from "@/tools/borrow-confirmation";
import { VIDEO_OVERLAY, VideoOverlayGate, type VideoOverlayMessage } from "@/video/overlay";

const OVERLAY_MOUNTED_SYMBOL = Symbol.for("bsk.overlay.mounted");

function isHandledOverlayMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { type?: unknown };
  return (
    candidate.type === VIDEO_OVERLAY ||
    isCaptureSuppressMessage(message) ||
    isInputPassthroughMessage(message) ||
    isRecordStartMessage(message) ||
    isRecordStopMessage(message) ||
    isRecordCancelMessage(message) ||
    candidate.type === OVERLAY_AUTOMATION_BYPASS ||
    isOverlayAgentStateMessage(message) ||
    isOverlayAgentOverlayResetMessage(message) ||
    candidate.type === "borrow-cancel" ||
    isHelpCancelMessage(message) ||
    isHelpRequestMessage(message) ||
    candidate.type === "borrow-request"
  );
}

// Runtime-only Tier A entrypoint: injected per tab via `ensureOverlayInjected`,
// never globally registered in `manifest.json`.
export default defineContentScript({
  registration: "runtime",
  matches: ["<all_urls>"],
  runAt: "document_end",
  allFrames: false,
  noScriptStartedPostMessage: true,

  async main(ctx) {
    if (window.top !== window) return;
    const releaseMount = claimIdempotentContentScript(ctx, "content", OVERLAY_MOUNTED_SYMBOL);
    if (!releaseMount) return;
    let alive = true;

    const overlays = new OverlayController();
    let activeRecordRequestId: string | null = null;
    const stoppedRecordRequestIds = new Set<string>();
    let reactRoot: ReactDOM.Root | null = null;
    let overlayHost: HTMLElement | null = null;
    let overlayContainer: HTMLElement | null = null;
    let activeAgentState: OverlayAgentStateMessage | null = null;
    const overlayVersions = new OverlayVersionGate();
    let hostLossReported = false;
    let remountInProgress = false;
    let isMounted = false;
    let hostObserver: MutationObserver | null = null;
    const videoOverlay = new VideoOverlayGate(
      async (action) => {
        const response = await chrome.runtime.sendMessage({ type: VIDEO_OVERLAY, action });
        if (
          !response ||
          response.error ||
          (response.recording_id !== null && typeof response.recording_id !== "string")
        )
          throw new Error(response?.error ?? "Video overlay unavailable");
        return response;
      },
      () => renderAll(),
      () => waitForRenderedOverlayUpdate(),
    );

    const captureSuppress = createCaptureSuppressController(() => overlayHost);
    const inputPassthrough = createInputPassthroughController(() => overlayHost);

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
      const controlVisible =
        videoOverlay.canRenderControl() && shouldShowAgentControlOverlay(overlayState);
      const controlOverlayVisible = controlVisible && !activeAgentState?.cooperation;
      const interactiveOverlayVisible =
        overlayState.borrowRequests.length > 0 ||
        overlayState.activeHelp !== null ||
        overlayState.activeRecord !== null;
      const showInteractive = videoOverlay.canRenderInteractive(interactiveOverlayVisible);
      const cooperationState =
        controlVisible && !interactiveOverlayVisible ? activeAgentState?.cooperation : undefined;
      const cardVisible = controlOverlayVisible || !!cooperationState;
      // Cooperative status updates and minimization keep the same click lease.
      // Clear it only when control UI leaves or interactive overlays take over.
      if (!cardVisible || interactiveOverlayVisible) inputPassthrough.reset();
      setOverlayHostHiddenFromAccessibility(!interactiveOverlayVisible && !cardVisible);
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
                requests: showInteractive ? overlayState.borrowRequests : [],
              }),
              React.createElement(HelpRequestOverlay, {
                request: showInteractive ? overlayState.activeHelp : null,
              }),
              React.createElement(RecordOverlay, {
                request: showInteractive ? overlayState.activeRecord : null,
              }),
              React.createElement(ControlOverlay, {
                sessionId: overlayState.activeSessionId,
                controller: overlayState.controller,
                visible: cardVisible,
                state: cooperationState,
                minimized: activeAgentState?.minimized ?? false,
                onMinimizedChange: handleMinimizedChange,
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
      // Background tabs may not receive animation frames. Rendering has already
      // committed synchronously; the fallback also bounds shutdown/navigation.
      const frame = () =>
        new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 500);
          window.requestAnimationFrame(() => {
            window.clearTimeout(timer);
            resolve();
          });
        });
      await frame();
      await frame();
    }

    function clearCurrentAgentSession(): void {
      const sessionId = overlays.snapshot().activeSessionId;
      if (!sessionId) return;
      resetAgentOverlayState(sessionId);
    }

    function receiveOverlayState(state: OverlayAgentStateMessage): void {
      if (overlayVersions.admit(state)) {
        recoverVideoOverlay();
        applyOverlayState(state);
      }
    }

    function applyOverlayState(state: OverlayAgentStateMessage): void {
      if (overlays.snapshot().activeSessionId !== state.sessionId) inputPassthrough.reset();
      activeAgentState = state;
      overlays.applyAgentControlMode(state.sessionId, state.mode, state.controller);
      renderAll();
    }

    function resetAgentOverlayState(sessionId: string) {
      const activeSessionId = overlays.snapshot().activeSessionId;
      if (activeSessionId && activeSessionId !== sessionId) return;
      inputPassthrough.reset();
      const previousHelp = overlays.resetAgentOverlays(sessionId);
      if (previousHelp) {
        void sendHelpFinish(previousHelp.id, "cancelled");
      }
      activeRecordRequestId = null;
      renderAll();
    }

    function handleMinimizedChange(minimized: boolean) {
      const sessionId = overlays.snapshot().activeSessionId;
      if (!sessionId) return;
      void chrome.runtime
        .sendMessage({ kind: OVERLAY_MSG_SET_MINIMIZED, sessionId, minimized })
        .catch((error) => console.debug("[bsk overlay] minimize update failed", error));
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

    const dispatchOverlayMessage = (
      message:
        | BorrowRequestMessage
        | BorrowCancelMessage
        | HelpRequestMessage
        | HelpCancelMessage
        | CaptureSuppressMessage
        | InputPassthroughMessage
        | RecordStartMessage
        | RecordStopMessage
        | RecordCancelMessage
        | OverlayAgentOverlayResetMessage
        | OverlayAgentStateMessage
        | OverlayAutomationBypassMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (
        response: BorrowResponseMessage | HelpAckMessage | CaptureSuppressAck | InputPassthroughAck,
      ) => void,
    ) => {
      if ((message as { type?: string }).type === VIDEO_OVERLAY) {
        void videoOverlay.set((message as unknown as VideoOverlayMessage).recording_id).then(() => {
          const state = overlays.snapshot();
          (sendResponse as (value: unknown) => void)({
            interactive:
              state.borrowRequests.length > 0 ||
              state.activeHelp !== null ||
              state.activeRecord !== null,
          });
        });
        return true;
      }
      if (isCaptureSuppressMessage(message)) {
        return captureSuppress.handleMessage(message, sendResponse);
      }
      if (isInputPassthroughMessage(message)) {
        return inputPassthrough.handleMessage(message, sendResponse);
      }

      if (isRecordStartMessage(message)) {
        if (stoppedRecordRequestIds.has(message.requestId)) {
          (sendResponse as unknown as (response: RecordStartAck) => void)({ ok: true });
          return false;
        }
        recoverVideoOverlay();
        mountRecordRequest(message.requestId, message.startedAtMs);
        renderAll();
        (sendResponse as unknown as (response: RecordStartAck) => void)({ ok: true });
        return false;
      }

      if (isRecordStopMessage(message) || isRecordCancelMessage(message)) {
        stoppedRecordRequestIds.add(message.requestId);
        if (stoppedRecordRequestIds.size > 64) {
          const oldest = stoppedRecordRequestIds.values().next().value;
          if (oldest !== undefined) stoppedRecordRequestIds.delete(oldest);
        }
        if (
          activeRecordRequestId !== message.requestId &&
          overlays.snapshot().activeRecord?.id !== message.requestId
        ) {
          if (isRecordStopMessage(message)) {
            (sendResponse as unknown as (response: RecordStopAck) => void)({ ok: true });
          }
          return false;
        }
        overlays.clearAgentRecordRequest(message.requestId);
        activeRecordRequestId = null;
        renderAll();
        if (isRecordStopMessage(message)) {
          (sendResponse as unknown as (response: RecordStopAck) => void)({ ok: true });
        }
        return false;
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
        receiveOverlayState(message);
        return false;
      }

      if (isOverlayAgentOverlayResetMessage(message)) {
        if (overlayVersions.admit(message)) resetAgentOverlayState(message.sessionId);
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
        recoverVideoOverlay();
        const helpMsg = message as HelpRequestMessage;
        const previousHelp = mountHelpRequest(helpMsg);
        if (previousHelp && previousHelp.id !== helpMsg.requestId) {
          void sendHelpFinish(previousHelp.id, "cancelled");
        }
        renderAll();
        sendResponse({ type: HELP_ACK, ok: true });
        return false;
      }

      if (message.type === "borrow-request") {
        recoverVideoOverlay();
        let responded = false;
        const respond = (allowed: boolean, timedOut = false) => {
          if (responded) return;
          responded = true;
          sendResponse({ type: "borrow-response", allowed, ...(timedOut ? { timedOut } : {}) });
          overlays.removeBorrowRequest(message.requestId);
          renderAll();
        };

        overlays.addBorrowRequest({
          id: message.requestId,
          isActiveTab: message.isActiveTab,
          tabTitle: message.tabTitle,
          timeoutMs: message.timeoutMs,
          onAllow: () => respond(true),
          onDeny: (timedOut) => respond(false, timedOut),
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

    function mountHelpRequest(helpMsg: Omit<HelpRequestMessage, "type">) {
      return overlays.setAgentHelpRequest(
        createHelpRequestData(helpMsg, {
          finish: (requestId, outcome, note) => {
            void sendHelpFinish(requestId, outcome, note);
          },
          query: () =>
            chrome.runtime.sendMessage({ type: HELP_QUERY }) as Promise<
              HelpQueryResponse | undefined
            >,
        }),
      );
    }

    function mountRecordRequest(requestId: string, startedAtMs?: number): void {
      activeRecordRequestId = requestId;
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
    }

    async function queryActiveHelpWithRetry(): Promise<void> {
      const mountedHelpId = overlays.snapshot().activeHelp?.id ?? null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (!alive) return;
        try {
          const helpQuery = (await chrome.runtime.sendMessage({
            type: HELP_QUERY,
          })) as HelpQueryResponse | undefined;
          if (!alive) return;
          if (helpQuery?.active && helpQuery.request) {
            mountHelpRequest(helpQuery.request);
            renderAll();
            return;
          }
          if (
            helpQuery?.active === false &&
            mountedHelpId !== null &&
            overlays.snapshot().activeHelp?.id === mountedHelpId
          ) {
            overlays.clearAgentHelpRequest(mountedHelpId);
            renderAll();
            return;
          }
        } catch (err) {
          console.debug("[bsk overlay] help query failed", err);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
      // If the last active help request ended while this document was in BFCache,
      // the background detached its HELP_QUERY listener (returning undefined).
      // Clear the stale banner once retries confirm no active help replaced it.
      if (alive && mountedHelpId !== null && overlays.snapshot().activeHelp?.id === mountedHelpId) {
        overlays.clearAgentHelpRequest(mountedHelpId);
        renderAll();
      }
    }

    async function queryActiveRecord(): Promise<void> {
      const mountedRecordId = activeRecordRequestId;
      try {
        const recordQuery = (await chrome.runtime.sendMessage({
          type: RECORD_QUERY,
        })) as RecordQueryResponse | undefined;
        if (!alive) return;
        if (
          recordQuery?.active &&
          typeof recordQuery.requestId === "string" &&
          !stoppedRecordRequestIds.has(recordQuery.requestId)
        ) {
          if (
            activeRecordRequestId === mountedRecordId &&
            (activeRecordRequestId !== recordQuery.requestId ||
              overlays.snapshot().activeRecord === null)
          ) {
            mountRecordRequest(recordQuery.requestId, recordQuery.startedAtMs);
            renderAll();
          }
        } else if (
          recordQuery?.active === false &&
          mountedRecordId !== null &&
          activeRecordRequestId === mountedRecordId
        ) {
          activeRecordRequestId = null;
          overlays.clearAgentRecordRequest(mountedRecordId);
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
          receiveOverlayState(state);
        }
        void refreshAuxiliaryOverlayState();
      } catch (err) {
        console.debug("[bsk overlay] overlay.ready failed", err);
      }
    }

    function refreshVideoOverlay(): void {
      // Prerendered documents are not the captured page. Discover their state
      // on activation, when the bridge can validate the active document.
      if ((document as Document & { prerendering?: boolean }).prerendering) return;
      void videoOverlay
        .initialize()
        .then(() => videoOverlay.clean())
        .catch((error) => {
          console.debug(
            "[bsk overlay] video discovery failed; will retry on activation or request",
            error,
          );
        });
    }

    function recoverVideoOverlay(): void {
      if (videoOverlay.needsDiscovery()) refreshVideoOverlay();
    }

    const onPageActivated = () => {
      refreshVideoOverlay();
      void requestOverlayState();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) onPageActivated();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") recoverVideoOverlay();
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

    const mountReady = (async () => {
      // Load the user's control-hints preference up front so an already-active
      // Agent session does not flash the overlay before the stored value lands.
      try {
        overlays.setControlHintsHidden(await getControlHintsHidden());
      } catch (err) {
        console.debug("[bsk overlay] control-hints preference read failed", err);
      }
      if (!alive) return;
      if (!document.documentElement) await waitForDocumentElement();
      if (!alive) return;

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
          inputPassthrough.onHostMounted(shadowHost);
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
      if (!alive) return;

      chrome.storage.onChanged.addListener(onStorageChange);
      ui.mount();
      isMounted = true;
      // Start the handshake after mounting/listening; it never delays page setup.
      refreshVideoOverlay();
      void requestOverlayState();

      window.addEventListener("pageshow", onPageShow);
      document.addEventListener("prerenderingchange", onPageActivated);
      document.addEventListener("visibilitychange", onVisibilityChange);

      hostObserver = new MutationObserver(() => {
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
    })();

    const onMessage: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (
      message,
      sender,
      sendResponse,
    ) => {
      if (!isHandledOverlayMessage(message)) return false;
      if (isMounted) {
        return dispatchOverlayMessage(
          message as Parameters<typeof dispatchOverlayMessage>[0],
          sender,
          sendResponse,
        );
      }
      void mountReady.then(() => {
        if (!alive) {
          (sendResponse as (value?: unknown) => void)(undefined);
          return;
        }
        const asyncReply = dispatchOverlayMessage(
          message as Parameters<typeof dispatchOverlayMessage>[0],
          sender,
          sendResponse,
        );
        if (!asyncReply) {
          (sendResponse as (value?: unknown) => void)(undefined);
        }
      });
      return true;
    };

    // Register the message listener synchronously before awaiting storage/UI
    // setup so `await ensureOverlayInjected(tabId)` followed immediately by
    // `chrome.tabs.sendMessage` never hits a missing receiver.
    chrome.runtime.onMessage.addListener(onMessage);

    ctx.onInvalidated(() => {
      alive = false;
      releaseMount();
      isMounted = false;
      videoOverlay.dispose();
      inputPassthrough.reset();
      hostObserver?.disconnect();
      hostObserver = null;
      chrome.runtime?.onMessage?.removeListener(onMessage);
      chrome.storage?.onChanged?.removeListener(onStorageChange);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("prerenderingchange", onPageActivated);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      activeRecordRequestId = null;
    });

    await mountReady;
  },
});
