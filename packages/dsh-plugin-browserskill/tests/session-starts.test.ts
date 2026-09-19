import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBrowserTools } from "../src/browser-tools";
import { ObservationService } from "../src/observation";
import { KeyedExecutor } from "../src/queue";
import type { BskRunOptions, BskRunResult } from "../src/runner";
import { SessionStarts } from "../src/session-starts";
import { SessionRegistry } from "../src/sessions";
import { DiskStartJournal, memoryStartJournal, type StartJournal } from "../src/start-journal";
import type { ToolDeps } from "../src/tools";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const ok = (body: unknown): BskRunResult => ({
  code: 0,
  stdout: JSON.stringify(body),
  stderr: "",
  aborted: false,
  timedOut: false,
});
const failed = (message: string): BskRunResult => ({
  code: 2,
  stdout: JSON.stringify({ code: "protocol_error", message }),
  stderr: "",
  aborted: false,
  timedOut: false,
});
const exec = (signal = new AbortController().signal) =>
  ({
    callId: "call",
    name: "browser_session",
    signal,
    agent: { id: "conversation" },
  }) as ToolRunContext;

function harness(
  run: (args: string[], options: BskRunOptions) => Promise<BskRunResult>,
  journal: StartJournal = memoryStartJournal(),
) {
  const calls: Array<{ args: string[]; options: BskRunOptions }> = [];
  const tools = new Map<string, ToolDefinition>();
  const ctx = {
    tools: {
      register: (tool: ToolDefinition) => {
        tools.set(tool.name, tool);
        return () => {};
      },
    },
    get: () => undefined,
  };
  const prepare = vi.fn(async () => ok({ state: "prepared" }));
  const runner = {
    run: async (args: string[], options: BskRunOptions = {}) => {
      calls.push({ args, options });
      if (args.includes("--prepare")) return prepare();
      return run(args, options);
    },
    killAll: vi.fn(),
    killFor: () => 0,
  };
  const registry = new SessionRegistry(5);
  const queue = new KeyedExecutor();
  const observation = new ObservationService({
    ctx: ctx as never,
    runner,
    registry,
    queue,
    options: { enabled: true, thumbnailIntervalMs: 1500, idleIntervalMs: 8000 },
  });
  const deps: ToolDeps = {
    ctx: ctx as never,
    runner,
    registry,
    queue,
    observation,
    config: {
      bskPath: "bsk",
      defaultTimeoutMs: 120000,
      maxSessions: 5,
      observationEnabled: true,
      thumbnailIntervalMs: 1500,
      idleIntervalMs: 8000,
      lazyTools: false,
    },
  };
  const starts = (deps.starts = new SessionStarts(deps, journal));
  registerBrowserTools(deps);
  const session = (args: Record<string, unknown>, context = exec()) =>
    tools.get("browser_session")!.execute(args, context);
  cleanups.push(async () => {
    await starts.dispose();
    observation.dispose();
  });
  return { starts, registry, journal, calls, session, runner, prepare, tools, observation, queue };
}

