/**
 * Wire protocol for user-action recording, sent between the background
 * service worker and a tab's content script.
 */

import type { CaptureTargetDescriptor } from "./describe-target";
import type { FrameCaptureFailure, FrameCaptureStatus } from "@/transport/types";

export const RECORD_START = "bsk-record-start";
export const RECORD_STEP = "bsk-record-step";
export const RECORD_STOP = "bsk-record-stop";
export const RECORD_CANCEL = "bsk-record-cancel";
export const RECORD_FINISH = "bsk-record-finish";
export const RECORD_QUERY = "bsk-record-query";
export const RECORD_CAPTURE_STATUS = "bsk-record-capture-status";

export interface RecordStartAck {
  ok: true;
}

export type RecordStopAck = { ok: true } | { ok: false; error: string };

export interface RecordQueryMessage {
  type: typeof RECORD_QUERY;
}

export interface RecordQueryResponse {
  active: boolean;
  requestId?: string;
  /** Epoch ms when the recording began; see `RecordStartMessage.startedAtMs`. */
  startedAtMs?: number;
  captureStatus?: FrameCaptureStatus;
  captureFailures?: FrameCaptureFailure[];
}

export type RecordFrameMode = "top" | "child";

export interface RecordStartMessage {
  type: typeof RECORD_START;
  requestId: string;
  /**
   * Epoch ms when the whole recording began, not when this tab was armed.
   * The overlay timer must span the session, so it survives navigations and
   * content-script remounts instead of restarting per page.
   */
  startedAtMs?: number;
  /** When true, the top-frame overlay should mount. Child frames omit this. */
  showOverlay?: boolean;
  /** Whether this document runs top-frame or child-frame capture semantics. */
  frameMode?: RecordFrameMode;
}

export interface RecordStepPayload {
  op: "click" | "hover" | "fill" | "press" | "select" | "navigate" | "scroll";
  target?: CaptureTargetDescriptor;
  value?: string;
  key?: string;
  modifiers?: Array<"alt" | "ctrl" | "meta" | "shift">;
  values?: string[];
  labels?: string[];
  url?: string;
  redacted?: boolean;
  commit?: "enter" | "suggestion" | "blur";
  /** Top-level tab URL when the step was captured. */
  page_url?: string;
  /** URL of the frame document where the interaction occurred. */
  frame_url?: string;
  /** Ephemeral token stamped on the active document root; not persisted in trace steps. */
  documentToken?: string;
  /** Epoch ms when the step was captured in the content script. */
  capturedAtMs?: number;
  /** Document geometry at capture time for background geometric matching. */
  geometry?: {
    rect: { x: number; y: number; w: number; h: number };
    scrollX: number;
    scrollY: number;
    position: string;
    tag: string;
    ownerFrameBackendNodeId?: number | null;
  };
  /** Capture-only hint; never persisted unless converted to navigated_to. */
  expects_navigation?: boolean;
  /** Whether an observed URL change was synchronously caused by the action. */
  navigation_caused_by_action?: boolean;
  /** Raw webNavigation transition metadata for cause mapping. */
  transitionType?: string;
  transitionQualifiers?: string[];
}

export interface RecordStepMessage {
  type: typeof RECORD_STEP;
  requestId: string;
  step: RecordStepPayload;
}

export interface RecordStopMessage {
  type: typeof RECORD_STOP;
  requestId: string;
}

export interface RecordCancelMessage {
  type: typeof RECORD_CANCEL;
  requestId: string;
}

export interface RecordFinishMessage {
  type: typeof RECORD_FINISH;
  requestId: string;
}

export interface RecordCaptureStatusMessage {
  type: typeof RECORD_CAPTURE_STATUS;
  status: FrameCaptureStatus;
  failures?: FrameCaptureFailure[];
}

export function isRecordStartMessage(msg: unknown): msg is RecordStartMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === RECORD_START && typeof m.requestId === "string";
}

export function isRecordStopMessage(msg: unknown): msg is RecordStopMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === RECORD_STOP && typeof m.requestId === "string";
}

export function isRecordCancelMessage(msg: unknown): msg is RecordCancelMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === RECORD_CANCEL && typeof m.requestId === "string";
}

export function isRecordFinishMessage(msg: unknown): msg is RecordFinishMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === RECORD_FINISH && typeof m.requestId === "string";
}

export function isRecordQueryMessage(msg: unknown): msg is RecordQueryMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === RECORD_QUERY;
}

export function isRecordCaptureStatusMessage(msg: unknown): msg is RecordCaptureStatusMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.type === RECORD_CAPTURE_STATUS &&
    (m.status === "complete" || m.status === "partial") &&
    (m.failures === undefined || Array.isArray(m.failures))
  );
}

export function isRecordStepMessage(msg: unknown): msg is RecordStepMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.type !== RECORD_STEP || typeof m.requestId !== "string") return false;
  const step = m.step;
  if (typeof step !== "object" || step === null) return false;
  return typeof (step as RecordStepPayload).op === "string";
}
