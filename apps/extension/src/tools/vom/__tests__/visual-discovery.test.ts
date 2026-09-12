import { describe, expect, it } from "vitest";
import type { CdpFrame } from "@/browser-driver/frame-graph";
import { OVERLAY_HOST_MARKER_ATTR } from "@/lib/overlay-bridge";
import type { GeometryProjection } from "../../geometry";
import { buildDocumentIndex, type DocumentFacts, type ObservationFacts } from "../facts";
import type { FrameOwnedAxNode } from "../frame-document";
import { normalizeDocument } from "../normalize";
import { VISUAL_SNAPSHOT, VISUAL_STYLES } from "../snapshot";
import { discoverVisualCandidates } from "../visual-discovery";

const defaults: Record<string, string> = {
  position: "static",
  "pointer-events": "auto",
  cursor: "auto",
  visibility: "visible",
  opacity: "1",
  display: "block",
  "overflow-x": "visible",
  "overflow-y": "visible",
  transform: "none",
  zoom: "1",
  "clip-path": "none",
  "mask-image": "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  clip: "auto",
  contain: "none",
  "overflow-clip-margin": "0px",
};
const projection: GeometryProjection = {
  sourceClips: [],
  edges: [],
  topViewport: { width: 1000, height: 800 },
};
interface Spec {
  id: number;
  parent?: number;
  tag?: string;
  styles?: Record<string, string>;
  bounds?: number[] | null;
  client?: number[];
  attrs?: Record<string, string>;
}
async function document(
  nodes: Spec[],
  options: {
    frame?: CdpFrame;
    projection?: GeometryProjection;
    pageScale?: number;
    scrollY?: number;
    layoutScale?: number;
  } = {},
): Promise<DocumentFacts<FrameOwnedAxNode>> {
  const frame = options.frame ?? { frameId: "main", target: { tabId: 1 } };
  const strings: string[] = [];
  const str = (value: string) => {
    const index = strings.indexOf(value);
    if (index >= 0) return index;
    strings.push(value);
    return strings.length - 1;
  };
  const input: Spec[] = [
    { id: 0, tag: "#document", bounds: null },
    { id: 1, parent: 0, tag: "html", bounds: [0, 0, 1000, 800] },
    ...nodes,
  ];
  const layouts = input.filter((node) => node.bounds !== null);
  const normalized = await normalizeDocument(
    {
      nodes: {
        backendNodeId: input.map((n) => n.id),
        nodeType: input.map((n) =>
          n.tag === "#document" ? 9 : n.tag === "#document-fragment" ? 11 : 1,
        ),
        parentIndex: input.map((n) =>
          n.parent === undefined ? -1 : input.findIndex((p) => p.id === n.parent),
        ),
        nodeName: input.map((n) => str(n.tag ?? "canvas")),
        attributes: input.map((n) =>
          Object.entries(n.attrs ?? {}).flatMap(([k, v]) => [str(k), str(v)]),
        ),
      },
      layout: {
        nodeIndex: layouts.map((n) => input.indexOf(n)),
        bounds: layouts.map((n) => n.bounds ?? [10, 20, 120, 40]),
        clientRects: layouts.map((n) => n.client ?? [0, 0, 1000, 800]),
        styles: layouts.map((n) =>
          VISUAL_STYLES.map((key) => str({ ...defaults, ...n.styles }[key])),
        ),
      },
    },
    strings,
    {
      frameId: frame.frameId,
      ownerFrameBackendNodeId: frame.ownerBackendNodeId ?? null,
      target: frame.target,
      projection: {
        status: "available",
        projection: {
          source: { target: frame.target, frameId: frame.frameId },
          geometry: options.projection ?? projection,
        },
      },
      coordinates: {
        layoutUnitsPerCssPixel: options.layoutScale ?? 1,
        scrollCss: { x: 0, y: options.scrollY ?? 0 },
      },
      pageScale: options.pageScale ?? 1,
    },
    undefined,
    VISUAL_SNAPSHOT,
  );
  return {
    frame,
    identity: {
      attachmentId: "attached",
      target: frame.target,
      frameId: frame.frameId,
      documentElementBackendNodeId: 1,
    },
    index: normalized.index,
    geometry: normalized.geometry,
    domNodes: normalized.nodes,
    axNodes: [],
  };
}
function facts(
  documents: DocumentFacts<FrameOwnedAxNode>[],
  issues: ObservationFacts<FrameOwnedAxNode>["issues"] = [],
): ObservationFacts<FrameOwnedAxNode> {
  return {
    visualFactsCollected: true,
    rootFrameId: "main",
    documents,
    viewport: { width: 1000, height: 800 },
    issues,
    startedAt: 1,
    finishedAt: 2,
  };
}

