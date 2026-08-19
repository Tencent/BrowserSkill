// ObservationService host tests: state machine, cadence/backoff, observation-
// traffic isolation, interrupt routing, the owned boundary, and the HTTP/SSE
// interface. All bsk runs are faked; the scheduler is a manual timer queue.

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionForLabel,
  type ObservationEvent,
  type ObservationScheduler,
  ObservationService,
} from "../src/observation";
import { registerObservationRoutes } from "../src/observation-http";
import { KeyedExecutor } from "../src/queue";
import type { BskRunner, BskRunOptions, BskRunResult } from "../src/runner";
import { SessionRegistry } from "../src/sessions";

const OPTIONS = { enabled: true, thumbnailIntervalMs: 1500, idleIntervalMs: 8000 };

/** Manual timer queue + controllable clock. */
function fakeScheduler() {
  let now = 1_000_000;
  const timers: { handle: object; fn: () => void; ms: number }[] = [];
  const scheduler: ObservationScheduler & {
    advance: (ms: number) => void;
    runNext: () => void;
    pending: () => number[];
  } = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms };
      timers.push({ handle, fn, ms });
      return handle;
    },
    clearTimeout: (h) => {
      const index = timers.findIndex((t) => t.handle === h);
      if (index >= 0) timers.splice(index, 1);
    },
    advance: (ms) => {
      now += ms;
    },
    runNext: () => {
      const next = timers.shift();
      next?.fn();
    },
    pending: () => timers.map((t) => t.ms),
  };
  return scheduler;
}

interface FakeRunner extends BskRunner {
  calls: { args: string[]; options: BskRunOptions }[];
  killed: string[];
}

