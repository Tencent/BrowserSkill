import type { VomNode } from "@browser-skill/vom";
import { describe, expect, it } from "vitest";
import { contentChanges, sameObservationEvidence } from "./observation-evidence";

const node = (id: number, parentId: number | null, role: string, name = ""): VomNode => ({
  id,
  parentId,
  backendNodeId: id,
  frameId: "frame",
  role,
  name,
  tag: role,
  rect: { x: 10, y: 10, w: 100, h: 20 },
  paintOrder: 1,
  position: "static",
  pointerEvents: "auto",
});
const scene = () => [
  node(1, null, "main"),
  node(2, 1, "form"),
  node(3, 2, "textbox", "Choice"),
  node(4, 2, "button", "Continue"),
  node(5, 1, "aside", "Rotating announcement"),
];
const target = { backendNodeId: 4, frameId: "frame" };

it("allows unrelated updates and cosmetic hover changes while retaining form evidence", () => {
  const before = scene();
  const after = structuredClone(before);
  after[4].name = "Next announcement";
  after[3].attrs = { class: "hovered" };
  after[3].rect!.x += 30;
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(true);
});

describe("selection evidence", () => {
  it.each([
    { role: "button" },
    { role: "generic", clickable: true },
    { role: "generic", attrs: { onclick: "selectCell()" } },
  ])("protects semantic and custom controls: %j", (control) => {
    const before = scene();
    before[3] = { ...before[3], ...control };
    const after = structuredClone(before);
    after[3].attrs = { ...after[3].attrs, class: "selected" };
    expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(false);
  });

  it("ignores selection-like attributes on decorative wrappers", () => {
    const before = scene();
    const after = structuredClone(before);
    after[1].attrs = { class: "selected", "data-selected": "true", "data-state": "selected" };
    expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(true);
    expect(sameObservationEvidence({ nodes: before }, { nodes: after })).toBe(true);
  });

  it("keeps unrelated selection changes outside an explicit dependency region", () => {
    const before = scene();
    before.push({ ...node(6, 5, "button", "Other choice"), attrs: { "data-selected": "false" } });
    const after = structuredClone(before);
    after[5].attrs = { "data-selected": "true" };
    expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(true);
    expect(sameObservationEvidence({ nodes: before }, { nodes: after })).toBe(false);
    expect(sameObservationEvidence({ nodes: before }, { nodes: after }, { backendNodeId: 6 })).toBe(
      false,
    );
  });

  it("never learns selection changes as volatile text", () => {
    const before = scene();
    before[3].text = "16:00";
    const after = structuredClone(before);
    after[3].text = "16:01";
    after[3].attrs = { "data-state": "selected" };
    expect(contentChanges({ nodes: before }, { nodes: after })).toBeUndefined();
    expect(
      sameObservationEvidence({ nodes: before }, { nodes: after }, undefined, new Set(["frame:4"])),
    ).toBe(false);
  });
});

it.each([
  "value",
  "identity",
  "disabled",
  "overlay",
])("rejects changed %s even when the button remains", (change) => {
  const before = scene();
  const after = structuredClone(before);
  if (change === "value") after[2].value = "different";
  if (change === "identity") after[3].backendNodeId = 40;
  if (change === "disabled") after[3].disabled = true;
  if (change === "overlay") after.push({ ...node(6, 1, "dialog"), modal: true });
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(false);
});

it("invalidates a selection when another candidate changes or the list reorders", () => {
  const before = [
    node(1, null, "list"),
    node(2, 1, "button", "A 100"),
    node(3, 1, "button", "B 120"),
  ];
  const changed = structuredClone(before);
  changed[2].name = "B 80";
  for (const after of [changed, [before[0], before[2], before[1]]])
    expect(sameObservationEvidence({ nodes: before }, { nodes: after }, { backendNodeId: 2 })).toBe(
      false,
    );
});

it("checks fields outside the action region and falls back to the whole document without a scope", () => {
  const before = scene();
  before.push({ ...node(6, 1, "textbox", "Destination"), value: "A" });
  const after = structuredClone(before);
  after[5].value = "B";
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(false);
  expect(sameObservationEvidence({ nodes: scene() }, { nodes: after })).toBe(false);
});

