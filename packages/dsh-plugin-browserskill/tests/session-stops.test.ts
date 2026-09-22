import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { armArchiveCleanup } from "../src/archive-cleanup";
import { registerObservationRoutes } from "../src/observation-http";
import type { BskRunOptions, BskRunResult } from "../src/runner";
import { DiskStartJournal, memoryStartJournal } from "../src/start-journal";
import { cleanups, exec, failed, harness, ok } from "./session-lifecycle-harness";

function managed(
  close: (id: string, options: BskRunOptions) => Promise<BskRunResult> = async () =>
    ok({ state: "closed" }),
  journal = memoryStartJournal(),
  names = ["A", "B", "C", "D", "E", "F"],
) {
  let count = 0;
  const requests = new Map<string, string>();
  const targets: string[] = [];
  const h = harness(async (args, options) => {
    if (args[1] === "start") {
      const id = names[count++];
      requests.set(args[3], id);
      return ok({ session_id: id, browser_instance_id: "browser" });
    }
    if (args.includes("--claim")) return ok({ state: "active" });
    if (args.includes("--cancel")) {
      const id =
        requests.get(args[2]) ?? journal.records.get(args[2])?.session?.sessionId ?? "unknown";
      targets.push(id);
      return close(id, options);
    }
    return ok({ url: "https://example.com", reached: "load", tab_id: 1 });
  }, journal);
  return { ...h, targets, requests };
}

