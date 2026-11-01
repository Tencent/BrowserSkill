import { describe, expect, it } from "vitest";
import { type DomRefInput, RefStore, type VisualRefInput } from "../ref-store";

describe("RefStore", () => {
  it("stores and resolves ref → backendNodeId", () => {
    const s = new RefStore();
    s.set("e1", 42, { tabId: 7 });
    expect(s.resolve("@e1")).toBe(42);
    expect(s.resolve("e1")).toBe(42);
    expect(s.resolve("@e1", { tabId: 7 })).toBe(42);
    expect(s.resolve("@e1", { tabId: 8 })).toBeNull();
    expect(s.resolveEntry("@e1")).toMatchObject({
      backendNodeId: 42,
      tabId: 7,
      generation: 0,
    });
    expect(s.size()).toBe(1);
    expect(s.isEmpty()).toBe(false);
  });

  it("replace() clears prior entries", () => {
    const s = new RefStore();
    s.set("@e1", 1);
    s.set("@e2", 2);
    s.replace([
      ["e10", { backendNodeId: 10, tabId: 1, name: "Save" }],
      ["@e11", { backendNodeId: 11, tabId: 1 }],
    ]);
    expect(s.resolve("@e1")).toBeNull();
    expect(s.resolve("@e10")).toBe(10);
    expect(s.resolveEntry("e10")).toMatchObject({ kind: "dom", name: "Save" });
    expect(s.resolve("@e10", { tabId: 1 })).toBe(10);
    expect(s.resolve("@e10", { tabId: 2 })).toBeNull();
    expect(s.resolve("@e11")).toBe(11);
    expect(s.size()).toBe(2);
  });

  it("preserves the child CDP session as part of ref identity", () => {
    const s = new RefStore();
    s.set("e1", 42, {
      tabId: 7,
      frameId: "child-frame",
      cdpSessionId: "child-session",
    });
    expect(s.resolveEntry("e1")).toMatchObject({
      backendNodeId: 42,
      tabId: 7,
      frameId: "child-frame",
      cdpSessionId: "child-session",
    });
  });
});

describe("document invalidation", () => {
  it("rejects old refs without disturbing another tab's refs", () => {
    const refs = new RefStore();
    refs.set("e1", 10, { tabId: 7 });
    refs.set("e2", 10, { tabId: 8 });
    refs.invalidateTab(7);
    expect(refs.resolve("e1")).toBeNull();
    expect(refs.resolve("e2")).toBe(10);
    expect(refs.documentRevision(7)).toBe(1);
    expect(refs.documentRevision(8)).toBe(0);
    refs.set("e3", 10, { tabId: 7 });
    expect(refs.resolve("e1")).toBeNull();
    expect(refs.resolve("e3")).toBe(10);
  });

  it("records navigation during an in-flight first observation", () => {
    const refs = new RefStore();
    const revision = refs.documentRevision(7);
    refs.invalidateTab(7);
    expect(refs.documentRevision(7)).not.toBe(revision);
    expect(refs.isEmpty()).toBe(true);
  });
});

describe("stable DOM references", () => {
  const button: DomRefInput = { backendNodeId: 42, tabId: 7, frameId: "top" };
  const publish = (store: RefStore, inputs: DomRefInput[]) => {
    const entries = inputs.map((input) => [store.allocateRef(input), input] as const);
    store.replace(entries);
    return entries.map(([ref]) => ref);
  };

  it("keeps identities through reordered and partial observations while advancing evidence", () => {
    const store = new RefStore();
    store.enableStableRefs();
    const other = { ...button, backendNodeId: 43 };
    const [first, second] = publish(store, [button, other]);
    const observation = store.observationId;
    const revision = store.revision;
    expect(publish(store, [other, button])).toEqual([second, first]);
    expect(store.observationId).not.toBe(observation);
    expect(store.revision).toBe(revision + 1);
    expect(publish(store, [other])).toEqual([second]);
    expect(store.resolve(first)).toBe(42);
    expect(store.resolve(second)).toBe(43);
  });

  it("separates tabs, frames and CDP sessions even when backend node IDs overlap", () => {
    const store = new RefStore();
    store.enableStableRefs();
    const inputs = [
      button,
      { ...button, tabId: 8 },
      { ...button, frameId: "child" },
      { ...button, frameId: "child", cdpSessionId: "oopif" },
    ];
    const refs = publish(store, inputs);
    expect(new Set(refs).size).toBe(inputs.length);
    expect(publish(store, [...inputs].reverse())).toEqual([...refs].reverse());
  });

  it("never reuses a name after document replacement, including reserved unpublished rows", () => {
    const store = new RefStore();
    store.enableStableRefs();
    const [old] = publish(store, [button]);
    const reserved = store.allocateRef({ ...button, backendNodeId: 43 });
    const [otherTab] = publish(store, [{ ...button, tabId: 8 }]);
    store.invalidateTab(7);
    const [fresh, newReserved] = publish(store, [button, { ...button, backendNodeId: 43 }]);
    expect(new Set([old, reserved, otherTab, fresh, newReserved]).size).toBe(5);
    expect(store.resolve(old)).toBeNull();
    expect(store.resolve(otherTab)).toBe(42);
    store.clear();
    expect(publish(store, [button])[0]).not.toBe(fresh);
  });

  it("does not recycle identifiers issued before negotiation", () => {
    const store = new RefStore();
    store.replace([["e20", button]]);
    store.replace([]);
    store.enableStableRefs();
    const [ref] = publish(store, [button]);
    expect(ref).toBe("e21");
    store.enableStableRefs();
    expect(store.resolve(ref)).toBe(42);
  });

  it("expires visual refs at every publication without invalidating stable DOM refs", () => {
    const store = new RefStore();
    store.enableStableRefs();
    const visual = {
      kind: "visual-region",
      candidate: {
        backendNodeId: 90,
        document: {
          target: { tabId: 7 },
          attachmentId: "attached",
          frameId: "top",
          documentElementBackendNodeId: 1,
        },
      },
    } as VisualRefInput;
    const [dom] = publish(store, [button]);
    const first = store.allocateRef(visual);
    store.replace([[first, visual]]);
    expect(store.resolve(dom)).toBe(42);
    expect(store.resolveEntry(first)?.kind).toBe("visual-region");
    const second = store.allocateRef(visual);
    store.replace([[second, visual]]);
    expect(second).not.toBe(first);
    expect(store.resolveEntry(first)).toBeNull();
    expect(store.resolve(dom)).toBe(42);
  });
});