it("identifies in-place text changes and tolerates only those in the whole-page check", () => {
  const before = scene();
  before.push({ ...node(6, 1, "timer"), text: "10:00:00" });
  const after = structuredClone(before);
  after[5].text = "10:00:01";
  expect(contentChanges({ nodes: before }, { nodes: after })).toEqual([
    { key: "frame:6", before: "10:00:00", after: "10:00:01" },
  ]);
  const volatile = new Set(["frame:6"]);
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, undefined, volatile)).toBe(
    true,
  );
  for (const change of ["removed", "disabled", "hidden", "added"]) {
    const next = structuredClone(after);
    if (change === "removed") next.pop();
    if (change === "disabled") next[5].disabled = true;
    if (change === "hidden") next[5].rect = { x: 0, y: 0, w: 0, h: 0 };
    if (change === "added") next.push(node(7, 1, "status", "Sold out"));
    expect(sameObservationEvidence({ nodes: before }, { nodes: next }, undefined, volatile)).toBe(
      false,
    );
    expect(contentChanges({ nodes: before }, { nodes: next }, volatile)).toBeUndefined();
  }
  // Explicit targets never use the tolerated set.
  expect(
    sameObservationEvidence({ nodes: before }, { nodes: after }, { backendNodeId: 6 }, volatile),
  ).toBe(false);
});

it("never treats form values or modal content as page activity", () => {
  const before = scene();
  before.push({ ...node(6, 1, "textbox", "Amount"), value: "1" });
  before.push({ ...node(7, 1, "dialog", "Confirm"), modal: true });
  for (const index of [5, 6]) {
    const after = structuredClone(before);
    after[index].name = "changed";
    const volatile = new Set([`frame:${index + 1}`]);
    expect(contentChanges({ nodes: before }, { nodes: after })).toBeUndefined();
    expect(sameObservationEvidence({ nodes: before }, { nodes: after }, undefined, volatile)).toBe(
      false,
    );
  }
});

it("reports aria-label and title rewrites as content changes", () => {
  const before = [
    node(1, null, "main"),
    { ...node(2, 1, "timer"), attrs: { "aria-label": "10:00" } },
  ];
  const after = structuredClone(before);
  after[1].attrs = { "aria-label": "10:01" };
  expect(contentChanges({ nodes: before }, { nodes: after })).toEqual([
    { key: "frame:2", before: "10:00", after: "10:01" },
  ]);
  const volatile = new Set(["frame:2"]);
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, undefined, volatile)).toBe(
    true,
  );
});

it("relaxes learned text only around targets in <main> or without a region", () => {
  const volatile = new Set(["frame:4"]);
  const check = (parent: string, sibling = true) => {
    const before = [
      node(1, null, "body"),
      node(2, 1, parent),
      node(3, 2, "button", "Buy"),
      { ...node(4, sibling ? 2 : 3, "span"), text: "1" },
    ];
    const after = structuredClone(before);
    after[3].text = "2";
    return sameObservationEvidence(
      { nodes: before },
      { nodes: after },
      { backendNodeId: 3 },
      volatile,
    );
  };
  expect(check("main")).toBe(true);
  expect(check("div")).toBe(true);
  for (const region of ["form", "dialog", "list", "table", "section", "article", "region"])
    expect(check(region)).toBe(false);
  // Text inside the target itself is never relaxed.
  expect(check("main", false)).toBe(false);
});

// Real Chrome observations add text nodes and derive container names from
// descendant text: a tick changes every ancestor's name, a StaticText node and
// an InlineTextBox without a backend node.
const page = (clock: string, price = "$100", hidden = false): VomNode[] => [
  { ...node(1, null, "main"), name: hidden ? clock : `${clock} ${price}` },
  { ...node(2, 1, "span"), name: clock, text: clock },
  { ...node(3, 2, "StaticText"), name: clock },
  { ...node(4, 3, "InlineTextBox"), name: clock, backendNodeId: undefined },
  { ...node(5, 1, "generic"), name: price },
  ...(hidden
    ? []
    : [
        { ...node(6, 5, "span"), name: price, text: price },
        { ...node(7, 6, "StaticText"), name: price },
      ]),
  node(8, 1, "button", "Buy"),
];

it("learns virtual text through the node that owns it, never derived names", () => {
  const before = { nodes: page("10:00:00") };
  const after = { nodes: page("10:00:01") };
  expect(contentChanges(before, after)?.map((change) => change.key)).toEqual([
    "frame:2",
    "frame:3",
  ]);
  expect(sameObservationEvidence(before, after, undefined, new Set(["frame:2", "frame:3"]))).toBe(
    true,
  );
  // The InlineTextBox and derived names stay exact without their owner.
  expect(sameObservationEvidence(before, after, undefined, new Set(["frame:2"]))).toBe(false);
});

it("keeps content without its own node exact inside derived names", () => {
  // An aria-hidden price exists only in its ancestors' derived names.
  expect(
    contentChanges({ nodes: page("1", "$100", true) }, { nodes: page("1", "$200", true) }),
  ).toBe(undefined);
  const learned = new Set(["frame:2", "frame:3"]);
  const before = { nodes: page("10:00:00", "$100", true) };
  // The learned clock ticks while the hidden price changes in the same container.
  const after = { nodes: page("10:00:01", "$100", true) };
  after.nodes[0].name = "10:00:01 $200";
  before.nodes[0].name = "10:00:00 $100";
  expect(sameObservationEvidence(before, after, undefined, learned)).toBe(false);
});

