import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/sessions";

/** Drive one full successful start through the reservation protocol. */
function start(registry: SessionRegistry, sessionId: string): void {
  registry.reserveStart();
  registry.completeStart({ sessionId, startedAtMs: Date.now() });
}

describe("SessionRegistry", () => {
  it("tracks the current session across start and remove", () => {
    const registry = new SessionRegistry(5);
    expect(registry.current()).toBeUndefined();
    start(registry, "s1");
    expect(registry.current()).toBe("s1");
    start(registry, "s2");
    expect(registry.current()).toBe("s2");
    registry.remove("s2");
    expect(registry.current()).toBe("s1");
    registry.remove("s1");
    expect(registry.current()).toBeUndefined();
  });

  it("enforces the concurrency cap including in-flight starts", () => {
    const registry = new SessionRegistry(2);
    start(registry, "s1");
    start(registry, "s2");
    expect(() => registry.reserveStart()).toThrow(/session limit/);
    registry.remove("s1");
    registry.reserveStart();
    registry.completeStart({ sessionId: "s3", startedAtMs: Date.now() });
    expect(registry.size()).toBe(2);
  });

  it("counts reserved (not yet spawned) starts against the cap — the race case", () => {
    const registry = new SessionRegistry(2);
    registry.reserveStart();
    registry.reserveStart();
    // Both slots are in flight; a third concurrent start must reject even
    // though no session has been registered yet.
    expect(() => registry.reserveStart()).toThrow(/session limit/);
    registry.abandonStart();
    registry.reserveStart();
    registry.completeStart({ sessionId: "s1", startedAtMs: Date.now() });
    expect(registry.ownedIds()).toEqual(["s1"]);
  });

  it("resolve prefers the explicit session and adopts it as a reference", () => {
    const registry = new SessionRegistry(5);
    start(registry, "s1");
    expect(registry.resolve("foreign", "tool")).toBe("foreign");
    expect(registry.current()).toBe("foreign");
    expect(registry.isOwned("foreign")).toBe(false);
    expect(registry.ownedIds()).toEqual(["s1"]);
  });

  it("resolve falls back to the current session", () => {
    const registry = new SessionRegistry(5);
    start(registry, "s1");
    expect(registry.resolve(undefined, "tool")).toBe("s1");
  });

  it("resolve throws actionable guidance when no session exists", () => {
    const registry = new SessionRegistry(5);
    expect(() => registry.resolve(undefined, "browser_click")).toThrow(/browser_session_start/);
  });

  it("touch refreshes recency so fallback picks the most recent survivor", () => {
    const registry = new SessionRegistry(5);
    start(registry, "s1");
    start(registry, "s2");
    registry.touch("s1");
    registry.remove("s1");
    expect(registry.current()).toBe("s2");
  });

  it("resolveForStop accepts owned sessions and refuses foreign ones", () => {
    const registry = new SessionRegistry(5);
    start(registry, "s1");
    expect(registry.resolveForStop(undefined)).toBe("s1");
    expect(registry.resolveForStop("s1")).toBe("s1");
    registry.resolve("foreign", "browser_snapshot");
    expect(() => registry.resolveForStop("foreign")).toThrow(/not created by this plugin/);
    expect(() => registry.resolveForStop("never-seen")).toThrow(/not created by this plugin/);
  });

  it("a refused stop does not move the current pointer", () => {
    const registry = new SessionRegistry(5);
    start(registry, "s1");
    expect(() => registry.resolveForStop("foreign")).toThrow();
    expect(registry.current()).toBe("s1");
  });

  it("ownedIds excludes referenced sessions even after heavy interleaving", () => {
    const registry = new SessionRegistry(5);
    start(registry, "own1");
    registry.resolve("ext1", "tool");
    start(registry, "own2");
    registry.resolve("ext2", "tool");
    expect(registry.ownedIds().sort()).toEqual(["own1", "own2"]);
  });
});
