import { describe, expect, it, vi } from "vitest";
import type { CdpFrame, CdpTarget } from "@/browser-driver/frame-graph";
import { cdpTargetKey } from "@/browser-driver/frame-graph";
import { OVERLAY_HOST_MARKER_ATTR } from "@/lib/overlay-bridge";
import { captureVomObservation } from "../../observation";
import type { CdpRunner } from "../../shared";
import { captureObservationFacts, semanticCapture } from "../capture-coordinator";
import { buildSemanticGraph, buildSemanticVomScene } from "../semantic-graph";
import { REQUESTED_STYLES, type SnapshotReply, VISUAL_STYLES } from "../snapshot";
import { discoverVisualCandidates } from "../visual-discovery";

function fixture(
  options: {
    frames?: CdpFrame[];
    canvas?: boolean;
    after?: Record<string, { element?: number; missing?: boolean; unreadable?: boolean }>;
    fail?: string;
    missingIdentity?: boolean;
    omitDocument?: string;
    attachmentChanged?: boolean;
    overlay?: string;
  } = {},
) {
  const frames = options.frames ?? [
    { frameId: "main", target: { tabId: 4 } },
    {
      frameId: "same",
      parentFrameId: "main",
      ownerBackendNodeId: 3,
      target: { tabId: 4 },
    },
    {
      frameId: "nested",
      parentFrameId: "same",
      ownerBackendNodeId: 13,
      target: { tabId: 4 },
    },
    {
      frameId: "remote",
      parentFrameId: "main",
      ownerBackendNodeId: 4,
      target: { tabId: 4, sessionId: "remote" },
    },
  ];
  const elements = new Map(
    frames.map((frame, i) => [frame.frameId, frame.target.sessionId ? 1 : i * 10 + 1]),
  );
  const contexts = new Map(frames.map((frame, i) => [i + 1, frame.frameId]));
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
      if (method === "Runtime.evaluate" && args.contextId) {
        const id = contexts.get(Number(args.contextId))!;
        const change = options.after?.[id];
        result =
          options.missingIdentity || change?.unreadable
            ? {}
            : {
                result: {
                  deepSerializedValue: change?.missing
                    ? { type: "null" }
                    : {
                        type: "node",
                        value: { backendNodeId: change?.element ?? elements.get(id) },
                      },
                },
              };
      }
      if (method === "Page.getLayoutMetrics")
        result = {
          visualViewport: { clientWidth: 1000 },
          cssVisualViewport: { clientWidth: 1000, scale: 1 },
          cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 },
        };
      if (method === "DOMSnapshot.captureSnapshot") {
        snapshots++;
        const requested = (params as { computedStyles: readonly string[] }).computedStyles;
        expect([REQUESTED_STYLES, VISUAL_STYLES]).toContainEqual(requested);
        result = {
          strings: [
            "#document",
            "html",
            options.canvas ? "canvas" : "button",
            OVERLAY_HOST_MARKER_ATTR,
            "",
            "visible",
            "1",
            "static",
            "auto",
            "block",
            "none",
            "0px",
          ],
          documents: frames
            .filter(
              (frame) =>
                cdpTargetKey(frame.target) === cdpTargetKey(target) &&
                frame.frameId !== options.omitDocument,
            )
            .map((frame) => {
              const element = elements.get(frame.frameId)!;
              const localFrames = frames.filter(
                (f) =>
                  cdpTargetKey(f.target) === cdpTargetKey(target) &&
                  f.frameId !== options.omitDocument,
              );
              const children = localFrames.filter((f) => f.parentFrameId === frame.frameId);

              return {
                scrollOffsetX: 0,
                scrollOffsetY: 0,
                frameId: frame.frameId,
                nodes: {
                  backendNodeId: [
                    element - 1,
                    element + 10000,
                    element,
                    element + 1,
                    ...children.map((f) => f.ownerBackendNodeId!),
                  ],
                  nodeName: [0, 1, 1, 2, ...children.map(() => 2)],
                  nodeType: [9, 10, 1, 1, ...children.map(() => 1)],
                  parentIndex: [-1, 0, 0, 2, ...children.map(() => 2)],
                  attributes: [
                    [],
                    [],
                    [],
                    frame.frameId === options.overlay ? [3, 4] : [],
                    ...children.map(() => []),
                  ],
                  contentDocumentIndex: {
                    index: children.map((_, i) => 4 + i),
                    value: children.map((f) => localFrames.indexOf(f)),
                  },
                },
                layout: {
                  nodeIndex: [2, 3],
                  bounds: [
                    [0, 0, 1000, 800],
                    [10, 20, 100, 40],
                  ],
                  clientRects: [
                    [0, 0, 1000, 800],
                    [0, 0, 100, 40],
                  ],
                  styles: Array.from({ length: 2 }, () =>
                    requested.map(
                      (name) =>
                        [7, 8, 8, 5, 6, 9, 5, 5, 10, 6, 10, 10, 10, 10, 10, 8, 10, 11][
                          VISUAL_STYLES.indexOf(name as (typeof VISUAL_STYLES)[number])
                        ],
                    ),
                  ),
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
      options.missingIdentity
        ? undefined
        : options.attachmentChanged && snapshots === targetCount
          ? "new-attachment"
          : "attachment",
    getFrameGraph: async () => ({ rootFrameId: frames[0].frameId, frames }),
    send: (tabId, method, params) =>
      (send as NonNullable<CdpRunner["sendToTarget"]>)({ tabId }, method, params),
    sendToTarget: send as NonNullable<CdpRunner["sendToTarget"]>,
  };
  return { cdp, logs, elements };
}

describe("captureObservationFacts", () => {
  it("normalizes snapshot-owned root scroll instead of mixing in stale CSS scroll", async () => {
    const { cdp } = fixture({ frames: [{ frameId: "main", target: { tabId: 4 } }] });
    const original = cdp.sendToTarget!;
    cdp.sendToTarget = async (target, method, params) => {
      if (method === "Page.getLayoutMetrics")
        return {
          visualViewport: { clientWidth: 2000 },
          cssVisualViewport: { clientWidth: 1000, scale: 1 },
          cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 999, pageY: 999 },
        } as never;
      const reply = await original(target, method, params);
      if (method === "DOMSnapshot.captureSnapshot") {
        const doc = (reply as SnapshotReply).documents![0];
        doc.scrollOffsetX = 40;
        doc.scrollOffsetY = 200;
        doc.layout!.bounds![1] = [200, 800, 240, 80];
      }
      return reply as never;
    };
    cdp.send = (tabId, method, params) => cdp.sendToTarget!({ tabId }, method, params);
    const facts = await captureObservationFacts(cdp, 4);
    expect(facts.documents[0].domNodes.find((node) => node.backendNodeId === 2)).toMatchObject({
      localRect: { x: 80, y: 300, w: 120, h: 40 },
      rect: { x: 80, y: 300, w: 120, h: 40 },
      rendered: true,
    });
    expect(facts.issues).toEqual([]);
  });

  it("collects each target once and scopes equal backend IDs", async () => {
    const { cdp, logs } = fixture();
    const facts = await captureObservationFacts(cdp, 4);
    expect(logs.filter((call) => call.method === "DOMSnapshot.captureSnapshot")).toHaveLength(2);
    expect(logs.filter((call) => call.method === "Accessibility.enable")).toHaveLength(2);
    expect(logs.filter((call) => call.method === "Accessibility.getFullAXTree")).toHaveLength(4);
    expect(facts.documents.every((doc) => doc.identity)).toBe(true);
    expect(logs.filter((call) => call.method === "DOM.describeNode")).toHaveLength(0);
    expect(logs.filter((call) => call.method === "Page.createIsolatedWorld")).toHaveLength(4);
    const main = facts.documents.find((doc) => doc.frame.frameId === "main")!;
    const remote = facts.documents.find((doc) => doc.frame.frameId === "remote")!;
    expect(main.index.nodes.get(2)).not.toBe(remote.index.nodes.get(2));
    expect(main.index.nodes.get(2)?.parentBackendNodeId).toBe(1);
    expect(main.index.nodes.get(10001)?.nodeType).toBe(10);
    expect(remote.axNodes[0].frameId).toBe("remote");
    expect(main.index.nodes.get(2)).toBe(main.domNodes.find((node) => node.backendNodeId === 2));
    expect(facts.finishedAt).toBeGreaterThanOrEqual(facts.startedAt);
  });

  it.each([
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

  it.each([
    "main",
    "same",
  ])("does not publish a previously identified %s document after identity reads fail", async (frameId) => {
    const { cdp } = fixture({ after: { [frameId]: { unreadable: true } } });
    if (frameId === "main")
      await expect(captureObservationFacts(cdp, 4)).rejects.toThrow("document identity");
    else {
      const facts = await captureObservationFacts(cdp, 4);
      expect(facts.documents.map((doc) => doc.frame.frameId)).toEqual(["main", "remote"]);
      expect(facts.issues).toContainEqual(
        expect.objectContaining({ frameId, reason: "identity-unavailable" }),
      );
    }
  });

  it("validates newly discovered snapshot documents without a pre-snapshot identity read", async () => {
    const { cdp, logs } = fixture();
    const graph = await cdp.getFrameGraph!(4);
    cdp.getFrameGraph = async () => ({ ...graph, frames: graph.frames.slice(0, 1) });
    const facts = await captureObservationFacts(cdp, 4);
    expect(facts.documents.map((doc) => doc.frame.frameId)).toEqual(["main", "same", "nested"]);
    expect(facts.documents.every((doc) => doc.identity)).toBe(true);
    expect(logs.filter((call) => call.method === "Page.createIsolatedWorld")).toHaveLength(3);
    expect(logs.findIndex((call) => call.method === "Page.createIsolatedWorld")).toBeGreaterThan(
      logs.findIndex((call) => call.method === "Accessibility.getFullAXTree"),
    );
  });

  it("rejects a snapshot root that no longer matches the current frame root", async () => {
    const { cdp } = fixture();
    const original = cdp.sendToTarget!;
    cdp.sendToTarget = async (target, method, params) => {
      const result = await original(target, method, params);
      if (method === "DOMSnapshot.captureSnapshot" && !target.sessionId) {
        const snapshot = result as {
          documents: { frameId: string; nodes: { backendNodeId: number[] } }[];
        };
        snapshot.documents[0].nodes.backendNodeId[2] = 999;
      }
      return result as never;
    };
    cdp.send = (tabId, method, params) => cdp.sendToTarget!({ tabId }, method, params);
    await expect(captureObservationFacts(cdp, 4)).rejects.toThrow("document identity");
  });

  it("starts after-identity reads only after every target finishes and propagates cancellation during identity cleanup", async () => {
    const { cdp, logs } = fixture();
    const controller = new AbortController();
    const original = cdp.sendToTarget!;
    let identityCleanup = 0;
    cdp.sendToTarget = async (target, method, params) => {
      if (method === "Page.createIsolatedWorld") {
        expect(logs.filter((call) => call.method === "Accessibility.getFullAXTree")).toHaveLength(
          4,
        );
      }
      const result = await original(target, method, params);
      if (
        method === "Runtime.releaseObjectGroup" &&
        String((params as { objectGroup?: string })?.objectGroup).startsWith(
          "bsk-document-identity-",
        ) &&
        target.sessionId === "remote"
      ) {
        if (++identityCleanup === 1) controller.abort();
      }
      return result as never;
    };
    cdp.send = (tabId, method, params) => cdp.sendToTarget!({ tabId }, method, params);
    await expect(captureObservationFacts(cdp, 4, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(identityCleanup).toBe(1);
  });

  it.each([
    1, 10, 100,
  ])("bounds identity reads for %i same-target documents after snapshot and AX collection", async (count) => {
    const frames: CdpFrame[] = Array.from({ length: count }, (_, i) => ({
      frameId: `frame-${i}`,
      target: { tabId: 4 },
      ...(i ? { parentFrameId: "frame-0", ownerBackendNodeId: 90000 + i } : {}),
    }));
    const { cdp, logs } = fixture({ frames });
    const original = cdp.sendToTarget!;
    let active = 0;
    let peak = 0;
    let released = 0;
    cdp.sendToTarget = async (target, method, params) => {
      if (method === "Page.createIsolatedWorld") {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (method === "DOMSnapshot.captureSnapshot") {
        expect(active).toBe(0);
        expect(released).toBe(0);
      }
      if (method === "Page.createIsolatedWorld") {
        expect(logs.filter((call) => call.method === "Accessibility.getFullAXTree")).toHaveLength(
          count,
        );
      }
      const result = await original(target, method, params);
      if (
        method === "Runtime.releaseObjectGroup" &&
        String((params as { objectGroup?: string })?.objectGroup).startsWith(
          "bsk-document-identity-",
        )
      ) {
        active--;
        released++;
      }
      return result as never;
    };
    cdp.send = (tabId, method, params) => cdp.sendToTarget!({ tabId }, method, params);
    const facts = await captureObservationFacts(cdp, 4);
    expect(facts.documents.every((doc) => doc.identity)).toBe(true);
    expect(peak).toBe(Math.min(count, 4));
    expect(active).toBe(0);
    expect(released).toBe(count);
    for (const method of [
      "Page.createIsolatedWorld",
      "Runtime.evaluate",
      "Runtime.releaseObjectGroup",
    ])
      expect(logs.filter((call) => call.method === method)).toHaveLength(count);
    expect(logs.filter((call) => call.method === "DOMSnapshot.captureSnapshot")).toHaveLength(1);
    expect(logs.filter((call) => call.method === "Page.getFrameTree")).toHaveLength(0);
  });

  it("joins identity cleanup on cancellation without starting queued frames", async () => {
    const frames: CdpFrame[] = Array.from({ length: 5 }, (_, i) => ({
      frameId: `frame-${i}`,
      target: { tabId: 4 },
      ...(i ? { parentFrameId: "frame-0", ownerBackendNodeId: 90000 + i } : {}),
    }));
    const { cdp, logs } = fixture({ frames });
    const original = cdp.sendToTarget!;
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const blocked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let held = 0;
    cdp.sendToTarget = async (target, method, params) => {
      const result = await original(target, method, params);
      if (
        method === "Runtime.releaseObjectGroup" &&
        String((params as { objectGroup?: string })?.objectGroup).startsWith(
          "bsk-document-identity-",
        )
      ) {
        if (++held === 4) ready();
        await gate;
      }
      return result as never;
    };
    cdp.send = (tabId, method, params) => cdp.sendToTarget!({ tabId }, method, params);
    let settled = false;
    const pending = captureObservationFacts(cdp, 4, controller.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await blocked;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await rejected;
    expect(held).toBe(4);
    expect(logs.filter((call) => call.method === "Page.createIsolatedWorld")).toHaveLength(4);
  });

  it.each([
    [{ after: { same: { element: 99 } } }, "omitted", false],
    [{ after: { same: { unreadable: true } } }, "omitted", false],
    [{ missingIdentity: true }, "document identity unverified", true],
    [{}, "", true],
  ] as const)("publishes identity integrity without silently losing content %j", async (options, notice, retained) => {
    const { cdp } = fixture(options);
    const result = await captureVomObservation(cdp, 4, "https://example.com");
    expect(result.frames.some((frame) => frame.frameId === "same")).toBe(retained);
    if (notice) expect(result.text).toContain(notice);
    else expect(result.text).not.toContain("identity");
    if (!retained) expect(result.text).not.toContain("document identity unverified");
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

  it.each([
    "cancel",
    "worker-abort",
  ] as const)("joins target cleanup and stops claiming targets after %s", async (mode) => {
    const frames = Array.from({ length: 5 }, (_, i) => ({
      frameId: `f${i}`,
      target: { tabId: 4, ...(i ? { sessionId: `s${i}` } : {}) },
    }));
    const { cdp } = fixture({ frames });
    const original = cdp.sendToTarget!;
    const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
    const calls: Array<{ target: string; method: string }> = [];
    let release: (() => void) | undefined;
    let released = false;
    const send: NonNullable<CdpRunner["sendToTarget"]> = async <T>(
      target: CdpTarget,
      method: string,
      params?: object,
    ) => {
      calls.push({ target: target.sessionId ?? "main", method });
      if (method === "DOMSnapshot.captureSnapshot" && target.sessionId) {
        await new Promise<void>((resolve, reject) =>
          pending.set(target.sessionId!, { resolve, reject }),
        );
      }
      if (method === "Runtime.releaseObjectGroup") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        released = true;
      }
      const result = await original<T>(target, method, params);
      if (method === "DOMSnapshot.captureSnapshot" && !target.sessionId)
        (result as { strings: string[] }).strings[2] = "input";
      return result;
    };
    cdp.sendToTarget = send;
    cdp.send = (tabId, method, params) => send({ tabId }, method, params);
    const controller = new AbortController();
    let settled = false;
    const capture = captureObservationFacts(cdp, 4, controller.signal);
    const rejected = expect(capture).rejects.toMatchObject({ name: "AbortError" });
    void capture.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => {
      expect(pending.size).toBe(3);
      expect(release).toBeDefined();
    });
    if (mode === "cancel") controller.abort();
    // Cancellation may race with an ordinary transport rejection. Without an
    // external signal, an escaping AbortError still terminates the worker pool.
    pending
      .get("s1")!
      .reject(
        mode === "cancel"
          ? new Error("transport closed")
          : new DOMException("target aborted", "AbortError"),
      );
    pending.get("s2")!.resolve();
    pending.get("s3")!.resolve();
    await vi.waitFor(() => {
      if (mode === "worker-abort")
        expect(
          calls.some((call) => call.target === "s3" && call.method === "Accessibility.enable"),
        ).toBe(true);
      else
        expect(
          calls.some(
            (call) => call.target === "s3" && call.method === "DOMSnapshot.captureSnapshot",
          ),
        ).toBe(true);
    });
    // Allow worker rejection and the outer promise chain to run while cleanup
    // is deliberately held. The old fail-fast pool settles here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(released).toBe(false);
    expect(calls.some((call) => call.target === "s4")).toBe(false);
    if (mode === "cancel")
      expect(
        calls.some(
          (call) => call.method === "Accessibility.enable" || call.method === "DOM.getDocument",
        ),
      ).toBe(false);
    release!();
    await rejected;
    expect(released).toBe(true);
    expect(calls.some((call) => call.target === "s4")).toBe(false);
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
        scrollOffsetX: 0,
        scrollOffsetY: 0,
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
      if (method === "Runtime.evaluate") return { result: { value: { width: 300, height: 200 } } };
      if (method === "Page.getLayoutMetrics") {
        return {
          visualViewport: { clientWidth: 1000 },
          cssVisualViewport: { clientWidth: 1000, scale: 1 },
          cssLayoutViewport: { clientWidth: 300, clientHeight: 200, pageX: 0, pageY: 0 },
        };
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
          return {
            visualViewport: { clientWidth: 1000 },
            cssVisualViewport: { clientWidth: 1000, scale: 1 },
            cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 },
          };
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

  it("retains nested owner failures when merging a captured OOPIF", async () => {
    const child = childSnapshot("child", 101);
    const nested = childSnapshot("nested", 201);
    const document = child.documents[0];
    const snapshot = {
      strings: child.strings,
      documents: [
        {
          ...document,
          nodes: { ...document.nodes, contentDocumentIndex: { index: [1], value: [1] } },
        },
        nested.documents[0],
      ],
    };
    const reply = async (_target: unknown, method: string) => {
      if (method === "Page.getLayoutMetrics")
        return {
          visualViewport: { clientWidth: 1000 },
          cssVisualViewport: { clientWidth: 1000, scale: 1 },
          cssLayoutViewport: { clientWidth: 300, clientHeight: 200 },
        };
      if (method === "DOMSnapshot.captureSnapshot")
        return typeof _target === "number" ? childSnapshot("main", 11) : snapshot;
      if (method === "DOM.getBoxModel")
        return { model: { content: [50, 100, 350, 100, 350, 300, 50, 300] } };
      if (method === "DOM.resolveNode") throw new Error("nested owner replaced");
      return {};
    };
    const cdp: CdpRunner = {
      send: vi.fn(reply) as CdpRunner["send"],
      sendToTarget: vi.fn(reply) as NonNullable<CdpRunner["sendToTarget"]>,
      getFrameGraph: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          { frameId: "main", target: { tabId: 4 } },
          {
            frameId: "nested",
            parentFrameId: "child",
            ownerBackendNodeId: 101,
            target: { tabId: 4, sessionId: "child-session" },
          },
          {
            frameId: "child",
            parentFrameId: "main",
            ownerBackendNodeId: 10,
            target: { tabId: 4, sessionId: "child-session" },
          },
        ],
      })),
    };
    const captured = await captureObservationFacts(cdp, 4);
    expect(
      captured.issues
        .filter((issue) => issue.projectionIssue)
        .map((issue) => issue.projectionIssue),
    ).toEqual([
      {
        status: "unavailable",
        source: { target: { tabId: 4, sessionId: "child-session" }, frameId: "nested" },
        ownerBackendNodeId: 101,
      },
    ]);
    expect(
      captured.documents.find((doc) => doc.frame.frameId === "nested")?.domNodes[1],
    ).toMatchObject({
      rect: null,
      localRect: { x: 10, y: 20, w: 100, h: 40 },
    });
  });

  it("keeps OOPIF semantics when viewport projection is unavailable", async () => {
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId, method) => {
        if (method === "Accessibility.enable" || method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return childSnapshot("main", 1);
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        if (method === "DOM.getBoxModel") throw new Error("owner geometry unavailable");
        if (method === "Page.getLayoutMetrics") {
          return {
            visualViewport: { clientWidth: 1000 },
            cssVisualViewport: { clientWidth: 1000, scale: 1 },
            cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 },
          };
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
      expect.objectContaining({ rect: null, localRect: null, rendered: true }),
    );
  });
});

// Six sibling frames and one nested frame exercise scheduling through the real capture entry.
function siblingCaptureFixture(
  beforeReply: (method: string, params: Record<string, unknown>) => Promise<void> = async () => {},
) {
  const document = (id: number, owners: number[], childIndexes: number[]) => ({
    scrollOffsetX: 0,
    scrollOffsetY: 0,
    frameId: `frame-${id}`,
    nodes: {
      parentIndex: [-1, ...owners.map(() => 0)],
      nodeName: [0, ...owners.map(() => 1)],
      backendNodeId: [1000 + id, ...owners],
      attributes: [[], ...owners.map(() => [])],
      contentDocumentIndex: { index: owners.map((_, i) => i + 1), value: childIndexes },
    },
    layout: {
      nodeIndex: [0, ...owners.map((_, i) => i + 1)],
      bounds: [[0, 0, 200, 100], ...owners.map(() => [0, 0, 200, 100])],
    },
  });
  const snapshot = {
    strings: ["body", "iframe"],
    documents: [
      document(0, [100, 101, 102, 103, 104, 105], [1, 2, 3, 4, 5, 6]),
      document(1, [200], [7]),
      ...Array.from({ length: 6 }, (_, i) => document(i + 2, [], [])),
    ],
  };
  let active = 0;
  let peak = 0;
  const send = vi.fn(async (_tabId: number, method: string, params: object = {}) => {
    const args = params as Record<string, unknown>;
    active++;
    peak = Math.max(peak, active);
    try {
      await beforeReply(method, args);
      if (method === "DOMSnapshot.captureSnapshot") return snapshot;
      if (method === "Page.getLayoutMetrics")
        return {
          visualViewport: { clientWidth: 1000 },
          cssVisualViewport: { clientWidth: 1000, scale: 1 },
          cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 },
        };
      if (method === "DOM.getBoxModel")
        return { model: { content: [0, 0, 200, 0, 200, 100, 0, 100] } };
      if (method === "DOM.resolveNode") return { object: { objectId: String(args.backendNodeId) } };
      if (method === "Runtime.callFunctionOn")
        return { result: { value: { width: 200, height: 100 } } };
      return {};
    } finally {
      active--;
    }
  });
  return {
    snapshot,
    cdp: { send: send as CdpRunner["send"] },
    send,
    peak: () => peak,
    active: () => active,
    measured: () =>
      send.mock.calls
        .filter(([, method]) => method === "DOM.getBoxModel")
        .map(([, , params]) => (params as { backendNodeId: number }).backendNodeId),
  };
}

describe("snapshot document provenance", () => {
  it.each([
    "new-child",
    "new-root",
    "stale-owner",
  ])("retains current snapshot evidence with %s graph data", async (mode) => {
    const f = siblingCaptureFixture();
    const cdp: CdpRunner = {
      ...f.cdp,
      getFrameGraph: async () => ({
        rootFrameId: mode === "new-root" ? "old-root" : "frame-0",
        frames: [
          { frameId: mode === "new-root" ? "old-root" : "frame-0", target: { tabId: 4 } },
          ...(mode === "stale-owner"
            ? [
                {
                  frameId: "frame-1",
                  parentFrameId: "frame-0",
                  ownerBackendNodeId: 999,
                  target: { tabId: 4 },
                },
              ]
            : []),
        ],
      }),
    };
    const facts = await captureObservationFacts(cdp, 4);
    expect(facts.rootFrameId).toBe("frame-0");
    expect(facts.documents.find((doc) => doc.frame.frameId === "frame-1")).toMatchObject({
      frame: { ownerBackendNodeId: 100 },
      domNodes: [
        expect.objectContaining({ rect: { x: 0, y: 0, w: 200, h: 100 } }),
        expect.anything(),
      ],
    });
    expect(
      facts.documents.find((doc) => doc.frame.frameId === "frame-7")?.domNodes[0].rect,
    ).not.toBeNull();
    expect(f.measured()).not.toContain(999);
    expect(
      f.send.mock.calls.filter(([, method]) => method === "DOMSnapshot.captureSnapshot"),
    ).toHaveLength(1);
    expect(
      f.send.mock.calls.some(
        ([, method, params]) =>
          method === "Accessibility.getFullAXTree" &&
          (params as { frameId?: string }).frameId === "frame-7",
      ),
    ).toBe(true);
  });

  it("uses snapshot URLs before graph URLs and limits the caller URL to the root", async () => {
    const f = siblingCaptureFixture();
    f.snapshot.strings.push("https://current.test/page", "https://child.test/page");
    Object.assign(f.snapshot.documents[0], { documentURL: 2 });
    Object.assign(f.snapshot.documents[1], { documentURL: 3 });
    const facts = await captureObservationFacts(
      {
        ...f.cdp,
        getFrameGraph: async () => ({
          rootFrameId: "frame-0",
          frames: [{ frameId: "frame-0", target: { tabId: 4 }, url: "https://old.test/" }],
        }),
      },
      4,
      undefined,
      "https://caller.test/",
    );
    expect(facts.documents.find((doc) => doc.frame.frameId === "frame-0")?.frame.url).toBe(
      "https://current.test/page",
    );
    expect(facts.documents.find((doc) => doc.frame.frameId === "frame-1")?.frame.url).toBe(
      "https://child.test/page",
    );
    expect(
      facts.documents.find((doc) => doc.frame.frameId === "frame-2")?.frame.url,
    ).toBeUndefined();
  });

  it("accepts a migrated snapshot claim without merging AX from the old target", async () => {
    const f = siblingCaptureFixture();
    const cdp: CdpRunner = {
      ...f.cdp,
      getFrameGraph: async () => ({
        rootFrameId: "frame-0",
        frames: [
          { frameId: "frame-0", target: { tabId: 4 } },
          {
            frameId: "frame-1",
            parentFrameId: "frame-0",
            ownerBackendNodeId: 100,
            target: { tabId: 4, sessionId: "old" },
          },
        ],
      }),
      sendToTarget: async <T>(_target: CdpTarget, method: string): Promise<T> =>
        (method === "Accessibility.getFullAXTree"
          ? { nodes: [{ nodeId: "stale", role: { value: "button" }, name: { value: "stale" } }] }
          : {}) as T,
    };
    const facts = await captureObservationFacts(cdp, 4);
    const current = facts.documents.find((doc) => doc.frame.frameId === "frame-1");
    expect(current?.frame.target).toEqual({ tabId: 4 });
    expect(current?.domNodes.length).toBeGreaterThan(0);
    expect(current?.axNodes).toEqual([]);
  });

  it.each([
    0, 1,
  ])("rejects duplicate snapshot frame identity at document %i without overwriting", async (index) => {
    const f = siblingCaptureFixture();
    f.snapshot.documents.push(f.snapshot.documents[index]);
    if (index === 0) {
      await expect(captureObservationFacts(f.cdp, 4)).rejects.toThrow(
        "root document ownership is ambiguous",
      );
    } else {
      const facts = await captureObservationFacts(f.cdp, 4);
      expect(facts.documents.map((doc) => doc.frame.frameId)).not.toContain("frame-1");
      expect(facts.documents.map((doc) => doc.frame.frameId)).not.toContain("frame-7");
      expect(
        facts.documents.find((doc) => doc.frame.frameId === "frame-2")?.domNodes.length,
      ).toBeGreaterThan(0);
    }
  });

  it("retains the caller URL in the root AX-only fallback", async () => {
    const cdp: CdpRunner = {
      getFrameGraph: async () => {
        throw new Error("no graph");
      },
      send: async <T>(_tabId: number, method: string): Promise<T> => {
        if (method === "DOMSnapshot.captureSnapshot") throw new Error("no snapshot");
        return (
          method === "Accessibility.getFullAXTree"
            ? { nodes: [{ nodeId: "root", role: { value: "RootWebArea" } }] }
            : {}
        ) as T;
      },
    };
    const facts = await captureObservationFacts(cdp, 4, undefined, "https://page.test/");
    expect(facts.documents[0].frame.url).toBe("https://page.test/");
    expect(facts.documents[0].axNodes).toHaveLength(1);
  });

  it("retains disconnected document data without inventing top-level geometry", async () => {
    const f = siblingCaptureFixture();
    f.snapshot.documents[0].nodes.contentDocumentIndex = { index: [], value: [] };
    const facts = await captureObservationFacts(f.cdp, 4);
    expect(
      facts.documents.find((doc) => doc.frame.frameId === "frame-1")?.domNodes[0],
    ).toMatchObject({ rect: null, localRect: { x: 0, y: 0, w: 200, h: 100 } });
    expect(f.measured()).toEqual([]);
    expect(facts.issues).toContainEqual(
      expect.objectContaining({ frameId: "frame-1", stage: "ownership" }),
    );
  });

  it.each([
    false,
    true,
  ])("isolates competing target claims independent of batch order %s", async (reverse) => {
    const f = siblingCaptureFixture();
    const remote = {
      frameId: "frame-1",
      parentFrameId: "frame-0",
      ownerBackendNodeId: 100,
      target: { tabId: 4, sessionId: "remote" },
    };
    const main = { frameId: "frame-0", target: { tabId: 4 } };
    const cdp: CdpRunner = {
      ...f.cdp,
      getFrameGraph: async () => ({
        rootFrameId: "frame-0",
        frames: reverse ? [remote, main] : [main, remote],
      }),
      sendToTarget: async <T>(_target: CdpTarget, method: string): Promise<T> =>
        (method === "DOMSnapshot.captureSnapshot"
          ? { ...f.snapshot, documents: [f.snapshot.documents[1]] }
          : method === "Page.getLayoutMetrics"
            ? {
                visualViewport: { clientWidth: 1000 },
                cssVisualViewport: { clientWidth: 1000, scale: 1 },
                cssLayoutViewport: { clientWidth: 200, clientHeight: 100 },
              }
            : {}) as T,
    };
    const facts = await captureObservationFacts(cdp, 4);
    expect(facts.documents.map((doc) => doc.frame.frameId)).not.toContain("frame-1");
    expect(facts.documents.map((doc) => doc.frame.frameId)).not.toContain("frame-7");
    expect(
      facts.documents.find((doc) => doc.frame.frameId === "frame-2")?.domNodes[0].rect,
    ).not.toBeNull();
    expect(facts.issues).toContainEqual(
      expect.objectContaining({ frameId: "frame-1", stage: "ownership" }),
    );
  });
});

describe("sibling frame measurement scheduling", () => {
  it("batches same-target owner sizes without changing projected results", async () => {
    const fixture = siblingCaptureFixture();
    const original = fixture.cdp.send;
    const methods: string[] = [];
    fixture.cdp.send = async (tabId, method, params) => {
      methods.push(method);
      if (method === "Runtime.evaluate")
        return {
          result: {
            deepSerializedValue: {
              type: "array",
              value: [100, 101, 102, 103, 104, 105, 200].map((backendNodeId) => ({
                type: "array",
                value: [
                  { type: "node", value: { backendNodeId } },
                  { type: "string", value: JSON.stringify({ width: 200, height: 100 }) },
                ],
              })),
            },
          },
        } as never;
      return original(tabId, method, params);
    };
    const captured = await captureObservationFacts(fixture.cdp, 4);
    expect(captured.issues.filter((issue) => issue.stage === "geometry")).toEqual([]);
    expect(captured.documents.map((doc) => doc.frame.frameId)).toEqual(
      Array.from({ length: 8 }, (_, i) => `frame-${i}`),
    );
    expect(
      captured.documents.find((doc) => doc.frame.frameId === "frame-7")?.domNodes[0].rect,
    ).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(methods.filter((method) => method === "DOM.getBoxModel")).toHaveLength(7);
    expect(methods.filter((method) => method === "Runtime.evaluate")).toHaveLength(1);
    expect(methods.filter((method) => method === "Runtime.releaseObjectGroup")).toHaveLength(1);
    expect(methods).not.toContain("DOM.resolveNode");
    expect(methods).not.toContain("Runtime.callFunctionOn");
  });

  it("bounds concurrent reads, fills free slots and preserves breadth-first output despite reordered replies", async () => {
    const pending = new Map<number, () => void>();
    const fixture = siblingCaptureFixture(async (method, params) => {
      if (method === "DOM.getBoxModel" && Number(params.backendNodeId) < 200)
        await new Promise<void>((resolve) => pending.set(Number(params.backendNodeId), resolve));
    });
    const capture = captureObservationFacts(fixture.cdp, 4);
    await vi.waitFor(() => expect(pending.size).toBe(4));
    expect(fixture.measured()).toEqual([100, 101, 102, 103]);
    pending.get(103)!();
    await vi.waitFor(() => expect(pending.has(104)).toBe(true));
    pending.get(104)!();
    await vi.waitFor(() => expect(pending.has(105)).toBe(true));
    expect(fixture.measured()).not.toContain(200);
    for (const id of [105, 102, 101, 100]) pending.get(id)!();
    const captured = await capture;
    expect(
      captured.issues
        .filter((issue) => issue.stage === "geometry")
        .map((issue) => issue.projectionIssue),
    ).toEqual([]);
    expect(fixture.peak()).toBe(4);
    expect(fixture.active()).toBe(0);
    expect(fixture.measured()).toEqual([100, 101, 102, 103, 104, 105, 200]);
    expect(captured.documents.map((doc) => doc.frame.frameId)).toEqual(
      Array.from({ length: 8 }, (_, i) => `frame-${i}`),
    );
    expect(
      captured.documents.find((doc) => doc.frame.frameId === "frame-7")?.domNodes[0].rect,
    ).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    for (const method of [
      "DOM.getBoxModel",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
      "Runtime.releaseObject",
    ])
      expect(fixture.send.mock.calls.filter(([, name]) => name === method)).toHaveLength(7);
  });

  it("does not measure descendants of a failed owner and retains sibling geometry and local nodes", async () => {
    const fixture = siblingCaptureFixture(async (method, params) => {
      if (method === "DOM.resolveNode" && params.backendNodeId === 100)
        throw new Error("owner replaced");
    });
    const captured = await captureObservationFacts(fixture.cdp, 4);
    expect(
      captured.issues
        .filter((issue) => issue.stage === "geometry")
        .map((issue) => issue.projectionIssue),
    ).toEqual([
      {
        status: "unavailable",
        source: { target: { tabId: 4 }, frameId: "frame-1" },
        ownerBackendNodeId: 100,
      },
      {
        status: "blocked",
        source: { target: { tabId: 4 }, frameId: "frame-7" },
        cause: captured.issues.find((issue) => issue.frameId === "frame-1")?.projectionIssue,
      },
    ]);
    expect(fixture.measured()).not.toContain(200);
    expect(
      captured.documents.find((doc) => doc.frame.frameId === "frame-7")?.domNodes[0],
    ).toMatchObject({
      tag: "body",
      rect: null,
      localRect: { x: 0, y: 0, w: 200, h: 100 },
    });
    expect(
      captured.documents.find((doc) => doc.frame.frameId === "frame-2")?.domNodes[0].rect,
    ).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(captured.documents.map((doc) => doc.frame.frameId)).toEqual(
      Array.from({ length: 8 }, (_, i) => `frame-${i}`),
    );
  });

  it("stops scheduling on cancellation and waits for resolved objects to be released", async () => {
    const controller = new AbortController();
    const resolutions = new Map<string, () => void>();
    const releases = new Map<string, () => void>();
    const fixture = siblingCaptureFixture(async (method, params) => {
      if (method === "DOM.resolveNode")
        await new Promise<void>((resolve) =>
          resolutions.set(String(params.backendNodeId), resolve),
        );
      if (method === "Runtime.releaseObject")
        await new Promise<void>((resolve) => releases.set(String(params.objectId), resolve));
    });
    let settled = false;
    const capture = captureObservationFacts(fixture.cdp, 4, controller.signal);
    const rejected = expect(capture).rejects.toMatchObject({ name: "AbortError" });
    void capture.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(resolutions.size).toBe(4));
    controller.abort();
    for (const resolve of resolutions.values()) resolve();
    await vi.waitFor(() => expect(releases.size).toBe(4));
    expect(settled).toBe(false);
    expect(fixture.measured()).toEqual([100, 101, 102, 103]);
    for (const release of releases.values()) release();
    await rejected;
    expect(fixture.active()).toBe(0);
    expect(fixture.send.mock.calls.some(([, method]) => method === "Runtime.callFunctionOn")).toBe(
      false,
    );
  });
});

describe("AX frame scheduling", () => {
  it.each([
    false,
    true,
  ])("shares four workers across frames and drains cancellation=%s", async (cancel) => {
    const f = siblingCaptureFixture();
    const original = f.cdp.send;
    const pending = new Map<string, () => void>();
    let active = 0,
      peak = 0;
    f.cdp.send = async (tabId, method, params) => {
      if (method !== "Accessibility.getFullAXTree") return original(tabId, method, params);
      const frameId = (params as { frameId: string }).frameId;
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) => pending.set(frameId, resolve));
        if (frameId === "frame-2") throw new Error("one AX frame unavailable");
        return { nodes: [{ nodeId: frameId, frameId }] } as never;
      } finally {
        active--;
      }
    };
    const controller = new AbortController();
    let settled = false;
    const capture = captureObservationFacts(f.cdp, 4, controller.signal);
    const outcome = capture.then(
      (facts) => ({ facts, error: undefined }),
      (error) => ({ facts: undefined, error }),
    );
    void outcome.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(pending.size).toBe(4));
    if (cancel) {
      controller.abort();
      pending.get("frame-3")!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(pending.size).toBe(4);
      for (const release of pending.values()) release();
      expect((await outcome).error).toMatchObject({ name: "AbortError" });
    } else {
      for (let i = 3; i < 7; i++) {
        pending.get(`frame-${i}`)!();
        await vi.waitFor(() => expect(pending.has(`frame-${i + 1}`)).toBe(true));
      }
      for (const release of pending.values()) release();
      const { facts, error } = await outcome;
      expect(error).toBeUndefined();
      expect(facts?.documents.map((doc) => doc.frame.frameId)).toEqual(
        Array.from({ length: 8 }, (_, i) => `frame-${i}`),
      );
      expect(facts?.documents.find((doc) => doc.frame.frameId === "frame-2")?.axNodes).toEqual([]);
      expect(facts?.issues).toContainEqual(
        expect.objectContaining({ stage: "ax", frameId: "frame-2" }),
      );
      expect(facts?.documents.find((doc) => doc.frame.frameId === "frame-7")?.axNodes).toHaveLength(
        1,
      );
    }
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });
});

describe("visual facts integration", () => {
  it("defaults to base facts across targets and shares semantic behavior with visual capture", async () => {
    const base = fixture({ canvas: true });
    const visual = fixture({ canvas: true });
    const baseFacts = await captureObservationFacts(base.cdp, 4);
    const visualFacts = await captureObservationFacts(visual.cdp, 4, undefined, undefined, {
      includeVisualFacts: true,
    });
    expect(baseFacts.visualFactsCollected).toBe(false);
    expect(visualFacts.visualFactsCollected).toBe(true);
    expect(baseFacts.documents).toHaveLength(4);
    expect(visualFacts.documents).toHaveLength(4);
    for (const doc of baseFacts.documents) {
      expect(doc.geometry).toBeUndefined();
      expect(doc.index.ancestryComplete).toBeUndefined();
      for (const node of doc.index.nodes.values()) {
        expect(node.parentMissing).toBeUndefined();
        expect(node.layout?.clientRect).toBeUndefined();
        if (node.layout) expect(Object.keys(node.layout.styles)).toEqual([...REQUESTED_STYLES]);
      }
    }
    // This fixture has no child frame projection measurements. Enabling visual
    // collection must preserve that missing evidence, not invent geometry.
    expect(
      visualFacts.documents.find((doc) => doc.frame.frameId === "main")?.geometry,
    ).toBeDefined();
    expect(visualFacts.documents.filter((doc) => doc.geometry)).toHaveLength(1);
    for (const doc of visualFacts.documents) {
      expect(doc.index.ancestryComplete).toBeDefined();
      for (const node of doc.index.nodes.values())
        if (node.layout) {
          expect(Object.keys(node.layout.styles)).toEqual([...VISUAL_STYLES]);
          expect(Object.keys(node.layout.styles).some((key) => key.includes("radius"))).toBe(false);
        }
    }
    for (const [capture, expected] of [
      [base, REQUESTED_STYLES],
      [visual, VISUAL_STYLES],
    ] as const) {
      const calls = capture.logs.filter((c) => c.method === "DOMSnapshot.captureSnapshot");
      expect(calls).toHaveLength(2);
      for (const call of calls) expect(call.params.computedStyles).toEqual(expected);
    }
    expect(base.logs.map((c) => [c.target, c.method])).toEqual(
      visual.logs.map((c) => [c.target, c.method]),
    );
    const scene = (input: typeof baseFacts) =>
      buildSemanticVomScene({
        documents: semanticCapture(input).documents,
        viewport: input.viewport,
        rootFrameId: input.rootFrameId,
        excludedBackendNodeIds: semanticCapture(input).captured.excludedBackendNodeIds,
      });
    expect(scene(baseFacts)).toEqual(scene(visualFacts));
    const before = base.logs.length;
    expect(await discoverVisualCandidates(baseFacts)).toMatchObject({
      complete: false,
      candidates: [],
      issues: [{ reason: "visual-facts-not-collected" }],
    });
    expect(base.logs).toHaveLength(before);
  });

  it("passes actual snapshot styles, client units, projection and identity to pure discovery without additional CDP", async () => {
    const { cdp, logs } = fixture({
      canvas: true,
      frames: [{ frameId: "main", target: { tabId: 4 } }],
    });
    const facts = await captureObservationFacts(cdp, 4, undefined, undefined, {
      includeVisualFacts: true,
    });
    const before = logs.length;
    const result = await discoverVisualCandidates(facts);
    expect(logs).toHaveLength(before);
    expect(logs.filter((call) => call.method === "DOMSnapshot.captureSnapshot")).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      document: { frameId: "main", documentElementBackendNodeId: 1 },
      region: { crop: { x: 10, y: 20, width: 100, height: 40 } },
    });
    expect(facts.documents[0].index.nodes.get(2)?.layout?.clientRect).toEqual([0, 0, 100, 40]);
    expect(facts.documents[0].geometry?.pageScale).toBe(1);
    const baseline = fixture({ frames: [{ frameId: "main", target: { tabId: 4 } }] });
    await captureObservationFacts(baseline.cdp, 4);
    expect(logs.map((call) => call.method)).toEqual(baseline.logs.map((call) => call.method));
  });
});