it("learns the same value shown twice", () => {
  const twins = (clock: string): VomNode[] => [
    { ...node(1, null, "main"), name: `${clock} ${clock}` },
    { ...node(2, 1, "span"), name: clock, text: clock },
    { ...node(3, 1, "span"), name: clock, text: clock },
    node(4, 1, "button", "Go"),
  ];
  const changes = contentChanges({ nodes: twins("1") }, { nodes: twins("2") });
  expect(changes?.map((change) => change.key)).toEqual(["frame:2", "frame:3"]);
  // A different value elsewhere in the derived name is not learned text.
  const after = twins("2");
  after[0].name = "2 3";
  expect(
    sameObservationEvidence(
      { nodes: twins("1") },
      { nodes: after },
      undefined,
      new Set(["frame:2"]),
    ),
  ).toBe(false);
});

describe("learned text around a target inside <main> or without a region", () => {
  const shape = (
    specs: [id: number, parent: number | null, role: string, extra?: Partial<VomNode>][],
  ): VomNode[] =>
    // Like Chrome, an element's name includes its own text.
    specs.map(([id, parent, role, extra]) => ({
      ...node(id, parent, role, extra?.text),
      ...extra,
    }));
  const tick = (nodes: VomNode[], id: number, text: string) => {
    const next = structuredClone(nodes);
    const changed = next.find((candidate) => candidate.id === id)!;
    changed.text = text;
    changed.name = text;
    return next;
  };
  const allowed = (nodes: VomNode[], target: number, learned: number) =>
    sameObservationEvidence(
      { nodes },
      { nodes: tick(nodes, learned, "changed") },
      { backendNodeId: target, frameId: "frame" },
      new Set([`frame:${learned}`]),
    );

  it("keeps a positioned panel exact", () => {
    const nodes = shape([
      [1, null, "main"],
      [2, 1, "form"],
      [3, 2, "button", { name: "Continue" }],
      [4, 1, "generic", { position: "fixed" }],
      [5, 4, "span", { text: "$100" }],
      [6, 4, "button", { name: "Pay" }],
    ]);
    expect(allowed(nodes, 6, 5)).toBe(false);
    // The same panel nested under a single-child wrapper stays exact as well.
    const wrapped = shape([
      [1, null, "main"],
      [7, 1, "generic"],
      [4, 7, "generic", { position: "absolute" }],
      [5, 4, "span", { text: "$100" }],
      [6, 4, "button", { name: "Pay" }],
    ]);
    expect(allowed(wrapped, 6, 5)).toBe(false);
  });

  it("keeps the target's own branch exact and tolerates other branches", () => {
    const nodes = shape([
      [1, null, "RootWebArea"],
      [2, 1, "html"],
      [3, 2, "body"],
      [4, 3, "generic"],
      [5, 4, "banner"],
      [6, 5, "span", { text: "10:00:00" }],
      [7, 4, "group"],
      [8, 7, "generic"],
      [9, 8, "span", { text: "$100" }],
      [10, 8, "button", { name: "Buy" }],
      [11, 7, "button", { name: "Refresh" }],
    ]);
    // Single-child wrappers collapse, so the header is a separate branch.
    expect(allowed(nodes, 10, 6)).toBe(true);
    // The card's price shares the content branch with Buy and Refresh.
    expect(allowed(nodes, 10, 9)).toBe(false);
    expect(allowed(nodes, 11, 9)).toBe(false);
    // A target beside its learned text directly inside <main> is its own branch.
    const flat = shape([
      [1, null, "main"],
      [2, 1, "button", { name: "Go" }],
      [3, 1, "span", { text: "10:00:00" }],
    ]);
    expect(allowed(flat, 2, 3)).toBe(true);
  });
});

const mediaScene = () => [
  ...scene(),
  { ...node(6, 1, "Video", "Preview"), tag: "video", attrs: { id: "preview", src: "clip.webm" } },
  {
    ...node(7, 1, "slider", "Playback progress"),
    tag: "input",
    inForm: false,
    value: "1",
    attrs: { type: "range" },
  },
];

it("tolerates only the value of an outside media timeline for a declared scope", () => {
  const before = mediaScene();
  const after = structuredClone(before);
  after[6].value = "2";
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(true);
  expect(sameObservationEvidence({ nodes: before }, { nodes: after })).toBe(false);
  expect(
    sameObservationEvidence(
      { nodes: before },
      { nodes: after },
      { backendNodeId: 7, frameId: "frame" },
    ),
  ).toBe(false);
});

