import { createRandomUuid } from "@/lib/random-uuid";
import {
  markRecordingDocument,
  type RecordingDocumentMarker,
  waitForDocumentElement,
} from "@/lib/recording/document-marker";
import {
  isRecordFrameStartMessage,
  RECORD_FRAME_PORT,
  RECORD_FRAME_QUERY,
  RECORD_FRAME_START,
  type RecordFramePortMessage,
  type RecordFrameQueryResponse,
  type RecordFrameStartMessage,
} from "@/lib/recording/frame-bridge";
import { type RecordCaptureController, startRecordCapture } from "../record-capture";
import { RecordStepDelivery } from "../record-step-delivery";

interface ActiveFrameRecording {
  requestId: string;
  producerId: string;
  port: chrome.runtime.Port;
  delivery: RecordStepDelivery;
  capture: RecordCaptureController;
  marker: RecordingDocumentMarker;
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
    const active: ActiveFrameRecording = {
      requestId: message.requestId,
      producerId,
      port,
      delivery,
      capture,
      marker,
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
      active.capture.dispose();
      active.marker.restore();
      this.#active = null;
    });
    return { ok: true };
  }

  async #stop(active: ActiveFrameRecording, commandId: string | undefined): Promise<void> {
    if (!commandId || this.#active !== active) return;
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
  void chrome.runtime
    .sendMessage({ type: RECORD_FRAME_QUERY })
    .then((response: RecordFrameQueryResponse | undefined) => {
      if (!response?.active || !response.requestId || response.startedAtMs === undefined) return;
      return agent.start({
        type: RECORD_FRAME_START,
        requestId: response.requestId,
        startedAtMs: response.startedAtMs,
      });
    })
    .catch(() => {});
  return () => {
    chrome.runtime.onMessage.removeListener(onMessage);
    agent.dispose();
  };
}