describe("Canvas discovery", () => {
  it("shares frame address paths from existing Facts without changing candidate evidence", async () => {
    const parent = await document([{ id: 2, parent: 1, tag: "iframe" }]);
    const child = await document(
      [
        { id: 3, parent: 1 },
        { id: 4, parent: 1 },
      ],
      {
        frame: {
          frameId: "child",
          parentFrameId: "main",
          ownerBackendNodeId: 2,
          target: { tabId: 1 },
        },
      },
    );
    const result = await discoverVisualCandidates(facts([child, parent]));
    expect(result.candidates).toHaveLength(2);
    const path = result.candidates[0].framePath;
    expect(path).toBe(result.candidates[1].framePath);
    expect(path?.document).toBe(child.identity);
    expect(path?.parent?.ownerBackendNodeId).toBe(2);
    expect(path?.parent?.frame.document).toBe(parent.identity);
    expect(path?.parent?.frame.parent).toBeUndefined();
  });

  it("distinguishes visual facts not collected from complete empty discovery and honors cancellation", async () => {
    const empty = facts([]);
    expect(await discoverVisualCandidates(empty)).toMatchObject({
      complete: true,
      candidates: [],
      issues: [],
    });
    expect(await discoverVisualCandidates({ ...empty, visualFactsCollected: false })).toMatchObject(
      { complete: false, candidates: [], issues: [{ reason: "visual-facts-not-collected" }] },
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      discoverVisualCandidates({ ...empty, visualFactsCollected: false }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("discovers Canvas and frame contents without corner radius facts", async () => {
    const own = await document([{ id: 2, parent: 1, styles: {} }]);
    expect(await discoverVisualCandidates(facts([own]))).toMatchObject({
      candidates: [{ backendNodeId: 2 }],
      complete: true,
      issues: [],
    });
    const parent = await document([{ id: 2, parent: 1, tag: "iframe", styles: {} }]);
    const child = await document([{ id: 3, parent: 1 }], {
      frame: {
        frameId: "child",
        parentFrameId: "main",
        ownerBackendNodeId: 2,
        target: { tabId: 1 },
      },
    });
    expect(await discoverVisualCandidates(facts([parent, child]))).toMatchObject({
      candidates: [{ backendNodeId: 3 }],
      complete: true,
      issues: [],
    });
  });

  it.each([
    0.8, 1, 1.25, 2,
  ])("combines layout-unit bounds with CSS client clips at scale %s", async (scale) => {
    const doc = await document(
      [
        {
          id: 2,
          parent: 1,
          tag: "div",
          bounds: [100, 200, 64, 34].map((n) => n * scale),
          client: [2, 2, 60, 30],
          styles: { "overflow-x": "hidden", "overflow-y": "hidden" },
        },
        { id: 3, parent: 2, bounds: [102, 202, 120, 40].map((n) => n * scale) },
      ],
      { layoutScale: scale, scrollY: 75 },
    );
    const result = await discoverVisualCandidates(facts([doc]));
    expect(result.issues).toEqual([]);
    const expected = {
      borderBox: { x: 102, y: 127, width: 120, height: 40 },
      crop: { x: 102, y: 127, width: 60, height: 30 },
    };
    for (const box of ["borderBox", "crop"] as const)
      for (const key of ["x", "y", "width", "height"] as const)
        expect(result.candidates[0].region[box][key]).toBeCloseTo(expected[box][key], 8);
  });

  it("normalizes a zero-width ancestor origin before one-axis clipping", async () => {
    const doc = await document(
      [
        {
          id: 2,
          parent: 1,
          tag: "div",
          bounds: [200, 400, 0, 60],
          client: [0, 0, 0, 30],
          styles: { "overflow-y": "hidden" },
        },
        { id: 3, parent: 2, bounds: [200, 400, 240, 80] },
      ],
      { layoutScale: 2, scrollY: 75 },
    );
    const result = await discoverVisualCandidates(facts([doc]));
    expect(result.issues).toEqual([]);
    expect(result.candidates[0].region.crop).toEqual({ x: 100, y: 125, width: 120, height: 30 });
  });

  it("keeps unnamed, semantic, aria-hidden, inert, pointer-none and visibility override Canvas", async () => {
    const doc = await document([
      { id: 2, parent: 1 },
      { id: 3, parent: 1, attrs: { "aria-label": "Chart" } },
      {
        id: 4,
        parent: 1,
        attrs: { "aria-hidden": "true", inert: "" },
        styles: { "pointer-events": "none" },
      },
      { id: 5, parent: 1, tag: "div", styles: { visibility: "hidden" } },
      { id: 6, parent: 5, styles: { visibility: "visible" } },
      { id: 7, parent: 1, attrs: { hidden: "" }, styles: { display: "block" } },
    ]);
    doc.axNodes.push({ nodeId: "canvas", backendDOMNodeId: 2 } as FrameOwnedAxNode);
    const result = await discoverVisualCandidates(facts([doc]));
    expect(result.candidates.map((c) => c.backendNodeId)).toEqual([2, 3, 4, 6, 7]);
    expect(result.candidates[1].label).toBe("Chart");
    expect(result.complete).toBe(true);
  });

  it("excludes CSS transparent subtrees, hidden/zero/no-layout/fully clipped nodes and overlays", async () => {
    const doc = await document([
      { id: 2, parent: 1, tag: "div", styles: { opacity: "0" } },
      { id: 3, parent: 2 },
      { id: 4, parent: 1, styles: { visibility: "hidden" } },
      { id: 5, parent: 1, bounds: [0, 0, 0, 40] },
      { id: 6, parent: 1, bounds: null },
      { id: 7, parent: 1, bounds: [1200, 0, 100, 50] },
      { id: 8, parent: 1, tag: "div", attrs: { [OVERLAY_HOST_MARKER_ATTR]: "" } },
      { id: 9, parent: 8, tag: "#document-fragment", bounds: null },
      { id: 10, parent: 9 },
    ]);
    expect(await discoverVisualCandidates(facts([doc]))).toMatchObject({
      candidates: [],
      issues: [],
      complete: true,
    });
  });

  it.each([
    ["both", "hidden", "hidden", [0, 0, 60, 30], [60, 30]],
    ["x", "clip", "visible", [0, 0, 60, 20], [60, 40]],
    ["border", "hidden", "hidden", [5, 5, 68, 38], [64, 34]],
  ])("uses client box for %s clipping", async (_name, x, y, client, expected) => {
    const doc = await document([
      {
        id: 2,
        parent: 1,
        tag: "div",
        bounds: [0, 0, 78, 48],
        client: client as number[],
        styles: { "overflow-x": x as string, "overflow-y": y as string },
      },
      {
        id: 3,
        parent: 2,
        bounds: x === "clip" || _name === "both" ? [0, 0, 120, 40] : [9, 9, 120, 40],
      },
    ]);
    const [candidate] = (await discoverVisualCandidates(facts([doc]))).candidates;
    expect([candidate.region.crop.width, candidate.region.crop.height]).toEqual(expected);
    expect(candidate.region.clips?.backendNodeId).toBe(2);
  });

  it("keeps Canvas border-box and clips partial viewport intersections", async () => {
    const doc = await document([{ id: 2, parent: 1, bounds: [950, 20, 130, 50] }]);
    const [candidate] = (await discoverVisualCandidates(facts([doc]))).candidates;
    expect(candidate.region.borderBox.width).toBe(130);
    expect(candidate.region.crop).toEqual({ x: 950, y: 20, width: 50, height: 50 });
  });

  it("propagates owner ancestry across targets, without depending on semantic parents", async () => {
    const parent = await document([
      {
        id: 2,
        parent: 1,
        tag: "div",
        bounds: [0, 0, 200, 100],
        client: [0, 0, 200, 100],
        styles: { "overflow-x": "hidden", "overflow-y": "hidden" },
      },
      { id: 3, parent: 2, tag: "iframe", bounds: [100, 0, 200, 200] },
    ]);
    parent.domNodes.splice(0); // Visual discovery never reads the semantic subset.
    const child = await document([{ id: 2, parent: 1, bounds: [0, 0, 200, 200] }], {
      frame: {
        frameId: "child",
        parentFrameId: "main",
        ownerBackendNodeId: 3,
        target: { tabId: 1, sessionId: "remote" },
      },
      projection: {
        ...projection,
        edges: [
          {
            sourceViewport: { width: 200, height: 200 },
            destinationQuad: [
              { x: 100, y: 0 },
              { x: 300, y: 0 },
              { x: 300, y: 200 },
              { x: 100, y: 200 },
            ],
          },
        ],
      },
    });
    const result = await discoverVisualCandidates(facts([child, parent]));
    expect(result.complete).toBe(true);
    expect(result.candidates[0]).toMatchObject({
      document: { frameId: "child", target: { sessionId: "remote" } },
      region: { crop: { x: 100, y: 0, width: 100, height: 100 } },
    });
    const owner = parent.index.nodes.get(3)!;
    owner.layout!.styles = { ...owner.layout!.styles, visibility: "hidden" };
    expect((await discoverVisualCandidates(facts([parent, child]))).candidates).toHaveLength(0);
  });

  it.each<Record<string, string>>([
    { transform: "matrix(0,1,-1,0,0,0)" },
    { "clip-path": "circle(50%)" },
    { "mask-image": "url(mask)" },
    { zoom: "1.25", "overflow-x": "hidden" },
  ])("reports unsupported ancestor geometry: %o", async (styles) => {
    const doc = await document([
      { id: 2, parent: 1, tag: "div", styles },
      { id: 3, parent: 2 },
    ]);
    const result = await discoverVisualCandidates(facts([doc]));
    expect(result.candidates).toHaveLength(0);
    expect(result.issues[0].reason).toBe("geometry-unsupported");
  });

  it("supports positive scale without overflow, rejects pinch and non-rectangular frame projection", async () => {
    const nodes = [
      {
        id: 2,
        parent: 1,
        styles: { transform: "matrix(1.25,0,0,1.25,0,0)" },
        bounds: [10, 20, 150, 50],
      },
    ];
    expect(
      (await discoverVisualCandidates(facts([await document(nodes)]))).candidates,
    ).toHaveLength(1);
    expect(
      (await discoverVisualCandidates(facts([await document(nodes, { pageScale: 1.5 })]))).issues[0]
        .reason,
    ).toBe("geometry-unsupported");
    const rotated = {
      ...projection,
      edges: [
        {
          sourceViewport: { width: 200, height: 200 },
          destinationQuad: [
            { x: 10, y: 0 },
            { x: 200, y: 10 },
            { x: 190, y: 200 },
            { x: 0, y: 190 },
          ] as [
            { x: number; y: number },
            { x: number; y: number },
            { x: number; y: number },
            { x: number; y: number },
          ],
        },
      ],
    };
    expect(
      (await discoverVisualCandidates(facts([await document(nodes, { projection: rotated })])))
        .issues[0].reason,
    ).toBe("geometry-unsupported");
  });

  it("keeps partial capture separate from valid geometry, rejects unverified identities", async () => {
    const doc = await document([{ id: 2, parent: 1 }]);
    const partial = facts(
      [doc],
      [{ target: doc.frame.target, frameId: "main", stage: "ax", reason: "capture-unavailable" }],
    );
    const result = await discoverVisualCandidates(partial);
    expect(result.candidates).toHaveLength(1);
    expect(result.captureIssues).toBe(partial.issues);
    expect(result.complete).toBe(false);
    const unverified = { ...doc, identity: undefined };
    const failed = await discoverVisualCandidates(facts([unverified]));
    expect(failed.candidates).toHaveLength(0);
    expect(failed.issues[0].reason).toBe("identity-unverified");
  });

  it("does not trust orphan, cyclic, boxless or missing frame-owner ancestry", async () => {
    const doc = await document([
      { id: 2, parent: 1, tag: "div" },
      { id: 3, parent: 2 },
    ]);
    for (const parent of [99, 3]) {
      doc.index.nodes.get(2)!.parentBackendNodeId = parent;
      const index = await buildDocumentIndex([...doc.index.nodes.values()], undefined, true);
      const result = await discoverVisualCandidates(facts([{ ...doc, index }]));
      expect(result.candidates).toHaveLength(0);
      expect(result.issues[0].reason).toBe("ancestry-incomplete");
    }
    const boxless = await document([
      { id: 2, parent: 1, tag: "div", bounds: null },
      { id: 3, parent: 2 },
    ]);
    expect((await discoverVisualCandidates(facts([boxless]))).issues[0].reason).toBe(
      "facts-unavailable",
    );
    const child = {
      ...doc,
      frame: { ...doc.frame, frameId: "child", parentFrameId: "absent", ownerBackendNodeId: 2 },
    };
    expect((await discoverVisualCandidates(facts([child]))).issues[0].reason).toBe(
      "ownership-unresolved",
    );
  });

  it("is deterministic, does not deduplicate or mutate inputs", async () => {
    const input = facts([
      await document([
        { id: 2, parent: 1 },
        { id: 3, parent: 1 },
      ]),
    ]);
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
      if (value instanceof Map) for (const item of value.values()) freeze(item);
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    };
    freeze(input);
    const first = await discoverVisualCandidates(input);
    expect(await discoverVisualCandidates(input)).toEqual(first);
    expect(first.candidates).toHaveLength(2);
  });

  it.each([
    1000, 10000, 100000,
  ])("memoizes deep ancestry across %i nodes and checks cancellation", async (count) => {
    const doc = await document([{ id: 2, parent: 1 }]);
    const template = doc.index.nodes.get(2)!;
    let reads = 0;
    const input = [doc.index.nodes.get(0)!, doc.index.nodes.get(1)!];
    for (let id = 2; id < count + 2; id++) {
      const node = {
        ...template,
        backendNodeId: id,
        tag: id < count / 2 ? "div" : "canvas",
        parentBackendNodeId: id < count / 2 ? id - 1 : count / 2 - 1,
      };
      Object.defineProperty(node, "parentBackendNodeId", {
        get: () => {
          reads++;
          return id < count / 2 ? id - 1 : count / 2 - 1;
        },
      });
      input.push(node);
    }
    const index = await buildDocumentIndex(input, undefined, true);
    reads = 0;
    const result = await discoverVisualCandidates(facts([{ ...doc, index }]));
    expect(result.candidates).toHaveLength(count / 2 + 2);
    expect(reads).toBeLessThan(count * 5);
    const controller = new AbortController();
    controller.abort();
    await expect(discoverVisualCandidates(facts([doc]), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
