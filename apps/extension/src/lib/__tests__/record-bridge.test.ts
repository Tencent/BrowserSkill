import { describe, expect, it } from "vitest";
import {
  isAcceptedRecordStepAck,
  isRecordStepMessage,
  RECORD_STEP,
  type RecordStepMessage,
} from "../record-bridge";

const message: RecordStepMessage = {
  type: RECORD_STEP,
  requestId: "rec-1",
  producerId: "document-1",
  sequence: 1,
  step: { op: "click", target: { tag: "button", name: "Submit" } },
};

describe("record step delivery protocol", () => {
  it("requires a producer and a positive integer sequence", () => {
    expect(isRecordStepMessage(message)).toBe(true);
    expect(isRecordStepMessage({ ...message, producerId: "" })).toBe(false);
    expect(isRecordStepMessage({ ...message, sequence: 0 })).toBe(false);
    expect(isRecordStepMessage({ ...message, sequence: 1.5 })).toBe(false);
  });

  it("accepts only the acknowledgement for the sent sequence", () => {
    expect(isAcceptedRecordStepAck({ ok: true, sequence: 2 }, 2)).toBe(true);
    expect(isAcceptedRecordStepAck({ ok: true, sequence: 1 }, 2)).toBe(false);
    expect(isAcceptedRecordStepAck({ ok: false, expectedSequence: 2, error: "gap" }, 2)).toBe(
      false,
    );
  });
});