describe("recoverable plugin starts", () => {
  it("publishes a session only after both initialization and claim succeed", async () => {
    let finishNavigation!: (result: BskRunResult) => void;
    let finishClaim!: (result: BskRunResult) => void;
    const h = harness(async (args) => {
      if (args[1] === "start")
        return ok({ session_id: "starting", browser_instance_id: "browser" });
      if (args[0] === "navigate")
        return new Promise((resolve) => {
          finishNavigation = resolve;
        });
      if (args.includes("--claim"))
        return new Promise((resolve) => {
          finishClaim = resolve;
        });
      return ok({ state: "closed" });
    });
    h.registry.completeStart({ sessionId: "working", startedAtMs: 1 });
    const starting = h.session({
      action: "start",
      device: "iphone-14",
      url: "https://example.com",
    });
    await vi.waitFor(() => expect(finishNavigation).toBeTypeOf("function"));
    const assertUnavailable = async () => {
      expect(h.registry.current()).toBe("working");
      expect(h.registry.size()).toBe(2);
      expect(await h.session({ action: "list" })).toMatchObject({
        sessions: [
          { sessionId: "working", state: "active", current: true },
          { sessionId: "starting", state: "starting", current: false },
        ],
      });
      const before = h.calls.length;
      await expect(
        h.tools.get("browser_page")!.execute(
          {
            action: "navigate",
            session: "starting",
            url: "https://example.org",
          },
          exec(),
        ),
      ).rejects.toThrow(/not ready/);
      expect(h.calls).toHaveLength(before);
    };
    await assertUnavailable();
    finishNavigation(ok({ url: "https://example.com", reached: "load", tab_id: 1 }));
    await vi.waitFor(() => expect(finishClaim).toBeTypeOf("function"));
    await assertUnavailable();
    finishClaim(ok({ state: "active" }));
    await expect(starting).resolves.toMatchObject({ sessionId: "starting" });
    expect(h.registry.current()).toBe("starting");
    expect(h.registry.resolve("starting", "tool")).toBe("starting");
    expect(h.observation.getState()).toContainEqual(
      expect.objectContaining({
        sessionId: "starting",
        action: "idle",
      }),
    );
  });

  it("refuses a late claim after a stop fails during initialization", async () => {
    let finishClaim!: (result: BskRunResult) => void;
    const h = harness(async (args) => {
      if (args[1] === "start")
        return ok({ session_id: "starting", browser_instance_id: "browser" });
      if (args.includes("--claim"))
        return new Promise((resolve) => {
          finishClaim = resolve;
        });
      return failed("close unavailable");
    });
    const starting = h.session({ action: "start" });
    const rejected = expect(starting).rejects.toThrow(/cancelled|activation/);
    await vi.waitFor(() => expect(finishClaim).toBeTypeOf("function"));
    await expect(h.session({ action: "stop", session: "starting" })).rejects.toThrow(
      /close unavailable/,
    );
    finishClaim(ok({ state: "active" }));
    await rejected;
    expect(h.registry.current()).toBeUndefined();
    expect(h.registry.isOwned("starting")).toBe(true);
    expect(h.registry.stateFor("starting")).toBe("cleanup");
    expect(h.starts.pendingCleanup()).toBe(1);
  });

  it("rejects already queued ordinary work when its session enters cleanup", async () => {
    const h = harness(async (args) => {
      if (args[1] === "start") return ok({ session_id: "created", browser_instance_id: "browser" });
      if (args.includes("--claim")) return ok({ state: "active" });
      return failed("close unavailable");
    });
    await h.session({ action: "start" });
    let release!: () => void;
    const blocker = h.queue.run(
      "created",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const queued = h.tools.get("browser_page")!.execute(
      {
        action: "navigate",
        session: "created",
        url: "https://example.com",
      },
      exec(),
    );
    const rejected = expect(queued).rejects.toThrow(/awaiting cleanup/);
    h.starts.archive("conversation");
    expect(h.registry.current()).toBeUndefined();
    release();
    await blocker;
    await rejected;
    expect(h.calls.some(({ args }) => args[0] === "navigate")).toBe(false);
    expect(h.registry.isOwned("created")).toBe(true);
  });

  it("adopts recovered cleanup resources without making them usable", async () => {
    const journal = memoryStartJournal();
    journal.records.set("recovered", {
      requestId: "recovered",
      startedAtMs: 1,
      owners: [],
      cleanup: true,
    });
    const h = harness(
      async () =>
        ok({
          state: "cleanup_failed",
          session: { session_id: "broken", browser_instance_id: "browser" },
          cleanup_error: "close unavailable",
        }),
      journal,
    );
    h.registry.completeStart({ sessionId: "working", startedAtMs: 1 });
    await h.starts.reconcile();
    expect(h.registry.current()).toBe("working");
    expect(h.registry.stateFor("broken")).toBe("cleanup");
    expect(h.registry.resolveForStop("broken")).toBe("broken");
    expect(() => h.registry.resolve("broken", "tool")).toThrow(/awaiting cleanup/);
    expect(h.registry.size()).toBe(2);
    h.registry.remove("working");
    expect(h.registry.current()).toBeUndefined();
    expect(() => h.registry.resolve(undefined, "tool")).toThrow(/none is active/);
    expect(h.registry.resolveForStop(undefined)).toBe("broken");
  });

  it("keeps the working session current when another start and its cleanup fail", async () => {
    let count = 0;
    let canClose = false;
    const h = harness(async (args) => {
      if (args[1] === "start")
        return ok({
          session_id: count++ === 0 ? "working" : "broken",
          browser_instance_id: "browser",
        });
      if (args.includes("--claim")) return ok({ state: "active" });
      if (args.includes("--cancel"))
        return canClose ? ok({ state: "closed" }) : failed("close unavailable");
      if (args[0] === "navigate" && args.includes("broken")) return failed("navigation failed");
      return ok({ url: "https://example.com", reached: "load", tab_id: 1 });
    });
    await h.session({ action: "start" });
    await expect(h.session({ action: "start", url: "https://example.com" })).rejects.toThrow(
      /navigation failed/,
    );
    expect(h.registry.current()).toBe("working");
    expect(h.registry.ownedIds()).toEqual(["working", "broken"]);
    expect(h.registry.size()).toBe(2);
    expect(h.starts.pendingCleanup()).toBe(1);
    const page = h.tools.get("browser_page")!;
    await page.execute({ action: "navigate", url: "https://example.com" }, exec());
    expect(h.calls.at(-1)?.args).toContain("working");
    const before = h.calls.length;
    await expect(
      page.execute({ action: "navigate", url: "https://example.com", session: "broken" }, exec()),
    ).rejects.toThrow(/cleanup|not ready/);
    expect(h.calls).toHaveLength(before);
    canClose = true;
    await h.session({ action: "stop", session: "broken" });
    expect(h.registry.current()).toBe("working");
    expect(h.registry.ownedIds()).toEqual(["working"]);
  });
  it.each([
    "lost reply",
    "aborted success",
    "timed out success",
  ])("reaps only its own request after %s", async (mode) => {
    const backend = new Map<string, string>();
    backend.set("foreign-owner", "foreign-session");
    const h = harness(async (args, options) => {
      if (args[1] === "start") {
        const id = args[3];
        expect(h.journal.records.has(id)).toBe(true); // write-ahead ownership
        backend.set(id, "created");
        return {
          ...ok({ session_id: "created", browser_instance_id: "browser" }),
          stdout:
            mode === "lost reply"
              ? ""
              : ok({ session_id: "created", browser_instance_id: "browser" }).stdout,
          aborted: mode === "aborted success",
          timedOut: mode === "timed out success",
        };
      }
      expect(args).toEqual(["session", "request", expect.any(String), "--cancel"]);
      expect(options.signal).toBeUndefined();
      backend.delete(args[2]);
      return ok({ state: "closed" });
    });
    await expect(h.session({ action: "start" })).rejects.toThrow();
    expect([...backend.values()]).toEqual(["foreign-session"]);
    expect(h.registry.ownedIds()).toEqual([]);
    expect(h.journal.records.size).toBe(0);
  });

  it("retains failed navigation cleanup, exposes the session, and retries by request", async () => {
    let canClose = false;
    const h = harness(async (args) => {
      if (args[1] === "start") return ok({ session_id: "created", browser_instance_id: "browser" });
      if (args[0] === "navigate") return failed("navigation failed");
      return ok(
        canClose
          ? { state: "closed" }
          : {
              state: "cleanup_failed",
              session: { session_id: "created", browser_instance_id: "browser" },
              cleanup_error: "window close failed",
            },
      );
    });
    await expect(h.session({ action: "start", url: "https://example.com" })).rejects.toThrow(
      /navigation failed/,
    );
    expect(h.registry.ownedIds()).toEqual(["created"]);
    expect(h.starts.pendingCleanup()).toBe(1);
    expect(await h.session({ action: "list" })).toMatchObject({
      pendingCleanup: 1,
      sessions: [{ sessionId: "created", state: "cleanup", current: false }],
    });
    canClose = true;
    await h.session({ action: "list" });
    expect(h.registry.ownedIds()).toEqual([]);
    expect(h.journal.records.size).toBe(0);
    expect(h.calls.every(({ args }) => args[1] !== "stop")).toBe(true);
  });

  it.each([
    "archive",
    "unload",
  ])("cancels a pending start on %s and refuses its late success", async (mode) => {
    let resolveStart!: (result: BskRunResult) => void;
    const h = harness(async (args) => {
      if (args[1] === "start")
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      return ok({ state: "closed" });
    });
    const pending = h.session({ action: "start" });
    const rejected = expect(pending).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(resolveStart).toBeTypeOf("function"));
    if (mode === "archive") h.starts.archive("conversation");
    else await h.starts.dispose();
    await vi.waitFor(() => expect(h.journal.records.size).toBe(0));
    resolveStart(ok({ session_id: "late", browser_instance_id: "browser" }));
    await rejected;
    expect(h.registry.ownedIds()).toEqual([]);
    expect(h.calls.filter(({ args }) => args.includes("--cancel"))).toHaveLength(1);
  });

  it("does not start any process when the write-ahead record cannot be saved", async () => {
    const journal = memoryStartJournal();
    journal.save = () => {
      throw new Error("disk full");
    };
    const h = harness(async () => {
      throw new Error("must not spawn");
    }, journal);
    await expect(h.session({ action: "start" })).rejects.toThrow(/disk full/);
    expect(h.calls).toHaveLength(0);
    expect(h.registry.size()).toBe(0);
  });

  it("fails before creating a window when the CLI/daemon cannot prepare requests", async () => {
    const h = harness(async () => {
      throw new Error("must not create");
    });
    h.prepare.mockRejectedValueOnce(new Error("unsupported session request"));
    await expect(h.session({ action: "start" })).rejects.toThrow(/unsupported/);
    expect(h.calls).toHaveLength(1);
    expect(h.journal.records.size).toBe(0);
    expect(h.registry.size()).toBe(0);
  });

  it("stop without a current session retries a lost start's cleanup", async () => {
    let ready = false;
    const h = harness(async (args) =>
      args[1] === "start"
        ? { ...ok({}), aborted: true }
        : ready
          ? ok({ state: "closed" })
          : failed("temporarily unavailable"),
    );
    await expect(h.session({ action: "start" })).rejects.toThrow();
    expect(h.registry.current()).toBeUndefined();
    ready = true;
    await expect(h.session({ action: "stop" })).resolves.toMatchObject({
      stopped: "pending browser starts",
    });
    expect(h.journal.records.size).toBe(0);
  });

  it("keeps capacity reserved while a lost reply's cleanup is unavailable", async () => {
    const h = harness(async (args) =>
      args[1] === "start" ? { ...ok({}), aborted: true } : failed("daemon unavailable"),
    );
    for (let n = 0; n < 5; n++) await expect(h.session({ action: "start" })).rejects.toThrow();
    await expect(h.session({ action: "start" })).rejects.toThrow(/session limit/);
    expect(h.calls.filter(({ args }) => args[1] === "start")).toHaveLength(5);
    expect(h.journal.records.size).toBe(5);
  });

  it("never stops another request when a short session id has been reused", async () => {
    const h = harness(async (args) => {
      if (args[1] === "start") return ok({ session_id: "reused", browser_instance_id: "browser" });
      expect(args[2]).not.toBe("other-request");
      return ok({ state: "closed" });
    });
    h.registry.reserveStart();
    h.registry.completeStart({
      sessionId: "reused",
      browserInstanceId: "browser",
      requestId: "other-request",
      startedAtMs: 1,
    });
    await expect(h.session({ action: "start" })).rejects.toThrow(/conflicts/);
    expect(h.registry.requestFor("reused")).toBe("other-request");
    expect(h.registry.ownedIds()).toEqual(["reused"]);
    expect(h.journal.records.size).toBe(0);
  });

  it("counts recovered requests with unknown sessions against the start limit", async () => {
    const journal = memoryStartJournal();
    for (let n = 0; n < 5; n++) {
      journal.records.set(`recovered-${n}`, {
        requestId: `recovered-${n}`,
        owners: [],
        startedAtMs: 1,
        cleanup: true,
      });
    }
    const h = harness(async () => failed("cleanup unavailable"), journal);
    await expect(h.session({ action: "start" })).rejects.toThrow(/session limit/);
    expect(h.calls.every(({ args }) => args.includes("--cancel"))).toBe(true);
  });
});

