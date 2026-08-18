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

  it("resolve accepts an explicit owned session and makes it current", () => {
    const registry = new SessionRegistry(5);
    start(registry, "s1");
    start(registry, "s2");
    expect(registry.resolve("s1", "tool")).toBe("s1");
    expect(registry.current()).toBe("s1");
  });

  it("resolve rejects foreign ids and never adopts them", () => {
    const registry = new SessionRegistry(5);
    start(registry, "s1");
    expect(() => registry.resolve("foreign", "tool")).toThrow(/does not belong to this plugin/);
    expect(registry.isOwned("foreign")).toBe(false);
    expect(registry.ownedIds()).toEqual(["s1"]);
    // A rejected resolve must not move the current pointer.
    expect(registry.current()).toBe("s1");
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

  it("recency order survives remove of the current session", () => {
    const registry = new SessionRegistry(5);
    start(registry, "s1");
    start(registry, "s2");
    registry.resolve("s1", "tool");
    registry.remove("s1");
    expect(registry.current()).toBe("s2");
  });

  it("resolveForStop accepts owned sessions and refuses foreign ones", () => {
    const registry = new SessionRegistry(5);
    start(registry, "s1");
    expect(registry.resolveForStop(undefined)).toBe("s1");
    expect(registry.resolveForStop("s1")).toBe("s1");
    expect(() => registry.resolveForStop("foreign")).toThrow(/does not belong to this plugin/);
    expect(() => registry.resolveForStop("never-seen")).toThrow(/does not belong to this plugin/);
  });

  it("a refused stop does not move the current pointer", () => {
    const registry = new SessionRegistry(5);
    start(registry, "s1");
    expect(() => registry.resolveForStop("foreign")).toThrow();
    expect(registry.current()).toBe("s1");
  });

  it("ownedIds always equals every registered session (foreign ids never enter)", () => {
    const registry = new SessionRegistry(5);
    start(registry, "own1");
    start(registry, "own2");
    expect(registry.ownedIds().sort()).toEqual(["own1", "own2"]);
  });
});
