export const RECORD_FRAME_PORT = "bsk-record-frame";
export const RECORD_FRAME_QUERY = "bsk-record-frame-query";
export const RECORD_FRAME_START = "bsk-record-frame-start";

export interface RecordFrameQueryMessage {
  type: typeof RECORD_FRAME_QUERY;
}

export interface RecordFrameQueryResponse {
  active: boolean;
  requestId?: string;
  startedAtMs?: number;
}

export interface RecordFrameStartMessage {
  type: typeof RECORD_FRAME_START;
  requestId: string;
  startedAtMs: number;
}

export type RecordFramePortMessage =
  | {
      type: "ready";
      requestId: string;
      producerId: string;
    }
  | {
      type: "ready_ack";
      requestId: string;
      producerId: string;
    }
  | {
      type: "stop";
      requestId: string;
      commandId: string;
    }
  | {
      type: "cancel";
      requestId: string;
    }
  | {
      type: "stopped";
      requestId: string;
      commandId: string;
      ok: boolean;
      error?: string;
    };

export function isRecordFrameQueryMessage(value: unknown): value is RecordFrameQueryMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === RECORD_FRAME_QUERY
  );
}

export function isRecordFrameStartMessage(value: unknown): value is RecordFrameStartMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<RecordFrameStartMessage>;
  return (
    message.type === RECORD_FRAME_START &&
    typeof message.requestId === "string" &&
    typeof message.startedAtMs === "number"
  );
}