describe("durable recovery ownership", () => {
  it("recovers released/crashed owners without adopting a live plugin's records", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bsk-start-journal-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const abandoned = new DiskStartJournal(directory);
    abandoned.recover();
    const live = new DiskStartJournal(directory);
    live.recover();
    const first = harness(async () => failed("host interrupted"), abandoned);
    const other = harness(async () => failed("host interrupted"), live);
    const ours = first.starts.begin(["ours"]);
    const theirs = other.starts.begin(["theirs"]);
    const owner = readdirSync(directory).find((name) =>
      readFileSync(join(directory, name, "requests.json"), "utf8").includes(ours.requestId),
    )!;
    expect(
      JSON.parse(readFileSync(join(directory, owner, "requests.json"), "utf8"))[0].requestId,
    ).toBe(ours.requestId);
    abandoned.release(); // process/plugin ceased to own its journal, without running cleanup
    const recovered = new DiskStartJournal(directory);
    recovered.recover();
    expect([...recovered.records.keys()]).toEqual([ours.requestId]);
    expect(recovered.records.get(ours.requestId)?.cleanup).toBe(true);
    expect(live.records.has(theirs.requestId)).toBe(true);
    const h = harness(async (args) => {
      expect(args).toEqual(["session", "request", ours.requestId, "--cancel"]);
      return ok({ state: "closed" });
    }, recovered);
    await h.starts.reconcile();
    expect(recovered.records.size).toBe(0);
    // The abandoned JS objects no longer execute in a real crashed process.
    first.journal.records.clear();
    other.journal.records.clear();
  });
});
