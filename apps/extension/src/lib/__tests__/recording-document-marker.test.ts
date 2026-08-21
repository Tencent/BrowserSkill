import { describe, expect, it } from "vitest";
import {
  RECORD_DOCUMENT_ATTRIBUTE,
  recordingDocumentMarkerValue,
} from "@/shared/recording-document-identity";
import { markRecordingDocument } from "../recording/document-marker";
import { ObservationNodeIndex } from "../recording/observation-capture";

describe("recording document marker", () => {
  it("rejects a non-random Document identity", () => {
    expect(() => markRecordingDocument("user@example.com")).toThrow(
      "recording Document identity must be a random UUID",
    );
  });

  it("restores the Document attribute exactly", () => {
    document.documentElement.setAttribute(RECORD_DOCUMENT_ATTRIBUTE, "page-value");
    const producerId = "123e4567-e89b-42d3-a456-426614174000";
    const marker = markRecordingDocument(producerId);

    expect(document.documentElement.getAttribute(RECORD_DOCUMENT_ATTRIBUTE)).toBe(
      recordingDocumentMarkerValue(producerId),
    );
    marker.restore();
    expect(document.documentElement.getAttribute(RECORD_DOCUMENT_ATTRIBUTE)).toBe("page-value");
    document.documentElement.removeAttribute(RECORD_DOCUMENT_ATTRIBUTE);
  });

  it("indexes the CDP scope from the safe frame identity", () => {
    const index = new ObservationNodeIndex({
      rootFrameId: "root",
      frames: [
        {
          frameId: "child",
          target: { tabId: 3, sessionId: "oopif-session" },
          recordingDocumentId: "producer-1",
        },
      ],
      matchNodes: [],
      refs: [],
    });

    expect(index.documentScope("producer-1")).toEqual({
      frameId: "child",
      target: { tabId: 3, sessionId: "oopif-session" },
    });
  });

  it("fails closed when a recording identity maps to multiple Documents", () => {
    const index = new ObservationNodeIndex({
      rootFrameId: "root",
      frames: [
        {
          frameId: "left",
          target: { tabId: 3, sessionId: "left-session" },
          recordingDocumentId: "duplicate",
        },
        {
          frameId: "right",
          target: { tabId: 3, sessionId: "right-session" },
          recordingDocumentId: "duplicate",
        },
      ],
      matchNodes: [],
      refs: [],
    });

    expect(index.documentScope("duplicate")).toBeUndefined();
  });
});
