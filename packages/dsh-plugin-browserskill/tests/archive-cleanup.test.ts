// Archive-triggered cleanup: lineage resolution for browser-session
// ownership, the registry's owner index, and the domain/changed watcher
// that reaps a freshly archived conversation's bsk sessions.

import { describe, expect, it, vi } from "vitest";
import { armArchiveCleanup, ownerSessionIds } from "../src/archive-cleanup";
import { SessionRegistry } from "../src/sessions";

/** A ctx stub carrying a session store with the given lineage headers. */
function ctxWithSessions(headers: Record<string, { parentSession?: string }>) {
  return {
    get: (key: string) =>
      key === "sessions"
        ? {
            get: (id: string) => (headers[id] === undefined ? undefined : { header: headers[id] }),
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
    const lifecycle = { archive: vi.fn() };
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
      archive: lifecycle.archive,
      emit,
      arm: () => armArchiveCleanup(ctx as never, lifecycle),
    };
  }

  it("forwards fresh archive ownership to the lifecycle manager, until disarmed", () => {
    const h = harness();
    const disarm = h.arm();
    h.emit({
      domain: "workspace",
      table: "",
      value: { archivedSessionIds: ["root"] },
    });
    expect(h.archive).toHaveBeenCalledTimes(1);
    expect(h.archive).toHaveBeenCalledWith("root");
    // After the disposer runs the watcher is silent again.
    disarm();
    h.emit({
      domain: "workspace",
      table: "",
      value: { archivedSessionIds: ["root", "conv-b"] },
    });
    expect(h.archive).toHaveBeenCalledTimes(1);
  });

  it("ignores pre-archived ids, foreign domains, and malformed frames", () => {
    const h = harness({ archived: ["old-conv"] });
    h.arm();
    // Seeded from the registry: the pre-archived id must not retro-fire.
    h.emit({ domain: "workspace", table: "", value: { archivedSessionIds: ["old-conv"] } });
    h.emit({ domain: "settings", table: "", value: { archivedSessionIds: ["conv-a"] } });
    h.emit({ domain: "workspace", table: "rows", value: { archivedSessionIds: ["conv-a"] } });
    h.emit({ domain: "workspace", table: "", value: {} });
    expect(h.archive).not.toHaveBeenCalled();
    // A genuinely new archive still fires.
    h.emit({
      domain: "workspace",
      table: "",
      value: { archivedSessionIds: ["old-conv", "conv-a"] },
    });
    expect(h.archive).toHaveBeenCalledWith("conv-a");
  });

  it("handles the host updating its registry before broadcasting the first archive", () => {
    const options = { archived: [] as string[] };
    const h = harness(options);
    h.arm();
    options.archived = ["conv-a"];
    h.emit({ domain: "workspace", table: "", value: { archivedSessionIds: ["conv-a"] } });
    expect(h.archive).toHaveBeenCalledWith("conv-a");
  });

  it("treats a re-archived session as fresh again after unarchive", () => {
    const h = harness();
    h.arm();
    h.emit({ domain: "workspace", table: "", value: { archivedSessionIds: ["conv-a"] } });
    expect(h.archive).toHaveBeenCalledTimes(1);
    // Unarchive, then re-archive: the second archival cleans up again.
    h.emit({ domain: "workspace", table: "", value: { archivedSessionIds: [] } });
    h.emit({ domain: "workspace", table: "", value: { archivedSessionIds: ["conv-a"] } });
    expect(h.archive).toHaveBeenCalledTimes(2);
  });
});
