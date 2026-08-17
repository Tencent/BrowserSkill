import {
  RECORD_CANCEL,
  RECORD_START,
  RECORD_STOP,
  type RecordCancelMessage,
  type RecordStartAck,
  type RecordStartMessage,
  type RecordStopAck,
  type RecordStopMessage,
} from "@/lib/record-bridge";
import type { FrameCaptureFailure, FrameCaptureFailureReason } from "@/transport/types";

export interface WebNavigationFrameInfo {
  frameId: number;
  documentId?: string;
  url?: string;
  parentFrameId: number;
}

export interface ArmedDocument {
  tabId: number;
  frameId: number;
  documentId: string;
  url?: string;
  parentFrameId: number;
}

export interface RecordFrameSendDeps {
  sendToDocument(
    tabId: number,
    documentId: string,
    msg: RecordStartMessage | RecordStopMessage | RecordCancelMessage,
  ): Promise<unknown>;
  getAllFrames(tabId: number): Promise<WebNavigationFrameInfo[]>;
}

const RECORD_START_RETRIES = 3;
const RECORD_START_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isFrameUrlRestricted(url: string | undefined): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.startsWith("chrome://") ||
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("edge://") ||
    lower.startsWith("devtools://") ||
    lower.startsWith("devtools:") ||
    lower.startsWith("https://chrome.google.com/webstore")
  );
}

function isRecordStartAck(response: unknown): response is RecordStartAck {
  return (
    typeof response === "object" &&
    response !== null &&
    "ok" in response &&
    (response as RecordStartAck).ok === true
  );
}

function isRecordStopAckOk(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    "ok" in response &&
    (response as RecordStopAck).ok === true
  );
}

export function makeFrameCaptureFailure(
  reason: FrameCaptureFailureReason,
  input: { frameId: number; documentId?: string; url?: string; detail?: string },
): FrameCaptureFailure {
  return {
    reason,
    frame_id: input.frameId,
    ...(input.documentId ? { document_id: input.documentId } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
  };
}

export async function listInjectableFrames(
  tabId: number,
  deps: RecordFrameSendDeps,
): Promise<{ injectable: WebNavigationFrameInfo[]; failures: FrameCaptureFailure[] }> {
  const failures: FrameCaptureFailure[] = [];
  let frames: WebNavigationFrameInfo[] = [];
  try {
    frames = await deps.getAllFrames(tabId);
  } catch (err) {
    failures.push(
      makeFrameCaptureFailure("arm_failed", {
        frameId: 0,
        detail: err instanceof Error ? err.message : "webNavigation.getAllFrames failed",
      }),
    );
    return { injectable: [], failures };
  }

  const injectable = frames.filter((frame) => {
    if (!frame.documentId) {
      failures.push(
        makeFrameCaptureFailure("not_injectable", {
          frameId: frame.frameId,
          url: frame.url,
          detail: "missing documentId",
        }),
      );
      return false;
    }
    if (isFrameUrlRestricted(frame.url)) {
      failures.push(
        makeFrameCaptureFailure("not_injectable", {
          frameId: frame.frameId,
          documentId: frame.documentId,
          url: frame.url,
        }),
      );
      return false;
    }
    return true;
  });
  return { injectable, failures };
}

export async function sendRecordStartWithAckToDocument(
  tabId: number,
  documentId: string,
  msg: RecordStartMessage,
  deps: RecordFrameSendDeps,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RECORD_START_RETRIES; attempt += 1) {
    try {
      const response = await deps.sendToDocument(tabId, documentId, msg);
      if (isRecordStartAck(response)) return;
      lastError = new Error("content script did not ack RECORD_START");
    } catch (err) {
      lastError = err;
    }
    if (attempt + 1 < RECORD_START_RETRIES) {
      await sleep(RECORD_START_RETRY_DELAY_MS);
    }
  }
  throw lastError ?? new Error("failed to start recording in content script");
}

export async function armDocumentCapture(
  tabId: number,
  frame: WebNavigationFrameInfo,
  startMsg: RecordStartMessage,
  deps: RecordFrameSendDeps,
): Promise<{ armed?: ArmedDocument; failure?: FrameCaptureFailure }> {
  if (!frame.documentId) {
    return {
      failure: makeFrameCaptureFailure("not_injectable", {
        frameId: frame.frameId,
        url: frame.url,
        detail: "missing documentId",
      }),
    };
  }
  if (isFrameUrlRestricted(frame.url)) {
    return {
      failure: makeFrameCaptureFailure("not_injectable", {
        frameId: frame.frameId,
        documentId: frame.documentId,
        url: frame.url,
      }),
    };
  }
  try {
    await sendRecordStartWithAckToDocument(tabId, frame.documentId, startMsg, deps);
    return {
      armed: {
        tabId,
        frameId: frame.frameId,
        documentId: frame.documentId,
        url: frame.url,
        parentFrameId: frame.parentFrameId,
      },
    };
  } catch (err) {
    return {
      failure: makeFrameCaptureFailure("arm_failed", {
        frameId: frame.frameId,
        documentId: frame.documentId,
        url: frame.url,
        detail: err instanceof Error ? err.message : "RECORD_START failed",
      }),
    };
  }
}

export async function armAllDocumentsForTab(
  tabId: number,
  startMsg: RecordStartMessage,
  deps: RecordFrameSendDeps,
): Promise<{ armed: ArmedDocument[]; failures: FrameCaptureFailure[] }> {
  const { injectable, failures } = await listInjectableFrames(tabId, deps);
  const armed: ArmedDocument[] = [];
  for (const frame of injectable) {
    const result = await armDocumentCapture(tabId, frame, startMsg, deps);
    if (result.armed) armed.push(result.armed);
    if (result.failure) failures.push(result.failure);
  }
  return { armed, failures };
}

export async function stopDocumentCapture(
  armed: ArmedDocument,
  stopMsg: RecordStopMessage,
  deps: RecordFrameSendDeps,
): Promise<{ ok: true } | FrameCaptureFailure> {
  try {
    const response = await deps.sendToDocument(armed.tabId, armed.documentId, stopMsg);
    if (isRecordStopAckOk(response)) return { ok: true };
    return makeFrameCaptureFailure("flush_failed", {
      frameId: armed.frameId,
      documentId: armed.documentId,
      url: armed.url,
      detail: "content script did not confirm recorded steps",
    });
  } catch (err) {
    return makeFrameCaptureFailure("flush_failed", {
      frameId: armed.frameId,
      documentId: armed.documentId,
      url: armed.url,
      detail: err instanceof Error ? err.message : "RECORD_STOP failed",
    });
  }
}

export async function cancelDocumentCapture(
  armed: ArmedDocument,
  cancelMsg: RecordCancelMessage,
  deps: RecordFrameSendDeps,
): Promise<void> {
  try {
    await deps.sendToDocument(armed.tabId, armed.documentId, cancelMsg);
  } catch {
    // Best-effort cleanup.
  }
}
