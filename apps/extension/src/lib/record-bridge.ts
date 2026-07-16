/**
 * Wire protocol for user-action recording, sent between the background
 * service worker and a tab's content script.
 */

import type { TargetDescriptor } from "./describe-target";

export const RECORD_START = "bsk-record-start";
export const RECORD_STEP = "bsk-record-step";
export const RECORD_STOP = "bsk-record-stop";
export const RECORD_CANCEL = "bsk-record-cancel";
export const RECORD_FINISH = "bsk-record-finish";
export const RECORD_QUERY = "bsk-record-query";

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
}

export interface RecordStartMessage {
  type: typeof RECORD_START;
  requestId: string;
}

export interface RecordStepPayload {
  op: "click" | "fill" | "press" | "select" | "navigate";
  target?: TargetDescriptor;
  value?: string;
  key?: string;
  modifiers?: Array<"alt" | "ctrl" | "meta" | "shift">;
  values?: string[];
  labels?: string[];
  url?: string;
  summary?: string;
  redacted?: boolean;
  /** Page URL when the step was captured (for textbook page context). */
  page_url?: string;
  /** Capture-only hint; never persisted unless converted to navigated_to. */
  expects_navigation?: boolean;
  /** Whether an observed URL change was synchronously caused by the action. */
  navigation_caused_by_action?: boolean;
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
  if (m.type !== RECORD_STEP || typeof m.requestId !== "string") return false;
  const step = m.step;
  if (typeof step !== "object" || step === null) return false;
  return typeof (step as RecordStepPayload).op === "string";
}
