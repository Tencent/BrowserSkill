// Public protocol payloads are generated from bsk-protocol.
// Transport envelopes deliberately admit unknown method/event names for versioned peers.
import type {
  ErrorCode,
  HandshakeRequest,
  NavigateBackResult,
  RpcErrorReason,
  SessionStopOutcome,
  TabScope,
} from "./generated/types";

export type { EventName } from "./generated/methods";
export { TRACE_VERSION_V3, VOM_FORMAT_VERSION } from "./generated/methods";
export type * from "./generated/types";
export type HandshakeParams = HandshakeRequest;
export type HandshakeResult = import("./generated/input").HandshakeResponse;
export type SessionStopResult = SessionStopOutcome;
export type RpcId = string;
export type NavigateHistoryResult = NavigateBackResult;
export type TabScopeFilter = TabScope;
export type ConnectionState = "disconnected" | "connecting" | "connected" | "version_skew";

export type TransferEffectState = "none" | "committed" | "unknown";
export type TransferCleanupState = "complete" | "failed";

export interface RpcErrorData {
  reason?: RpcErrorReason;
  effect_state?: TransferEffectState;
  phase?: string;
  cleanup_state?: TransferCleanupState;
  [key: string]: unknown;
}

export interface RpcError {
  code: ErrorCode;
  message: string;
  data?: RpcErrorData;
}

export interface RequestFrame {
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface OkResponseFrame {
  id: RpcId;
  result: unknown;
}

export interface ErrResponseFrame {
  id: RpcId;
  error: RpcError;
}

export type ResponseFrame = OkResponseFrame | ErrResponseFrame;

export interface EventFrame {
  event: string;
  payload?: unknown;
}

/** Terminal user action: pages stay open, but the session cannot resume. */
export interface SessionEndedEvent extends EventFrame {
  event: "session.ended";
  payload: {
    session_id: string;
    reason: "user_moved_tab";
    tab_id: number;
  };
}

export type ProtocolFrame = RequestFrame | ResponseFrame | EventFrame;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRequestFrame(f: unknown): f is RequestFrame {
  return (
    isObject(f) &&
    typeof f.id === "string" &&
    typeof f.method === "string" &&
    !("result" in f) &&
    !("error" in f) &&
    !("event" in f)
  );
}

export function isResponseFrame(f: unknown): f is ResponseFrame {
  if (!isObject(f) || typeof f.id !== "string" || "method" in f || "event" in f) return false;
  if ("result" in f) return !("error" in f);
  return (
    isObject(f.error) &&
    typeof f.error.code === "string" &&
    typeof f.error.message === "string" &&
    (f.error.data === undefined || isObject(f.error.data))
  );
}

export function isEventFrame(f: unknown): f is EventFrame {
  return (
    isObject(f) &&
    typeof f.event === "string" &&
    !("id" in f) &&
    !("method" in f) &&
    !("result" in f) &&
    !("error" in f)
  );
}

export function isProtocolFrame(f: unknown): f is ProtocolFrame {
  return isRequestFrame(f) || isResponseFrame(f) || isEventFrame(f);
}
