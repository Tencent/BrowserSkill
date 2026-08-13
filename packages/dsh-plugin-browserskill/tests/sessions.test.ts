import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/sessions";

describe("SessionRegistry", () => {
  it("tracks the current session across add and remove", () => {
    const registry = new SessionRegistry(5);
    expect(registry.current()).toBeUndefined();
    registry.add({ sessionId: "s1", startedAtMs: 1 });
    expect(registry.current()).toBe("s1");
    registry.add({ sessionId: "s2", startedAtMs: 2 });
    expect(registry.current()).toBe("s2");
    registry.remove("s2");
    expect(registry.current()).toBe("s1");
    registry.remove("s1");
    expect(registry.current()).toBeUndefined();
  });

  it("enforces the concurrency cap", () => {
    const registry = new SessionRegistry(2);
    registry.add({ sessionId: "s1", startedAtMs: 1 });
    registry.add({ sessionId: "s2", startedAtMs: 2 });
    expect(() => registry.add({ sessionId: "s3", startedAtMs: 3 })).toThrow(/session limit/);
    registry.remove("s1");
    registry.add({ sessionId: "s3", startedAtMs: 3 });
    expect(registry.size()).toBe(2);
  });

  it("resolve prefers the explicit session and adopts unknown ids", () => {
    const registry = new SessionRegistry(5);
    registry.add({ sessionId: "s1", startedAtMs: 1 });
    expect(registry.resolve("s9", "tool")).toBe("s9");
    expect(registry.current()).toBe("s9");
    expect(registry.list().map((s) => s.sessionId)).toContain("s9");
  });

  it("resolve falls back to the current session", () => {
    const registry = new SessionRegistry(5);
    registry.add({ sessionId: "s1", startedAtMs: 1 });
    expect(registry.resolve(undefined, "tool")).toBe("s1");
  });

  it("resolve throws actionable guidance when no session exists", () => {
    const registry = new SessionRegistry(5);
    expect(() => registry.resolve(undefined, "browser_click")).toThrow(/browser_session_start/);
  });

  it("touch refreshes recency so fallback picks the most recent survivor", () => {
    const registry = new SessionRegistry(5);
    registry.add({ sessionId: "s1", startedAtMs: 1 });
    registry.add({ sessionId: "s2", startedAtMs: 2 });
    registry.touch("s1");
    registry.remove("s1");
    expect(registry.current()).toBe("s2");
  });
});