/** Real HTTP route and lifecycle manager; only the browser transport is faked. */
function overlay(h: ReturnType<typeof harness>) {
  const routes = new Map<
    string,
    (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  >();
  const webServer = {
    register: (route: {
      path: string;
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }) => {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };
  cleanups.push(
    registerObservationRoutes({ get: () => webServer } as never, h.observation, h.starts),
  );
  return (sessionId: string) =>
    new Promise<{ status: number; body: unknown }>((resolve) => {
      let status = 0;
      const req = {
        method: "POST",
        headers: { host: "127.0.0.1:3999", "content-type": "application/json" },
        on(event: string, callback: (data?: string) => void) {
          if (event === "data") callback(JSON.stringify({ sessionId }));
          if (event === "end") callback();
        },
      };
      const res = {
        writeHead(code: number) {
          status = code;
        },
        end(body: string) {
          resolve({ status, body: JSON.parse(body) });
        },
      };
      void routes.get("/bsk-observation/stop")!(
        req as IncomingMessage,
        res as unknown as ServerResponse,
      );
    });
}

describe("managed session stops", () => {
  it.each([
    "implicit",
    "explicit",
    "overlay",
  ])("preserves a cancelled default caller's retry when a concurrent %s stop succeeds", async (mode) => {
    let finish!: (result: BskRunResult) => void;
    const h = managed(async (id) =>
      id === "B"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : ok({ state: "closed" }),
    );
    await h.session({ action: "start" });
    await h.session({ action: "start" });
    const controller = new AbortController();
    const first = h.session({ action: "stop" }, exec(controller.signal));
    const interrupted = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const other =
      mode === "overlay"
        ? overlay(h)("B")
        : h.session({ action: "stop", ...(mode === "explicit" ? { session: "B" } : {}) });
    controller.abort();
    await interrupted;
    finish(ok({ state: "closed" }));
    await other;
    expect(h.registry.current()).toBe("A");
    expect(h.registry.isOwned("B")).toBe(false);
    await expect(h.session({ action: "stop" })).resolves.toMatchObject({
      stopped: "B",
      alreadyClosed: true,
    });
    expect(h.targets).toEqual(["B"]);
    expect(h.registry.isUsable("A")).toBe(true);
  });

  it("supports exact request targeting and rejects foreign or conflicting targets", async () => {
    const h = managed();
    await h.session({ action: "start" });
    const requestId = h.registry.requestFor("A")!;
    await expect(h.session({ action: "stop", requestId: "foreign" })).rejects.toThrow(
      /does not belong/,
    );
    await expect(h.session({ action: "stop", session: "A", requestId })).rejects.toThrow(
      /not both/,
    );
    expect(h.targets).toEqual([]);
    expect(await h.session({ action: "list" })).toMatchObject({ sessions: [{ requestId }] });
    await expect(h.session({ action: "stop", requestId })).resolves.toEqual({
      stopped: "A",
      requestId,
      alreadyClosed: false,
    });
  });

  it("retains anonymous stop receipts when a cancelled prepare replies late", async () => {
    const h = managed();
    let finishPrepare!: (result: BskRunResult) => void;
    h.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPrepare = resolve;
        }),
    );
    const start = h.session({ action: "start" });
    const cancelled = expect(start).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(finishPrepare).toBeTypeOf("function"));
    const requestId = [...h.journal.records.keys()][0];
    const controller = new AbortController();
    const stop = h.session({ action: "stop", requestId }, exec(controller.signal));
    const interrupted = expect(stop).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await interrupted;
    await h.starts.reconcile();
    finishPrepare(ok({ state: "prepared" }));
    await cancelled;
    expect(h.calls.some(({ args }) => args[1] === "start")).toBe(false);
    expect(h.journal.records.get(requestId)?.stop).toBe("closed");
    await h.session({ action: "start" });
    await expect(h.session({ action: "stop", requestId })).resolves.toEqual({
      stopped: "pending browser starts",
      requestId,
      alreadyClosed: true,
    });
    expect(h.registry.current()).toBe("A");
    expect(h.targets).toEqual(["unknown"]);
  });

  it("can acknowledge multiple anonymous completed stops by request ID", async () => {
    const journal = memoryStartJournal();
    for (const requestId of ["first", "second"])
      journal.records.set(requestId, {
        requestId,
        owners: [],
        startedAtMs: 1,
        cleanup: false,
        stop: "closed",
      });
    const h = managed(undefined, journal);
    await h.session({ action: "start" });
    await expect(h.session({ action: "stop" })).rejects.toThrow(/specify session or requestId/);
    await expect(h.session({ action: "stop", requestId: "first" })).resolves.toMatchObject({
      requestId: "first",
      alreadyClosed: true,
    });
    await expect(h.session({ action: "stop" })).resolves.toMatchObject({
      requestId: "second",
      alreadyClosed: true,
    });
    expect(h.registry.current()).toBe("A");
    expect(h.targets).toEqual([]);
  });

  it.each([
    "unknown",
    "cancelling",
    "cleanup_failed",
    "not_found",
  ])("does not release ownership for an unconfirmed %s result", async (state) => {
    let ready = false;
    const h = managed(async () =>
      ready
        ? ok({ state: "closed" })
        : state === "not_found"
          ? {
              ...failed("request not found"),
              stdout: JSON.stringify({ code: "not_found", message: "request not found" }),
            }
          : ok({ state }),
    );
    await h.session({ action: "start" });
    await expect(h.session({ action: "stop" })).rejects.toThrow();
    expect(h.registry.stateFor("A")).toBe("cleanup");
    expect(h.starts.pendingCleanup()).toBe(1);
    ready = true;
    await h.session({ action: "stop" });
    expect(h.registry.size()).toBe(0);
  });

  it.each([
    "cleanup_failed",
    "closed",
  ])("retains the original identity if a %s reply names a different session", async (state) => {
    let ready = false;
    const h = managed(async () =>
      ready
        ? ok({ state: "closed" })
        : ok({ state, session: { session_id: "B", browser_instance_id: "browser" } }),
    );
    await h.session({ action: "start" });
    await h.session({ action: "start" });
    const requestId = h.registry.requestFor("A")!;
    await expect(h.session({ action: "stop", session: "A" })).rejects.toThrow(
      /different session identity/,
    );
    expect(h.journal.records.get(requestId)?.session?.sessionId).toBe("A");
    expect(h.registry.stateFor("A")).toBe("cleanup");
    expect(h.registry.isUsable("B")).toBe(true);
    ready = true;
    await h.session({ action: "stop", requestId });
    expect(h.registry.ownedIds()).toEqual(["B"]);
  });

  it("does not accept an already cancelled stop or change the current session", async () => {
    const h = managed();
    await h.session({ action: "start" });
    const controller = new AbortController();
    controller.abort();
    const before = JSON.stringify([...h.journal.records.values()]);
    await expect(h.session({ action: "stop" }, exec(controller.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(JSON.stringify([...h.journal.records.values()])).toBe(before);
    expect(h.registry.current()).toBe("A");
    expect(h.registry.stateFor("A")).toBe("active");
    expect(h.targets).toEqual([]);
    expect(h.runner.killFor).not.toHaveBeenCalled();
  });

  it("rejects stop admission when its intent cannot be saved, keeping the session usable", async () => {
    const h = managed();
    await h.session({ action: "start" });
    const save = vi.spyOn(h.journal, "save").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(h.session({ action: "stop" })).rejects.toThrow(/disk full/);
    expect(h.registry.resolve(undefined, "tool")).toBe("A");
    expect([...h.journal.records.values()][0]).toMatchObject({ cleanup: false });
    expect([...h.journal.records.values()][0].stop).toBeUndefined();
    expect(h.targets).toEqual([]);
    expect(h.runner.killFor).not.toHaveBeenCalled();
    save.mockRestore();
    await expect(h.session({ action: "stop" })).resolves.toMatchObject({ stopped: "A" });
  });

  it("continues dispatched cleanup after a caller aborts and joins the same request on retry", async () => {
    let finish!: (result: BskRunResult) => void;
    const h = managed(async (_id, options) => {
      expect(options.signal).toBeUndefined();
      expect(options.tag).toMatch(/^cleanup:/);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await h.session({ action: "start" });
    const controller = new AbortController();
    const first = h.session({ action: "stop" }, exec(controller.signal));
    const aborted = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    controller.abort();
    await aborted;
    const second = h.session({ action: "stop" });
    expect(h.starts.pendingCleanup()).toBe(1);
    finish(ok({ state: "closed" }));
    await expect(second).resolves.toMatchObject({ stopped: "A" });
    expect(h.targets).toEqual(["A"]);
    expect(h.journal.records.size).toBe(0);
  });

  it.each([
    "lost reply",
    "timeout",
    "interrupted",
  ])("retains ownership after %s until terminal cleanup is confirmed", async (mode) => {
    let attempt = 0;
    const h = managed(async () => {
      if (attempt++ > 0) return ok({ state: "closed" });
      return {
        ...ok({}),
        stdout: mode === "lost reply" ? "" : "{}",
        timedOut: mode === "timeout",
        aborted: mode === "interrupted",
      };
    });
    await h.session({ action: "start" });
    await expect(h.session({ action: "stop" })).rejects.toThrow();
    expect(h.registry.stateFor("A")).toBe("cleanup");
    expect(h.registry.size()).toBe(1);
    expect(h.starts.pendingCleanup()).toBe(1);
    await h.starts.reconcile();
    expect(h.registry.size()).toBe(0);
    await expect(h.session({ action: "stop" })).resolves.toMatchObject({ stopped: "A" });
    expect(h.targets).toEqual(["A", "A"]);
  });

  it("retries failed stops on the timer without another tool call", async () => {
    vi.useFakeTimers();
    let ready = false;
    const h = managed(async () => (ready ? ok({ state: "closed" }) : failed("offline")));
    await h.session({ action: "start" });
    await expect(h.session({ action: "stop" })).rejects.toThrow(/offline/);
    ready = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.targets).toEqual(["A", "A"]);
    expect(h.registry.size()).toBe(0);
    expect(h.starts.pendingCleanup()).toBe(0);
    await expect(h.session({ action: "stop" })).resolves.toMatchObject({ stopped: "A" });
  });

  it("routes overlay failures into durable recovery and never stops a foreign session", async () => {
    let ready = false;
    const h = managed(async () => (ready ? ok({ state: "closed" }) : failed("offline")));
    await h.session({ action: "start" });
    const stop = overlay(h);
    expect(await stop("foreign")).toMatchObject({ status: 500 });
    expect(h.targets).toEqual([]);
    expect(await stop("A")).toMatchObject({ status: 500 });
    expect(h.starts.pendingCleanup()).toBe(1);
    expect([...h.journal.records.values()][0]).toMatchObject({ cleanup: true, stop: "pending" });
    ready = true;
    await h.session({ action: "list" });
    expect(await stop("A")).toEqual({ status: 200, body: { stopped: true } });
    expect(h.targets).toEqual(["A", "A"]);
    expect(h.journal.records.size).toBe(0);
  });

  it("shares one cleanup across tool, overlay, archive, and reconciliation", async () => {
    let finish!: (result: BskRunResult) => void;
    const h = managed(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await h.session({ action: "start" });
    const tool = h.session({ action: "stop" });
    const http = overlay(h)("A");
    let archive!: (change: unknown) => void;
    cleanups.push(
      armArchiveCleanup(
        {
          get: () => undefined,
          on: (_event: string, fn: typeof archive) => {
            archive = fn;
            return () => {};
          },
        } as never,
        h.starts,
      ),
    );
    archive({ domain: "workspace", table: "", value: { archivedSessionIds: ["conversation"] } });
    const reconcile = h.starts.reconcile();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    finish(ok({ state: "closed" }));
    await expect(tool).resolves.toMatchObject({ stopped: "A" });
    expect(await http).toMatchObject({ status: 200 });
    await reconcile;
    expect(h.targets).toEqual(["A"]);
    expect(h.runner.killFor.mock.calls.filter(([tag]) => tag === "A")).toEqual([["A"]]);
    expect(h.journal.records.size).toBe(0);
  });

  it("requires an explicit target when several stops are unacknowledged", async () => {
    let ready = false;
    const h = managed(async () => (ready ? ok({ state: "closed" }) : failed("offline")));
    for (let n = 0; n < 3; n++) await h.session({ action: "start" });
    await expect(h.session({ action: "stop", session: "B" })).rejects.toThrow();
    await expect(h.session({ action: "stop", session: "C" })).rejects.toThrow();
    expect(h.registry.current()).toBe("A");
    await expect(h.session({ action: "stop" })).rejects.toThrow(/specify session/);
    expect(h.targets).toEqual(["B", "C"]);
    ready = true;
    await h.session({ action: "stop", session: "B" });
    await expect(h.session({ action: "stop" })).resolves.toMatchObject({ stopped: "C" });
    expect(h.registry.ownedIds()).toEqual(["A"]);
  });

  it("does not cancel a new session that reuses a completed stop's short ID", async () => {
    let ready = false;
    const h = managed(
      async () => (ready ? ok({ state: "closed" }) : failed("offline")),
      memoryStartJournal(),
      ["A", "B", "B"],
    );
    await h.session({ action: "start" });
    await h.session({ action: "start" });
    const oldRequest = h.registry.requestFor("B");
    await expect(h.session({ action: "stop" })).rejects.toThrow();
    ready = true;
    await h.session({ action: "list" });
    await h.session({ action: "start" });
    expect(h.registry.requestFor("B")).not.toBe(oldRequest);
    const before = h.calls.length;
    await expect(h.session({ action: "stop" })).resolves.toMatchObject({ stopped: "B" });
    expect(h.calls).toHaveLength(before);
    expect(h.registry.isUsable("B")).toBe(true);
    expect(h.registry.size()).toBe(2);
  });

  it.each([
    "completion",
    "acknowledgement",
  ])("keeps the same receipt when %s persistence fails", async (phase) => {
    const h = managed();
    await h.session({ action: "start" });
    await h.session({ action: "start" });
    const requestId = h.registry.requestFor("B")!;
    let failOnce = true;
    vi.spyOn(h.journal, "save").mockImplementation(() => {
      const record = h.journal.records.get(requestId);
      if (failOnce && (phase === "completion" ? record?.stop === "closed" : !record)) {
        failOnce = false;
        throw new Error("receipt write failed");
      }
    });
    await expect(h.session({ action: "stop" })).rejects.toThrow(/receipt write failed/);
    expect(h.registry.current()).toBe("A");
    expect(h.registry.isOwned("B")).toBe(false);
    expect(h.journal.records.get(requestId)?.stop).toBe("closed");
    await expect(h.session({ action: "stop" })).resolves.toMatchObject({ stopped: "B" });
    expect(h.targets).toEqual(["B"]);
  });

  it.each([
    false,
    true,
  ])("recovers a stop receipt across restart (already closed=%s)", async (closed) => {
    const directory = mkdtempSync(join(tmpdir(), "bsk-stop-recovery-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const journal = new DiskStartJournal(directory);
    journal.recover();
    let ready = false;
    const first = managed(
      async () => (ready ? ok({ state: "closed" }) : failed("offline")),
      journal,
    );
    await first.session({ action: "start" });
    await expect(first.session({ action: "stop" })).rejects.toThrow();
    ready = true;
    if (closed) await first.starts.reconcile();
    const snapshot = readdirSync(directory).flatMap((name) =>
      JSON.parse(readFileSync(join(directory, name, "requests.json"), "utf8")),
    );
    expect(snapshot[0]).toMatchObject({ cleanup: !closed, stop: closed ? "closed" : "pending" });
    journal.release();
    journal.records.clear(); // the old process no longer runs; leave its durable ledger intact
    const recovered = new DiskStartJournal(directory);
    recovered.recover();
    const second = managed(undefined, recovered, ["new"]);
    await second.starts.reconcile();
    expect(second.targets).toEqual(closed ? [] : ["A"]);
    await second.session({ action: "start" });
    await expect(second.session({ action: "stop" })).resolves.toMatchObject({ stopped: "A" });
    expect(second.registry.current()).toBe("new");
    expect(second.registry.isUsable("new")).toBe(true);
  });

  it("does not count completed receipts as browser capacity", async () => {
    let ready = false;
    const h = managed(async () => (ready ? ok({ state: "closed" }) : failed("offline")));
    for (const id of ["A", "B", "C", "D", "E"]) {
      await h.session({ action: "start" });
      ready = false;
      await expect(h.session({ action: "stop", session: id })).rejects.toThrow();
      ready = true;
      await h.starts.reconcile();
    }
    expect(h.journal.records.size).toBe(5);
    expect(h.registry.size()).toBe(0);
    await expect(h.session({ action: "start" })).resolves.toMatchObject({ sessionId: "F" });
  });

  it("retries the same default stop after failure instead of stopping another active session", async () => {
    const ids = new Map<string, string>();
    const targets: string[] = [];
    let canClose = false;
    const h = harness(async (args) => {
      if (args[1] === "start") {
        const id = ids.size === 0 ? "A" : "B";
        ids.set(args[3], id);
        return ok({ session_id: id, browser_instance_id: "browser" });
      }
      if (args.includes("--claim")) return ok({ state: "active" });
      targets.push(ids.get(args[2])!);
      return canClose ? ok({ state: "closed" }) : failed("close unavailable");
    });
    await h.session({ action: "start" });
    await h.session({ action: "start" });
    await expect(h.session({ action: "stop" })).rejects.toThrow(/close unavailable/);
    expect(h.registry.current()).toBe("A");
    canClose = true;
    await expect(h.session({ action: "stop" })).resolves.toMatchObject({ stopped: "B" });
    expect(targets).toEqual(["B", "B"]);
    expect(h.registry.ownedIds()).toEqual(["A"]);
  });

  it("reconciles a failed active-session stop and retains its completion for default retry", async () => {
    let count = 0;
    let canClose = false;
    const h = harness(async (args) => {
      if (args[1] === "start")
        return ok({ session_id: count++ ? "B" : "A", browser_instance_id: "browser" });
      if (args.includes("--claim")) return ok({ state: "active" });
      return canClose ? ok({ state: "closed" }) : failed("close unavailable");
    });
    await h.session({ action: "start" });
    await h.session({ action: "start" });
    await expect(h.session({ action: "stop" })).rejects.toThrow();
    const record = [...h.journal.records.values()].find((r) => r.session?.sessionId === "B")!;
    expect(record.cleanup).toBe(true);
    expect(h.starts.pendingCleanup()).toBe(1);
    canClose = true;
    await h.session({ action: "list" });
    expect(h.registry.ownedIds()).toEqual(["A"]);
    expect(h.starts.pendingCleanup()).toBe(0);
    const before = h.calls.length;
    await expect(h.session({ action: "stop" })).resolves.toMatchObject({ stopped: "B" });
    expect(h.calls).toHaveLength(before);
    expect(h.registry.current()).toBe("A");
  });

  it("keeps an accepted stop recoverable when its caller aborts while queued", async () => {
    const h = harness(async (args, options) => {
      if (args[1] === "start") return ok({ session_id: "B", browser_instance_id: "browser" });
      if (args.includes("--claim")) return ok({ state: "active" });
      expect(options.signal).toBeUndefined();
      return ok({ state: "closed" });
    });
    await h.session({ action: "start" });
    let release!: () => void;
    const blocker = h.queue.run(
      "B",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const controller = new AbortController();
    const stop = h.session({ action: "stop" }, exec(controller.signal));
    const rejected = expect(stop).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    // Always drain the fixture queue, even when the regression assertion fails.
    release();
    await blocker;
    expect([...h.journal.records.values()][0].cleanup).toBe(true);
    await h.starts.reconcile();
    expect(h.calls.filter(({ args }) => args.includes("--cancel"))).toHaveLength(1);
    expect(h.registry.ownedIds()).toEqual([]);
    await expect(h.session({ action: "stop" })).resolves.toMatchObject({ stopped: "B" });
  });
});
