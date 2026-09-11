import {
  prepareObservationRender,
  renderVom,
  type VomNode,
  type VomScene,
} from "@browser-skill/vom";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { RefStore } from "@/session-manager/ref-store";
import type { ObserveResult } from "@/transport/types";
import { auditContext } from "../../audit-context";
import { handleObserve, handleSnapshot } from "../../observation";
import type { CdpRunner } from "../../shared";
import type { DocumentIdentity } from "../facts";
import {
  buildSemanticGraph,
  normalizeSemanticStructure,
  projectSemanticGraph,
  resolveSemanticGraph,
} from "../semantic-graph";
import { deduplicateVisualCandidates } from "../visual-dedup";
import type { VisualCandidate } from "../visual-discovery";
import {
  attachVisualEntries,
  type ObservationOutput,
  prepareVisualObservation,
  publishObservationPage,
} from "../visual-observation";

const identity: DocumentIdentity = {
  attachmentId: "a",
  target: { tabId: 4 },
  frameId: "top",
  documentElementBackendNodeId: 1,
};
const candidate = (id: number): VisualCandidate => ({
  document: identity,
  backendNodeId: id,
  parentBackendNodeId: 1,
  framePath: { document: identity },
  region: {
    status: "available",
    borderBox: { x: 0, y: 0, width: 100, height: 100 },
    crop: { x: 0, y: 0, width: 100, height: 100 },
  },
});
const node = (id: number, parentId: number | null, role: string, name?: string): VomNode => ({
  id,
  parentId,
  backendNodeId: id,
  frameId: "top",
  tag: role,
  role,
  name,
  rect: { x: 0, y: 0, w: 100, h: 30 },
  paintOrder: id,
  position: "static",
  pointerEvents: "auto",
});
function fixture(count = 20, maxTokens?: number) {
  const candidates = Array.from({ length: count }, (_, i) => candidate(i + 100));
  const scene: VomScene = {
    viewport: { width: 1200, height: 800 },
    nodes: [node(1, null, "rootwebarea")],
    visuals: candidates.map((_, key) => ({ key, parentId: 1, frameId: "top" })),
  };
  const output: ObservationOutput = {
    candidates,
    identities: new Map([["top", identity]]),
    rootIdentity: identity,
    frames: new Map([["top", { target: identity.target }]]),
    render: prepareObservationRender(scene),
    notices: [],
    maxTokens,
  };
  let changed = false;
  const send = vi.fn(async (_tab: number, method: string) => {
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Runtime.evaluate")
      return {
        result: {
          deepSerializedValue: { type: "node", value: { backendNodeId: changed ? 999 : 1 } },
        },
      };
    if (method === "Runtime.releaseObjectGroup") return {};
    throw new Error(`unexpected ${method}`);
  });
  const cdp = { send, getAttachmentId: () => "a" } as unknown as CdpRunner;
  return {
    output,
    scene,
    store: new RefStore(),
    cdp,
    send,
    change: () => {
      changed = true;
    },
  };
}
const success = (r: Awaited<ReturnType<typeof publishObservationPage>>): ObserveResult => {
  expect(r).not.toHaveProperty("code");
  return r as ObserveResult;
};