it.each([
  "business slider",
  "business text",
  "named input",
  "form member",
  "external form",
  "missing media",
  "ambiguous media",
  "different frame",
  "wrong relation",
])("protects %s despite video playback", (kind) => {
  const before = mediaScene();
  const progress = before[6];
  if (kind === "business slider") progress.name = "Order amount";
  if (kind === "business text") {
    progress.role = "textbox";
    progress.attrs = { type: "text" };
  }
  if (kind === "named input") progress.attrs!.name = "amount";
  if (kind === "form member") {
    progress.inForm = true;
    before.push(node(8, 1, "form", "Order"));
    progress.domAncestorIds = [8, 1];
  }
  if (kind === "external form") progress.attrs!.form = "order";
  if (kind === "missing media") before[5].tag = "div";
  if (kind === "ambiguous media") before.push({ ...node(8, 1, "Video"), tag: "video" });
  if (kind === "different frame") before[5].frameId = "other";
  if (kind === "wrong relation") progress.attrs!["aria-controls"] = "order";
  const after = structuredClone(before);
  after[6].value = "2";
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(false);
});

it("supports an explicit media relation when more than one player exists", () => {
  const before = mediaScene();
  before.push({ ...node(8, 1, "Video"), tag: "video", attrs: { id: "other" } });
  before[6].attrs!["aria-controls"] = "preview";
  const after = structuredClone(before);
  after[6].value = "2";
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(true);
});

it.each([
  "identity",
  "label",
  "disabled",
  "removed",
  "media identity",
  "media source",
  "business value",
])("retains %s evidence while ignoring timeline ticks", (kind) => {
  const before = mediaScene();
  before.push({ ...node(8, 1, "textbox", "Order total"), value: "100" });
  const after = structuredClone(before);
  after[6].value = "2";
  if (kind === "identity") after[6].backendNodeId = 70;
  if (kind === "label") after[6].name = "Order amount";
  if (kind === "disabled") after[6].disabled = true;
  if (kind === "removed") after.splice(6, 1);
  if (kind === "media identity") after[5].backendNodeId = 60;
  if (kind === "media source") after[5].attrs!.src = "other.webm";
  if (kind === "business value") after[7].value = "200";
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(false);
});

it.each([
  "min",
  "max",
  "step",
  "aria-valuemin",
  "aria-valuemax",
])("protects timeline %s while its value advances", (attribute) => {
  const before = mediaScene();
  const after = structuredClone(before);
  after[6].value = "2";
  after[6].attrs![attribute] = "10";
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(false);
});

it("never learns media values or relaxes an explicitly observed timeline", () => {
  const before = { nodes: mediaScene() };
  const after = structuredClone(before);
  after.nodes[6].value = "2";
  const learned = new Set(["frame:7"]);
  expect(contentChanges(before, after)).toBeUndefined();
  expect(sameObservationEvidence(before, after, undefined, learned)).toBe(false);
  expect(
    sameObservationEvidence(before, after, { backendNodeId: 7, frameId: "frame" }, learned),
  ).toBe(false);
  expect(sameObservationEvidence(before, after, target, learned)).toBe(true);
});

it("allows incidental progress within the pause button's region, but keeps declared containers exact", () => {
  const before = { nodes: mediaScene() };
  before.nodes[1].tag = "section";
  before.nodes[1].role = "region";
  before.nodes[5].parentId = 2;
  before.nodes[6].parentId = 2;
  const after = structuredClone(before);
  after.nodes[6].value = "2";
  expect(sameObservationEvidence(before, after, target)).toBe(true);
  expect(sameObservationEvidence(before, after, { backendNodeId: 7, frameId: "frame" })).toBe(
    false,
  );
  expect(sameObservationEvidence(before, after, { backendNodeId: 2, frameId: "frame" })).toBe(
    false,
  );
  expect(sameObservationEvidence(before, after)).toBe(false);
  after.nodes[2].value = "new order";
  expect(sameObservationEvidence(before, after, target)).toBe(false);
});

it("keeps explicitly declared DOM ancestors exact even when an AX parent differs", () => {
  const before = { nodes: mediaScene() };
  before.nodes.push(node(8, 1, "section", "Player"));
  before.nodes[6].domAncestorIds = [8, 1];
  const after = structuredClone(before);
  after.nodes[6].value = "2";
  expect(sameObservationEvidence(before, after, { backendNodeId: 8, frameId: "frame" })).toBe(
    false,
  );
});

it.each([
  true,
  undefined,
])("keeps media-labelled controls exact when native form membership is %s", (inForm) => {
  const before = { nodes: mediaScene() };
  before.nodes[6].inForm = inForm;
  const after = structuredClone(before);
  after.nodes[6].value = "2";
  expect(sameObservationEvidence(before, after, target)).toBe(false);
});

it("rejects a change in form membership even when the timeline value is unchanged", () => {
  const before = { nodes: mediaScene() };
  const after = structuredClone(before);
  after.nodes[6].inForm = true;
  expect(sameObservationEvidence(before, after, target)).toBe(false);
});
