import { describe, expect, it } from "vitest";
import { RefStore } from "../ref-store";

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
      ["e10", { backendNodeId: 10, tabId: 1 }],
      ["@e11", { backendNodeId: 11, tabId: 1 }],
    ]);
    expect(s.resolve("@e1")).toBeNull();
    expect(s.resolve("@e10")).toBe(10);
    expect(s.resolve("@e10", { tabId: 1 })).toBe(10);
    expect(s.resolve("@e10", { tabId: 2 })).toBeNull();
    expect(s.resolve("@e11")).toBe(11);
    expect(s.size()).toBe(2);
  });
});
