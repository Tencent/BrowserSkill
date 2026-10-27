// Archive-triggered cleanup: lineage resolution for browser-session
// ownership, the registry's owner index, and the domain/changed watcher
// that reaps a freshly archived conversation's bsk sessions.

import { describe, expect, it, vi } from "vitest";
import { armArchiveCleanup, ownerSessionIds } from "../src/archive-cleanup";
import type { BskRunResult } from "../src/runner";
import { SessionRegistry } from "../src/sessions";
import { cleanups, exec, harness as lifecycleHarness, ok } from "./session-lifecycle-harness";

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

describe("browser starts with archived lineage", () => {
  function harness(
    archivedSessionIds: string[],
    start = async () => ok({ session_id: "created", browser_instance_id: "browser" }),
  ) {
    const h = lifecycleHarness(async (args) => {
      if (args[1] === "start") return start();
      if (args.includes("--claim")) return ok({ state: "active" });
      if (args.includes("--cancel")) return ok({ state: "closed" });
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const workspace = { archivedSessionIds };
    const sessions = new Map<string, { header: { parentSession?: string } }>([
      ["parent", { header: { parentSession: "root" } }],
      ["root", { header: {} }],
    ]);
    h.ctx.get.mockImplementation((key) => {
      if (key === "workspaceRegistry") return workspace;
      if (key === "sessions") return sessions;
    });
    let onChange!: (change: unknown) => void;
    const ctx = {
      ...h.ctx,
      on: (_event: string, listener: typeof onChange) => {
        onChange = listener;
        return () => {};
      },
    };
    cleanups.push(armArchiveCleanup(ctx as never, h.starts));
    // The fork is created after the watcher has observed the archived ancestors.
    sessions.set("conversation", { header: { parentSession: "parent" } });
    const archive = (ids: string[]) => {
      workspace.archivedSessionIds = ids;
      onChange({ domain: "workspace", table: "", value: workspace });
    };
    return { ...h, archive };
  }

  it.each([
    "parent",
    "root",
  ])("allows a new fork of an archived %s and retains its cleanup lineage", async (ancestor) => {
    const h = harness([ancestor]);
    await expect(h.session({ action: "start" })).resolves.toMatchObject({ sessionId: "created" });
    expect(h.registry.dshOwnersOf("created")).toEqual(["conversation", "parent", "root"]);
    h.archive([ancestor]);
    expect(h.registry.current()).toBe("created");
    expect(h.calls.some(({ args }) => args.includes("--cancel"))).toBe(false);

    // Unarchive and re-archive: only the fresh event should reap the browser.
    h.archive([]);
    h.archive([ancestor]);
    await h.starts.reconcile();
    expect(h.registry.ownedIds()).toEqual([]);
    expect(h.calls.filter(({ args }) => args.includes("--cancel"))).toHaveLength(1);
  });

  it("refuses an archived caller before reserving capacity or invoking bsk", async () => {
    const h = harness(["conversation"]);
    await expect(h.session({ action: "start" })).rejects.toThrow(
      "browser conversation is archived",
    );
    expect(h.calls).toHaveLength(0);
    expect(h.journal.records.size).toBe(0);
    expect(h.registry.size()).toBe(0);

    h.archive([]);
    await expect(h.session({ action: "start" })).resolves.toMatchObject({ sessionId: "created" });
  });

  it("allows starts without a caller identity when conversations are archived", async () => {
    const h = harness(["conversation", "parent", "root"]);
    await expect(
      h.session({ action: "start" }, { ...exec(), agent: undefined }),
    ).resolves.toMatchObject({ sessionId: "created" });
    expect(h.registry.dshOwnersOf("created")).toEqual([]);
  });

  it.each([
    "parent",
    "root",
  ])("cancels an in-flight start when its %s is newly archived and allows a later start", async (ancestor) => {
    let resolveStart!: (reply: BskRunResult) => void;
    const start = vi.fn(async () => ok({ session_id: "later", browser_instance_id: "browser" }));
    start.mockImplementationOnce(
      () =>
        new Promise<BskRunResult>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const h = harness([], start);
    const pending = h.session({ action: "start" });
    const rejected = expect(pending).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(resolveStart).toBeTypeOf("function"));
    h.archive([ancestor]);
    await h.starts.reconcile();
    resolveStart(ok({ session_id: "late", browser_instance_id: "browser" }));
    await rejected;
    expect(h.registry.ownedIds()).toEqual([]);
    expect(h.journal.records.size).toBe(0);
    expect(h.calls.filter(({ args }) => args.includes("--cancel"))).toHaveLength(1);
    expect(h.calls.some(({ args }) => args.includes("--claim"))).toBe(false);

    await expect(h.session({ action: "start" })).resolves.toMatchObject({ sessionId: "later" });
  });
});
