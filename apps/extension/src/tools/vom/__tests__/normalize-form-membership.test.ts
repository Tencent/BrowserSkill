import { describe, expect, it } from "vitest";
import { normalizeDocument } from "../normalize";
import { buildSemanticVomScene } from "../semantic-graph";
import { BASIC_SNAPSHOT, type SnapshotProfile, VISUAL_SNAPSHOT } from "../snapshot";

interface Spec {
  id: number;
  parent?: number;
  tag: string;
  attrs?: Record<string, string>;
}

async function normalize(input: Spec[], profile: SnapshotProfile = BASIC_SNAPSHOT) {
  const strings: string[] = [];
  const str = (value: string) => strings.push(value) - 1;
  return normalizeDocument(
    {
      nodes: {
        backendNodeId: input.map((node) => node.id),
        nodeType: input.map((node) =>
          node.tag === "#document" ? 9 : node.tag === "#document-fragment" ? 11 : 1,
        ),
        nodeName: input.map((node) => str(node.tag)),
        parentIndex: input.map((node) => {
          if (node.parent === undefined) return -1;
          const index = input.findIndex((parent) => parent.id === node.parent);
          return index >= 0 ? index : input.length + 99;
        }),
        attributes: input.map((node) =>
          Object.entries(node.attrs ?? {}).flatMap(([key, value]) => [str(key), str(value)]),
        ),
      },
      layout: {
        nodeIndex: input.map((_, i) => i),
        bounds: input.map(() => [0, 0, 100, 30]),
      },
    },
    strings,
    {
      target: { tabId: 1 },
      frameId: "main",
      ownerFrameBackendNodeId: null,
      projection: null,
      coordinates: null,
    },
    undefined,
    profile,
  );
}

const roots: Spec[] = [
  { id: 1, tag: "#document" },
  { id: 2, parent: 1, tag: "html" },
];
const slider = { role: "slider", "aria-label": "Playback progress", "aria-valuenow": "0" };

describe("custom progress form membership", () => {
  it.each([
    BASIC_SNAPSHOT,
    VISUAL_SNAPSHOT,
  ])("preserves form containment before document and semantic pruning: %j", async (profile) => {
    const normalized = await normalize(
      [
        ...roots,
        { id: 3, parent: 2, tag: "form", attrs: { role: "none" } },
        { id: 4, parent: 3, tag: "div", attrs: slider },
        { id: 5, parent: 2, tag: "div", attrs: slider },
        { id: 6, parent: 99, tag: "div", attrs: slider },
      ],
      profile,
    );
    expect(normalized.nodes.some((node) => node.tag === "#document")).toBe(false);
    expect(normalized.index.nodes.get(4)?.inForm).toBe(true);
    expect(normalized.index.nodes.get(5)?.inForm).toBe(false);
    expect(normalized.index.nodes.get(6)?.inForm).toBeUndefined();
    const scene = buildSemanticVomScene({
      viewport: { width: 800, height: 600 },
      rootFrameId: "main",
      documents: [
        {
          frameId: "main",
          contextScopeId: "main",
          target: { tabId: 1 },
          axNodes: [],
          domNodes: normalized.nodes,
        },
      ],
    });
    expect(scene.nodes.some((node) => node.tag === "form")).toBe(false);
    for (const [id, membership] of [
      [4, true],
      [5, false],
      [6, undefined],
    ] as const)
      expect(scene.nodes.find((node) => node.backendNodeId === id)?.inForm).toBe(membership);
  });

  it.each(["slider", "progressbar"])("retains raw shadow ancestry for %s widgets", async (role) => {
    const normalized = await normalize([
      ...roots,
      { id: 3, parent: 2, tag: "form", attrs: { role: "presentation" } },
      { id: 4, parent: 3, tag: "#document-fragment" },
      { id: 5, parent: 4, tag: "div", attrs: { ...slider, role } },
      { id: 6, parent: 2, tag: "#document-fragment" },
      { id: 7, parent: 6, tag: "div", attrs: { ...slider, role } },
      { id: 8, parent: 3, tag: "progress" },
      { id: 9, parent: 2, tag: "progress" },
    ]);
    expect([5, 7, 8, 9].map((id) => normalized.index.nodes.get(id)?.inForm)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it("does not infer native ownership from physical containment", async () => {
    const normalized = await normalize([
      ...roots,
      { id: 3, parent: 2, tag: "form" },
      { id: 4, parent: 3, tag: "input", attrs: { type: "range" } },
      { id: 5, parent: 2, tag: "input", attrs: { type: "range", form: "external" } },
    ]);
    for (const id of [4, 5]) expect(normalized.index.nodes.get(id)?.inForm).toBeUndefined();
  });

  it("keeps disconnected roots and cyclic ancestry unknown", async () => {
    const normalized = await normalize([
      { id: 1, tag: "html" },
      { id: 2, parent: 1, tag: "div", attrs: slider },
      { id: 3, parent: 4, tag: "div", attrs: slider },
      { id: 4, parent: 3, tag: "div", attrs: slider },
      { id: 5, parent: 3, tag: "div", attrs: slider },
      { id: 6, parent: 99, tag: "#document" },
      { id: 7, parent: 6, tag: "div", attrs: slider },
    ]);
    for (const id of [2, 3, 4, 5, 7])
      expect(normalized.index.nodes.get(id)?.inForm).toBeUndefined();
  });
});