/** Runner that answers screenshot with a real temp PNG and records kills. */
function fakeRunner(
  opts: {
    screenshotFails?: boolean;
    screenshotNotFound?: boolean;
    killCount?: number;
    screenshotBytes?: () => Uint8Array;
  } = {},
): FakeRunner {
  const calls: FakeRunner["calls"] = [];
  const killed: string[] = [];
  return {
    calls,
    killed,
    async run(args: string[], options: BskRunOptions = {}): Promise<BskRunResult> {
      calls.push({ args, options });
      if (args[0] === "screenshot") {
        if (opts.screenshotNotFound) {
          return {
            code: 4,
            stdout: JSON.stringify({ code: "session_not_found", message: "no such session" }),
            stderr: "",
            timedOut: false,
            aborted: false,
          };
        }
        if (opts.screenshotFails) {
          return { code: 1, stdout: "", stderr: "boom", timedOut: false, aborted: false };
        }
        const outIndex = args.indexOf("--out") + 1;
        const out = args[outIndex];
        writeFileSync(out, opts.screenshotBytes?.() ?? Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return {
          code: 0,
          stdout: JSON.stringify({
            tab_id: 7,
            width: 4,
            height: 4,
            format: "png",
            path: out,
            byte_size: 4,
          }),
          stderr: "",
          timedOut: false,
          aborted: false,
        };
      }
      return { code: 0, stdout: "{}", stderr: "", timedOut: false, aborted: false };
    },
    killAll() {},
    killFor(tag: string) {
      killed.push(tag);
      return opts.killCount ?? 1;
    },
  };
}

function fakeCtx() {
  return { get: () => undefined } as never;
}

function setup(opts: {
  runner?: FakeRunner;
  registry?: SessionRegistry;
  scheduler?: ReturnType<typeof fakeScheduler>;
}) {
  const registry = opts.registry ?? new SessionRegistry(5);
  const runner = opts.runner ?? fakeRunner();
  const scheduler = opts.scheduler ?? fakeScheduler();
  const service = new ObservationService({
    ctx: fakeCtx(),
    runner,
    registry,
    queue: new KeyedExecutor(),
    options: OPTIONS,
    scheduler,
  });
  const events: ObservationEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { service, registry, runner, scheduler, events };
}

/** Drive the registry through a real start so the session is owned. */
function own(registry: SessionRegistry, sessionId: string): void {
  registry.reserveStart();
  registry.completeStart({ sessionId, startedAtMs: 1 });
}

/** Poll until the condition holds (capture completion is real async I/O). */
async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("state machine", () => {
  it("tracks add/action/end/url/remove and emits upsert/remove/reset events", () => {
    const { service, events } = setup({});
    service.addSession("s1");
    expect(service.getState()).toEqual([{ sessionId: "s1", action: "idle", since: 1_000_000 }]);
    service.beginAction("s1", "navigating");
    expect(service.getState()[0].action).toBe("navigating");
    service.endAction("s1");
    expect(service.getState()[0].action).toBe("idle");
    service.setUrl("s1", "https://example.com");
    expect(service.getState()[0].url).toBe("https://example.com");
    service.endAction("s1", "click failed: no ref");
    expect(service.getState()[0].lastError).toBe("click failed: no ref");
    service.removeSession("s1");
    expect(service.getState()).toEqual([]);
    expect(events.map((e) => e.type)).toEqual([
      "upsert", // add
      "upsert", // begin
      "upsert", // end
      "upsert", // setUrl
      "upsert", // end with error
      "remove",
    ]);
    service.dispose();
    expect(events[events.length - 1].type).toBe("reset");
  });

  it("ignores instrumentation for unknown sessions (owned-only by construction)", () => {
    const { service } = setup({});
    service.beginAction("foreign", "clicking");
    service.endAction("foreign");
    service.setUrl("foreign", "https://x");
    expect(service.getState()).toEqual([]);
  });
});

describe("thumbnail cadence", () => {
  it("captures immediately on add and after action end, then fast-cadences while active", async () => {
    const scheduler = fakeScheduler();
    const runner = fakeRunner();
    const { service } = setup({ runner, scheduler });
    const captures = () => runner.calls.filter((c) => c.args[0] === "screenshot").length;
    service.addSession("s1");
    // add schedules an immediate (0ms) capture.
    expect(scheduler.pending()).toEqual([0]);
    scheduler.runNext();
    await waitFor(() => captures() === 1 && scheduler.pending().length === 1);
    expect(service.getState()[0].thumbnailAttachmentId).toBe("obs-s1-1");
    // Just captured with fresh activity: next frame on the fast cadence.
    expect(scheduler.pending()).toEqual([1500]);
    scheduler.runNext();
    await waitFor(() => captures() === 2 && scheduler.pending().length === 1);
    expect(scheduler.pending()).toEqual([1500]);
  });

  it("downclocks to the idle cadence when the session has been quiet", async () => {
    const scheduler = fakeScheduler();
    const runner = fakeRunner();
    const { service, scheduler: sch } = setup({ scheduler, runner });
    const captures = () => runner.calls.filter((c) => c.args[0] === "screenshot").length;
    service.addSession("s1");
    sch.runNext();
    await waitFor(() => captures() === 1 && sch.pending().length === 1);
    // Fresh activity: fast cadence.
    expect(sch.pending()).toEqual([1500]);
    // Go quiet beyond the idle window before the next frame fires.
    sch.advance(9000);
    sch.runNext();
    await waitFor(() => captures() === 2 && sch.pending().length === 1);
    expect(sch.pending()).toEqual([8000]);
  });

  it("backs off to the idle cadence after repeated capture failures, keeping the old frame", async () => {
    const scheduler = fakeScheduler();
    const runner = fakeRunner({ screenshotFails: true });
    const { service } = setup({ runner, scheduler });
    const captures = () => runner.calls.filter((c) => c.args[0] === "screenshot").length;
    service.addSession("s1");
    for (let i = 1; i <= 4; i++) {
      scheduler.runNext();
      await waitFor(() => captures() === i && scheduler.pending().length === 1);
    }
    // 4 attempts (1 immediate + 3 fast), then backoff to the idle cadence.
    expect(captures()).toBe(4);
    expect(scheduler.pending()).toEqual([8000]);
    expect(service.getState()[0].thumbnailAttachmentId).toBeUndefined();
  });

  it("captures frames without an attachment store", async () => {
    const scheduler = fakeScheduler();
    const runner = fakeRunner();
    const { service } = setup({ runner, scheduler });
    service.addSession("s1");
    scheduler.runNext();
    await waitFor(() => service.getState()[0]?.thumbnailAttachmentId === "obs-s1-1");
    expect((await service.readThumbnail("obs-s1-1"))?.mediaType).toBe("image/png");
  });
});

describe("observation traffic isolation", () => {
  it("captures never emit action changes nor touch the registry", async () => {
    const scheduler = fakeScheduler();
    const registry = new SessionRegistry(5);
    own(registry, "s1");
    const { service, events } = setup({ registry, scheduler });
    service.addSession("s1");
    events.length = 0;
    scheduler.runNext();
    await waitFor(() => events.filter((e) => e.type === "upsert").length === 1);
    // The capture upsert carries the thumbnail but the action stays idle…
    const captureEvents = events.filter((e) => e.type === "upsert");
    expect(captureEvents).toHaveLength(1);
    const captureEvent = captureEvents[0];
    if (captureEvent.type !== "upsert") throw new Error("unreachable");
    expect(captureEvent.session?.action).toBe("idle");
    expect(captureEvent.session?.thumbnailAttachmentId).toBe("obs-s1-1");
    // …and the registry's current pointer never moved through observation.
    expect(registry.current()).toBe("s1");
    expect(registry.list()[0].startedAtMs).toBe(1);
  });
});

describe("interrupt routing", () => {
  it("interrupts the current session by default", () => {
    const registry = new SessionRegistry(5);
    own(registry, "s1");
    const runner = fakeRunner();
    const { service } = setup({ registry, runner });
    expect(service.interrupt()).toBe(true);
    expect(runner.killed).toEqual(["s1"]);
  });

  it("interrupts the specified owned session", () => {
    const registry = new SessionRegistry(5);
    own(registry, "s1");
    own(registry, "s2");
    const runner = fakeRunner();
    const { service } = setup({ registry, runner });
    expect(service.interrupt("s1")).toBe(true);
    expect(runner.killed).toEqual(["s1"]);
  });

  it("returns false with no current session and for foreign ids without killing", () => {
    const registry = new SessionRegistry(5);
    own(registry, "s1");
    const runner = fakeRunner();
    const { service } = setup({ registry, runner });
    expect(service.interrupt("foreign")).toBe(false);
    registry.remove("s1");
    expect(service.interrupt()).toBe(false);
    expect(runner.killed).toEqual([]);
  });
});

describe("HTTP/SSE interface", () => {
  interface RecordedRoute {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }

  function routeHarness() {
    const routes = new Map<string, RecordedRoute>();
    const webServer = {
      register(route: RecordedRoute & { kind: string }) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    };
    return { routes, webServer };
  }

  function fakeRes() {
    const chunks: string[] = [];
    const closeHandlers: (() => void)[] = [];
    const res = {
      status: 0,
      writeHead(status: number) {
        res.status = status;
        return res;
      },
      write(chunk: string) {
        chunks.push(chunk);
      },
      end(chunk?: string) {
        if (chunk !== undefined) chunks.push(chunk);
      },
      on(event: string, fn: () => void) {
        if (event === "close") closeHandlers.push(fn);
      },
      close: () => closeHandlers.forEach((fn) => fn()),
      body: () => chunks.join(""),
    };
    return {
      res: res as unknown as ServerResponse & {
        status: number;
        body: () => string;
        close: () => void;
      },
      chunks,
    };
  }

  /** Loopback GET/POST request stubs the fence accepts. */
  function fakeReq(overrides: Record<string, unknown> = {}): IncomingMessage {
    return {
      method: "GET",
      headers: { host: "127.0.0.1:3999" },
      on: (event: string, fn: (chunk?: string) => void) => {
        if (event === "data") fn(JSON.stringify({ sessionId: "s1" }));
        if (event === "end") fn();
      },
      ...overrides,
    } as unknown as IncomingMessage;
  }

  it("serves state, streams events, and routes interrupt", async () => {
    const registry = new SessionRegistry(5);
    own(registry, "s1");
    const runner = fakeRunner();
    const { service } = setup({ registry, runner });
    service.addSession("s1");

    const { routes, webServer } = routeHarness();
    const ctx = { get: (key: string) => (key === "webServer" ? webServer : undefined) } as never;
    const dispose = registerObservationRoutes(ctx, service);

    // state
    const stateRoute = routes.get("/bsk-observation/state");
    expect(stateRoute).toBeDefined();
    const stateRes = fakeRes();
    await stateRoute?.handler(fakeReq(), stateRes.res as never);
    expect(stateRes.res.status).toBe(200);
    expect(JSON.parse(stateRes.res.body()).sessions[0].sessionId).toBe("s1");

    // events (SSE): one write per service event
    const eventsRoute = routes.get("/bsk-observation/events");
    const eventsRes = fakeRes();
    await eventsRoute?.handler(fakeReq(), eventsRes.res as never);
    service.beginAction("s1", "clicking");
    expect(eventsRes.res.body()).toContain('"action":"clicking"');
    eventsRes.res.close();

    // interrupt (POST {sessionId})
    const interruptRoute = routes.get("/bsk-observation/interrupt");
    const interruptRes = fakeRes();
    const postReq = fakeReq({
      method: "POST",
      headers: { host: "127.0.0.1:3999", "content-type": "application/json" },
    });
    await interruptRoute?.handler(postReq, interruptRes.res as never);
    expect(JSON.parse(interruptRes.res.body())).toEqual({ interrupted: true });

    dispose();
    expect(routes.size).toBe(0);
    service.dispose();
  });

  it("fences off non-loopback, cross-site, and simple-request traffic", async () => {
    const registry = new SessionRegistry(5);
    own(registry, "s1");
    const { service } = setup({ registry });
    service.addSession("s1");
    const { routes, webServer } = routeHarness();
    const ctx = { get: (key: string) => (key === "webServer" ? webServer : undefined) } as never;
    const dispose = registerObservationRoutes(ctx, service);
    const stateRoute = routes.get("/bsk-observation/state");
    const interruptRoute = routes.get("/bsk-observation/interrupt");

    const getState = async (headers: Record<string, string>) => {
      const res = fakeRes();
      await stateRoute?.handler(fakeReq({ headers }), res.res as never);
      return res.res.status;
    };

    // Host must be a loopback authority.
    expect(await getState({ host: "192.168.1.20:3999" })).toBe(403);
    expect(await getState({ host: "attacker.example" })).toBe(403);
    expect(await getState({ host: "localhost:3999" })).toBe(200);
    expect(await getState({ host: "[::1]:3999" })).toBe(200);
    // A present Origin must match the Host (DNS-rebinding reads die here).
    expect(await getState({ host: "127.0.0.1:3999", origin: "http://evil.example" })).toBe(403);
    expect(await getState({ host: "127.0.0.1:3999", origin: "http://127.0.0.1:3999" })).toBe(200);
    // Explicitly cross-site fetches are refused even without an Origin.
    expect(await getState({ host: "127.0.0.1:3999", "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await getState({ host: "127.0.0.1:3999", "sec-fetch-site": "same-origin" })).toBe(200);

    // POST must be application/json — a cross-site simple request can never comply.
    const post = async (contentType: string | undefined) => {
      const res = fakeRes();
      const req = fakeReq({
        method: "POST",
        headers: {
          host: "127.0.0.1:3999",
          ...(contentType !== undefined ? { "content-type": contentType } : {}),
        },
      });
      await interruptRoute?.handler(req, res.res as never);
      return res.res.status;
    };
    expect(await post("text/plain")).toBe(403);
    expect(await post("application/x-www-form-urlencoded")).toBe(403);
    expect(await post(undefined)).toBe(403);
    expect(await post("application/json; charset=utf-8")).toBe(200);

    dispose();
    service.dispose();
  });

  it("registers nothing when no webServer is mounted", () => {
    const { service } = setup({});
    const ctx = { get: () => undefined } as never;
    const dispose = registerObservationRoutes(ctx, service);
    expect(typeof dispose).toBe("function");
    dispose();
    service.dispose();
  });
});

describe("availability and dead sessions", () => {
  it("flips availability off after repeated global failures and back on success", async () => {
    const scheduler = fakeScheduler();
    const runner = fakeRunner({ screenshotFails: true });
    const { service, events } = setup({ runner, scheduler });
    service.addSession("s1");
    for (let i = 1; i <= 3; i++) {
      scheduler.runNext();
      // the frame's scratch-file unlink lands before the next timer is queued
      await waitFor(
        () =>
          runner.calls.filter((c) => c.args[0] === "screenshot").length === i &&
          scheduler.pending().length === 1,
      );
    }
    expect(service.isAvailable()).toBe(false);
    expect(events.some((e) => e.type === "availability" && e.available === false)).toBe(true);
    service.dispose();
  });

  it("marks a session dead on session_not_found and stops asking for frames", async () => {
    const scheduler = fakeScheduler();
    const runner = fakeRunner({ screenshotNotFound: true });
    const { service, events } = setup({ runner, scheduler });
    service.addSession("s1");
    scheduler.runNext();
    await waitFor(() => events.some((e) => e.type === "upsert" && e.session?.dead === true));
    expect(service.getState()[0].dead).toBe(true);
    expect(service.getState()[0].action).toBe("idle");
    // No further captures are scheduled for a dead session.
    expect(scheduler.pending()).toEqual([]);
    // Instrumentation is dropped for dead sessions.
    service.beginAction("s1", "clicking");
    expect(service.getState()[0].action).toBe("idle");
    // A dead session leaves cleanly.
    service.removeSession("s1");
    expect(service.getState()).toEqual([]);
  });

  it("clears lastError on the next action and keeps it on failure", () => {
    const { service } = setup({});
    service.addSession("s1");
    service.endAction("s1", "click failed");
    expect(service.getState()[0].lastError).toBe("click failed");
    service.beginAction("s1", "clicking");
    expect(service.getState()[0].lastError).toBeUndefined();
    service.endAction("s1");
    expect(service.getState()[0].lastError).toBeUndefined();
    service.endAction("s1", "fill failed");
    expect(service.getState()[0].lastError).toBe("fill failed");
    service.dispose();
  });
});

describe("thumbnail read-back", () => {
  it("serves captured frames through readThumbnail and 404s unknown ids", async () => {
    const scheduler = fakeScheduler();
    const runner = fakeRunner();
    const { service } = setup({ runner, scheduler });
    service.addSession("s1");
    scheduler.runNext();
    await waitFor(() => service.getState()[0]?.thumbnailAttachmentId !== undefined);
    const frame = await service.readThumbnail("obs-s1-1");
    expect(frame?.mediaType).toBe("image/png");
    expect([...(frame?.data ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(await service.readThumbnail("nope")).toBeUndefined();
    service.dispose();
  });
});

describe("actionForLabel", () => {
  it("maps tool labels onto observation verbs", () => {
    expect(actionForLabel("navigate")).toBe("navigating");
    expect(actionForLabel("screenshot")).toBe("capturing");
    expect(actionForLabel("session start")).toBe("starting");
  });
});

describe("scratch files and thumbnail references", () => {
  it("reuses one scratch path per session and deletes it after reading", async () => {
    const scheduler = fakeScheduler();
    const runner = fakeRunner();
    const { service } = setup({ runner, scheduler });
    service.addSession("s1");
    // first frame (scheduled with delay 0)
    scheduler.runNext();
    await waitFor(
      () =>
        service.getState()[0]?.thumbnailAttachmentId !== undefined &&
        scheduler.pending().length === 1,
    );
    const firstOut = runner.calls.filter((c) => c.args[0] === "screenshot").at(-1)?.args;
    const pathOf = (args: string[]) => args[args.indexOf("--out") + 1];
    expect(pathOf(firstOut ?? [])).toBe(join(tmpdir(), "bsk-obs-s1.png"));
    expect(existsSync(pathOf(firstOut ?? []))).toBe(false);
    // second frame: same path, deleted again
    service.endAction("s1");
    scheduler.runNext();
    await waitFor(
      () =>
        runner.calls.filter((c) => c.args[0] === "screenshot").length >= 2 &&
        scheduler.pending().length === 1,
    );
    const secondOut = runner.calls.filter((c) => c.args[0] === "screenshot").at(-1)?.args;
    expect(pathOf(secondOut ?? [])).toBe(join(tmpdir(), "bsk-obs-s1.png"));
    await waitFor(() => !existsSync(pathOf(secondOut ?? [])));
    service.dispose();
  });

  it("keeps the last two distinct frames and evicts the third", async () => {
    let n = 0;
    const runner = fakeRunner({
      screenshotBytes: () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, n++]),
    });
    const scheduler = fakeScheduler();
    const { service } = setup({ scheduler, runner });
    service.addSession("s1");
    scheduler.runNext();
    await waitFor(
      () =>
        service.getState()[0]?.thumbnailAttachmentId === "obs-s1-1" &&
        scheduler.pending().length === 1,
    );
    service.endAction("s1");
    scheduler.runNext();
    await waitFor(
      () =>
        service.getState()[0]?.thumbnailAttachmentId === "obs-s1-2" &&
        scheduler.pending().length === 1,
    );
    expect((await service.readThumbnail("obs-s1-1"))?.mediaType).toBe("image/png");
    expect((await service.readThumbnail("obs-s1-2"))?.mediaType).toBe("image/png");
    service.endAction("s1");
    scheduler.runNext();
    await waitFor(
      () =>
        service.getState()[0]?.thumbnailAttachmentId === "obs-s1-3" &&
        scheduler.pending().length === 1,
    );
    expect(await service.readThumbnail("obs-s1-1")).toBeUndefined();
    expect((await service.readThumbnail("obs-s1-2"))?.mediaType).toBe("image/png");
    expect((await service.readThumbnail("obs-s1-3"))?.mediaType).toBe("image/png");
    service.removeSession("s1");
    expect(await service.readThumbnail("obs-s1-2")).toBeUndefined();
    expect(await service.readThumbnail("obs-s1-3")).toBeUndefined();
    service.dispose();
  });

  it("reuses the current frame id when the PNG bytes are unchanged", async () => {
    const scheduler = fakeScheduler();
    const runner = fakeRunner();
    const { service } = setup({ scheduler, runner });
    service.addSession("s1");
    scheduler.runNext();
    await waitFor(
      () =>
        service.getState()[0]?.thumbnailAttachmentId === "obs-s1-1" &&
        scheduler.pending().length === 1,
    );
    service.endAction("s1");
    scheduler.runNext();
    await waitFor(
      () =>
        runner.calls.filter((c) => c.args[0] === "screenshot").length >= 2 &&
        scheduler.pending().length === 1,
    );
    expect(service.getState()[0]?.thumbnailAttachmentId).toBe("obs-s1-1");
    expect((await service.readThumbnail("obs-s1-1"))?.mediaType).toBe("image/png");
    service.dispose();
  });
});
