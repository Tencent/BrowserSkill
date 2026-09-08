import { describe, expect, it, vi } from "vitest";
import type { CdpFrame, CdpTarget } from "@/browser-driver/frame-graph";
import { cdpTargetKey } from "@/browser-driver/frame-graph";
import { OVERLAY_HOST_MARKER_ATTR } from "@/lib/overlay-bridge";
import type { CdpRunner } from "../../shared";
import { captureObservationFacts, semanticCapture } from "../capture-coordinator";
import { buildSemanticGraph } from "../semantic-graph/build";
import { REQUESTED_STYLES } from "../snapshot";

function fixture(
  options: {
    frames?: CdpFrame[];
    after?: Record<string, { loader?: string; element?: number; missing?: boolean }>;
    fail?: string;
    missingIdentity?: boolean;
    omitDocument?: string;
    attachmentChanged?: boolean;
    overlay?: string;
  } = {},
) {
  const frames = options.frames ?? [
    { frameId: "main", loaderId: "main-loader", target: { tabId: 4 } },
    {
      frameId: "same",
      parentFrameId: "main",
      ownerBackendNodeId: 3,
      loaderId: "same-loader",
      target: { tabId: 4 },
    },
    {
      frameId: "nested",
      parentFrameId: "same",
      ownerBackendNodeId: 13,
      loaderId: "nested-loader",
      target: { tabId: 4 },
    },
    {
      frameId: "remote",
      parentFrameId: "main",
      ownerBackendNodeId: 4,
      loaderId: "remote-loader",
      target: { tabId: 4, sessionId: "remote" },
    },
  ];
  const elements = new Map(
    frames.map((frame, i) => [frame.frameId, frame.target.sessionId ? 1 : i * 10 + 1]),
  );
  const contexts = new Map(frames.map((frame, i) => [i + 1, frame.frameId]));
  const reads = new Map<string, number>();
  const logs: Array<{ target: CdpTarget; method: string; params: Record<string, unknown> }> = [];
  let snapshots = 0;
  const targetCount = new Set(frames.map((frame) => cdpTargetKey(frame.target))).size;
  const send = vi.fn(
    async <T>(target: CdpTarget, method: string, params: object = {}): Promise<T> => {
      logs.push({ target, method, params: params as Record<string, unknown> });
      const args = params as Record<string, string | number>;
      if (options.fail === `${target.sessionId ?? "main"}:${method}`)
        throw new Error("fixture failure");
      let result: unknown = {};
      if (method === "Page.createIsolatedWorld")
        result = {
          executionContextId: frames.findIndex((frame) => frame.frameId === args.frameId) + 1,
        };
      if (method === "Runtime.evaluate")
        result = { result: { objectId: contexts.get(Number(args.contextId)) } };
      if (method === "DOM.describeNode") {
        const id = String(args.objectId);
        const count = reads.get(id) ?? 0;
        reads.set(id, count + 1);
        result = options.missingIdentity
          ? {}
          : {
              node: {
                backendNodeId:
                  count > 0 ? (options.after?.[id]?.element ?? elements.get(id)) : elements.get(id),
              },
            };
      }
      if (method === "Page.getFrameTree") {
        const own = frames.filter(
          (frame) =>
            cdpTargetKey(frame.target) === cdpTargetKey(target) &&
            !options.after?.[frame.frameId]?.missing,
        );
        const trees = new Map(
          own.map((frame) => [
            frame.frameId,
            {
              frame: {
                id: frame.frameId,
                loaderId: options.after?.[frame.frameId]?.loader ?? frame.loaderId,
              },
              childFrames: [] as unknown[],
            },
          ]),
        );
        for (const frame of own)
          if (frame.parentFrameId && trees.has(frame.parentFrameId))
            trees.get(frame.parentFrameId)!.childFrames.push(trees.get(frame.frameId));
        result = { frameTree: trees.get(own[0]?.frameId) };
      }
      if (method === "Page.getLayoutMetrics")
        result = { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
      if (method === "DOMSnapshot.captureSnapshot") {
        snapshots++;
        expect((params as { computedStyles: unknown }).computedStyles).toEqual(REQUESTED_STYLES);
        result = {
          strings: [
            "#document",
            "html",
            "button",
            OVERLAY_HOST_MARKER_ATTR,
            "",
            "visible",
            "1",
            "static",
            "auto",
          ],
          documents: frames
            .filter(
              (frame) =>
                cdpTargetKey(frame.target) === cdpTargetKey(target) &&
                frame.frameId !== options.omitDocument,
            )
            .map((frame) => {
              const element = elements.get(frame.frameId)!;
              return {
                frameId: frame.frameId,
                nodes: {
                  backendNodeId: [element - 1, element + 10000, element, element + 1],
                  nodeName: [0, 1, 1, 2],
                  nodeType: [9, 10, 1, 1],
                  parentIndex: [-1, 0, 0, 2],
                  attributes: [[], [], [], frame.frameId === options.overlay ? [3, 4] : []],
                },
                layout: {
                  nodeIndex: [2, 3],
                  bounds: [
                    [0, 0, 1000, 800],
                    [10, 20, 100, 40],
                  ],
                  styles: [
                    [7, 8, 8, 5, 6],
                    [7, 8, 8, 5, 6],
                  ],
                },
              };
            }),
        };
      }
      if (method === "Accessibility.getFullAXTree") {
        const frameId = String(args.frameId);
        result = {
          nodes: [
            {
              nodeId: `${frameId}-button`,
              frameId,
              backendDOMNodeId: elements.get(frameId)! + 1,
              role: { value: "button" },
              name: { value: frameId },
            },
          ],
        };
      }
      return result as T;
    },
  );
  const cdp: CdpRunner = {
    getAttachmentId: () =>
      options.attachmentChanged && snapshots === targetCount ? "new-attachment" : "attachment",
    getFrameGraph: async () => ({ rootFrameId: frames[0].frameId, frames }),
    send: (tabId, method, params) =>
      (send as NonNullable<CdpRunner["sendToTarget"]>)({ tabId }, method, params),
    sendToTarget: send as NonNullable<CdpRunner["sendToTarget"]>,
  };
  return { cdp, logs, elements };
}

describe("captureObservationFacts", () => {
  it("collects each target once, validates every document and scopes equal backend IDs", async () => {
    const { cdp, logs } = fixture();
    const facts = await captureObservationFacts(cdp, 4);
    expect(logs.filter((call) => call.method === "DOMSnapshot.captureSnapshot")).toHaveLength(2);
    expect(logs.filter((call) => call.method === "Accessibility.enable")).toHaveLength(2);
    expect(logs.filter((call) => call.method === "Accessibility.getFullAXTree")).toHaveLength(4);
    expect(logs.filter((call) => call.method === "DOM.describeNode")).toHaveLength(8);
    expect(logs.filter((call) => call.method === "Runtime.releaseObject")).toHaveLength(8);
    expect(facts.documents.every((doc) => doc.identity)).toBe(true);
    const main = facts.documents.find((doc) => doc.frame.frameId === "main")!;
    const remote = facts.documents.find((doc) => doc.frame.frameId === "remote")!;
    expect(main.index.nodes.get(2)).not.toBe(remote.index.nodes.get(2));
    expect(main.index.children.get(1)).toEqual([2]);
    expect(main.index.nodes.get(10001)?.nodeType).toBe(10);
    expect(main.identity?.documentElementBackendNodeId).toBe(1);
    expect(remote.axNodes[0].frameId).toBe("remote");
    expect(main.index.nodes.get(2)).toBe(main.domNodes.find((node) => node.backendNodeId === 2));
    expect(facts.finishedAt).toBeGreaterThanOrEqual(facts.startedAt);
  });

  it.each([
    { loader: "new-loader" },
    { element: 99 },
    { missing: true },
  ])("isolates changed child identity %j and dependent descendants", async (change) => {
    const { cdp } = fixture({ after: { same: change } });
    const facts = await captureObservationFacts(cdp, 4);
    expect(facts.documents.map((doc) => doc.frame.frameId)).toEqual(["main", "remote"]);
    expect(facts.issues).toContainEqual(
      expect.objectContaining({ frameId: "same", reason: "document-changed" }),
    );
  });

  it.each([
    { after: { main: { element: 99 } } },
    { attachmentChanged: true },
  ])("rejects a root replacement or reattachment %j", async (options) => {
    await expect(captureObservationFacts(fixture(options).cdp, 4)).rejects.toThrow(
      "document identity",
    );
  });

  it("does not retry failed or missing documents and retains valid AX-only semantics", async () => {
    const { cdp, logs } = fixture({
      fail: "remote:DOMSnapshot.captureSnapshot",
      omitDocument: "same",
    });
    const facts = await captureObservationFacts(cdp, 4);
    const remote = facts.documents.find((doc) => doc.frame.frameId === "remote")!;
    expect(remote.domNodes).toHaveLength(0);
    expect(remote.axNodes).toHaveLength(1);
    expect(logs.filter((call) => call.method === "DOMSnapshot.captureSnapshot")).toHaveLength(2);
    expect(facts.issues).toContainEqual(
      expect.objectContaining({ frameId: "same", stage: "dom", reason: "capture-unavailable" }),
    );
    expect(facts.issues).toContainEqual(
      expect.objectContaining({ target: { tabId: 4, sessionId: "remote" }, stage: "dom" }),
    );
  });

  it("keeps missing identity explicit without manufacturing a verified document", async () => {
    const facts = await captureObservationFacts(fixture({ missingIdentity: true }).cdp, 4);
    expect(facts.documents.every((doc) => !doc.identity)).toBe(true);
    expect(facts.issues.filter((issue) => issue.reason === "identity-unverified")).toHaveLength(4);
  });

  it("excludes overlay AX in its own document without excluding equal IDs elsewhere", async () => {
    const facts = await captureObservationFacts(fixture({ overlay: "remote" }).cdp, 4);
    const { documents } = semanticCapture(facts);
    const graph = buildSemanticGraph({
      documents,
      viewport: facts.viewport,
      rootFrameId: facts.rootFrameId,
    });
    expect(
      [...graph.nodes.values()].find(
        (node) => node.frameId === "remote" && node.backendNodeId === 2,
      )?.excluded,
    ).toBe(true);
    expect(
      [...graph.nodes.values()].find((node) => node.frameId === "main" && node.backendNodeId === 2)
        ?.excluded,
    ).toBe(false);
  });

  it("bounds collection across many targets and stops scheduling after cancellation", async () => {
    const frames = Array.from({ length: 12 }, (_, i) => ({
      frameId: `f${i}`,
      target: { tabId: 4, ...(i ? { sessionId: `s${i}` } : {}) },
    }));
    const { cdp } = fixture({ frames });
    let active = 0,
      peak = 0;
    const original = cdp.sendToTarget!;
    const send: NonNullable<CdpRunner["sendToTarget"]> = async (target, method, params) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await original(target, method, params);
      } finally {
        active--;
      }
    };
    cdp.sendToTarget = send;
    cdp.send = (tabId, method, params) => send({ tabId }, method, params);
    await captureObservationFacts(cdp, 4);
    // This fixture has no frame edges, so no concurrent owner requests.
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    const controller = new AbortController();
    controller.abort();
    await expect(captureObservationFacts(cdp, 4, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(active).toBe(0);
  });
});

function childSnapshot(frameId: string, backendNodeId: number) {
  const strings = [frameId, "body", "button", "static", "auto", "pointer"];
  return {
    strings,
    documents: [
      {
        frameId,
        nodes: {
          parentIndex: [-1, 0],
          nodeName: [1, 2],
          backendNodeId: [backendNodeId - 1, backendNodeId],
          attributes: [[], []],
        },
        layout: {
          nodeIndex: [0, 1],
          styles: [
            [3, 4, 4],
            [3, 4, 5],
          ],
          bounds: [
            [0, 0, 300, 200],
            [10, 20, 100, 40],
          ],
          paintOrders: [0, 1],
        },
      },
    ],
  };
}

describe("OOPIF capture", () => {
  it("captures and positions multiple OOPIF documents missing from the root snapshot", async () => {
    const sendToTarget = vi.fn(async (target, method) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 300, clientHeight: 200, pageX: 0, pageY: 0 } };
      }
      if (method === "DOMSnapshot.enable" || method === "Accessibility.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") {
        return target.sessionId === "left-session"
          ? childSnapshot("left", 101)
          : childSnapshot("right", 201);
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      throw new Error(`unexpected ${method}`);
    });
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId, method, params) => {
        if (method === "Accessibility.enable" || method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return childSnapshot("main", 1);
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        if (method === "DOM.getBoxModel") {
          const backendNodeId = (params as { backendNodeId?: number })?.backendNodeId;
          const x = backendNodeId === 10 ? 50 : 500;
          return { model: { content: [x, 100, x + 300, 100, x + 300, 300, x, 300] } };
        }
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
        }
        throw new Error(`unexpected root ${method}`);
      }) as CdpRunner["send"],
      sendToTarget: sendToTarget as unknown as NonNullable<CdpRunner["sendToTarget"]>,
      getFrameGraph: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          { frameId: "main", target: { tabId: 4 } },
          {
            frameId: "left",
            parentFrameId: "main",
            ownerBackendNodeId: 10,
            target: { tabId: 4, sessionId: "left-session" },
          },
          {
            frameId: "right",
            parentFrameId: "main",
            ownerBackendNodeId: 20,
            target: { tabId: 4, sessionId: "right-session" },
          },
        ],
      })),
    };

    const { documents: trees } = semanticCapture(await captureObservationFacts(cdp, 4));

    expect(trees.map((tree) => tree.frameId)).toEqual(["main", "left", "right"]);
    expect(
      trees
        .find((doc) => doc.frameId === "left")
        ?.domNodes?.find((node) => node.backendNodeId === 101)?.rect,
    ).toEqual({ x: 60, y: 120, w: 100, h: 40 });
    expect(
      trees
        .find((doc) => doc.frameId === "right")
        ?.domNodes?.find((node) => node.backendNodeId === 201)?.rect,
    ).toEqual({ x: 510, y: 120, w: 100, h: 40 });
    expect(
      new Map(
        trees
          .filter((doc) => doc.ownerBackendNodeId !== undefined)
          .map((doc) => [doc.frameId, doc.ownerBackendNodeId]),
      ),
    ).toEqual(
      new Map([
        ["left", 10],
        ["right", 20],
      ]),
    );
    expect(
      new Map(
        trees.filter((doc) => doc.parentFrameId).map((doc) => [doc.frameId, doc.parentFrameId]),
      ),
    ).toEqual(
      new Map([
        ["left", "main"],
        ["right", "main"],
      ]),
    );
  });

  it("keeps OOPIF semantics when viewport projection is unavailable", async () => {
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId, method) => {
        if (method === "Accessibility.enable" || method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return childSnapshot("main", 1);
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        if (method === "DOM.getBoxModel") throw new Error("owner geometry unavailable");
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
        }
        throw new Error(`unexpected root ${method}`);
      }) as CdpRunner["send"],
      sendToTarget: vi.fn(async (_target, method) => {
        if (method === "Page.getLayoutMetrics") throw new Error("viewport unavailable");
        if (method === "DOMSnapshot.enable" || method === "Accessibility.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return childSnapshot("child", 101);
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              {
                nodeId: "button",
                backendDOMNodeId: 101,
                role: { type: "role", value: "button" },
                name: { type: "computedString", value: "Continue" },
              },
            ],
          };
        }
        throw new Error(`unexpected ${method}`);
      }) as unknown as NonNullable<CdpRunner["sendToTarget"]>,
      getFrameGraph: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          { frameId: "main", target: { tabId: 4 } },
          {
            frameId: "child",
            parentFrameId: "main",
            ownerBackendNodeId: 10,
            target: { tabId: 4, sessionId: "child-session" },
          },
        ],
      })),
    };

    const { documents } = semanticCapture(await captureObservationFacts(cdp, 4));
    const childDocument = documents.find((document) => document.frameId === "child");

    expect(childDocument?.axNodes).toEqual([
      expect.objectContaining({ backendDOMNodeId: 101, frameId: "child" }),
    ]);
    expect(childDocument?.domNodes.find((node) => node.backendNodeId === 101)).toEqual(
      expect.objectContaining({ rect: null, localRect: { x: 10, y: 20, w: 100, h: 40 } }),
    );
  });
});
