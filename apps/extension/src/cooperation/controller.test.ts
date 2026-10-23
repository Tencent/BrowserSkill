import type { VomScene } from "@browser-skill/vom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { handleDialog } from "@/tools/dialogs";
import { handleEmulate } from "@/tools/emulate";
import { resolveActionTarget } from "@/tools/interaction";
import { captureVomObservation, handleSnapshot } from "@/tools/observation";
import type { CdpRunner } from "@/tools/shared";
import { handleTabBorrow, handleTabCreate, handleTabReturn, handleTabSelect } from "@/tools/tabs";
import type { DialogParams, PendingJavaScriptDialog } from "@/transport/types";
import { CooperationController } from "./controller";
import type { FrameState } from "./types";

vi.mock("@/tools/observation", () => ({
  captureVomObservation: vi.fn(),
  handleSnapshot: vi.fn(async () => ({
    text: "City: Shanghai; Submit [ref=@e1]",
    ref_count: 1,
    tab_id: 7,
    truncated: false,
  })),
}));
vi.mock("@/tools/interaction", () => ({
  resolveActionTarget: vi.fn(async () => ({
    backendNodeId: 4,
    frameId: "frame",
    cdpTarget: { tabId: 7 },
    tab: { tabId: 7 },
  })),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(options: { url?: string; sync?: boolean } = {}) {
  let now = 10000;
  let frame: FrameState = {
    document: "doc-a",
    revision: 0,
    structure: 0,
    human: 0,
    busy: false,
    editing: false,
    lastInput: 0,
    fields: [],
    events: [],
  };
  const sessions = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  const ctx = await sessions.start("shared");
  const tab = {
    id: 7,
    windowId: 100,
    active: true,
    url: options.url ?? "https://fixture.test",
    pendingUrl: undefined as string | undefined,
  };
  vi.stubGlobal("chrome", { tabs: { get: async () => tab, query: async () => [tab] } });
  const native = vi.fn(async () => ({}));
  let beforeDispatch: (() => Promise<void>) | undefined;
  const cdp = {
    send: native,
    sendGuarded: async (_target, _method, _params, guard) => {
      await beforeDispatch?.();
      guard.onDispatch?.();
      return native();
    },
  } as CdpRunner;
  const readFrames = vi.fn(async () => new Map([[0, structuredClone(frame)]]));
  const resumeFrames = vi.fn(async () => {
    frame = { ...frame, editing: false, revision: frame.revision + 1 };
  });
  const sessionActivity = vi.fn();
  const controller = new CooperationController({
    sessions,
    sessionActivity,
    readFrames,
    resumeFrames,
    changed: vi.fn(),
    now: () => now,
  });
  const abort = new AbortController();
  const signal = abort.signal;
  const command = (action: "enable" | "sync" | "wait" | "status") =>
    controller.command(
      { session_id: "shared", tab_id: 7, action, timeout_ms: 0 },
      cdp,
      signal,
    ) as Promise<Record<string, any>>;
  await controller.run(
    { id: "start", method: "tool.session_start", params: { session_id: "shared" } },
    cdp,
    signal,
    async () => ({ agent_window_id: 100 }),
  );
  const first = options.sync === false ? {} : await command("sync");
  const act = (
    id = first.context_id,
    invoke = (runner: CdpRunner) =>
      runner.send(7, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        x: 4,
        y: 5,
      }),
    method = "tool.click",
  ) =>
    controller.run(
      { id: "action", method, params: { session_id: "shared", tab_id: 7, context_id: id } },
      cdp,
      signal,
      invoke,
    );
  return {
    tab,
    controller,
    sessions,
    sessionActivity,
    cdp,
    abort,
    ctx,
    first,
    native,
    command,
    act,
    readFrames,
    resumeFrames,
    advance: () => {
      now += 10000;
    },
    beforeDispatch: (work: () => Promise<void>) => {
      beforeDispatch = work;
    },
    change: (patch: Partial<FrameState>, notify = true) => {
      frame = { ...frame, revision: frame.revision + 1, ...patch };
      if (notify) controller.receive(7, 0, structuredClone(frame));
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared-tab dispatch fences", () => {
  it("rejects a stale plan after a mistaken edit, then exposes the current field without recapturing the page", async () => {
    const f = await fixture();
    f.change({
      human: 1,
      fields: [{ label: "City", value: "Beijing" }],
      events: [{ sequence: 1, type: "keydown", label: "City" }],
    });
    expect(await f.act()).toMatchObject({ data: { effect_state: "none" } });
    expect(f.native).not.toHaveBeenCalled();
    f.advance();
    const fresh = await f.command("sync");
    expect(fresh).toMatchObject({ kind: "delta", changes: [{ value: "Beijing" }] });
    expect(handleSnapshot).toHaveBeenCalledTimes(1);
    await f.act(fresh.context_id);
    expect(f.native).toHaveBeenCalledTimes(1);
    await f.act(fresh.context_id);
    expect(f.native).toHaveBeenCalledTimes(1);
  });
  it("checks ownership after asynchronous attachment, immediately before native input", async () => {
    const f = await fixture();
    const attached = deferred();
    const proceed = deferred();
    f.beforeDispatch(async () => {
      attached.resolve();
      await proceed.promise;
    });
    const action = f.act();
    await attached.promise;
    f.change({ human: 1 });
    proceed.resolve();
    expect(await action).toMatchObject({ data: { effect_state: "none" } });
    expect(f.native).not.toHaveBeenCalled();
  });
  it("detects missed ownership notifications by reading renderer state before dispatch", async () => {
    const f = await fixture();
    f.change({ human: 1 }, false);
    expect(await f.act()).toMatchObject({ data: { effect_state: "none" } });
    expect(f.native).not.toHaveBeenCalled();
  });
  it("never admits two actions with one context while the first call is awaiting input", async () => {
    const f = await fixture();
    const ready = deferred();
    const proceed = deferred();
    f.beforeDispatch(async () => {
      ready.resolve();
      await proceed.promise;
    });
    const first = f.act();
    await ready.promise;
    expect(await f.act()).toMatchObject({ code: "permission_denied" });
    proceed.resolve();
    await first;
    expect(f.native).toHaveBeenCalledTimes(1);
  });
  it.each([
    { busy: true },
    { editing: true },
  ])("does not time out a live interaction lease %j", async (patch) => {
    const f = await fixture();
    f.change({ human: 1, ...patch });
    f.advance();
    expect(await f.command("wait")).toMatchObject({ ready: false });
    expect(await f.command("sync")).toMatchObject({ code: "permission_denied" });
    expect(f.native).not.toHaveBeenCalled();
  });
  it("a late hand-back cannot override a newer explicit hold", async () => {
    const f = await fixture();
    const version = f.controller.view(7)!.revision;
    expect(await f.controller.control(7, version, "hold")).toMatchObject({ ok: true });
    expect(await f.controller.control(7, version, "resume")).toMatchObject({ ok: false });
    expect(f.controller.view(7)?.mode).toBe("held");
    expect(f.resumeFrames).not.toHaveBeenCalled();
  });
  it("reports uncertain input and releases only the button pressed by that action", async () => {
    const f = await fixture();
    const result = await f.act(f.first.context_id, async (runner) => {
      await runner.send(7, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
      f.change({ human: 1 });
      await runner.send(7, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" });
      return {};
    });
    expect(result).toMatchObject({ data: { effect_state: "unknown" } });
    expect(f.native).toHaveBeenCalledTimes(2);
    await f.act();
    expect(f.native).toHaveBeenCalledTimes(2);
  });
  it("does not alias a context to a replacement reference map", async () => {
    const f = await fixture();
    f.ctx.refStore.replace([["e1", 999]]);
    expect(await f.act()).toMatchObject({ code: "permission_denied" });
    expect(f.native).not.toHaveBeenCalled();
  });
  it("keeps an observed action on its original tab when the user changes the active tab", async () => {
    const f = await fixture();
    const original = { id: 7, windowId: 100, active: false };
    const active = { id: 8, windowId: 100, active: true };
    f.ctx.agentCreatedTabs.add(8);
    vi.stubGlobal("chrome", {
      tabs: {
        get: async (id: number) => (id === 7 ? original : active),
        query: async () => [active],
      },
    });
    const request = {
      id: "bound-action",
      method: "tool.click",
      params: { session_id: "shared", context_id: f.first.context_id },
    };
    const invoke = vi.fn(async () => ({}));
    await f.controller.run(request, f.cdp, f.abort.signal, invoke);
    expect(invoke).toHaveBeenCalledOnce();
    expect(request.params).toMatchObject({ tab_id: 7 });
  });
  it("preserves explicit cancellation even when an existing handler catches the guard error", async () => {
    const f = await fixture();
    const result = await f.act(f.first.context_id, async (runner) => {
      f.abort.abort();
      try {
        await runner.send(7, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
      } catch {
        return { code: "cdp_failed", message: "wrapped by an existing handler" };
      }
    });
    expect(result).toMatchObject({ code: "cancelled", data: { effect_state: "none" } });
    expect(f.native).not.toHaveBeenCalled();
  });
  it("distinguishes stopping the task from a temporary manual hold, including later requests", async () => {
    const f = await fixture();
    f.controller.stopSession("shared");
    expect(await f.command("wait")).toMatchObject({ code: "user_aborted" });
    expect(await f.command("sync")).toMatchObject({ code: "user_aborted" });
    expect(await f.command("enable")).toMatchObject({ code: "user_aborted" });
    expect(await f.act()).toMatchObject({ code: "user_aborted" });
    expect(await f.command("status")).toMatchObject({ ready: false, stopped: true });
    expect(f.native).not.toHaveBeenCalled();
  });
  it("reports a mid-action stop as a user abort with uncertain effects", async () => {
    const f = await fixture();
    const result = await f.act(f.first.context_id, async (runner) => {
      await runner.send(7, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
      f.controller.stopSession("shared");
      await runner.send(7, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" });
      return {};
    });
    expect(result).toMatchObject({ code: "user_aborted", data: { effect_state: "unknown" } });
    expect(f.native).toHaveBeenCalledTimes(2);
  });
  it("preserves revocation even when an existing handler catches the guard error", async () => {
    const f = await fixture();
    const result = await f.act(f.first.context_id, async (runner) => {
      f.change({ human: 1 });
      try {
        await runner.send(7, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
      } catch {
        return { code: "cdp_failed", message: "wrapped by an existing handler" };
      }
    });
    expect(result).toMatchObject({
      code: "permission_denied",
      data: { reason: "cooperation_sync_required", effect_state: "none" },
    });
    expect(f.native).not.toHaveBeenCalled();
  });
  it("rejects changed geometry between target resolution and the first native press", async () => {
    const f = await fixture();
    const result = await f.act(f.first.context_id, async (runner) => {
      f.change({ structure: 1 });
      return runner.send(7, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        x: 4,
        y: 5,
      });
    });
    expect(result).toMatchObject({ data: { effect_state: "none" } });
    expect(f.native).not.toHaveBeenCalled();
  });
  it("keeps a newer hold when an older resume acknowledgement arrives late", async () => {
    const f = await fixture();
    const pending = deferred();
    f.resumeFrames.mockImplementationOnce(() => pending.promise);
    const resume = f.controller.control(7, f.controller.view(7)!.revision, "resume");
    await f.controller.control(7, f.controller.view(7)!.revision, "hold");
    pending.resolve();
    await resume;
    expect(f.controller.view(7)?.mode).toBe("held");
    expect(await f.command("wait")).toMatchObject({ ready: false });
  });
  it("falls back to a baseline on structure changes and lost document history", async () => {
    const f = await fixture();
    f.change({ document: "doc-b", structure: 1 });
    expect(await f.command("sync")).toMatchObject({ kind: "baseline", history_complete: false });
    expect(handleSnapshot).toHaveBeenCalledTimes(2);
  });
  it("retains collected human activity across navigation and does not mix document sequences", async () => {
    const f = await fixture();
    f.change({ human: 5, events: [{ sequence: 5, type: "pointerdown", label: "Apply" }] });
    await f.command("status");
    f.change({
      document: "doc-b",
      human: 1,
      events: [{ sequence: 1, type: "pointerdown", label: "Next" }],
    });
    const result = await f.command("sync");
    expect(result.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ document: "doc-a", label: "Apply" }),
        expect.objectContaining({ document: "doc-b", label: "Next" }),
      ]),
    );
    expect(result.history_complete).toBe(false);
    expect((await f.command("sync")).activity).toEqual([]);
  });
  it("routes human help without an action context and preserves a newer manual hold", async () => {
    const f = await fixture();
    const request = { id: "help", method: "tool.request_help", params: { session_id: "shared" } };
    const result = await f.controller.run(request, f.cdp, f.abort.signal, async () => {
      expect(f.controller.view(7)?.mode).toBe("yielding");
      await f.controller.control(7, f.controller.view(7)!.revision, "hold");
      return { outcome: "continued" };
    });
    expect(result).toEqual({ outcome: "continued" });
    expect(request.params).toMatchObject({ tab_id: 7 });
    expect(f.controller.view(7)?.mode).toBe("held");
    expect(await f.act()).toMatchObject({ data: { effect_state: "none" } });
  });
  it.each([
    false,
    true,
  ])("checks the whole page unless the decision dependencies are explicit: %s", async (scoped) => {
    const scene = (notice: string): VomScene => ({
      viewport: { width: 800, height: 600 },
      nodes: [
        { id: 1, parentId: null, tag: "main", name: "", role: "main" },
        { id: 2, parentId: 1, tag: "form", name: "", role: "form" },
        { id: 4, parentId: 2, tag: "button", name: "Continue", role: "button" },
        { id: 5, parentId: 1, tag: "aside", name: notice, role: "region" },
      ].map((node) => ({
        ...node,
        backendNodeId: node.id,
        frameId: "frame",
        rect: { x: 0, y: 0, w: 20, h: 20 },
        paintOrder: 1,
        position: "static",
        pointerEvents: "auto",
      })),
    });
    vi.mocked(handleSnapshot).mockImplementationOnce(async (_m, _p, deps) => {
      deps!.onScene?.(scene("First notice"));
      return { text: "Continue", ref_count: 1, tab_id: 7, truncated: false };
    });
    vi.mocked(captureVomObservation).mockImplementation(async (_c, _t, _u, options) => {
      options?.onScene?.(scene("Second notice"));
      return {} as Awaited<ReturnType<typeof captureVomObservation>>;
    });
    const f = await fixture();
    f.change({ structure: 5 });
    const result = await f.controller.run(
      {
        id: "noisy",
        method: "tool.click",
        params: {
          session_id: "shared",
          tab_id: 7,
          context_id: f.first.context_id,
          ref: "e4",
          ...(scoped ? { depends_on: ["e4"] } : {}),
        },
      },
      f.cdp,
      f.abort.signal,
      (runner) => runner.send(7, "Input.dispatchMouseEvent", { type: "mousePressed" }),
    );
    if (scoped) {
      expect(result).toEqual({});
      expect(f.native).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatchObject({
        data: { reason: "cooperation_sync_required", effect_state: "none" },
      });
      expect(f.native).not.toHaveBeenCalled();
    }
    expect(resolveActionTarget).toHaveBeenCalled();
  });
  it("uses updated field evidence after a delta when a later cosmetic mutation occurs", async () => {
    const scene = (value: string): VomScene => ({
      viewport: { width: 800, height: 600 },
      nodes: [
        {
          id: 1,
          parentId: null,
          backendNodeId: 1,
          frameId: "frame",
          tag: "input",
          role: "textbox",
          name: "City",
          value,
          rect: { x: 0, y: 0, w: 20, h: 20 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
        },
      ],
    });
    vi.mocked(handleSnapshot).mockImplementationOnce(async (_m, _p, deps) => {
      deps!.onScene?.(scene("Shanghai"));
      return { text: "City Shanghai", ref_count: 1, tab_id: 7, truncated: false };
    });
    vi.mocked(captureVomObservation).mockImplementation(async (_c, _t, _u, options) => {
      options?.onScene?.(scene("Beijing"));
      return {} as Awaited<ReturnType<typeof captureVomObservation>>;
    });
    const f = await fixture();
    f.change({ fields: [{ id: "1", label: "City", value: "Beijing" }] });
    const updated = await f.command("sync");
    expect(updated).toMatchObject({ kind: "delta", changes: [{ value: "Beijing" }] });
    expect(handleSnapshot).toHaveBeenCalledTimes(1);
    f.change({ structure: 1 });
    expect(await f.act(updated.context_id)).toEqual({});
    expect(f.native).toHaveBeenCalledOnce();
  });
  it("reobserves if structural content changes while preparing a field delta", async () => {
    const f = await fixture();
    f.change({ fields: [{ label: "City", value: "Beijing" }] });
    vi.mocked(captureVomObservation).mockImplementationOnce(async () => {
      f.change({ structure: 1 });
      return {} as Awaited<ReturnType<typeof captureVomObservation>>;
    });
    expect(await f.command("sync")).toMatchObject({
      data: { reason: "cooperation_sync_required" },
    });
    expect(await f.command("sync")).toMatchObject({ kind: "baseline" });
  });
  it("does not misreport a document invalidation as human input", async () => {
    const f = await fixture();
    const result = await f.act(f.first.context_id, async () => {
      f.controller.invalidate(7);
      return { code: "cdp_failed", message: "document changed" };
    });
    expect(result).toMatchObject({
      message: "Page interaction coverage changed; wait and synchronize",
      data: { reason: "cooperation_sync_required", effect_state: "none" },
    });
    expect(f.native).not.toHaveBeenCalled();
  });
  it.each([
    "tool.navigate",
    "tool.navigate_back",
    "tool.navigate_forward",
    "tool.reload",
  ])("returns a completed %s receipt while invalidating its old context", async (method) => {
    const f = await fixture();
    const receipt = { tab_id: 7, final_url: "https://fixture.test/next", reached: "load" };
    const result = await f.act(
      f.first.context_id,
      async (runner) => {
        await runner.send(7, "Page.navigate", { url: receipt.final_url });
        f.controller.invalidate(7);
        f.change({ document: "doc-b" });
        return receipt;
      },
      method,
    );
    expect(result).toEqual(receipt);
    expect(await f.act()).toMatchObject({ code: "permission_denied" });
    expect(f.native).toHaveBeenCalledOnce();
    const fresh = await f.command("sync");
    expect(await f.act(fresh.context_id)).toEqual({});
  });
  it("still blocks input after a navigation invalidates the action's document", async () => {
    const f = await fixture();
    const result = await f.act(
      f.first.context_id,
      async (runner) => {
        await runner.send(7, "Page.navigate", { url: "https://fixture.test/next" });
        f.controller.invalidate(7);
        return runner.send(7, "Input.insertText", { text: "stale" });
      },
      "tool.navigate",
    );
    expect(result).toMatchObject({
      code: "permission_denied",
      data: { effect_state: "unknown" },
    });
    expect(f.native).toHaveBeenCalledOnce();
  });
  it.each([
    "human",
    "hold",
    "stop",
    "cancel",
  ])("does not treat a completed navigation as authority to ignore %s intervention", async (intervention) => {
    const f = await fixture();
    const result = await f.act(
      f.first.context_id,
      async (runner) => {
        await runner.send(7, "Page.navigate", { url: "https://fixture.test/next" });
        f.controller.invalidate(7);
        if (intervention === "human") f.change({ human: 1, lastInput: 10000 });
        if (intervention === "hold")
          await f.controller.control(7, f.controller.view(7)!.revision, "hold");
        if (intervention === "stop") f.controller.stopSession("shared");
        if (intervention === "cancel") f.abort.abort();
        return { tab_id: 7, final_url: "https://fixture.test/next", reached: "load" };
      },
      "tool.navigate",
    );
    expect(result).toMatchObject({
      code:
        intervention === "cancel"
          ? "cancelled"
          : intervention === "stop"
            ? "user_aborted"
            : "permission_denied",
      data: { effect_state: "unknown" },
    });
    expect(f.native).toHaveBeenCalledOnce();
  });
  it("reports loading frames as not ready and recovers on the next wait", async () => {
    const f = await fixture();
    f.readFrames.mockRejectedValueOnce(new Error("frame is loading"));
    expect(await f.command("wait")).toMatchObject({ ready: false, state: { mode: "unavailable" } });
    expect(await f.command("wait")).toMatchObject({ ready: true });
    expect(await f.act()).toMatchObject({ code: "permission_denied" });
  });
  it("fails closed when any frame is inaccessible and preserves a page the person touched", async () => {
    const f = await fixture();
    f.change({ human: 1 });
    f.readFrames.mockRejectedValueOnce(new Error("missing frame"));
    expect(await f.act()).toMatchObject({ code: "permission_denied" });
    expect(f.native).not.toHaveBeenCalled();
    expect(f.ctx.agentCreatedTabs.has(7)).toBe(false);
    expect(f.ctx.observedTabs?.has(7)).toBe(true);
  });
  it("keeps passive reads free of background focus preparation", async () => {
    const f = await fixture();
    const invoke = vi.fn(async () => ({}));
    expect(await f.act(f.first.context_id, invoke, "tool.evaluate")).toEqual({});
    expect(invoke).toHaveBeenCalledOnce();
    await f.act(
      undefined,
      async (cdp) => {
        expect(cdp.acquireBackgroundExecution).toBeUndefined();
        return {};
      },
      "tool.snapshot",
    );
  });
});

describe("shared task routing and lifetime", () => {
  it("keeps wait, sync, observation and help on the task tab after a human switches tabs", async () => {
    const f = await fixture();
    const original = { id: 7, windowId: 100, active: false, url: "https://fixture.test" };
    const other = { id: 8, windowId: 100, active: true, url: "https://unrelated.test" };
    vi.stubGlobal("chrome", {
      tabs: {
        get: async (id: number) => (id === 7 ? original : other),
        query: async () => [other],
      },
    });
    for (const action of ["wait", "sync", "status"] as const) {
      const result = await f.controller.command(
        { session_id: "shared", action, timeout_ms: 0 },
        f.cdp,
        f.abort.signal,
      );
      expect(result).toMatchObject({ tab_id: 7 });
      expect(result).not.toHaveProperty("code");
    }
    for (const method of ["tool.snapshot", "tool.request_help"]) {
      const request = { id: method, method, params: { session_id: "shared" } };
      const invoke = vi.fn(async () => ({}));
      await f.controller.run(request, f.cdp, f.abort.signal, invoke);
      expect(invoke).toHaveBeenCalledOnce();
      expect(request.params).toMatchObject({ tab_id: 7 });
    }
  });

  it("never falls through to the active page when the shared task page closes", async () => {
    const f = await fixture();
    f.controller.releaseTab(7);
    f.sessions.forgetClosedTab(7);
    vi.stubGlobal("chrome", {
      tabs: {
        get: async (id: number) => {
          if (id === 7) throw new Error("No tab");
          return { id, windowId: 100 };
        },
        query: async () => [{ id: 8, windowId: 100, active: true }],
      },
    });
    expect(
      await f.controller.command({ session_id: "shared", action: "sync" }, f.cdp, f.abort.signal),
    ).toMatchObject({ code: "not_found" });
    const invoke = vi.fn();
    await f.controller.run(
      { id: "read", method: "tool.snapshot", params: { session_id: "shared" } },
      f.cdp,
      f.abort.signal,
      invoke,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(await f.act()).toHaveProperty("code");
    expect(f.sessionActivity).toHaveBeenLastCalledWith("shared", false);
    f.controller.release("shared");
    expect(f.controller.hasSession("shared")).toBe(false);
  });

  it("retains the session until its last live shared page ends and accepts an explicit replacement", async () => {
    const f = await fixture();
    f.ctx.agentCreatedTabs.add(8);
    vi.stubGlobal("chrome", {
      tabs: { get: async (id: number) => ({ id, windowId: 100, url: "https://fixture.test" }) },
    });
    await f.controller.command(
      { session_id: "shared", action: "enable", tab_id: 8 },
      f.cdp,
      f.abort.signal,
    );
    await f.controller.control(8, f.controller.view(8)!.revision, "hold");
    f.controller.releaseTab(7);
    expect(f.sessionActivity).toHaveBeenLastCalledWith("shared", true);
    expect(
      await f.controller.command({ session_id: "shared", action: "status" }, f.cdp, f.abort.signal),
    ).toMatchObject({ tab_id: 8 });
    f.controller.stopSession("shared");
    expect(f.sessionActivity).toHaveBeenLastCalledWith("shared", false);
    expect(
      await f.controller.command({ session_id: "shared", action: "sync" }, f.cdp, f.abort.signal),
    ).toMatchObject({ code: "user_aborted" });
    f.controller.release("shared");
    expect(f.controller.enabled(8)).toBe(false);
  });
});

describe("cooperation is the session default", () => {
  it("pins the initial tab at creation and begins collecting before the first sync", async () => {
    const f = await fixture({ sync: false });
    expect(f.controller.hasSession("shared")).toBe(true);
    expect(f.controller.enabled(7)).toBe(true);
    await f.controller.observeTab(7);
    expect(f.readFrames).toHaveBeenCalledOnce();
    expect(f.sessionActivity).not.toHaveBeenCalledWith("shared", true);
    f.change({ human: 1, editing: true, fields: [{ label: "City", value: "Beijing" }] });
    expect(await f.command("wait")).toMatchObject({ ready: false });
    const invoke = vi.fn();
    expect(
      await f.controller.run(
        { id: "click", method: "tool.click", params: { session_id: "shared", selector: "button" } },
        f.cdp,
        f.abort.signal,
        invoke,
      ),
    ).toMatchObject({ data: { reason: "cooperation_sync_required" } });
    expect(invoke).not.toHaveBeenCalled();
    f.change({ editing: false });
    f.advance();
    expect(await f.command("sync")).toMatchObject({
      kind: "baseline",
      context_id: expect.any(String),
    });
  });

  it("allows only the pristine blank tab's first navigation without a context", async () => {
    const f = await fixture({ url: "about:blank", sync: false });
    const request = { id: "navigate", method: "tool.navigate", params: { session_id: "shared" } };
    const navigate = (cdp: CdpRunner) =>
      cdp.send(7, "Page.navigate", { url: "https://fixture.test" });
    expect(await f.controller.run(request, f.cdp, f.abort.signal, navigate)).toEqual({});
    expect(f.native).toHaveBeenCalledOnce();
    expect(f.sessionActivity).not.toHaveBeenCalledWith("shared", true);
    expect(f.ctx.agentCreatedTabs.has(7)).toBe(true);
    expect(await f.controller.run(request, f.cdp, f.abort.signal, navigate)).toMatchObject({
      data: { reason: "cooperation_sync_required" },
    });
    expect(f.native).toHaveBeenCalledOnce();
  });

  it.each([
    "about:blank",
    "",
  ])("keeps initial setup available while the blank page is committing (url=%s)", async (url) => {
    const f = await fixture({ url, sync: false });
    f.tab.pendingUrl = "about:blank";
    f.readFrames.mockRejectedValue(new Error("No observable document"));
    await f.controller.observeTab(7);
    expect(
      await f.controller.run(
        { id: "emulate", method: "tool.emulate", params: { session_id: "shared" } },
        f.cdp,
        f.abort.signal,
        (runner) =>
          runner.send(7, "Emulation.setDeviceMetricsOverride", { width: 390, height: 844 }),
      ),
    ).toEqual({});
    expect(f.readFrames).not.toHaveBeenCalled();
    expect(f.native).toHaveBeenCalledOnce();
    expect(f.ctx.agentCreatedTabs.has(7)).toBe(true);
    expect(f.sessionActivity).not.toHaveBeenCalledWith("shared", true);
  });

  it("lets a never-navigated blank session expire without losing its pinned target", async () => {
    const f = await fixture({ url: "about:blank", sync: false });
    await f.controller.observeTab(7);
    expect(f.readFrames).not.toHaveBeenCalled();
    expect(f.sessionActivity).not.toHaveBeenCalledWith("shared", true);
    const other = { id: 8, windowId: 100, active: true, url: "https://other.test" };
    vi.stubGlobal("chrome", {
      tabs: { get: async (id: number) => (id === 7 ? f.tab : other), query: async () => [other] },
    });
    const request = { id: "read", method: "tool.snapshot", params: { session_id: "shared" } };
    await f.controller.run(request, f.cdp, f.abort.signal, async () => ({}));
    expect(request.params).toMatchObject({ tab_id: 7 });
  });

  it.each([
    "before",
    "prepare",
    "dispatch",
  ])("does not overwrite a human navigation at %s", async (phase) => {
    const f = await fixture({ url: "about:blank", sync: false });
    const moved = () => {
      f.tab.url = "https://human-progress.test";
      f.controller.invalidate(7);
    };
    if (phase === "before") moved();
    if (phase === "dispatch") f.beforeDispatch(async () => moved());
    const result = await f.controller.run(
      { id: "navigate", method: "tool.navigate", params: { session_id: "shared" } },
      f.cdp,
      f.abort.signal,
      async (runner) => {
        if (phase === "prepare") moved();
        return runner.send(7, "Page.navigate", { url: "https://old-plan.test" });
      },
    );
    expect(result).toMatchObject({
      data: { reason: "cooperation_sync_required", effect_state: "none" },
    });
    expect(f.native).not.toHaveBeenCalled();
    expect(f.tab.url).toBe("https://human-progress.test");
  });

  it.each([
    false,
    true,
  ])("fences typed device setup when human navigation intervenes (partial=%s)", async (partial) => {
    const f = await fixture({ url: "about:blank", sync: false });
    const cdp = Object.assign(f.cdp, {
      setDeviceMetricsOverride: ChromiumCdp.prototype.setDeviceMetricsOverride,
      clearDeviceMetricsOverride: ChromiumCdp.prototype.clearDeviceMetricsOverride,
      setUserAgentOverride: ChromiumCdp.prototype.setUserAgentOverride,
      setTouchEmulationEnabled: ChromiumCdp.prototype.setTouchEmulationEnabled,
    });
    const params = {
      session_id: "shared",
      overrides: { width: 800, height: 600, user_agent: "fixture", touch: true },
    };
    f.beforeDispatch(async () => {
      if (f.native.mock.calls.length === (partial ? 1 : 0)) {
        f.tab.url = "https://human-progress.test";
        f.controller.invalidate(7);
      }
    });
    expect(
      await f.controller.run(
        { id: "device", method: "tool.emulate", params },
        cdp,
        f.abort.signal,
        (runner) => handleEmulate(f.sessions, params, { cdp: runner, tabsApi: chrome.tabs }),
      ),
    ).toMatchObject({
      data: { reason: "cooperation_sync_required", effect_state: partial ? "unknown" : "none" },
    });
    expect(f.native).toHaveBeenCalledTimes(partial ? 1 : 0);
  });

  it.each([
    false,
    true,
  ])("keeps its own responsive layout changes within one device action (off=%s)", async (off) => {
    const f = await fixture();
    const cdp = Object.assign(f.cdp, {
      setDeviceMetricsOverride: ChromiumCdp.prototype.setDeviceMetricsOverride,
      clearDeviceMetricsOverride: ChromiumCdp.prototype.clearDeviceMetricsOverride,
      setUserAgentOverride: ChromiumCdp.prototype.setUserAgentOverride,
      setTouchEmulationEnabled: ChromiumCdp.prototype.setTouchEmulationEnabled,
    });
    f.native.mockImplementation(async () => {
      f.change({ structure: 1 });
      return {};
    });
    const params = {
      session_id: "shared",
      context_id: f.first.context_id,
      ...(off
        ? { off: true }
        : { overrides: { width: 390, height: 844, user_agent: "fixture", touch: true } }),
    };
    expect(
      await f.controller.run(
        { id: "responsive", method: "tool.emulate", params },
        cdp,
        f.abort.signal,
        (runner) => handleEmulate(f.sessions, params, { cdp: runner, tabsApi: chrome.tabs }),
      ),
    ).toMatchObject({ cleared: off });
    expect(f.native).toHaveBeenCalledTimes(3);
  });

  it.each([
    "start",
    "requests",
    "request",
    "performance",
    "replay",
    "rule_add",
  ])("keeps passive debug %s available without permitting network intervention", async (action) => {
    const f = await fixture();
    const invoke = vi.fn(async () => ({ action }));
    const result = await f.controller.run(
      { id: "debug", method: "tool.debug", params: { session_id: "shared", action } },
      f.cdp,
      f.abort.signal,
      invoke,
    );
    if (["replay", "rule_add"].includes(action)) {
      expect(result).toMatchObject({ data: { reason: "cooperation_sync_required" } });
      expect(invoke).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual({ action });
      expect(invoke).toHaveBeenCalledOnce();
    }
  });

  it("does not overwrite a pending navigation from the initial blank tab", async () => {
    const f = await fixture({ url: "about:blank", sync: false });
    f.tab.pendingUrl = "https://human-progress.test";
    expect(
      await f.controller.run(
        { id: "navigate", method: "tool.navigate", params: { session_id: "shared" } },
        f.cdp,
        f.abort.signal,
        (runner) => runner.send(7, "Page.navigate", { url: "https://old-plan.test" }),
      ),
    ).toMatchObject({ data: { effect_state: "none" } });
    expect(f.native).not.toHaveBeenCalled();
  });

  it("does not promote a failed start into a shared session", async () => {
    const f = await fixture();
    f.controller.release("shared");
    expect(
      await f.controller.run(
        { id: "start", method: "tool.session_start", params: { session_id: "shared" } },
        f.cdp,
        f.abort.signal,
        async () => ({ code: "cancelled", message: "cancelled" }),
      ),
    ).toMatchObject({ code: "cancelled" });
    expect(f.controller.hasSession("shared")).toBe(false);
  });

  it("cannot use an explicit owned tab id to bypass default protection", async () => {
    const f = await fixture();
    f.ctx.agentCreatedTabs.add(8);
    vi.stubGlobal("chrome", {
      tabs: { get: async (id: number) => ({ id, windowId: 100, url: "https://second.test" }) },
    });
    const invoke = vi.fn();
    expect(
      await f.controller.run(
        { id: "click", method: "tool.click", params: { session_id: "shared", tab_id: 8 } },
        f.cdp,
        f.abort.signal,
        invoke,
      ),
    ).toMatchObject({ data: { reason: "cooperation_sync_required" } });
    expect(f.controller.enabled(8)).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    "tool.tab_create",
    "tool.tab_borrow",
    "tool.tab_select",
  ])("automatically protects the target returned by %s", async (method) => {
    const f = await fixture();
    f.ctx.agentCreatedTabs.add(8);
    vi.stubGlobal("chrome", {
      tabs: { get: async (id: number) => ({ id, windowId: 100, url: "https://second.test" }) },
    });
    await f.controller.run(
      { id: "claim", method, params: { session_id: "shared", tab_id: 8 } },
      f.cdp,
      f.abort.signal,
      async (runner) => {
        expect(runner.acquireBackgroundExecution).toBeUndefined();
        return { tab_id: 8 };
      },
    );
    expect(f.controller.enabled(8)).toBe(true);
    expect(
      await f.controller.command({ session_id: "shared", action: "status" }, f.cdp, f.abort.signal),
    ).toMatchObject({ tab_id: 8 });
    expect(f.ctx.agentCreatedTabs.has(8)).toBe(true);
    expect(f.ctx.observedTabs?.has(8) ?? false).toBe(false);
  });

  it("keeps an unspecified new tab navigable without background focus emulation", async () => {
    const f = await fixture();
    f.cdp.acquireBackgroundExecution = vi.fn();
    const request = { id: "create", method: "tool.tab_create", params: { session_id: "shared" } };
    await f.controller.run(request, f.cdp, f.abort.signal, async (runner) => {
      expect(runner.acquireBackgroundExecution).toBeUndefined();
      expect(request.params).toMatchObject({ url: "about:blank" });
      return { code: "cancelled", message: "cancelled" };
    });
    expect(f.cdp.acquireBackgroundExecution).not.toHaveBeenCalled();
  });

  it("does not reacquire a returned tab while its readiness lookup is in flight", async () => {
    const f = await fixture();
    const lookup = deferred();
    vi.stubGlobal("chrome", {
      tabs: {
        get: async () => {
          await lookup.promise;
          return f.tab;
        },
      },
    });
    f.readFrames.mockClear();
    const ready = f.controller.observeTab(7);
    f.controller.releaseTab(7);
    f.ctx.observedTabs?.delete(7);
    lookup.resolve();
    await ready;
    expect(f.controller.enabled(7)).toBe(false);
    expect(f.readFrames).not.toHaveBeenCalled();
  });

  it("does not acquire a human-created tab from its ready announcement", async () => {
    const f = await fixture();
    f.readFrames.mockClear();
    await f.controller.observeTab(8);
    expect(f.controller.enabled(8)).toBe(false);
    expect(f.readFrames).not.toHaveBeenCalled();
  });
});

describe("legacy capabilities under default cooperation", () => {
  const nativeEffects = [
    ["tool.evaluate", "Runtime.evaluate", { expression: "document.title = 'done'" }],
    ["tool.upload", "DOM.setFileInputFiles", { files: ["/staged/example.txt"], backendNodeId: 4 }],
    ["tool.upload", "Input.dispatchDragEvent", { type: "drop", x: 4, y: 5, data: { items: [] } }],
    [
      "tool.download",
      "Input.dispatchMouseEvent",
      { type: "mousePressed", button: "left", x: 4, y: 5 },
    ],
    ["tool.emulate", "Emulation.setDeviceMetricsOverride", { width: 390, height: 844 }],
  ] as const;

  it.each(
    nativeEffects,
  )("runs %s (%s) without human input and consumes its context", async (tool, method, params) => {
    const f = await fixture();
    const invoke = (cdp: CdpRunner) => cdp.send(7, method, params);
    expect(await f.act(f.first.context_id, invoke, tool)).toEqual({});
    expect(f.native).toHaveBeenCalledOnce();
    expect(await f.act(f.first.context_id, invoke, tool)).toMatchObject({
      data: { effect_state: "none" },
    });
    expect(f.native).toHaveBeenCalledOnce();
  });

  it.each(
    nativeEffects,
  )("revokes %s (%s) after preparation but before native dispatch", async (tool, method, params) => {
    const f = await fixture();
    f.beforeDispatch(async () => f.change({ human: 1, lastInput: 10000 }));
    expect(
      await f.act(f.first.context_id, (cdp) => cdp.send(7, method, params), tool),
    ).toMatchObject({
      data: { reason: "cooperation_sync_required", effect_state: "none" },
    });
    expect(f.native).not.toHaveBeenCalled();
  });

  it.each([
    "tool.window_resize",
    "tool.tab_close",
    "tool.screenshot_full_page",
    "tool.debug",
  ])("fences browser API effects for %s after asynchronous handler validation", async (tool) => {
    const f = await fixture();
    const effect = vi.fn(async () => ({ done: true }));
    const invoke = async (cdp: CdpRunner) => {
      await Promise.resolve();
      f.change({ human: 1, lastInput: 10000 });
      return cdp.runBrowserMutation!(effect);
    };
    expect(await f.act(f.first.context_id, invoke, tool)).toMatchObject({
      data: { effect_state: "none" },
    });
    expect(effect).not.toHaveBeenCalled();
    f.advance();
    const fresh = await f.command("sync");
    expect(await f.act(fresh.context_id, (cdp) => cdp.runBrowserMutation!(effect), tool)).toEqual({
      done: true,
    });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("cancels a pending transfer when the person takes over and never repeats its effect", async () => {
    const f = await fixture();
    const started = deferred();
    let cancelled = false;
    const running = f.controller.run(
      {
        id: "download",
        method: "tool.download",
        params: { session_id: "shared", context_id: f.first.context_id },
      },
      f.cdp,
      f.abort.signal,
      async (cdp, signal) => {
        await cdp.runBrowserMutation!(async () => f.native());
        started.resolve();
        await new Promise<void>((resolve) =>
          signal!.addEventListener(
            "abort",
            () => {
              cancelled = true;
              resolve();
            },
            { once: true },
          ),
        );
        return { code: "cancelled", message: "transfer cancelled" };
      },
    );
    await started.promise;
    f.change({ human: 1, editing: true, lastInput: 10000 });
    expect(await running).toMatchObject({
      data: { reason: "cooperation_sync_required", effect_state: "unknown" },
    });
    expect(cancelled).toBe(true);
    expect(f.native).toHaveBeenCalledOnce();
  });

  it.each([
    "stop",
    "close",
    "cancel",
  ])("keeps receipt collection alive after human input until %s", async (ending) => {
    const f = await fixture();
    const started = deferred();
    let inputSignal!: AbortSignal;
    let receiptSignal!: AbortSignal;
    const running = f.controller.run(
      {
        id: "download",
        method: "tool.download",
        params: { session_id: "shared", context_id: f.first.context_id },
      },
      f.cdp,
      f.abort.signal,
      async (cdp, input, completion) => {
        inputSignal = input!;
        receiptSignal = completion!;
        await cdp.send(7, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          x: 4,
          y: 5,
        });
        started.resolve();
        await new Promise<void>((resolve) =>
          receiptSignal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { code: "cancelled", message: "download cancelled" };
      },
    );
    await started.promise;
    f.change({ human: 1, lastInput: 10000 });
    expect(inputSignal.aborted).toBe(true);
    expect(receiptSignal.aborted).toBe(false);
    if (ending === "stop") f.controller.stopSession("shared");
    else if (ending === "close") f.controller.releaseTab(7);
    else f.abort.abort();
    expect(receiptSignal.aborted).toBe(true);
    await running;
    expect(f.native).toHaveBeenCalledOnce();
  });

  it("reports an intervened script as uncertain even if its browser reply succeeds", async () => {
    const f = await fixture();
    expect(
      await f.act(
        f.first.context_id,
        async (cdp) => {
          await cdp.send(7, "Runtime.evaluate", { expression: "submit()" });
          f.change({ human: 1, lastInput: 10000 }, false);
          return { ok: true };
        },
        "tool.evaluate",
      ),
    ).toMatchObject({ data: { effect_state: "unknown" } });
    expect(f.native).toHaveBeenCalledOnce();
  });

  it("preserves a completed download receipt when human input arrives during final cleanup", async () => {
    const f = await fixture();
    const receipt = { browser_path: "/owned/download.bin", byte_size: 12, tab_id: 7 };
    expect(
      await f.act(
        f.first.context_id,
        async (cdp) => {
          await cdp.send(7, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            button: "left",
            x: 4,
            y: 5,
          });
          f.change({ human: 1, lastInput: 10000 });
          return receipt;
        },
        "tool.download",
      ),
    ).toEqual(receipt);
    expect(await f.act(f.first.context_id)).toMatchObject({ data: { effect_state: "none" } });
    expect(f.native).toHaveBeenCalledOnce();
  });

  it("keeps an upload's cleanup available after intervention without allowing more file assignment", async () => {
    const f = await fixture();
    const result = await f.act(
      f.first.context_id,
      async (cdp) => {
        await cdp.send(7, "Page.setInterceptFileChooserDialog", { enabled: true });
        f.change({ human: 1, lastInput: 10000 });
        await expect(
          cdp.send(7, "DOM.setFileInputFiles", { files: ["/staged/example.txt"] }),
        ).rejects.toThrow();
        await cdp.resourceCleanup!.send(7, "Runtime.callFunctionOn", {
          objectId: "own-probe",
          functionDeclaration: "function() { delete window.ownProbe; }",
        });
        await cdp.send(7, "Page.setInterceptFileChooserDialog", { enabled: false, cancel: true });
        expect(() => cdp.resourceCleanup!.send(7, "Input.insertText", { text: "late" })).toThrow();
        return {};
      },
      "tool.upload",
    );
    expect(result).toMatchObject({ data: { effect_state: "unknown" } });
    expect(f.native).toHaveBeenCalledTimes(3);
  });

  it("allows explicit hover observation with fresh context, and blocks stale probes", async () => {
    const f = await fixture();
    const run = (context: string) =>
      f.controller.run(
        {
          id: "probe",
          method: "tool.observe",
          params: { session_id: "shared", probe_hover: true, context_id: context },
        },
        f.cdp,
        f.abort.signal,
        (cdp) => cdp.send(7, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 5 }),
      );
    expect(await run(f.first.context_id)).toEqual({});
    const fresh = await f.command("sync");
    f.change({ human: 1, lastInput: 10000 });
    expect(await run(fresh.context_id)).toMatchObject({ data: { effect_state: "none" } });
    expect(f.native).toHaveBeenCalledOnce();
  });
});

it("retires late browser dispatch after a handler has settled", async () => {
  const f = await fixture();
  let late!: CdpRunner;
  await f.act(
    f.first.context_id,
    async (cdp) => {
      late = cdp;
      return {};
    },
    "tool.evaluate",
  );
  await expect(late.send(7, "Runtime.evaluate", { expression: "submit()" })).rejects.toThrow(
    "already settled",
  );
  expect(f.native).not.toHaveBeenCalled();
});

it("preserves passive reads of user tabs without enrolling or controlling them", async () => {
  const f = await fixture();
  vi.stubGlobal("chrome", {
    tabs: {
      get: async (id: number) =>
        id === 8 ? { id: 8, windowId: 200, url: "https://user.test" } : f.tab,
    },
  });
  const invoke = vi.fn(async () => ({ text: "User page" }));
  const run = (method: string) =>
    f.controller.run(
      { id: "user-read", method, params: { session_id: "shared", tab_id: 8 } },
      f.cdp,
      f.abort.signal,
      invoke,
    );
  expect(await run("tool.snapshot")).toEqual({ text: "User page" });
  expect(f.controller.enabled(8)).toBe(false);
  expect(await run("tool.evaluate")).toMatchObject({ code: "permission_denied" });
  expect(invoke).toHaveBeenCalledOnce();
});

it("keeps debug history readable after the task tab is closed", async () => {
  const f = await fixture();
  vi.stubGlobal("chrome", {
    tabs: {
      get: async () => {
        throw new Error("closed");
      },
    },
  });
  const invoke = vi.fn(async () => ({ requests: [] }));
  expect(
    await f.controller.run(
      { id: "history", method: "tool.debug", params: { session_id: "shared", action: "requests" } },
      f.cdp,
      f.abort.signal,
      invoke,
    ),
  ).toEqual({ requests: [] });
});

it("cancels pending work when its task tab closes", async () => {
  const f = await fixture();
  const started = deferred();
  const work = f.controller.run(
    {
      id: "closed-download",
      method: "tool.download",
      params: { session_id: "shared", context_id: f.first.context_id },
    },
    f.cdp,
    f.abort.signal,
    async (cdp, signal) => {
      await cdp.runBrowserMutation!(async () => f.native());
      started.resolve();
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { code: "cancelled", message: "Transfer cancelled" };
    },
  );
  await started.promise;
  f.controller.releaseTab(7);
  expect(await work).toMatchObject({ data: { effect_state: "unknown" } });
  expect(f.native).toHaveBeenCalledOnce();
});

describe("tab management respects human control of the task window", () => {
  it.each([
    "held",
    "editing",
    "dragging",
    "recent input",
  ])("blocks activation while the person is %s", async (mode) => {
    const f = await fixture();
    if (mode === "held") await f.controller.control(7, f.controller.view(7)!.revision, "hold");
    else
      f.change({
        human: 1,
        editing: mode === "editing",
        busy: mode === "dragging",
        lastInput: 10000,
      });
    const update = vi.fn(async () => f.tab);
    Object.assign(chrome.tabs, { update });
    const params = { session_id: "shared", tab_id: 7 };
    expect(
      await f.controller.run(
        { id: "select", method: "tool.tab_select", params },
        f.cdp,
        f.abort.signal,
        (cdp, signal) => handleTabSelect(f.sessions, params, { cdp, signal }),
      ),
    ).toMatchObject({
      data: { reason: "cooperation_sync_required", effect_state: "none" },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    "hold",
    "missed input",
    "stop",
  ])("fences activation after an asynchronous tab lookup and %s", async (mode) => {
    const f = await fixture();
    const lookup = deferred();
    const proceed = deferred();
    const update = vi.fn(async () => f.tab);
    let lookups = 0;
    Object.assign(chrome.tabs, {
      update,
      get: async () => {
        if (++lookups === 1) {
          lookup.resolve();
          await proceed.promise;
        }
        return f.tab;
      },
    });
    const params = { session_id: "shared", tab_id: 7 };
    const action = f.controller.run(
      { id: "select", method: "tool.tab_select", params },
      f.cdp,
      f.abort.signal,
      (cdp, signal) => handleTabSelect(f.sessions, params, { cdp, signal }),
    );
    await lookup.promise;
    expect(await f.command("sync")).toMatchObject({ data: { effect_state: "none" } });
    if (mode === "hold") await f.controller.control(7, f.controller.view(7)!.revision, "hold");
    else if (mode === "stop") f.controller.stopSession("shared");
    else f.change({ human: 1, lastInput: 10000 }, false);
    proceed.resolve();
    expect(await action).toMatchObject(
      mode === "stop" ? { code: "user_aborted" } : { data: { effect_state: "none" } },
    );
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    "tool.tab_create",
    "tool.tab_borrow",
    "tool.tab_select",
    "tool.tab_return",
  ])("blocks %s while another owned tab is held", async (method) => {
    const f = await fixture();
    f.ctx.agentCreatedTabs.add(8);
    await f.controller.control(7, f.controller.view(7)!.revision, "hold");
    const invoke = vi.fn();
    expect(
      await f.controller.run(
        { id: "tabs", method, params: { session_id: "shared", tab_id: 8 } },
        f.cdp,
        f.abort.signal,
        invoke,
      ),
    ).toMatchObject({ data: { effect_state: "none" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("allows a normal activation once and does not retain an unattended page", async () => {
    const f = await fixture();
    const update = vi.fn(async () => f.tab);
    Object.assign(chrome.tabs, { update });
    const params = { session_id: "shared", tab_id: 7 };
    expect(
      await f.controller.run(
        { id: "select", method: "tool.tab_select", params },
        f.cdp,
        f.abort.signal,
        (cdp, signal) => handleTabSelect(f.sessions, params, { cdp, signal }),
      ),
    ).toEqual({ tab_id: 7, window_id: 100 });
    expect(update).toHaveBeenCalledExactlyOnceWith(7, { active: true });
    expect(f.ctx.agentCreatedTabs.has(7)).toBe(true);
    expect(f.sessionActivity).not.toHaveBeenCalledWith("shared", true);
  });

  it("fences creation at its browser API boundary", async () => {
    const f = await fixture();
    const create = vi.fn();
    Object.assign(chrome.tabs, { create });
    const params = { session_id: "shared" };
    expect(
      await f.controller.run(
        { id: "create", method: "tool.tab_create", params },
        f.cdp,
        f.abort.signal,
        async (cdp, signal) => {
          f.change({ human: 1, editing: true });
          return handleTabCreate(f.sessions, params, { cdp, signal });
        },
      ),
    ).toMatchObject({ data: { effect_state: "none" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("rechecks human input after borrow approval without moving the user tab", async () => {
    const f = await fixture();
    const other = { id: 8, windowId: 200, index: 0, url: "https://other.test" };
    const move = vi.fn();
    Object.assign(chrome.tabs, { move, get: async (id: number) => (id === 7 ? f.tab : other) });
    const params = { session_id: "shared", tab_id: 8 };
    expect(
      await f.controller.run(
        { id: "borrow", method: "tool.tab_borrow", params },
        f.cdp,
        f.abort.signal,
        (cdp, signal) =>
          handleTabBorrow(f.sessions, params, {
            cdp,
            signal,
            approveBorrow: async () => {
              f.change({ human: 1, editing: true }, false);
              return true;
            },
          }),
      ),
    ).toMatchObject({ data: { effect_state: "none" } });
    expect(move).not.toHaveBeenCalled();
    expect(f.ctx.borrowedTabs.size).toBe(0);
  });

  it.each([false, true])("preserves return cleanup with fallback=%s", async (fallback) => {
    const f = await fixture();
    f.ctx.agentCreatedTabs.delete(7);
    f.ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 0 });
    const move = vi.fn(async (_id: number, props: { windowId: number; index: number }) => {
      if (fallback && props.windowId === 200) throw new Error("Original window closed");
      f.controller.releaseTab(7);
      return { ...f.tab, windowId: props.windowId, index: props.index };
    });
    Object.assign(chrome.tabs, { move, sendMessage: vi.fn(async () => ({})) });
    Object.assign(chrome, {
      windows: {
        get: async () => ({ id: 200 }),
        getLastFocused: async () => ({ id: 300 }),
      },
    });
    const params = { session_id: "shared", tab_id: 7 };
    expect(
      await f.controller.run(
        { id: "return", method: "tool.tab_return", params },
        f.cdp,
        f.abort.signal,
        (cdp, signal) => handleTabReturn(f.sessions, params, { cdp, signal }),
      ),
    ).toMatchObject({ tab_id: 7, returned_to_window_id: fallback ? 300 : 200 });
    expect(move).toHaveBeenCalledTimes(fallback ? 2 : 1);
    expect(f.ctx.borrowedTabs.size).toBe(0);
    expect(f.controller.enabled(7)).toBe(false);
  });

  it("fences the fallback return when human input follows the first move failure", async () => {
    const f = await fixture();
    f.ctx.agentCreatedTabs.delete(7);
    f.ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 0 });
    const move = vi.fn(async () => {
      throw new Error("Original window closed");
    });
    Object.assign(chrome.tabs, { move });
    Object.assign(chrome, {
      windows: {
        get: async () => ({ id: 200 }),
        getLastFocused: async () => {
          f.change({ human: 1, editing: true }, false);
          return { id: 300 };
        },
      },
    });
    const params = { session_id: "shared", tab_id: 7 };
    expect(
      await f.controller.run(
        { id: "return", method: "tool.tab_return", params },
        f.cdp,
        f.abort.signal,
        (cdp, signal) => handleTabReturn(f.sessions, params, { cdp, signal }),
      ),
    ).toMatchObject({ data: { reason: "cooperation_sync_required", effect_state: "unknown" } });
    expect(move).toHaveBeenCalledTimes(1);
    expect(f.ctx.borrowedTabs.has(7)).toBe(true);
  });

  it("rolls back a completed borrow move if the user intervenes before activation", async () => {
    const f = await fixture();
    let other = { id: 8, windowId: 200, index: 0, url: "https://other.test" };
    const update = vi.fn();
    const move = vi.fn(async (_id: number, props: { windowId: number; index: number }) => {
      other = { ...other, ...props };
      if (props.windowId === 100) f.change({ human: 1, editing: true }, false);
      return other;
    });
    Object.assign(chrome.tabs, {
      move,
      update,
      get: async (id: number) => (id === 7 ? f.tab : other),
      sendMessage: vi.fn(async () => ({})),
    });
    Object.assign(chrome, { windows: { get: async () => ({ id: 200 }) } });
    const params = { session_id: "shared", tab_id: 8 };
    expect(
      await f.controller.run(
        { id: "borrow", method: "tool.tab_borrow", params },
        f.cdp,
        f.abort.signal,
        (cdp, signal) =>
          handleTabBorrow(f.sessions, params, { cdp, signal, approveBorrow: async () => true }),
      ),
    ).toMatchObject({ data: { reason: "cooperation_sync_required", effect_state: "unknown" } });
    expect(update).not.toHaveBeenCalled();
    expect(move.mock.calls.map(([, props]) => props.windowId)).toEqual([100, 200]);
    expect(f.ctx.borrowedTabs.size).toBe(0);
    expect(other.windowId).toBe(200);
  });

  it("rechecks return after locating the original window", async () => {
    const f = await fixture();
    f.ctx.agentCreatedTabs.delete(7);
    f.ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 0 });
    const move = vi.fn();
    Object.assign(chrome.tabs, { move });
    Object.assign(chrome, {
      windows: {
        get: async () => {
          f.change({ human: 1, editing: true }, false);
          return { id: 200 };
        },
      },
    });
    const params = { session_id: "shared", tab_id: 7 };
    expect(
      await f.controller.run(
        { id: "return", method: "tool.tab_return", params },
        f.cdp,
        f.abort.signal,
        (cdp, signal) => handleTabReturn(f.sessions, params, { cdp, signal }),
      ),
    ).toMatchObject({ data: { effect_state: "none" } });
    expect(move).not.toHaveBeenCalled();
    expect(f.ctx.borrowedTabs.has(7)).toBe(true);
  });
});

describe("default collaboration preserves the original unattended lifetime", () => {
  it("does not preserve pages for observation, DOM updates, navigation or agent input", async () => {
    const f = await fixture();
    expect(await f.act()).toEqual({});
    f.change({ fields: [{ label: "City", value: "Shanghai" }] });
    f.advance();
    await f.command("sync");
    f.change({ document: "new-document", human: 0 });
    await f.controller.observeTab(7);
    expect(f.ctx.agentCreatedTabs.has(7)).toBe(true);
    expect(f.ctx.observedTabs?.has(7) ?? false).toBe(false);
    expect(f.sessionActivity).not.toHaveBeenCalledWith("shared", true);
  });

  it.each([true, false])("preserves real human input with notification=%s", async (notify) => {
    const f = await fixture();
    f.change({ human: 1 }, notify);
    if (!notify) await f.command("status");
    expect(f.ctx.agentCreatedTabs.has(7)).toBe(false);
    expect(f.ctx.observedTabs?.has(7)).toBe(true);
    expect(f.sessionActivity).toHaveBeenLastCalledWith("shared", true);
    f.advance();
    await f.command("sync");
    expect(f.ctx.observedTabs?.has(7)).toBe(true);
  });

  it("does not inherit previous lease input counters on first collection", async () => {
    const f = await fixture({ sync: false });
    f.change({ human: 8, lastInput: 0 }, false);
    await f.controller.observeTab(7);
    expect(f.ctx.agentCreatedTabs.has(7)).toBe(true);
    expect(f.sessionActivity).not.toHaveBeenCalledWith("shared", true);
    f.change({ human: 9 });
    expect(f.sessionActivity).toHaveBeenLastCalledWith("shared", true);
  });

  it("hands an untouched task page back when the person moves it out of its window", async () => {
    const f = await fixture();
    f.controller.detachTab(7);
    // The background's existing detach listener relinquishes observed-page ownership.
    expect(f.sessions.releaseObservedTab(7)).toEqual(["shared"]);
    expect(f.ctx.agentCreatedTabs.has(7)).toBe(false);
    expect(f.sessions.findControllingSession(7)).toBeNull();
    expect(f.controller.enabled(7)).toBe(false);
    expect(f.sessionActivity).toHaveBeenLastCalledWith("shared", false);
    expect(await f.act()).toMatchObject({ data: { effect_state: "none" } });
  });

  it("does not convert an agent tab-return into an observed-page claim", async () => {
    const f = await fixture();
    f.ctx.agentCreatedTabs.delete(7);
    f.ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 0 });
    f.controller.detachTab(7);
    expect(f.ctx.observedTabs?.has(7) ?? false).toBe(false);
    expect(f.ctx.borrowedTabs.has(7)).toBe(true);
    expect(f.sessionActivity).toHaveBeenLastCalledWith("shared", false);
  });

  it("keeps protection only while a human-touched tab remains", async () => {
    const f = await fixture();
    f.ctx.agentCreatedTabs.add(8);
    Object.assign(chrome.tabs, { get: async (id: number) => ({ ...f.tab, id }) });
    await f.controller.observeTab(8);
    await f.controller.control(7, f.controller.view(7)!.revision, "hold");
    f.controller.releaseTab(7);
    expect(f.controller.enabled(8)).toBe(true);
    expect(f.ctx.agentCreatedTabs.has(8)).toBe(true);
    expect(f.sessionActivity).toHaveBeenLastCalledWith("shared", false);
  });
});

async function dialogFixture() {
  const f = await fixture();
  await f.act(); // The triggering operation has consumed its DOM context.
  let pending: PendingJavaScriptDialog | null = {
    id: "dialog-1",
    tab_id: 7,
    type: "prompt",
    message: "Name?",
    sequence: 1,
  };
  f.cdp.pendingDialog = () => pending;
  const answer = vi.fn(async () => {
    pending = null;
    return {
      tab_id: 7,
      type: "prompt" as const,
      message: "Name?",
      sequence: 1,
      handled: "accepted" as const,
    };
  });
  f.cdp.handleDialog = answer;
  f.readFrames.mockClear();
  f.readFrames.mockImplementation(() => new Promise(() => {}));
  vi.mocked(handleSnapshot).mockClear();
  const decide = (params: Partial<DialogParams>, before?: () => Promise<void>) => {
    const req = {
      id: "dialog",
      method: "tool.dialog",
      params: { session_id: "shared", action: "accept", dialog_id: "dialog-1", ...params },
    };
    return f.controller.run(req, f.cdp, f.abort.signal, async (runner, signal) => {
      await before?.();
      return handleDialog(f.sessions, req.params as DialogParams, runner, chrome.tabs, signal);
    });
  };
  return { ...f, answer, decide };
}

describe("native dialogs under shared control", () => {
  it("reads and answers the identified modal after context consumption without renderer calls", async () => {
    const f = await dialogFixture();
    expect(await f.decide({ action: "status", dialog_id: undefined })).toMatchObject({
      pending: { id: "dialog-1" },
    });
    expect(await f.decide({ prompt_text: "" })).toMatchObject({
      pending: null,
      handled: { handled: "accepted" },
    });
    expect(f.answer).toHaveBeenCalledWith(7, "dialog-1", true, "");
    expect(f.readFrames).not.toHaveBeenCalled();
    expect(handleSnapshot).not.toHaveBeenCalled();
    expect(f.controller.view(7)?.mode).toBe("syncing");
  });

  it("rejects missing or stale dialog identity without answering a different prompt", async () => {
    const f = await dialogFixture();
    expect(await f.decide({ dialog_id: undefined })).toMatchObject({ code: "invalid_params" });
    expect(await f.decide({ dialog_id: "stale" })).toMatchObject({ code: "not_found" });
    expect(f.answer).not.toHaveBeenCalled();
    expect(f.readFrames).not.toHaveBeenCalled();
  });

  it.each([
    "hold",
    "editing",
    "stop",
  ])("respects %s while keeping status available", async (control) => {
    const f = await dialogFixture();
    if (control === "hold") await f.controller.control(7, f.controller.view(7)!.revision, "hold");
    else if (control === "editing") f.change({ human: 1, editing: true });
    else f.controller.stopSession("shared");
    expect(await f.decide({ action: "status", dialog_id: undefined })).toMatchObject({
      pending: { id: "dialog-1" },
    });
    expect(await f.decide({})).toMatchObject({
      code: control === "stop" ? "user_aborted" : "permission_denied",
    });
    expect(f.answer).not.toHaveBeenCalled();
    expect(f.readFrames).not.toHaveBeenCalled();
  });

  it("rechecks control immediately before the native decision after an async lookup", async () => {
    const f = await dialogFixture();
    const entered = deferred(),
      release = deferred();
    const result = f.decide({}, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    await f.controller.control(7, f.controller.view(7)!.revision, "hold");
    release.resolve();
    expect(await result).toMatchObject({
      code: "permission_denied",
      data: { effect_state: "none" },
    });
    expect(f.answer).not.toHaveBeenCalled();
  });

  it("pins status to the task tab when another browser tab is active", async () => {
    const f = await dialogFixture();
    vi.stubGlobal("chrome", {
      tabs: {
        get: async (id: number) => ({ ...f.tab, id }),
        query: async () => [{ ...f.tab, id: 99 }],
      },
    });
    expect(f.controller.taskTab("shared")).toBe(7);
    expect(await f.decide({ action: "status", dialog_id: undefined })).toMatchObject({
      tab_id: 7,
      pending: { id: "dialog-1" },
    });
    expect(f.readFrames).not.toHaveBeenCalled();
  });
});
