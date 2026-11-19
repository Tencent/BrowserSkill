import { describe, expect, it, vi } from "vitest";
import { type FrameDocumentHandle, toFrameDocumentHandle } from "@/browser-driver/frame-handles";
import { type CdpRunner, createStubCdpRunner } from "../../shared";
import type { CapturedNode } from "../capture";
import type { FrameDocument, FrameOwnedAxNode } from "../frame-document";
import { probeTooltipNames } from "../name-enrichment";
import { buildSemanticGraph, resolveSemanticGraph } from "../semantic-graph";
import { stableIdentifierName } from "../semantic-graph/name-evidence";
import { frameBackendKey } from "../semantic-graph/types";

function document(
  handle: FrameDocumentHandle,
  backendNodeId: number,
  accessibleName?: string,
  frameId = handle.frameId || "child",
  x = 10,
): FrameDocument<FrameOwnedAxNode> {
  const node: CapturedNode = {
    backendNodeId,
    parentBackendNodeId: null,
    frameId,
    tag: "button",
    attrs: {
      id: "toolInsertRecord",
      "data-test-id": "toolInsertRecord",
      ...(accessibleName ? { "aria-label": accessibleName } : {}),
    },
    rect: { x, y: 20, w: 40, h: 30 },
    localRect: { x: 2, y: 3, w: 40, h: 30 },
    paintOrder: 1,
    position: "static",
    pointerEvents: "auto",
    cursor: "pointer",
  };
  return {
    frameId,
    loaderId: handle.loaderId,
    processKey: "root",
    isOutOfProcess: false,
    parentFrameId: "main",
    contextScopeId: "child",
    handle,
    axNodes: [],
    domNodes: [node],
    url: "https://example.com/frame",
  };
}

function semantics(documents: FrameDocument<FrameOwnedAxNode>[]) {
  return resolveSemanticGraph(
    buildSemanticGraph({
      documents,
      viewport: { width: 800, height: 600 },
      rootFrameId: documents[0]?.frameId,
    }),
    { identifierFallback: false },
  );
}

