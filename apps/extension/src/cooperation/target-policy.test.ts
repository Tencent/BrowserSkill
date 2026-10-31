import type { VomScene } from "@browser-skill/vom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { resolveActionTarget } from "@/tools/interaction";
import { captureVomObservation, handleSnapshot } from "@/tools/observation";
import type { CdpRunner } from "@/tools/shared";
import { checkActionTarget, checkExpectations } from "./action-checks";
import { CooperationController } from "./controller";
import type { FrameState } from "./types";

vi.mock("@/tools/observation", () => ({
  captureVomObservation: vi.fn(),
  handleSnapshot: vi.fn(async () => ({ text: "@e1 button Continue", tab_id: 7 })),
}));
vi.mock("@/tools/interaction", () => ({ resolveActionTarget: vi.fn() }));
vi.mock("./action-checks", async (original) => ({
  ...(await original<typeof import("./action-checks")>()),
  checkActionTarget: vi.fn(async () => undefined),
  checkExpectations: vi.fn(async () => undefined),
}));

async function fixture(policy: "strict" | "target" = "target") {
  let now = 10_000;
  let frame: FrameState = {
    document: "doc",
    revision: 0,
    structure: 0,
    human: 0,
    busy: false,
    editing: false,
    lastInput: 0,
    fields: [],
    fieldsComplete: true,
    events: [],
  };
  const sessions = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  const session = await sessions.start("s");
  const tab = { id: 7, tabId: 7, windowId: 100, active: true, url: "https://fixture.test" };
  vi.stubGlobal("chrome", { tabs: { get: async () => tab, query: async () => [tab] } });
  vi.mocked(resolveActionTarget).mockResolvedValue({
    tab,
    backendNodeId: 4,
    cdpTarget: { tabId: 7 },
    usedRef: "e1",
  });
  const send = vi.fn(async () => ({}));
  const cdp = { send } as CdpRunner;
  const readFrames = vi.fn(async () => new Map([[0, structuredClone(frame)]]));
  const controller = new CooperationController({
    sessions,
    readFrames,
    resumeFrames: async () => {},
    changed: () => {},
    now: () => now,
  });
  const abort = new AbortController();
  const signal = abort.signal;
  const sync = (policy?: "auto" | "strict" | "target") =>
    controller.command(
      { session_id: "s", tab_id: 7, action: "sync", control_policy: policy },
      cdp,
      signal,
    ) as Promise<Record<string, any>>;
  const first = await sync(policy);
  const run = (
    params: Record<string, unknown> = {},
    method = "tool.click",
    invoke?: (runner: CdpRunner) => Promise<unknown>,
  ) => {
    const request = {
      id: crypto.randomUUID(),
      method,
      params: {
        session_id: "s",
        tab_id: 7,
        context_id: first.context_id,
        ...(method === "tool.click" ? { ref: "e1" } : {}),
        ...params,
      },
    };
    return controller.run(
      request,
      cdp,
      signal,
      invoke ??
        ((runner) =>
          runner.send(7, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            button: "left",
            x: 10,
            y: 20,
          })),
    );
  };
  return {
    first,
    run,
    sync,
    controller,
    session,
    cdp,
    send,
    signal,
    abort,
    readFrames,
    change(patch: Partial<FrameState>, notify = true) {
      frame = { ...frame, revision: frame.revision + 1, ...patch };
      if (notify) controller.receive(7, 0, frame);
    },
    advance() {
      now += 10_000;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(["strict", "target"] as const)("completed action receipts (%s)", (policy) => {
  it.each([
    "click",
    "press",
    "evaluate",
  ])("keeps a completed %s receipt after document replacement and revokes its old context", async (action) => {
    const f = await fixture(policy);
    const receipt = action === "evaluate" ? { ok: true, tab_id: 7, value: false } : { tab_id: 7 };
    const result = await f.run(
      { ref: "e1", observation_id: f.first.observation_id },
      `tool.${action}`,
      async (runner) => {
        if (action === "evaluate") {
          await runner.beginDomMutation?.();
          await runner.send(7, "Runtime.evaluate", { expression: "replaceFrame(); false" });
        } else if (action === "press") {
          await runner.send(7, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
        } else {
          await runner.send(7, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            button: "left",
          });
        }
        f.controller.invalidate(7);
        f.change({ document: "next" }, false);
        if (action === "press")
          await runner.send(7, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter" });
        if (action === "click")
          await runner.send(7, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            button: "left",
          });
        return receipt;
      },
    );
    expect(result).toEqual(receipt);
    expect(await f.run()).toMatchObject({ code: "permission_denied" });
    expect(f.send).toHaveBeenCalledTimes(action === "evaluate" ? 1 : 2);
    const next = await f.sync();
    expect(next.context_id).not.toBe(f.first.context_id);
    expect(await f.run({ context_id: next.context_id })).toEqual({});
  });

  it.each([
    "loading",
    "empty",
  ])("keeps a successful script receipt when its post-action collector is %s", async (coverage) => {
    const f = await fixture(policy);
    const receipt = { ok: true, tab_id: 7, value: "saved" };
    expect(
      await f.run({ observation_id: f.first.observation_id }, "tool.evaluate", async (runner) => {
        await runner.send(7, "Runtime.evaluate", { expression: "save()" });
        if (coverage === "loading")
          f.readFrames.mockRejectedValueOnce(new Error("frame is loading"));
        else f.readFrames.mockResolvedValueOnce(new Map());
        return receipt;
      }),
    ).toEqual(receipt);
    expect(f.controller.view(7)).toMatchObject({ mode: "unavailable" });
    const oldScript = vi.fn(async () => ({ ok: true, tab_id: 7 }));
    expect(
      await f.run({ observation_id: f.first.observation_id }, "tool.evaluate", oldScript),
    ).toMatchObject({ code: "permission_denied" });
    expect(oldScript).not.toHaveBeenCalled();
    expect(await f.run()).toMatchObject({ code: "permission_denied" });
    expect(f.send).toHaveBeenCalledOnce();
    const next = await f.sync();
    expect(next.context_id).not.toBe(f.first.context_id);
    if (policy === "target")
      expect(
        await f.run(
          { context_id: next.context_id, observation_id: f.first.observation_id },
          "tool.evaluate",
          oldScript,
        ),
      ).toMatchObject({ data: { reason: "observation_required" } });
    expect(oldScript).not.toHaveBeenCalled();
    expect(await f.run({ context_id: next.context_id })).toEqual({});
  });

  it.each([
    "human",
    "hold",
    "hold-resume",
    "stop",
    "cancel",
  ])("keeps %s intervention authoritative after a script completes", async (intervention) => {
    const f = await fixture(policy);
    const result = await f.run(
      { observation_id: f.first.observation_id },
      "tool.evaluate",
      async (runner) => {
        await runner.send(7, "Runtime.evaluate", { expression: "save()" });
        if (intervention === "human") {
          // Polling can discover input after its short quiet window has elapsed.
          // Its authority revision still revokes the completed action's decision.
          f.change({ human: 1, lastInput: 0 }, false);
        }
        if (intervention === "hold" || intervention === "hold-resume") {
          await f.controller.control(7, f.controller.view(7)!.revision, "hold");
          if (intervention === "hold-resume")
            await f.controller.control(7, f.controller.view(7)!.revision, "resume");
          f.controller.invalidate(7);
        }
        if (intervention === "stop") f.controller.stopSession("s");
        if (intervention === "cancel") f.abort.abort();
        return { ok: true, tab_id: 7, value: "saved" };
      },
    );
    expect(result).toMatchObject({
      code:
        intervention === "stop"
          ? "user_aborted"
          : intervention === "cancel"
            ? "cancelled"
            : "permission_denied",
      data: { effect_state: "unknown" },
    });
    expect(await f.run()).toHaveProperty("code");
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("blocks additional input after a frame changes even if a handler swallows the error", async () => {
    const f = await fixture(policy);
    expect(
      await f.run({}, "tool.click", async (runner) => {
        await runner.send(7, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
        f.controller.invalidate(7);
        await expect(runner.send(7, "Input.insertText", { text: "stale" })).rejects.toThrow();
        return { tab_id: 7 };
      }),
    ).toMatchObject({ code: "permission_denied", data: { effect_state: "unknown" } });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it.each([
    ["timeout", { code: "timeout", message: "script did not complete" }],
    [
      "exception",
      { ok: false, tab_id: 7, error: { text: "script threw after changing the frame" } },
    ],
  ])("keeps a script %s during document replacement uncertain", async (_failure, receipt) => {
    const f = await fixture(policy);
    expect(
      await f.run({ observation_id: f.first.observation_id }, "tool.evaluate", async (runner) => {
        await runner.send(7, "Runtime.evaluate", { expression: "save()" });
        f.controller.invalidate(7);
        f.change({ document: "next" }, false);
        return receipt;
      }),
    ).toMatchObject({ code: "permission_denied", data: { effect_state: "unknown" } });
    expect(await f.run()).toHaveProperty("code");
    expect(f.send).toHaveBeenCalledOnce();
  });
});

describe("negotiated target control", () => {
  it("allows repeated actions beside live fields without any private VOM captures", async () => {
    const f = await fixture();
    for (let tick = 1; tick <= 3; tick++) {
      f.change({
        structure: tick,
        fields: [{ label: "Counter in the same form", value: String(tick) }],
      });
      expect(await f.run()).toEqual({});
    }
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(captureVomObservation).not.toHaveBeenCalled();
    expect(handleSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps control valid across supplementary observations and another sync", async () => {
    const f = await fixture();
    f.session.refStore.replace([["e8", { tabId: 7, backendNodeId: 8 }]]);
    expect(await f.run({}, "tool.snapshot", async () => ({ text: "details" }))).toEqual({
      text: "details",
    });
    const second = await f.sync();
    expect(second.context_id).toBe(f.first.context_id);
    expect(second.observation_id).not.toBe(f.first.observation_id);
    expect(await f.run()).toEqual({});
  });

  it("keeps a valid receipt when a supplementary sync cannot produce its snapshot", async () => {
    const f = await fixture();
    f.change({ structure: 1 });
    vi.mocked(handleSnapshot).mockResolvedValueOnce({
      code: "timeout",
      message: "capture timed out",
    } as never);
    expect(await f.sync()).toMatchObject({ code: "timeout" });
    expect(await f.run()).toEqual({});
  });

  it.each([
    true,
    false,
  ])("revokes stale decisions after human participation (notification %s)", async (notify) => {
    const f = await fixture();
    f.change({ human: 1, lastInput: 10_000 }, notify);
    expect(await f.run()).toMatchObject({ data: { effect_state: "none", phase: "control" } });
    expect(f.send).not.toHaveBeenCalled();
    f.advance();
    const next = await f.sync();
    expect(next.context_id).not.toBe(f.first.context_id);
    expect(await f.run()).toMatchObject({ data: { reason: "control_context_invalid" } });
    expect(await f.run({ context_id: next.context_id })).toEqual({});
  });

  it("fences input if the user takes control during target checking", async () => {
    const f = await fixture();
    vi.mocked(checkActionTarget).mockImplementationOnce(async () => {
      f.change({ human: 1, editing: true });
      return undefined;
    });
    expect(await f.run()).toMatchObject({
      data: { reason: "human_intervention", effect_state: "none" },
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("requires a new receipt after document replacement", async () => {
    const f = await fixture();
    f.change({ document: "replacement" }, false);
    expect(await f.run()).toMatchObject({
      data: { reason: "document_changed", effect_state: "none" },
    });
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.sync()).context_id).not.toBe(f.first.context_id);
  });

  it("reports the exact business fact and does not change the caller's expected value", async () => {
    const f = await fixture();
    const checks = [{ target: "#price", field: "text", equals: "$100" }];
    const error = {
      code: "permission_denied" as const,
      message: "Price changed",
      data: {
        reason: "precondition_failed" as const,
        phase: "precondition",
        effect_state: "none" as const,
        target: "#price",
        field: "text",
        expected: "$100",
        actual: "$200",
      },
    };
    vi.mocked(checkExpectations).mockResolvedValueOnce(error);
    expect(await f.run({ expect: checks })).toEqual(error);
    expect(f.send).not.toHaveBeenCalled();
    expect(checks[0].equals).toBe("$100");
    expect(await f.run()).toEqual({});
  });

  it("validates again immediately before input and never replays an action", async () => {
    const f = await fixture();
    vi.mocked(checkExpectations)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        code: "permission_denied",
        message: "Recipient changed during preparation",
        data: { reason: "precondition_failed", effect_state: "none" },
      });
    expect(await f.run()).toMatchObject({
      data: { reason: "precondition_failed", effect_state: "none" },
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(checkExpectations).toHaveBeenCalledTimes(2);
  });

  it("requires explicit immutable observations for scripts and consumes only that observation", async () => {
    const f = await fixture();
    const script = (runner: CdpRunner) =>
      runner.send(7, "Runtime.evaluate", { expression: "submit()" });
    expect(await f.run({}, "tool.evaluate", script)).toMatchObject({
      data: { reason: "observation_required" },
    });
    f.session.refStore.replace([["e8", { tabId: 7, backendNodeId: 8 }]]);
    expect(
      await f.run({ observation_id: f.first.observation_id }, "tool.evaluate", script),
    ).toEqual({});
    expect(
      await f.run({ observation_id: f.first.observation_id }, "tool.evaluate", script),
    ).toMatchObject({ data: { reason: "observation_required" } });
    expect(await f.run()).toEqual({});
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("never learns live-text tolerance for an opaque script supplied with a ref", async () => {
    let tick = 0;
    const scene = (): VomScene => ({
      viewport: { width: 800, height: 600 },
      nodes: [
        { id: 1, parentId: null, tag: "main", role: "main" },
        { id: 2, parentId: 1, tag: "form", role: "form" },
        { id: 4, parentId: 2, tag: "button", role: "button", name: "Continue" },
        { id: 5, parentId: 1, tag: "span", text: `10:00:0${tick}` },
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
    const snapshots = vi.mocked(handleSnapshot);
    const captures = vi.mocked(captureVomObservation);
    const originalSnapshot = snapshots.getMockImplementation()!;
    snapshots.mockImplementation(async (_manager, _params, deps) => {
      deps!.onScene?.(scene());
      return { text: `Continue; clock ${tick}`, ref_count: 1, tab_id: 7, truncated: false };
    });
    captures.mockImplementation(async (_cdp, _tab, _url, options) => {
      options?.onScene?.(scene());
      return {} as Awaited<ReturnType<typeof captureVomObservation>>;
    });
    try {
      const f = await fixture();
      let observation = f.first.observation_id;
      const script = (runner: CdpRunner) =>
        runner.send(7, "Runtime.evaluate", { expression: "submit()" });
      for (let attempt = 0; attempt < 3; attempt++) {
        tick++;
        f.change({});
        expect(
          await f.run({ ref: "e1", observation_id: observation }, "tool.evaluate", script),
        ).toMatchObject({ data: { reason: "observation_changed", effect_state: "none" } });
        expect(f.send).not.toHaveBeenCalled();
        if (attempt < 2) {
          const next = await f.sync();
          expect(next.context_id).toBe(f.first.context_id);
          expect(next.observation_id).not.toBe(observation);
          observation = next.observation_id;
        }
      }
      // The same unrelated clock remains harmless to a genuinely targeted DOM action.
      expect(await f.run()).toEqual({});
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(captures).toHaveBeenCalledTimes(3);
      expect(snapshots).toHaveBeenCalledTimes(3);
    } finally {
      snapshots.mockImplementation(originalSnapshot);
      captures.mockReset();
    }
  });

  it("never upgrades a context silently to a newly synchronized strict baseline", async () => {
    const f = await fixture();
    const second = await f.sync();
    expect(second.context_id).toBe(f.first.context_id);
    expect(await f.run({ observation_id: f.first.observation_id }, "tool.evaluate")).toMatchObject({
      data: { reason: "observation_required" },
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("rejects policy changes and legacy implicit dependencies explicitly", async () => {
    const f = await fixture();
    expect(await f.sync("strict")).toMatchObject({
      code: "invalid_params",
      message: expect.stringContaining("fixed"),
    });
    expect(await f.run({ depends_on: ["#price"] })).toMatchObject({
      code: "invalid_params",
      message: expect.stringContaining("expect"),
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("negotiates auto for a new session and preserves an explicitly strict session", async () => {
    const f = await fixture();
    expect(await f.sync("auto")).toMatchObject({
      control_policy: "target",
      context_id: f.first.context_id,
    });
    f.controller.release("s");
    f.session.controlPolicy = undefined;
    expect(await f.sync("auto")).toMatchObject({ control_policy: "target" });
    f.controller.release("s");
    f.session.controlPolicy = undefined;
    expect(await f.sync("strict")).toMatchObject({ control_policy: "strict" });
    expect(await f.sync("auto")).toMatchObject({ control_policy: "strict" });
  });

  it.each([
    "tool.focus",
    "tool.blur",
    "tool.hover",
    "tool.scroll_to",
  ])("checks conditions at the primary effect of %s", async (method) => {
    const f = await fixture();
    const effects: Record<string, string> = {
      "tool.focus": "DOM.focus",
      "tool.blur": "Runtime.callFunctionOn",
      "tool.hover": "Input.dispatchMouseEvent",
      "tool.scroll_to": "DOM.scrollIntoViewIfNeeded",
    };
    vi.mocked(checkExpectations)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        code: "permission_denied",
        message: "Changed during preparation",
        data: { reason: "precondition_failed", effect_state: "none" },
      });
    expect(
      await f.run({ ref: "e1" }, method, (runner) => runner.send(7, effects[method], {})),
    ).toMatchObject({ data: { reason: "precondition_failed", effect_state: "none" } });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("revokes the receipt after a handler reports an unknown result", async () => {
    const f = await fixture();
    expect(
      await f.run({}, "tool.click", async (runner) => {
        await runner.send(7, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          x: 10,
          y: 20,
        });
        return { code: "cdp_failed", message: "Cleanup failed", data: { effect_state: "unknown" } };
      }),
    ).toMatchObject({
      data: { effect_state: "unknown", recovery: expect.stringContaining("synchronize") },
    });
    expect(await f.run()).toMatchObject({ data: { reason: "control_context_invalid" } });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("requires reconciliation when a condition fails after a preparation effect", async () => {
    const f = await fixture();
    vi.mocked(checkExpectations)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        code: "permission_denied",
        message: "Recipient changed after scrolling",
        data: {
          reason: "precondition_failed",
          effect_state: "none",
          expected: "Alice",
          actual: "Bob",
          recovery: "A new control context is not required.",
        },
      });
    expect(
      await f.run({}, "tool.click", async (runner) => {
        await runner.send(7, "DOM.scrollIntoViewIfNeeded", { backendNodeId: 4 });
        return runner.send(7, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          x: 10,
          y: 20,
        });
      }),
    ).toMatchObject({
      data: {
        reason: "precondition_failed",
        effect_state: "unknown",
        expected: "Alice",
        actual: "Bob",
        recovery: expect.stringContaining("synchronize"),
      },
    });
    expect(f.send).toHaveBeenCalledExactlyOnceWith(7, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId: 4,
    });
    expect(await f.run()).toMatchObject({ data: { reason: "control_context_invalid" } });
    expect(f.send).toHaveBeenCalledTimes(1);
    const next = await f.sync();
    expect(next.context_id).not.toBe(f.first.context_id);
    expect(await f.run({ context_id: next.context_id })).toEqual({});
  });

  it("waits only for initial target readiness and never repeats input", async () => {
    const f = await fixture();
    f.readFrames.mockClear();
    vi.mocked(checkActionTarget).mockResolvedValueOnce({
      code: "permission_denied",
      message: "disabled",
      data: { reason: "target_disabled", effect_state: "none" },
    });
    expect(await f.run({ timeout_ms: 200 })).toEqual({});
    expect(f.send).toHaveBeenCalledTimes(1);
    // Collect once at entry and once at dispatch, independently of readiness retries.
    expect(f.readFrames).toHaveBeenCalledTimes(2);
  });

  it("rechecks only the target while it is becoming ready", async () => {
    const f = await fixture();
    f.readFrames.mockClear();
    vi.mocked(handleSnapshot).mockClear();
    for (let i = 0; i < 3; i++)
      vi.mocked(checkActionTarget).mockResolvedValueOnce({
        code: "permission_denied",
        message: "disabled",
        data: { reason: "target_disabled", effect_state: "none" },
      });
    expect(await f.run({ timeout_ms: 1_000 })).toEqual({});
    expect(checkActionTarget).toHaveBeenCalledTimes(5);
    expect(f.readFrames).toHaveBeenCalledTimes(2);
    expect(handleSnapshot).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    false,
    true,
  ])("checks unreported human input in an iframe at dispatch (existing: %s)", async (existing) => {
    const f = await fixture();
    const frames = await f.readFrames();
    const child = { ...frames.get(0)!, document: "child" };
    if (existing) frames.set(2, child);
    f.readFrames.mockImplementation(async () => structuredClone(frames));
    const observation = await f.sync();
    f.readFrames.mockClear();
    vi.mocked(checkActionTarget).mockImplementationOnce(async () => {
      // No push notification: the final collector must catch even quiet input
      // in an existing frame, or activity in a frame inserted during the wait.
      frames.set(2, { ...child, revision: 1, human: 1, editing: !existing });
      return {
        code: "permission_denied",
        message: "disabled",
        data: { reason: "target_disabled", effect_state: "none" },
      };
    });
    expect(await f.run({ context_id: observation.context_id, timeout_ms: 1_000 })).toMatchObject({
      code: "permission_denied",
      data: { effect_state: "none", phase: "control" },
    });
    expect(f.readFrames).toHaveBeenCalledTimes(2);
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([
    "navigation",
    "collector failure",
  ])("blocks dispatch after %s during a readiness wait", async (change) => {
    const f = await fixture();
    f.readFrames.mockClear();
    vi.mocked(checkActionTarget).mockImplementationOnce(async () => {
      if (change === "navigation") f.change({ document: "next-document" }, false);
      else f.readFrames.mockRejectedValueOnce(new Error("Collector unavailable"));
      return {
        code: "permission_denied",
        message: "hidden",
        data: { reason: "target_hidden", effect_state: "none" },
      };
    });
    expect(await f.run({ timeout_ms: 1_000 })).toMatchObject({
      code: "permission_denied",
      data: { effect_state: "none", phase: "control" },
    });
    expect(f.readFrames).toHaveBeenCalledTimes(2);
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([
    "tool.click",
    "tool.download",
    "tool.upload",
    "tool.wheel",
  ])("preserves the selector in a pinned %s receipt", async (method) => {
    const f = await fixture();
    const request = {
      id: "selector-action",
      method,
      params: {
        session_id: "s",
        tab_id: 7,
        context_id: f.first.context_id,
        selector: "#confirm",
      } as Record<string, unknown>,
    };
    const result = await f.controller.run(request, f.cdp, f.signal, async (runner) => {
      expect(request.params.selector).toBeUndefined();
      expect(request.params.ref).toMatch(/^e\d+$/);
      expect(f.session.refStore.resolveEntry(request.params.ref as string)).toMatchObject({
        backendNodeId: 4,
      });
      await runner.send(7, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        x: 10,
        y: 20,
      });
      return { tab_id: 7, used_ref: request.params.ref };
    });
    expect(result).toEqual({
      tab_id: 7,
      used_ref: request.params.ref,
      used_selector: "#confirm",
    });
    expect(resolveActionTarget).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("preserves handler failures without adding successful selector metadata", async () => {
    const f = await fixture();
    const error = {
      code: "not_found",
      message: "The pinned node was removed",
      data: {
        reason: "target_detached",
        effect_state: "none",
        recovery: "Observe the new target.",
      },
    };
    const result = await f.run(
      { ref: undefined, selector: "#confirm" },
      "tool.click",
      async () => error,
    );
    expect(result).toMatchObject(error);
    expect(result).not.toHaveProperty("used_selector");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("keeps business expectations immediate instead of waiting for a price to change back", async () => {
    const f = await fixture();
    vi.mocked(checkExpectations).mockResolvedValueOnce({
      code: "permission_denied",
      message: "Changed price",
      data: { reason: "precondition_failed", effect_state: "none" },
    });
    expect(await f.run({ timeout_ms: 30_000 })).toMatchObject({
      data: { reason: "precondition_failed" },
    });
    expect(checkExpectations).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("gives human takeover priority over a target that is still becoming ready", async () => {
    const f = await fixture();
    vi.mocked(checkActionTarget).mockImplementationOnce(async () => {
      f.change({ human: 1, editing: true });
      return {
        code: "permission_denied",
        message: "hidden",
        data: { reason: "target_hidden", effect_state: "none" },
      };
    });
    expect(await f.run({ timeout_ms: 200 })).toMatchObject({
      data: { reason: "human_intervention", effect_state: "none" },
    });
    expect(f.send).not.toHaveBeenCalled();
  });
});
