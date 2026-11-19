import { createRandomUuid } from "@/lib/random-uuid";
import {
  markRecordingDocument,
  type RecordingDocumentMarker,
  waitForDocumentElement,
} from "@/lib/recording/document-marker";
import {
  isRecordFrameStartMessage,
  RECORD_FRAME_PORT,
  type RecordFramePortMessage,
  type RecordFrameStartMessage,
} from "@/lib/recording/frame-bridge";
import {
  hasAddedSubframeElement,
  isExtensionOverlayNode,
  openOrClosedShadowRoot,
} from "../dom-primitives";
import { type RecordCaptureController, startRecordCapture } from "../record-capture";
import { RecordStepDelivery } from "../record-step-delivery";

interface ActiveFrameRecording {
  requestId: string;
  producerId: string;
  port: chrome.runtime.Port;
  delivery: RecordStepDelivery;
  capture: RecordCaptureController;
  marker: RecordingDocumentMarker;
  subframeObserver: MutationObserver;
}

const RECORD_FRAME_REGISTER_TIMEOUT_MS = 5_000;

export class RecordFrameAgent {
  #active: ActiveFrameRecording | null = null;
  #startPromise: Promise<{ ok: true } | { ok: false; error: string }> | null = null;
  #disposed = false;

  async start(
    message: RecordFrameStartMessage,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.#active?.requestId === message.requestId) return { ok: true };
    if (this.#disposed) return { ok: false, error: "recording document is disposed" };
    if (this.#startPromise) {
      await this.#startPromise;
      return this.start(message);
    }
    if (this.#active) this.cancel(this.#active.requestId);
    const starting = this.#start(message);
    this.#startPromise = starting;
    try {
      return await starting;
    } finally {
      if (this.#startPromise === starting) this.#startPromise = null;
    }
  }

  cancel(requestId: string): void {
    const active = this.#active;
    if (!active || active.requestId !== requestId) return;
    active.subframeObserver.disconnect();
    active.capture.dispose();
    active.marker.restore();
    active.port.disconnect();
    this.#active = null;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#active) this.cancel(this.#active.requestId);
  }

  async #start(
    message: RecordFrameStartMessage,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const producerId = createRandomUuid();
    const root = await waitForDocumentElement();
    if (this.#disposed) return { ok: false, error: "recording document is disposed" };
    const marker = markRecordingDocument(producerId, root);
    const port = chrome.runtime.connect({ name: RECORD_FRAME_PORT });
    try {
      await registerPort(port, message.requestId, producerId);
    } catch {
      marker.restore();
      port.disconnect();
      return { ok: false, error: "failed to register recording document" };
    }
    if (this.#disposed) {
      marker.restore();
      port.disconnect();
      return { ok: false, error: "recording document is disposed" };
    }

    const delivery = new RecordStepDelivery(message.requestId, undefined, producerId);
    const capture = startRecordCapture(
      message.requestId,
      (step) => {
        marker.ensure();
        delivery.enqueue(step);
      },
      { captureNavigation: window.top === window },
    );
    let subframeNotifyScheduled = false;
    const observedSubframeRoots = new WeakSet<Node>();
    const observeSubframesIn = (target: Node) => {
      if (isExtensionOverlayNode(target)) return;
      if (
        target.nodeType === Node.DOCUMENT_NODE ||
        target instanceof ShadowRoot ||
        target === root
      ) {
        if (!observedSubframeRoots.has(target)) {
          observedSubframeRoots.add(target);
          subframeObserver.observe(target, { childList: true, subtree: true });
        }
      }
      if (target instanceof Element) {
        const nested = openOrClosedShadowRoot(target);
        if (nested) observeSubframesIn(nested);
      }
      if ("querySelectorAll" in target) {
        for (const el of (target as ParentNode).querySelectorAll("*")) {
          if (isExtensionOverlayNode(el)) continue;
          const nested = openOrClosedShadowRoot(el);
          if (nested) observeSubframesIn(nested);
        }
      }
    };
    const subframeObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== "childList" || isExtensionOverlayNode(record.target)) continue;
        for (const node of record.addedNodes) observeSubframesIn(node);
      }
      if (subframeNotifyScheduled || !hasAddedSubframeElement(records)) return;
      subframeNotifyScheduled = true;
      queueMicrotask(() => {
        subframeNotifyScheduled = false;
        if (this.#active !== active) return;
        try {
          active.port.postMessage({
            type: "subframe_added",
            requestId: active.requestId,
            producerId: active.producerId,
          } satisfies RecordFramePortMessage);
        } catch {
          // Disconnected ports are cleaned up by `onDisconnect`.
        }
      });
    });
    observeSubframesIn(root);
    const active: ActiveFrameRecording = {
      requestId: message.requestId,
      producerId,
      port,
      delivery,
      capture,
      marker,
      subframeObserver,
    };
    this.#active = active;
    port.onMessage.addListener((raw: unknown) => {
      const command = raw as Partial<RecordFramePortMessage>;
      if (command.type === "stop" && command.requestId === active.requestId) {
        void this.#stop(active, command.commandId);
      } else if (command.type === "cancel" && command.requestId === active.requestId) {
        this.cancel(active.requestId);
      }
    });
    port.onDisconnect.addListener(() => {
      if (this.#active !== active) return;
      active.subframeObserver.disconnect();
      active.capture.dispose();
      active.marker.restore();
      this.#active = null;
    });
    return { ok: true };
  }

  async #stop(active: ActiveFrameRecording, commandId: string | undefined): Promise<void> {
    if (!commandId || this.#active !== active) return;
    active.subframeObserver.disconnect();
    active.capture.dispose();
    const succeeded = await active.delivery.flush();
    try {
      active.port.postMessage({
        type: "stopped",
        requestId: active.requestId,
        commandId,
        ok: succeeded,
        ...(succeeded ? {} : { error: "failed to deliver one or more recorded steps" }),
      } satisfies RecordFramePortMessage);
    } catch {
      return;
    }
    if (!succeeded || this.#active !== active) return;
    active.marker.restore();
    this.#active = null;
    active.port.disconnect();
  }
}

function registerPort(
  port: chrome.runtime.Port,
  requestId: string,
  producerId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("recording document registration timed out"));
    }, RECORD_FRAME_REGISTER_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
    };
    const onMessage = (raw: unknown) => {
      const message = raw as Partial<RecordFramePortMessage>;
      if (
        message.type !== "ready_ack" ||
        message.requestId !== requestId ||
        message.producerId !== producerId
      ) {
        return;
      }
      cleanup();
      resolve();
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("recording document port disconnected"));
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    port.postMessage({ type: "ready", requestId, producerId } satisfies RecordFramePortMessage);
  });
}

export function attachRecordFrameAgent(): () => void {
  const agent = new RecordFrameAgent();
  const onMessage = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: { ok: true } | { ok: false; error: string }) => void,
  ) => {
    if (!isRecordFrameStartMessage(message)) return false;
    void agent.start(message).then(sendResponse);
    return true;
  };
  chrome.runtime.onMessage.addListener(onMessage);
  return () => {
    chrome.runtime.onMessage.removeListener(onMessage);
    agent.dispose();
  };
}