describe("tooltip name enrichment", () => {
  it("uses the owning frame target and upgrades an identifier name from a tooltip", async () => {
    const handle = toFrameDocumentHandle(7, { frameId: "child", loaderId: "oopif-loader" });
    let hovered = false;
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async (_tabId, method, params) => {
        if (method === "Input.dispatchMouseEvent") {
          hovered = (params as { x?: number }).x === 30;
        }
        return {};
      }) as CdpRunner["send"],
      sendToFrame: vi.fn(async (_handle, method) => {
        if (method === "Page.createIsolatedWorld") return { executionContextId: 11 };
        if (method === "DOM.resolveNode") return { object: { objectId: "button-501" } };
        if (method === "Runtime.callFunctionOn") {
          return { result: { value: hovered ? ["插入行"] : [] } };
        }
        return {};
      }) as CdpRunner["sendToFrame"],
    });

    const documents = [document(handle, 501)];
    const graph = semantics(documents);
    const names = await probeTooltipNames(cdp, 7, documents, graph);

    expect(names.get(frameBackendKey("child", 501))).toBe("插入行");
    expect(cdp.sendToFrame).toHaveBeenCalledWith(
      handle,
      "Page.createIsolatedWorld",
      expect.objectContaining({ frameId: "child" }),
    );

    const sendsBeforeCache = vi.mocked(cdp.send).mock.calls.length;
    const frameSendsBeforeCache = vi.mocked(cdp.sendToFrame).mock.calls.length;
    const cached = await probeTooltipNames(cdp, 7, documents, graph);
    expect(cached.get(frameBackendKey("child", 501))).toBe("插入行");
    expect(cdp.send).toHaveBeenCalledTimes(sendsBeforeCache);
    expect(cdp.sendToFrame).toHaveBeenCalledTimes(frameSendsBeforeCache);
  });

  it("does not probe controls that already have a higher-confidence name", async () => {
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      sendToFrame: vi.fn(async () => ({ executionContextId: 12 })) as CdpRunner["sendToFrame"],
    });

    const documents = [
      document(toFrameDocumentHandle(8, { frameId: "child" }), 601, "Add a new record"),
    ];
    const names = await probeTooltipNames(cdp, 8, documents, semantics(documents));

    expect(names.size).toBe(0);
    expect(cdp.send).not.toHaveBeenCalled();
    expect(cdp.sendToFrame).not.toHaveBeenCalled();
  });

  it("does not collect supplemental names from form controls", async () => {
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      sendToFrame: vi.fn(async () => ({ executionContextId: 12 })) as CdpRunner["sendToFrame"],
    });
    const inputDocument = document(toFrameDocumentHandle(8, { frameId: "child" }), 602);
    inputDocument.domNodes[0] = {
      ...inputDocument.domNodes[0],
      tag: "input",
      attrs: { type: "email" },
      formValue: "user@example.com",
      formDefaultValue: "",
      formState: "filled",
    };

    const names = await probeTooltipNames(cdp, 8, [inputDocument], semantics([inputDocument]));

    expect(names.size).toBe(0);
    expect(cdp.send).not.toHaveBeenCalled();
    expect(cdp.sendToFrame).not.toHaveBeenCalled();
  });

  it("remembers controls that revealed no tooltip so the miss is paid once", async () => {
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      sendToFrame: vi.fn(async (_handle, method) => {
        if (method === "Page.createIsolatedWorld") return { executionContextId: 31 };
        if (method === "DOM.resolveNode") return { object: { objectId: "button-801" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: [] } };
        return {};
      }) as CdpRunner["sendToFrame"],
    });

    const documents = [
      document(
        toFrameDocumentHandle(11, { frameId: "miss-frame", loaderId: "miss-loader" }),
        801,
        undefined,
        "miss-frame",
      ),
    ];
    const graph = semantics(documents);

    const first = await probeTooltipNames(cdp, 11, documents, graph);
    expect(first.size).toBe(0);
    const hoversAfterFirst = vi
      .mocked(cdp.send)
      .mock.calls.filter(([, method]) => method === "Input.dispatchMouseEvent").length;
    expect(hoversAfterFirst).toBeGreaterThan(0);

    const second = await probeTooltipNames(cdp, 11, documents, graph);
    expect(second.size).toBe(0);
    expect(
      vi.mocked(cdp.send).mock.calls.filter(([, method]) => method === "Input.dispatchMouseEvent")
        .length,
    ).toBe(hoversAfterFirst);
  });

  it("keeps tooltip evidence isolated across sibling frame sessions", async () => {
    let hoveredX = -10;
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async (_tabId, method, params) => {
        if (method === "Input.dispatchMouseEvent") {
          hoveredX = (params as { x: number }).x;
        }
        return {};
      }) as CdpRunner["send"],
      sendToFrame: vi.fn(async (handle, method, params) => {
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: handle.frameId === "left" ? 21 : 22 };
        }
        if (method === "DOM.resolveNode") {
          return { object: { objectId: handle.frameId === "left" ? "left" : "right" } };
        }
        if (method === "Runtime.callFunctionOn") {
          const objectId = (params as { objectId: string }).objectId;
          const value =
            objectId === "left" && hoveredX === 30
              ? ["Left action"]
              : objectId === "right" && hoveredX === 130
                ? ["Right action"]
                : [];
          return { result: { value } };
        }
        return {};
      }) as CdpRunner["sendToFrame"],
    });
    const documents = [
      document(
        toFrameDocumentHandle(9, { frameId: "left", loaderId: "left-loader" }),
        701,
        undefined,
        "left",
        10,
      ),
      document(
        toFrameDocumentHandle(9, { frameId: "right", loaderId: "right-loader" }),
        701,
        undefined,
        "right",
        110,
      ),
    ];

    const names = await probeTooltipNames(cdp, 9, documents, semantics(documents));

    expect(names.get(frameBackendKey("left", 701))).toBe("Left action");
    expect(names.get(frameBackendKey("right", 701))).toBe("Right action");
  });
});

describe("stable identifier evidence", () => {
  it("accepts readable action identifiers and rejects framework-generated ids", () => {
    expect(stableIdentifierName({ id: "toolInsertRecord" })).toBe("Insert record");
    expect(stableIdentifierName({ id: "reactivateAccount" })).toBe("Reactivate account");
    expect(stableIdentifierName({ id: "headlessui-menu-button-r1" })).toBeUndefined();
    expect(stableIdentifierName({ id: "7f15a3bc91" })).toBeUndefined();
  });
});
