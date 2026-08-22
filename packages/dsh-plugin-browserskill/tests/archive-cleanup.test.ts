// Archive-triggered cleanup: lineage resolution for browser-session
// ownership, the registry's owner index, and the domain/changed watcher
// that reaps a freshly archived conversation's bsk sessions.

import { describe, expect, it, vi } from "vitest";
import { armArchiveCleanup, ownerSessionIds } from "../src/archive-cleanup";
import type { ObservationService } from "../src/observation";
import { SessionRegistry } from "../src/sessions";

/** A ctx stub carrying a session store with the given lineage headers. */
function ctxWithSessions(headers: Record<string, { parentSession?: string }>) {
  return {
    get: (key: string) =>
      key === "sessions"
        ? {
            get: (id: string) =>
              headers[id] === undefined ? undefined : { header: headers[id] },
          }
        : undefined,
  } as never;
}

describe("ownerSessionIds", () => {
  it("walks the seed lineage to the root; empty without an agent identity", () => {
    expect(ownerSessionIds(ctxWithSessions({}), undefined)).toEqual([]);
    const ctx = ctxWithSessions({
      child: { parentSession: "parent" },
      parent: { parentSession: "root" },
      root: {},
    });
    expect(ownerSessionIds(ctx, "child")).toEqual(["child", "parent", "root"]);
  });

  it("stops the walk at an unloaded ancestor", () => {
    const ctx = ctxWithSessions({ child: { parentSession: "gone" } });
    expect(ownerSessionIds(ctx, "child")).toEqual(["child", "gone"]);
  });

  it("never loops on a malformed parent cycle", () => {
    const ctx = ctxWithSessions({
      a: { parentSession: "b" },
      b: { parentSession: "a" },
    });
    expect(ownerSessionIds(ctx, "a")).toEqual(["a", "b"]);
  });
});

describe("SessionRegistry owner tracking", () => {
  function start(registry: SessionRegistry, sessionId: string): void {
    registry.reserveStart();
    registry.completeStart({ sessionId, startedAtMs: 1 });
  }

  it("indexes owners and forgets them on remove; ignores empty/unknown ownership", () => {
    const registry = new SessionRegistry(5);
    start(registry, "bsk1");
    start(registry, "bsk2");
    registry.trackOwner("bsk1", ["conv-a", "root"]);
    registry.trackOwner("bsk2", ["conv-b"]);
    expect(registry.ownedByDsh("root")).toEqual(["bsk1"]);
    expect(registry.ownedByDsh("conv-a")).toEqual(["bsk1"]);
    expect(registry.ownedByDsh("conv-b")).toEqual(["bsk2"]);
    expect(registry.ownedByDsh("nobody")).toEqual([]);
    registry.remove("bsk1");
    expect(registry.ownedByDsh("root")).toEqual([]);
    // Empty owner lists and unknown session ids record nothing.
    registry.trackOwner("bsk2", []);
    registry.trackOwner("ghost", ["conv-c"]);
    expect(registry.ownedByDsh("conv-c")).toEqual([]);
  });
});

describe("armArchiveCleanup", () => {
  function harness(opts: { archived?: string[] } = {}) {
    const registry = new SessionRegistry(5);
    const observation = { stopSession: vi.fn(async () => true) };
    const listeners = new Set<(change: unknown) => void>();
    const ctx = {
      get: (key: string) =>
        key === "workspaceRegistry" ? { archivedSessionIds: opts.archived ?? [] } : undefined,
      on: (event: string, listener: (change: unknown) => void) => {
        if (event === "domain/changed") listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const emit = (change: unknown) => {
      for (const listener of [...listeners]) listener(change);
    };
    return {
      registry,
      observation: observation as unknown as ObservationService,
      stopSession: observation.stopSession,
      emit,
      arm: () =>
        armArchiveCleanup(ctx as never, registry, observation as unknown as ObservationService),
    };
  }

  function startOwned(registry: SessionRegistry, bskId: string, owners: string[]): void {
    registry.reserveStart();
    registry.completeStart({ sessionId: bskId, startedAtMs: 1 });
    registry.trackOwner(bskId, owners);
  }

  it("stops every bsk session owned by a freshly archived conversation, until disarmed", () => {
    const h = harness();
    startOwned(h.registry, "bsk1", ["conv-a", "root"]);
    startOwned(h.registry, "bsk2", ["conv-b"]);
    const disarm = h.arm();
    h.emit({
      domain: "workspace",
      table: "",
      value: { archivedSessionIds: ["root"] },
    });
    expect(h.stopSession).toHaveBeenCalledTimes(1);
    expect(h.stopSession).toHaveBeenCalledWith("bsk1");
    // After the disposer runs the watcher is silent again.
    disarm();
    h.emit({
      domain: "workspace",
      table: "",
      value: { archivedSessionIds: ["root", "conv-b"] },
    });
    expect(h.stopSession).toHaveBeenCalledTimes(1);
  });

  it("ignores pre-archived ids, foreign domains, and malformed frames", () => {
    const h = harness({ archived: ["old-conv"] });
    startOwned(h.registry, "bsk1", ["old-conv"]);
    startOwned(h.registry, "bsk2", ["conv-a"]);
    h.arm();
    // Seeded from the registry: the pre-archived id must not retro-fire.
    h.emit({ domain: "workspace", table: "", value: { archivedSessionIds: ["old-conv"] } });
    h.emit({ domain: "settings", table: "", value: { archivedSessionIds: ["conv-a"] } });
    h.emit({ domain: "workspace", table: "rows", value: { archivedSessionIds: ["conv-a"] } });
    h.emit({ domain: "workspace", table: "", value: {} });
    expect(h.stopSession).not.toHaveBeenCalled();
    // A genuinely new archive still fires.
    h.emit({ domain: "workspace", table: "", value: { archivedSessionIds: ["old-conv", "conv-a"] } });
    expect(h.stopSession).toHaveBeenCalledWith("bsk2");
  });

  it("treats a re-archived session as fresh again after unarchive", () => {
    const h = harness();
    startOwned(h.registry, "bsk1", ["conv-a"]);
    h.arm();
    h.emit({ domain: "workspace", table: "", value: { archivedSessionIds: ["conv-a"] } });
    expect(h.stopSession).toHaveBeenCalledTimes(1);
    // Unarchive, then re-archive: the second archival cleans up again.
    h.emit({ domain: "workspace", table: "", value: { archivedSessionIds: [] } });
    h.emit({ domain: "workspace", table: "", value: { archivedSessionIds: ["conv-a"] } });
    expect(h.stopSession).toHaveBeenCalledTimes(2);
  });
});
