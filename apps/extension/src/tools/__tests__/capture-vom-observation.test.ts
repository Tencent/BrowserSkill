import { describe, expect, it } from "vitest";
import { RECORD_DOCUMENT_TOKEN_ATTR } from "@/lib/record-document-token";
import type { CapturedNode } from "@/tools/vom/capture";
import { collectDocumentTokenOwners } from "../capture-vom-observation";

function htmlNode(
  backendNodeId: number,
  token: string,
  ownerFrameBackendNodeId: number | null = null,
): CapturedNode {
  return {
    backendNodeId,
    parentBackendNodeId: null,
    tag: "html",
    attrs: { [RECORD_DOCUMENT_TOKEN_ATTR]: token },
    rect: { x: 0, y: 0, w: 1280, h: 720 },
    paintOrder: 0,
    position: "static",
    pointerEvents: "auto",
    ...(ownerFrameBackendNodeId === null ? {} : { ownerFrameBackendNodeId }),
  };
}

describe("collectDocumentTokenOwners", () => {
  it("maps document tokens to their immediate iframe owner backend node", () => {
    const topToken = "top-doc-token";
    const childToken = "child-doc-token";
    const owners = collectDocumentTokenOwners({
      viewport: { width: 1280, height: 720 },
      nodes: [htmlNode(1, topToken, null)],
      iframeNodes: new Map([
        [
          13,
          [
            htmlNode(101, childToken, 13),
            {
              backendNodeId: 102,
              parentBackendNodeId: 101,
              tag: "input",
              attrs: {},
              rect: { x: 10, y: 20, w: 200, h: 30 },
              paintOrder: 1,
              position: "static",
              pointerEvents: "auto",
              ownerFrameBackendNodeId: 13,
            },
          ],
        ],
      ]),
      excludedBackendNodeIds: new Set(),
    });

    expect(owners.get(topToken)).toBeNull();
    expect(owners.get(childToken)).toBe(13);
  });

  it("maps nested iframe documents to their direct owner, not the outer iframe", () => {
    const nestedToken = "nested-doc-token";
    const owners = collectDocumentTokenOwners({
      viewport: { width: 1280, height: 720 },
      nodes: [htmlNode(1, "top-token", null)],
      iframeNodes: new Map([
        [
          13,
          [
            {
              backendNodeId: 23,
              parentBackendNodeId: 101,
              tag: "iframe",
              attrs: {},
              rect: { x: 0, y: 0, w: 400, h: 300 },
              paintOrder: 1,
              position: "static",
              pointerEvents: "auto",
              ownerFrameBackendNodeId: 13,
            },
          ],
        ],
        [23, [htmlNode(201, nestedToken, 23)]],
      ]),
      excludedBackendNodeIds: new Set(),
    });

    expect(owners.get(nestedToken)).toBe(23);
  });
});
