export const RECORD_FRAME_PORT = "bsk-record-frame";
export const RECORD_FRAME_START = "bsk-record-frame-start";

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
      type: "subframe_added";
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

export function isRecordFrameStartMessage(value: unknown): value is RecordFrameStartMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<RecordFrameStartMessage>;
  return (
    message.type === RECORD_FRAME_START &&
    typeof message.requestId === "string" &&
    typeof message.startedAtMs === "number"
  );
}
