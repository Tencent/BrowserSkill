import { describe, expect, it } from "vitest";
import {
  RECORD_DOCUMENT_ATTRIBUTE,
  recordingDocumentMarkerValue,
} from "@/shared/recording-document-identity";
import { projectRecordSafeObservation } from "../record-safe-observation";

describe("projectRecordSafeObservation", () => {
  it("projects the opaque recording identity without exposing captured attributes", () => {
    const recordingDocumentId = "123e4567-e89b-42d3-a456-426614174000";
    const result = projectRecordSafeObservation({
      rootFrameId: "child",
      frameDocuments: [
        {
          frameId: "child",
          target: { tabId: 4, sessionId: "oopif-session" },
          contextScopeId: "scope-1",
          axNodes: [],
          domNodes: [
            {
              backendNodeId: 1,
              parentBackendNodeId: null,
              tag: "html",
              attrs: {
                [RECORD_DOCUMENT_ATTRIBUTE]: recordingDocumentMarkerValue(recordingDocumentId),
                value: "user@example.com",
              },
              rect: null,
              paintOrder: 0,
              position: "static",
              pointerEvents: "auto",
            },
          ],
        },
      ],
      rendered: { text: '@vom 1\nRootWebArea "Example"', refs: [], truncated: false },
    });

    expect(result.frames).toEqual([
      {
        frameId: "child",
        target: { tabId: 4, sessionId: "oopif-session" },
        recordingDocumentId,
      },
    ]);
    const dumped = JSON.stringify(result);
    expect(dumped).not.toContain("user@example.com");
    expect(dumped).not.toContain("attrs");
    expect(dumped).not.toContain("domNodes");
    expect(dumped).not.toContain("axNodes");
  });

  it("does not project a page-controlled marker value as recording identity", () => {
    const result = projectRecordSafeObservation({
      rootFrameId: "root",
      frameDocuments: [
        {
          frameId: "root",
          target: { tabId: 4 },
          contextScopeId: "scope-1",
          axNodes: [],
          domNodes: [
            {
              backendNodeId: 1,
              parentBackendNodeId: null,
              tag: "html",
              attrs: { [RECORD_DOCUMENT_ATTRIBUTE]: "bsk:user@example.com" },
              rect: null,
              paintOrder: 0,
              position: "static",
              pointerEvents: "auto",
            },
          ],
        },
      ],
      rendered: { text: '@vom 1\nRootWebArea "Example"', refs: [], truncated: false },
    });

    expect(result.frames).toEqual([{ frameId: "root", target: { tabId: 4 } }]);
    expect(JSON.stringify(result)).not.toContain("user@example.com");
  });
});