describe("visual observation output", () => {
  it("publishes all unnamed Canvas refs by default without live reads or screenshots", async () => {
    const f = fixture(120);
    const r = success(await publishObservationPage(f.store, f.cdp, 4, { output: f.output }));
    expect(r.ref_count).toBe(120);
    expect(r.next_cursor).toBeUndefined();
    expect(r.text.match(/\[visual:screenshot\]/g)).toHaveLength(120);
    expect(f.store.resolveEntry("e1")?.kind).toBe("visual-region");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("publishes distinct refs for overlapping Canvas nodes after candidate deduplication", async () => {
    const f = fixture(2);
    const graph = normalizeSemanticStructure(
      resolveSemanticGraph(
        buildSemanticGraph({
          rootFrameId: "top",
          viewport: { width: 1200, height: 800 },
          documents: [
            {
              frameId: "top",
              target: identity.target,
              contextScopeId: "top",
              axNodes: [],
              domNodes: [1, 100, 101].map((id) => ({
                backendNodeId: id,
                parentBackendNodeId: id === 1 ? null : 1,
                tag: id === 1 ? "main" : "canvas",
                attrs: {},
                rect: { x: 0, y: 0, w: 100, h: 100 },
                paintOrder: id,
                position: "static",
                pointerEvents: "auto",
              })),
            },
          ],
        }),
      ),
    );
    const discovery = await deduplicateVisualCandidates({
      candidates: [candidate(100), candidate(101), candidate(100)],
      complete: true,
      issues: [],
      captureIssues: [],
    });
    f.output.candidates = discovery.candidates;
    f.output.render = prepareObservationRender(
      attachVisualEntries(projectSemanticGraph(graph), graph, discovery.candidates),
    );
    const result = success(await publishObservationPage(f.store, f.cdp, 4, { output: f.output }));
    expect(result.ref_count).toBe(2);
    expect(result.text.match(/\[visual:screenshot\]/g)).toHaveLength(2);
    const refs = [...f.store.entries()];
    expect(refs[0][0]).not.toBe(refs[1][0]);
    expect(
      refs.map(([, entry]) => entry.kind === "visual-region" && entry.candidate.backendNodeId),
    ).toEqual([100, 101]);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("continues all candidates, replaces refs and retries the latest cursor without skipping", async () => {
    const f = fixture(35, 100);
    let r = success(await publishObservationPage(f.store, f.cdp, 4, { output: f.output }));
    const seen = new Set<string>();
    let pages = 0;
    let retriedFinalPage = false;
    while (true) {
      expect(
        r.text.split("\n").reduce((n, line) => n + Math.ceil(line.length / 4), 0),
      ).toBeLessThanOrEqual(100);
      for (const [ref] of f.store.entries()) {
        expect(seen.has(ref)).toBe(false);
        seen.add(ref);
      }
      if (!r.next_cursor) break;
      const cursor = r.next_cursor;
      const old = [...f.store.entries()].map(([ref]) => ref);
      r = success(await publishObservationPage(f.store, f.cdp, 4, { cursor }));
      for (const ref of old) expect(f.store.resolveEntry(ref)).toBeNull();
      const revision = f.store.revision;
      expect(await publishObservationPage(f.store, f.cdp, 4, { cursor })).toEqual(r);
      expect(f.store.revision).toBe(revision);
      if (!r.next_cursor) retriedFinalPage = true;
      expect(++pages).toBeLessThan(35);
    }
    expect(retriedFinalPage).toBe(true);
    expect(seen.size).toBe(35);
    expect(
      f.send.mock.calls.every((c) =>
        ["Page.createIsolatedWorld", "Runtime.evaluate", "Runtime.releaseObjectGroup"].includes(
          c[1],
        ),
      ),
    ).toBe(true);
  });
  it.each(["DOM", "replace", "clear", "tab"])("rejects a cursor after %s changes", async (kind) => {
    const f = fixture(20, 100);
    const first = success(await publishObservationPage(f.store, f.cdp, 4, { output: f.output }));
    if (kind === "DOM") f.change();
    if (kind === "replace") f.store.replace([]);
    if (kind === "clear") f.store.clear();
    expect(
      await publishObservationPage(f.store, f.cdp, kind === "tab" ? 5 : 4, {
        cursor: first.next_cursor,
      }),
    ).toHaveProperty("code");
  });
  it("does not consume an entry when a continuation budget is too small", async () => {
    const f = fixture(20, 100);
    const first = success(await publishObservationPage(f.store, f.cdp, 4, { output: f.output }));
    const cursor = first.next_cursor!;
    expect(
      await publishObservationPage(f.store, f.cdp, 4, { cursor, maxTokens: 1 }),
    ).toHaveProperty("code");
    const next = success(
      await publishObservationPage(f.store, f.cdp, 4, { cursor, maxTokens: 100 }),
    );
    expect(next.ref_count).toBeGreaterThan(0);
  });
  it("shrinks a long visual label, preserving its complete capability marker", async () => {
    const f = fixture(1, 45);
    f.scene.visuals![0].label = 'bad\n" ' + "x".repeat(1000);
    f.output.render = prepareObservationRender(f.scene);
    const r = success(await publishObservationPage(f.store, f.cdp, 4, { output: f.output }));
    expect(r.text).toContain("@e1 canvas [visual:screenshot]");
    expect(r.next_cursor).toBeUndefined();
  });
  it("keeps Canvas reachable below a depth limit", async () => {
    const f = fixture(1);
    f.scene.nodes.push(node(2, 1, "group", "deep"));
    f.scene.visuals![0].parentId = 2;
    f.output.render = prepareObservationRender(f.scene, { maxDepth: 1 });
    const r = success(await publishObservationPage(f.store, f.cdp, 4, { output: f.output }));
    expect(r.ref_count).toBe(1);
    expect(r.truncated).toBe(true);
  });
  it("preserves the original semantic output when there are no Canvas entries", () => {
    const scene: VomScene = {
      viewport: { width: 1000, height: 800 },
      nodes: [
        node(1, null, "rootwebarea"),
        node(2, 1, "button", "Save"),
        node(3, 2, "statictext", "Save"),
      ],
    };
    const original = renderVom(scene);
    const prepared = prepareObservationRender(scene);
    expect(
      [
        ...prepared.headers,
        ...Array.from({ [Symbol.iterator]: () => prepared.rows }).map((r) => r.text),
      ].join("\n"),
    ).toBe(original.text);
  });
  it("joins through a dropped wrapper using source order without naming Canvas from nearby buttons", () => {
    const docs: Parameters<typeof buildSemanticGraph>[0]["documents"] = [
      {
        frameId: "top",
        target: { tabId: 4 },
        contextScopeId: "top",
        domNodes: [
          {
            backendNodeId: 1,
            parentBackendNodeId: null,
            tag: "main",
            attrs: {},
            rect: { x: 0, y: 0, w: 300, h: 300 },
            paintOrder: 1,
            position: "static",
            pointerEvents: "auto",
          },
          {
            backendNodeId: 2,
            parentBackendNodeId: 1,
            tag: "button",
            attrs: { "aria-label": "Before" },
            rect: { x: 0, y: 0, w: 100, h: 30 },
            paintOrder: 2,
            position: "static",
            pointerEvents: "auto",
          },
          {
            backendNodeId: 3,
            parentBackendNodeId: 1,
            tag: "div",
            attrs: {},
            rect: { x: 0, y: 30, w: 100, h: 100 },
            paintOrder: 3,
            position: "static",
            pointerEvents: "auto",
          },
          {
            backendNodeId: 4,
            parentBackendNodeId: 3,
            tag: "canvas",
            attrs: {},
            rect: { x: 0, y: 30, w: 100, h: 100 },
            paintOrder: 4,
            position: "static",
            pointerEvents: "auto",
          },
          {
            backendNodeId: 5,
            parentBackendNodeId: 1,
            tag: "button",
            attrs: { "aria-label": "After" },
            rect: { x: 0, y: 130, w: 100, h: 30 },
            paintOrder: 5,
            position: "static",
            pointerEvents: "auto",
          },
        ],
        axNodes: [],
      },
    ];
    const graph = normalizeSemanticStructure(
      resolveSemanticGraph(
        buildSemanticGraph({
          documents: docs,
          rootFrameId: "top",
          viewport: { width: 300, height: 300 },
        }),
      ),
    );
    const scene = attachVisualEntries(projectSemanticGraph(graph), graph, [candidate(4)]);
    const prepared = prepareObservationRender(scene);
    const text = Array.from({ [Symbol.iterator]: () => prepared.rows })
      .map((r) => r.text)
      .join("\n");
    expect(text.indexOf('"Before"')).toBeLessThan(text.indexOf("[visual:screenshot]"));
    expect(text.indexOf("[visual:screenshot]")).toBeLessThan(text.indexOf('"After"'));
    expect(text).toMatch(/canvas \[visual:screenshot\]/);
  });
  it("keeps unplaced candidates in an explicit supplement", () => {
    const graph = normalizeSemanticStructure(
      resolveSemanticGraph(
        buildSemanticGraph({
          documents: [],
          rootFrameId: "top",
          viewport: { width: 300, height: 300 },
        }),
      ),
    );
    const prepared = prepareObservationRender(
      attachVisualEntries({ viewport: { width: 300, height: 300 }, nodes: [] }, graph, [
        candidate(10),
      ]),
    );
    const text = Array.from({ [Symbol.iterator]: () => prepared.rows })
      .map((r) => r.text)
      .join("\n");
    expect(text).toContain("Unplaced Canvas regions");
    expect(text).toContain("[visual:screenshot]");
  });
  it("places child-frame Canvas under its iframe owner", () => {
    const graph = normalizeSemanticStructure(
      resolveSemanticGraph(
        buildSemanticGraph({
          rootFrameId: "top",
          viewport: { width: 300, height: 300 },
          documents: [
            {
              frameId: "top",
              target: { tabId: 4 },
              contextScopeId: "top",
              axNodes: [],
              domNodes: [
                {
                  backendNodeId: 1,
                  parentBackendNodeId: null,
                  tag: "main",
                  attrs: {},
                  rect: { x: 0, y: 0, w: 300, h: 300 },
                  paintOrder: 1,
                  position: "static",
                  pointerEvents: "auto",
                },
                {
                  backendNodeId: 2,
                  parentBackendNodeId: 1,
                  tag: "iframe",
                  attrs: {},
                  rect: { x: 0, y: 0, w: 200, h: 200 },
                  paintOrder: 2,
                  position: "static",
                  pointerEvents: "auto",
                },
              ],
            },
            {
              frameId: "child",
              parentFrameId: "top",
              ownerBackendNodeId: 2,
              target: { tabId: 4, sessionId: "oopif" },
              contextScopeId: "child",
              axNodes: [],
              domNodes: [
                {
                  backendNodeId: 11,
                  parentBackendNodeId: null,
                  tag: "canvas",
                  attrs: {},
                  rect: { x: 0, y: 0, w: 100, h: 100 },
                  paintOrder: 1,
                  position: "static",
                  pointerEvents: "auto",
                },
              ],
            },
          ],
        }),
      ),
    );
    const c = { ...candidate(11), document: { ...identity, frameId: "child" } };
    const scene = attachVisualEntries(projectSemanticGraph(graph), graph, [c]);
    const owner = scene.nodes.find((n) => n.backendNodeId === 2)!;
    expect(scene.visuals![0].parentId).toBe(owner.id);
    expect(scene.visuals![0].fallbackContext).toBeUndefined();
  });
  it("does not register candidates missing screenshot paths", () => {
    const graph = normalizeSemanticStructure(
      resolveSemanticGraph(
        buildSemanticGraph({
          documents: [],
          rootFrameId: "top",
          viewport: { width: 300, height: 300 },
        }),
      ),
    );
    const c = { ...candidate(4), framePath: undefined };
    const output = prepareVisualObservation(
      { viewport: { width: 300, height: 300 }, nodes: [] },
      graph,
      { candidates: [c], issues: [], captureIssues: [], complete: true },
      new Map(),
      "top",
      [],
      {},
    );
    expect(output.candidates).toHaveLength(0);
    expect(output.notices[0]).toContain("no verified screenshot path");
  });
});

it("observe discovers and registers visual refs from its single production capture; snapshot stays semantic", async () => {
  const strings = [
    "#document",
    "HTML",
    "CANVAS",
    "static",
    "auto",
    "visible",
    "1",
    "block",
    "none",
    "0px",
    "http://fixture.test",
  ];
  const index = (s: string) => strings.indexOf(s);
  const manager = new SessionManager({
    agentWindow: {
      create: async () => 100,
      remove: async () => {},
      ensureActiveTab: async () => 4,
    },
  });
  const ctx = await manager.start("test");
  const send = vi.fn(async (_tab: number, method: string, params: Record<string, unknown> = {}) => {
    if (method === "Page.getLayoutMetrics")
      return {
        visualViewport: { clientWidth: 1000, clientHeight: 800 },
        cssVisualViewport: { clientWidth: 1000, clientHeight: 800, scale: 1, zoom: 1 },
        cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
      };
    if (method === "DOMSnapshot.captureSnapshot") {
      const styles = (params.computedStyles as string[]).map((key) =>
        index(
          (
            {
              position: "static",
              "pointer-events": "auto",
              cursor: "auto",
              visibility: "visible",
              opacity: "1",
              display: "block",
              "overflow-x": "visible",
              "overflow-y": "visible",
              zoom: "1",
              clip: "auto",
              "overflow-clip-margin": "0px",
            } as Record<string, string>
          )[key] ?? "none",
        ),
      );
      return {
        strings,
        documents: [
          {
            frameId: "top",
            documentURL: index("http://fixture.test"),
            scrollOffsetX: 0,
            scrollOffsetY: 0,
            nodes: {
              parentIndex: [-1, 0, 1],
              nodeType: [9, 1, 1],
              nodeName: [0, 1, 2],
              backendNodeId: [10, 1, 100],
              attributes: [[], [], []],
            },
            layout: {
              nodeIndex: [1, 2],
              styles: [styles, styles],
              bounds: [
                [0, 0, 1000, 800],
                [20, 20, 100, 100],
              ],
              clientRects: [
                [0, 0, 1000, 800],
                [0, 0, 100, 100],
              ],
              paintOrders: [0, 1],
            },
          },
        ],
      };
    }
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: [
          {
            nodeId: "1",
            backendDOMNodeId: 1,
            role: { value: "RootWebArea" },
            name: { value: "Fixture" },
          },
        ],
      };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Runtime.evaluate")
      return { result: { deepSerializedValue: { type: "node", value: { backendNodeId: 1 } } } };
    if (method === "Runtime.releaseObjectGroup" || method.endsWith(".enable")) return {};
    throw new Error(`unexpected ${method}`);
  });
  const cdp = {
    send,
    getAttachmentId: () => "a",
    getFrameGraph: async () => ({
      rootFrameId: "top",
      frames: [{ frameId: "top", target: { tabId: 4 } }],
    }),
  } as unknown as CdpRunner;
  const tab = { id: 4, windowId: 100, active: true, url: "http://fixture.test" } as chrome.tabs.Tab;
  const deps = { cdp, tabsApi: { get: async () => tab, query: async () => [tab] } };
  const observed = await handleObserve(manager, { session_id: "test" }, deps);
  expect(observed).not.toHaveProperty("code");
  expect((observed as ObserveResult).text).toContain("@e1 canvas [visual:screenshot]");
  expect(ctx.refStore.resolveEntry("e1")?.kind).toBe("visual-region");
  expect(send.mock.calls.filter((c) => c[1] === "DOMSnapshot.captureSnapshot")).toHaveLength(1);
  expect(send.mock.calls.some((c) => c[1] === "Page.captureScreenshot")).toBe(false);
  await handleSnapshot(manager, { session_id: "test" }, deps);
  const captures = send.mock.calls.filter((c) => c[1] === "DOMSnapshot.captureSnapshot");
  expect(captures[0][2]?.computedStyles).toHaveLength(18);
  expect(captures[1][2]?.computedStyles).toHaveLength(5);
  expect([...ctx.refStore.entries()].some(([, entry]) => entry.kind === "visual-region")).toBe(
    false,
  );
});

it.each([
  "same",
  "different",
  "action",
])("only suppresses redundant passive Canvas semantics: %s", (kind) => {
  const semantic = node(
    2,
    1,
    kind === "action" ? "button" : "canvas",
    kind === "different" ? "Distinct semantics" : "Canvas title",
  );
  semantic.tag = "canvas";
  const scene: VomScene = {
    viewport: { width: 1000, height: 800 },
    nodes: [node(1, null, "rootwebarea"), semantic],
    visuals: [
      { key: 0, sourceId: 2, beforeId: 2, parentId: 1, label: "Canvas title", frameId: "top" },
    ],
  };
  const rows = Array.from({ [Symbol.iterator]: () => prepareObservationRender(scene).rows });
  expect(rows.filter((r) => r.text.includes("Canvas title"))).toHaveLength(
    kind === "action" ? 2 : 1,
  );
  expect(rows.some((r) => r.text.includes("Distinct semantics"))).toBe(kind === "different");
  if (kind === "action") expect(rows.filter((r) => r.ref)).toHaveLength(2);
});

it.each([
  "source",
  "parent",
  "frame",
  "unplaced",
])("does not resurrect modal background Canvas via %s", async (kind) => {
  const f = fixture(1);
  f.scene.rootFrameId = "top";
  f.scene.nodes.push(node(2, 1, kind === "frame" ? "iframe" : "canvas"));
  f.scene.nodes.push({
    ...node(10, 1, "dialog", "Login"),
    position: "fixed",
    rect: { x: 0, y: 0, w: 800, h: 600 },
  });
  f.scene.visuals = [
    {
      key: 0,
      frameId: kind === "frame" ? "child" : "top",
      parentId: kind === "unplaced" ? null : 2,
      ...(kind === "source" ? { sourceId: 2 } : {}),
    },
  ];
  f.output.render = prepareObservationRender(f.scene);
  const result = success(await publishObservationPage(f.store, f.cdp, 4, { output: f.output }));
  expect(result.text).toContain("focus=L1");
  expect(result.text).not.toContain("[visual:screenshot]");
  expect(result.text).not.toContain("Unplaced Canvas");
  expect([...f.store.entries()].some(([, entry]) => entry.kind === "visual-region")).toBe(false);
  f.scene.nodes = f.scene.nodes.filter((n) => n.id !== 10);
  expect(
    Array.from({ [Symbol.iterator]: () => prepareObservationRender(f.scene).rows }).filter(
      (r) => r.ref?.visualKey !== undefined,
    ),
  ).toHaveLength(1);
});

it("preserves modal Canvas with omitted semantics and admits proven foreground fallback", () => {
  const scene: VomScene = {
    rootFrameId: "top",
    viewport: { width: 1000, height: 800 },
    nodes: [
      node(1, null, "rootwebarea"),
      {
        ...node(10, 1, "dialog", "Login"),
        position: "fixed",
        rect: { x: 0, y: 0, w: 800, h: 600 },
      },
    ],
    visuals: [
      { key: 0, parentId: 10, frameId: "top" },
      {
        key: 1,
        parentId: null,
        frameId: "top",
        paintOrder: 11,
        rect: { x: 10, y: 10, w: 40, h: 40 },
      },
    ],
  };
  const result = Array.from({ [Symbol.iterator]: () => prepareObservationRender(scene).rows });
  expect(result.filter((r) => r.ref?.visualKey !== undefined).map((r) => r.ref!.visualKey)).toEqual(
    [0, 1],
  );
});

it.each([
  true,
  false,
])("applies the existing active-region policy to Canvas (enabled=%s)", (enabled) => {
  const scene: VomScene = {
    rootFrameId: "top",
    viewport: { width: 1000, height: 800 },
    nodes: [
      node(1, null, "rootwebarea"),
      node(2, 1, "canvas"),
      {
        ...node(10, 1, "group", "Popover"),
        position: "fixed",
        rect: { x: 0, y: 0, w: 100, h: 100 },
      },
    ],
    visuals: [
      {
        key: 0,
        parentId: 1,
        sourceId: 2,
        frameId: "top",
        rect: { x: 0, y: 0, w: 100, h: 30 },
        paintOrder: 2,
      },
    ],
  };
  const rendered = Array.from({
    [Symbol.iterator]: () => prepareObservationRender(scene, { activeRegionPolicy: enabled }).rows,
  });
  expect(rendered.filter((r) => r.ref?.visualKey !== undefined)).toHaveLength(enabled ? 0 : 1);
});

it.each([
  "Runtime.evaluate",
  "Runtime.releaseObjectGroup",
])("retains a cancelled page through handleObserve during %s", async (method) => {
  const f = fixture(35, 100);
  const manager = new SessionManager({
    agentWindow: {
      create: async () => 100,
      remove: async () => {},
      ensureActiveTab: async () => 4,
    },
  });
  const ctx = await manager.start("cancel-test");
  const first = success(await publishObservationPage(ctx.refStore, f.cdp, 4, { output: f.output }));
  const originalRefs = [...ctx.refStore.entries()];
  const revision = ctx.refStore.revision;
  const controller = new AbortController();
  const original = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (tab, command) => {
    const result = await original(tab, command);
    if (command === method) controller.abort();
    return result;
  });
  const tab = { id: 4, windowId: 100, url: "http://fixture.test" } as chrome.tabs.Tab;
  const cancelled = await handleObserve(
    manager,
    { session_id: "cancel-test", cursor: first.next_cursor },
    { cdp: f.cdp, tabsApi: { get: async () => tab, query: async () => [tab] } },
    controller.signal,
  );
  expect(cancelled).toHaveProperty("code", "cancelled");
  expect(ctx.refStore.revision).toBe(revision);
  expect([...ctx.refStore.entries()]).toEqual(originalRefs);
  f.send.mockImplementation(original);
  const seen = new Set(originalRefs.map(([ref]) => ref));
  let cursor = first.next_cursor;
  while (cursor) {
    const page = success(await publishObservationPage(ctx.refStore, f.cdp, 4, { cursor }));
    expect(await publishObservationPage(ctx.refStore, f.cdp, 4, { cursor })).toEqual(page);
    for (const [ref] of ctx.refStore.entries()) {
      expect(seen.has(ref)).toBe(false);
      seen.add(ref);
    }
    cursor = page.next_cursor;
  }
  expect(seen.size).toBe(35);
});

it("preserves a Canvas containing an active region rather than treating it as background", () => {
  const scene: VomScene = {
    rootFrameId: "top",
    viewport: { width: 1000, height: 800 },
    nodes: [
      node(1, null, "rootwebarea"),
      { ...node(2, 1, "canvas"), paintOrder: 5 },
      {
        ...node(10, 2, "group", "Popover"),
        paintOrder: 5,
        position: "fixed",
        rect: { x: 0, y: 0, w: 100, h: 100 },
      },
    ],
    visuals: [{ key: 0, parentId: 1, sourceId: 2, frameId: "top" }],
  };
  const result = prepareObservationRender(scene, { activeRegionPolicy: true });
  const text = [
    ...result.headers,
    ...Array.from({ [Symbol.iterator]: () => result.rows }, (r) => r.text),
  ].join("\n");
  expect(text).toContain("[visual:screenshot]");
  expect(text).toContain('group "Popover"');
});

it("an old cancelled validation cannot clear a newer observation", async () => {
  const f = fixture(20, 100);
  const first = success(await publishObservationPage(f.store, f.cdp, 4, { output: f.output }));
  const controller = new AbortController();
  const original = f.send.getMockImplementation()!;
  let newer: ObserveResult | undefined;
  f.send.mockImplementation(async (tab, method) => {
    if (method === "Runtime.evaluate") {
      newer = success(
        await publishObservationPage(f.store, f.cdp, 4, { output: fixture(25, 100).output }),
      );
      controller.abort();
    }
    return original(tab, method);
  });
  await expect(
    publishObservationPage(f.store, f.cdp, 4, { cursor: first.next_cursor }, controller.signal),
  ).rejects.toThrow();
  f.send.mockImplementation(original);
  expect(
    success(await publishObservationPage(f.store, f.cdp, 4, { cursor: newer!.next_cursor }))
      .ref_count,
  ).toBeGreaterThan(0);
});

it("keeps excluded Canvas out of every continuation page", async () => {
  const f = fixture(36, 100);
  f.scene.rootFrameId = "top";
  f.scene.nodes.push({
    ...node(10, 1, "dialog", "Login"),
    position: "fixed",
    rect: { x: 0, y: 0, w: 800, h: 600 },
  });
  f.scene.visuals!.forEach((v, i) => {
    v.parentId = i === 0 ? 1 : 10;
  });
  f.output.render = prepareObservationRender(f.scene);
  let result = success(await publishObservationPage(f.store, f.cdp, 4, { output: f.output }));
  let count = 0;
  while (true) {
    for (const [, entry] of f.store.entries())
      if (entry.kind === "visual-region") {
        expect(entry.candidate.backendNodeId).not.toBe(100);
        count++;
      }
    if (!result.next_cursor) break;
    result = success(
      await publishObservationPage(f.store, f.cdp, 4, { cursor: result.next_cursor }),
    );
  }
  expect(count).toBe(35);
});

it("can retry a cancelled final page with a smaller budget without losing buffered rows", async () => {
  const f = fixture(20, 100);
  const first = success(await publishObservationPage(f.store, f.cdp, 4, { output: f.output }));
  const seen = new Set([...f.store.entries()].map(([ref]) => ref));
  const controller = new AbortController();
  const original = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (tab, method) => {
    if (method === "Runtime.evaluate") controller.abort();
    return original(tab, method);
  });
  await expect(
    publishObservationPage(
      f.store,
      f.cdp,
      4,
      { cursor: first.next_cursor, maxTokens: 10000 },
      controller.signal,
    ),
  ).rejects.toThrow();
  f.send.mockImplementation(original);
  let cursor = first.next_cursor;
  while (cursor) {
    const result = success(
      await publishObservationPage(f.store, f.cdp, 4, { cursor, maxTokens: 100 }),
    );
    for (const [ref] of f.store.entries()) {
      expect(seen.has(ref)).toBe(false);
      seen.add(ref);
    }
    cursor = result.next_cursor;
  }
  expect(seen.size).toBe(20);
});

it("preserves DOM labels for audit on the first and continuation pages", async () => {
  const f = fixture(0, 110);
  f.scene.nodes.push(
    ...Array.from({ length: 12 }, (_, i) => ({
      ...node(i + 2, 1, "button", `Action ${i}`),
      rect: { x: 0, y: i * 35, w: 100, h: 30 },
    })),
  );
  f.output.render = prepareObservationRender(f.scene);
  const manager = new SessionManager({
    agentWindow: {
      create: async () => 100,
      remove: async () => {},
      ensureActiveTab: async () => 4,
    },
  });
  const ctx = await manager.start("audit-test");
  ctx.agentCreatedTabs.add(4);
  const originalChrome = globalThis.chrome;
  vi.stubGlobal("chrome", {
    tabs: { get: vi.fn(async () => ({ id: 4, url: "https://fixture.test/page" })) },
  });
  try {
    let result = success(
      await publishObservationPage(ctx.refStore, f.cdp, 4, { output: f.output }),
    );
    let pages = 0;
    const labels: string[] = [];
    while (true) {
      for (const [ref, entry] of ctx.refStore.entries()) {
        expect(entry.kind).toBe("dom");
        if (entry.kind !== "dom") throw new Error("expected DOM ref");
        expect(entry.name).toBe(`Action ${labels.length}`);
        const audit = await auditContext(
          {
            id: "audit-click",
            method: "tool.click",
            params: {
              session_id: ctx.sessionId,
              tab_id: 4,
              ref,
              _audit_id: "operation-test",
            },
          },
          manager,
        );
        expect(audit).toMatchObject({ target: entry.name, tab_id: 4 });
        labels.push(entry.name!);
      }
      pages++;
      if (!result.next_cursor) break;
      result = success(
        await publishObservationPage(ctx.refStore, f.cdp, 4, { cursor: result.next_cursor }),
      );
    }
    expect(pages).toBeGreaterThan(1);
    expect(labels).toHaveLength(12);
    // A visual ref has no DOM audit label, even when its candidate has a label.
    ctx.refStore.replace([
      ["e1", { kind: "visual-region", candidate: { ...candidate(100), label: "Canvas" } }],
    ]);
    expect(
      await auditContext(
        {
          id: "audit-visual",
          method: "tool.click",
          params: {
            session_id: ctx.sessionId,
            tab_id: 4,
            ref: "e1",
            _audit_id: "operation-test",
          },
        },
        manager,
      ),
    ).not.toHaveProperty("target");
  } finally {
    vi.stubGlobal("chrome", originalChrome);
  }
});
