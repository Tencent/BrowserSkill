/**
 * Wire protocol for user-action recording, sent between the background
 * service worker and a tab's content script.
 */

import type { CaptureTargetDescriptor } from "./describe-target";

export const RECORD_START = "bsk-record-start";
export const RECORD_STEP = "bsk-record-step";
export const RECORD_STOP = "bsk-record-stop";
export const RECORD_CANCEL = "bsk-record-cancel";
export const RECORD_FINISH = "bsk-record-finish";
export const RECORD_QUERY = "bsk-record-query";

export interface RecordStartAck {
  ok: true;
}

export type RecordStepAck =
  | { ok: true; sequence: number }
  | { ok: false; expectedSequence: number; error: string };

export type RecordStopAck = { ok: true } | { ok: false; error: string };

export interface RecordQueryMessage {
  type: typeof RECORD_QUERY;
}

export interface RecordQueryResponse {
  active: boolean;
  requestId?: string;
  /** Epoch ms when the recording began; see `RecordStartMessage.startedAtMs`. */
  startedAtMs?: number;
}

export interface RecordStartMessage {
  type: typeof RECORD_START;
  requestId: string;
  /**
   * Epoch ms when the whole recording began, not when this tab was armed.
   * The overlay timer must span the session, so it survives navigations and
   * content-script remounts instead of restarting per page.
   */
  startedAtMs?: number;
}

export interface RecordStepPayload {
  op: "click" | "hover" | "fill" | "press" | "select" | "navigate";
  target?: CaptureTargetDescriptor;
  value?: string;
  key?: string;
  modifiers?: Array<"alt" | "ctrl" | "meta" | "shift">;
  values?: string[];
  labels?: string[];
  url?: string;
  redacted?: boolean;
  commit?: "enter" | "suggestion" | "blur";
  /** Page URL when the step was captured. */
  page_url?: string;
  /** Event-target bounds in the source frame's viewport coordinate space. */
  geometry?: {
    rect: { x: number; y: number; w: number; h: number };
    tag: string;
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
  /** Stable for the lifetime of one content-script document. */
  producerId: string;
  /** Monotonic within one content-script producer and recording request. */
  sequence: number;
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

export function isRecordStepMessage(msg: unknown): msg is RecordStepMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (
    m.type !== RECORD_STEP ||
    typeof m.requestId !== "string" ||
    typeof m.producerId !== "string" ||
    m.producerId.length === 0 ||
    typeof m.sequence !== "number" ||
    !Number.isSafeInteger(m.sequence) ||
    m.sequence < 1
  ) {
    return false;
  }
  const step = m.step;
  if (typeof step !== "object" || step === null) return false;
  return typeof (step as RecordStepPayload).op === "string";
}

export function isAcceptedRecordStepAck(
  value: unknown,
  sequence: number,
): value is Extract<RecordStepAck, { ok: true }> {
  if (typeof value !== "object" || value === null) return false;
  const ack = value as Partial<RecordStepAck>;
  return ack.ok === true && ack.sequence === sequence;
}
