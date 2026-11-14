import type { VomScene } from "@browser-skill/vom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { scrollNodeIntoView } from "@/tools/element-geometry";
import { resolveActionTarget } from "@/tools/interaction";
import { captureVomObservation, handleSnapshot } from "@/tools/observation";
import type { CdpRunner } from "@/tools/shared";
import {
  ActionCheckError,
  actionError,
  checkActionTarget,
  checkExpectations,
} from "./action-checks";
import { CooperationController, type CooperationDeps } from "./controller";
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
    handle: { tabId: 7, frameId: "", loaderId: "", backendNodeId: 4 },
    usedRef: "e1",
  });
  const send = vi.fn(async () => ({}));
  const cdp = { send } as CdpRunner;
  const readFrames = vi.fn<CooperationDeps["readFrames"]>(async () => ({
    frames: new Map([[0, structuredClone(frame)]]),
    gaps: [],
  }));
  const controller = new CooperationController({
    sessions,
    readFrames,
    resumeFrames: async () => {
      frame = { ...frame, editing: false, revision: frame.revision + 1 };
    },
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

describe("action cancellation diagnostics", () => {
  it("reports a precondition cancellation before any page effect", async () => {
    const f = await fixture();
    const invoke = vi.fn();
    vi.mocked(checkActionTarget).mockImplementationOnce(async () => {
      f.abort.abort();
      return undefined;
    });
    expect(await f.run({ ref: "e1" }, "tool.fill", invoke)).toMatchObject({
      code: "cancelled",
      data: { phase: "precondition", effect_state: "none" },
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("reports execution uncertainty when cancellation follows dispatch", async () => {
    const f = await fixture();
    expect(
      await f.run({ ref: "e1" }, "tool.fill", async (runner) => {
        await runner.send(7, "Input.insertText", { text: "saved" });
        f.abort.abort();
        return { tab_id: 7 };
      }),
    ).toMatchObject({
      code: "cancelled",
      data: { phase: "execution", effect_state: "unknown" },
    });
    expect(f.send).toHaveBeenCalledOnce();
  });
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
        else f.readFrames.mockResolvedValueOnce({ frames: new Map(), gaps: [] });
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

  it.each([
    ["inserted", "poll"],
    ["inserted", "push"],
    ["navigated", "poll"],
    ["navigated", "push"],
  ])("preserves human work in a %s iframe discovered by %s, even after quiet", async (kind, delivery) => {
    const f = await fixture(policy);
    const { frames } = await f.readFrames.mock.results.at(-1)!.value;
    const child = { ...frames.get(0)!, document: "child" };
    if (kind === "navigated") frames.set(2, child);
    f.readFrames.mockImplementation(async () => ({ frames: structuredClone(frames), gaps: [] }));
    const observation = await f.sync();
    const lease = f.readFrames.mock.calls.at(-1)![2];
    const result = await f.run(
      { context_id: observation.context_id, observation_id: observation.observation_id },
      "tool.evaluate",
      async (runner) => {
        await runner.send(7, "Runtime.evaluate", { expression: "openFrame()" });
        const human = { ...child, document: "new-child", human: 1, lastInput: 10_000 };
        frames.set(2, human);
        if (delivery === "push") f.controller.receive(7, 2, human, lease);
        else await f.controller.observeTab(7);
        f.advance();
        return { ok: true, tab_id: 7 };
      },
    );
    expect(result).toMatchObject({
      code: "permission_denied",
      data: {
        reason: policy === "target" ? "human_intervention" : "cooperation_sync_required",
        effect_state: "unknown",
      },
    });
    expect(f.session.agentCreatedTabs.has(7)).toBe(false);
    expect(f.session.observedTabs?.has(7)).toBe(true);
    expect(f.send).toHaveBeenCalledOnce();
  });

  it.each([
    { human: 0, lastInput: 0 },
    { human: 1, lastInput: 0 },
  ])("does not preserve new frame history without recent human input: %j", async (history) => {
    const f = await fixture(policy);
    const { frames } = await f.readFrames.mock.results.at(-1)!.value;
    const receipt = { ok: true, tab_id: 7 };
    expect(
      await f.run({ observation_id: f.first.observation_id }, "tool.evaluate", async (runner) => {
        await runner.send(7, "Runtime.evaluate", { expression: "openFrame()" });
        frames.set(2, { ...frames.get(0)!, document: "new-child", ...history });
        f.readFrames.mockImplementation(async () => ({
          frames: structuredClone(frames),
          gaps: [],
        }));
        return receipt;
      }),
    ).toEqual(receipt);
    expect(f.session.agentCreatedTabs.has(7)).toBe(true);
  });

  it("does not let an unknown document replace collected frames or repeatedly revoke control", async () => {
    const f = await fixture(policy);
    const frame = (await f.readFrames.mock.results.at(-1)!.value).frames.get(0)!;
    const lease = f.readFrames.mock.calls.at(-1)![2];
    const human = { ...frame, document: "uncollected", human: 1, lastInput: 10_000 };
    const guard = f.controller.controlGuard("s", 7);
    f.controller.receive(7, 0, human, "old-lease");
    expect(guard).not.toThrow();
    expect(f.session.agentCreatedTabs.has(7)).toBe(true);
    f.controller.receive(7, 0, human, lease);
    expect(guard).toThrow();
    // The current collected document never had human input, so sync is ready
    // immediately. A duplicate old message must not invalidate that new decision.
    const next = await f.sync();
    expect(next.context_id).toEqual(expect.any(String));
    const nextGuard = f.controller.controlGuard("s", 7);
    f.controller.receive(7, 0, human, lease);
    expect(nextGuard).not.toThrow();
    expect(await f.run({ context_id: next.context_id })).toEqual({});
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

  it("preserves set_file_input_failed when upload cleanup detaches the debugger", async () => {
    const f = await fixture(policy);
    f.cdp.detach = vi.fn(async (tabId: number) => {
      // Production background.ts wires ChromiumCdp.onDocumentChanged to
      // invalidateTabRefs + cooperation.invalidate on every debugger detach.
      f.session.refStore.invalidateTab(tabId);
      f.controller.invalidate(tabId);
    });
    const refusal = {
      code: "cdp_failed" as const,
      message: "DOM.setFileInputFiles failed: -32000 Not allowed",
      data: {
        reason: "set_file_input_failed",
        phase: "set_files",
        effect_state: "unknown" as const,
        recovery:
          "Inspect the page before retrying; the file input may or may not have been updated.",
      },
    };

    const result = await f.run({ ref: "e1" }, "tool.upload", async (runner) => {
      await runner.send(7, "Page.setInterceptFileChooserDialog", { enabled: true });
      await runner.send(7, "DOM.setFileInputFiles", {
        backendNodeId: 4,
        files: ["/stage/tiny.txt"],
      });
      await runner.detach?.(7);
      return refusal;
    });

    expect(result).toEqual(refusal);
    expect(f.cdp.detach).toHaveBeenCalledExactlyOnceWith(7, undefined);
    expect(f.controller.view(7)).toMatchObject({ mode: "syncing" });
    expect(await f.run()).toMatchObject({
      code: "permission_denied",
      data: {
        reason: policy === "target" ? "control_context_invalid" : "cooperation_sync_required",
        effect_state: "none",
      },
    });
    const next = await f.sync();
    expect(next.context_id).not.toBe(f.first.context_id);
  });

  it("preserves file_drop_failed with effect_state none when drag_enter is rejected", async () => {
    const f = await fixture(policy);
    const refusal = {
      code: "cdp_failed" as const,
      message: "Input.dispatchDragEvent failed: -32000 Not allowed",
      data: {
        reason: "file_drop_failed",
        phase: "drag_enter",
        effect_state: "none" as const,
        recovery:
          "Retry the drop when the target is ready, or upload through a file input instead.",
      },
    };

    const result = await f.run({ ref: "e1", mode: "drop" }, "tool.upload", async (runner) => {
      await runner.send(7, "Runtime.callFunctionOn", {
        objectId: "drop-target",
        functionDeclaration: "function() { return true; }",
      });
      return refusal;
    });

    expect(result).toEqual(refusal);
    if (policy === "target") expect(await f.run()).toEqual({});
  });

  it("preserves an upload refusal when the post-action collector is unavailable", async () => {
    const f = await fixture(policy);
    const refusal = {
      code: "invalid_params" as const,
      message: "Target did not open a file chooser and is not an <input type=file>",
      data: {
        reason: "upload_target_not_file_input",
        phase: "open_chooser",
        effect_state: "none" as const,
        recovery: "Choose the <input type=file> or the control that opens the file chooser.",
      },
    };

    const result = await f.run({ ref: "e1" }, "tool.upload", async (runner) => {
      await runner.send(7, "Page.setInterceptFileChooserDialog", { enabled: true });
      f.readFrames.mockRejectedValueOnce(new Error("frame is loading"));
      return refusal;
    });

    expect(result).toEqual(refusal);
    expect(f.controller.view(7)).toMatchObject({ mode: "unavailable" });
    expect(await f.run()).toMatchObject({ code: "permission_denied" });
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

  it("publishes main-document control when a carousel frame navigates during sync", async () => {
    const f = await fixture();
    const { frames } = await f.readFrames.mock.results.at(-1)!.value;
    const slide = { ...frames.get(0)!, document: "slide-1" };
    frames.set(2, slide);
    f.readFrames.mockImplementation(async () => ({ frames: structuredClone(frames), gaps: [] }));
    vi.mocked(handleSnapshot).mockImplementationOnce(async (_sessions, _params, deps) => {
      deps?.onScene?.({ nodes: [], viewport: { width: 800, height: 600 }, rootFrameId: "root" });
      frames.set(2, { ...slide, document: "slide-2" });
      return { text: "@e1 button Continue", tab_id: 7 } as never;
    });

    const current = await f.sync();
    expect(current).toMatchObject({
      context_id: f.first.context_id,
      observation_id: expect.any(String),
    });
    f.session.refStore.set("e1", 4, { tabId: 7, frameId: "root" });
    expect(await f.run({ observation_id: current.observation_id }, "tool.evaluate")).toMatchObject({
      data: { reason: "document_changed", effect_state: "none" },
    });
    expect(f.send).not.toHaveBeenCalled();
    const applied = await f.run({ expect: [{ target: "@e1", field: "text", equals: "Continue" }] });
    expect(applied).toEqual({});
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("still requires a fresh observation for iframe targets and iframe conditions", async () => {
    const f = await fixture();
    const { frames } = await f.readFrames.mock.results.at(-1)!.value;
    const slide = { ...frames.get(0)!, document: "slide-1" };
    frames.set(2, slide);
    f.readFrames.mockImplementation(async () => ({ frames: structuredClone(frames), gaps: [] }));
    const synced = await f.sync();
    f.session.refStore.set("e2", 5, { tabId: 7, frameId: "child" });
    frames.set(2, { ...slide, document: "slide-2" });

    const context_id = synced.context_id;
    const inChild = { ref: "e2" };
    const inMain = { ref: undefined, selector: "#continue" };
    for (const rejected of [
      await f.run({ context_id, ...inChild }),
      await f.run({ context_id, source: inMain, target: inChild }, "tool.drag"),
      await f.run({
        context_id,
        ...inMain,
        expect: [{ target: "@e2", field: "text", equals: "Slide 1" }],
      }),
    ]) {
      expect(rejected).toMatchObject({
        data: { reason: "document_changed", effect_state: "none" },
      });
    }
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.run({ context_id, ...inMain })).toEqual({ used_selector: "#continue" });
    expect(f.send).toHaveBeenCalledOnce();
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

  it.each([
    "held",
    "editing",
  ] as const)("reports control_context_invalid and auto-resumes %s on the next sync after an idle gap", async (mode) => {
    const f = await fixture();
    if (mode === "held") {
      await f.controller.control(7, f.controller.view(7)!.revision, "hold");
    } else {
      f.change({ human: 1, editing: true, lastInput: 10_000 });
    }
    f.advance();
    expect(await f.run()).toMatchObject({
      data: { reason: "control_context_invalid", phase: "control", effect_state: "none" },
    });
    expect(f.send).not.toHaveBeenCalled();
    const next = await f.sync();
    expect(next).toMatchObject({
      context_id: expect.any(String),
      state: { mode: "ready" },
    });
    expect(next.context_id).not.toBe(f.first.context_id);
    expect(await f.run({ context_id: next.context_id })).toEqual({});
    expect(f.send).toHaveBeenCalledOnce();
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

  it("validates once at entry and never replays an action", async () => {
    const f = await fixture();
    vi.mocked(checkExpectations).mockResolvedValueOnce({
      code: "permission_denied",
      message: "Recipient changed before dispatch",
      data: { reason: "precondition_failed", effect_state: "none" },
    });
    expect(await f.run()).toMatchObject({
      data: { reason: "precondition_failed", effect_state: "none" },
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(checkExpectations).toHaveBeenCalledTimes(1);
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

  it("names the sync reply's top-level observation_id when given a ref-map token", async () => {
    const f = await fixture();
    const script = (runner: CdpRunner) =>
      runner.send(7, "Runtime.evaluate", { expression: "submit()" });
    const nestedObservationId = f.session.refStore.observationId;
    expect(nestedObservationId).not.toBe(f.first.observation_id);
    expect(
      await f.run({ observation_id: nestedObservationId }, "tool.evaluate", script),
    ).toMatchObject({
      data: {
        reason: "observation_required",
        effect_state: "none",
        recovery: expect.stringContaining("top-level observation_id"),
      },
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(
      await f.run({ observation_id: f.first.observation_id }, "tool.evaluate", script),
    ).toEqual({});
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
  ])("checks conditions at entry before %s", async (method) => {
    const f = await fixture();
    const effects: Record<string, string> = {
      "tool.focus": "DOM.focus",
      "tool.blur": "Runtime.callFunctionOn",
      "tool.hover": "Input.dispatchMouseEvent",
      "tool.scroll_to": "DOM.scrollIntoViewIfNeeded",
    };
    vi.mocked(checkExpectations).mockResolvedValueOnce({
      code: "permission_denied",
      message: "Changed before primary effect",
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

  it("requires reconciliation when human intervention arrives after a preparation effect", async () => {
    const f = await fixture();
    expect(
      await f.run({}, "tool.click", async (runner) => {
        await runner.send(7, "DOM.scrollIntoViewIfNeeded", { backendNodeId: 4 });
        f.change({ human: 1, lastInput: 10_000 });
        return runner.send(7, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          x: 10,
          y: 20,
        });
      }),
    ).toMatchObject({
      data: {
        reason: "human_intervention",
        effect_state: "unknown",
        press_sent: false,
        recovery: expect.stringContaining("synchronize"),
      },
    });
    expect(f.send).toHaveBeenCalledExactlyOnceWith(7, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId: 4,
    });
    expect(await f.run()).toMatchObject({ data: { reason: "human_intervention" } });
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance();
    expect(await f.run()).toMatchObject({ data: { reason: "control_context_invalid" } });
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

  it("blocks entry preconditions before running any scroll fallback", async () => {
    const f = await fixture();
    f.send.mockResolvedValue({ object: { objectId: "button" } });
    vi.mocked(checkExpectations).mockResolvedValueOnce({
      code: "permission_denied",
      message: "Changed price",
      data: { reason: "precondition_failed", phase: "precondition", effect_state: "none" },
    });
    const result = await f.run({}, "tool.click", async (runner) => {
      await scrollNodeIntoView(runner, 7, 4);
      return runner.send(7, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
      });
    });
    expect(result).toMatchObject({
      data: { reason: "precondition_failed", phase: "precondition", effect_state: "none" },
    });
    expect(checkExpectations).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("reports invalidated control instead of the previous readiness failure", async () => {
    const f = await fixture();
    vi.mocked(checkActionTarget).mockImplementationOnce(async () => {
      f.controller.invalidate(7);
      return {
        code: "permission_denied",
        message: "hidden",
        data: { reason: "target_hidden", effect_state: "none" },
      };
    });
    expect(await f.run({ timeout_ms: 200 })).toMatchObject({
      data: { reason: "control_context_invalid", phase: "control", effect_state: "none" },
    });
    expect(checkActionTarget).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([
    { code: "not_found", message: "No match", data: { reason: "selector_not_found" } },
    { code: "invalid_params", message: "Ambiguous selector" },
  ] as const)("marks target resolution failure as unsent: $message", async (error) => {
    const f = await fixture();
    vi.mocked(resolveActionTarget).mockResolvedValueOnce(error);
    expect(await f.run({ ref: undefined, selector: ".button" })).toMatchObject({
      code: error.code,
      message: error.message,
      data: {
        reason: error.data?.reason ?? "target_unavailable",
        phase: "target",
        effect_state: "none",
        recovery: expect.any(String),
      },
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("marks a missing drag destination as unsent", async () => {
    const f = await fixture();
    const source = await resolveActionTarget(
      f.cdp,
      f.session,
      { tabId: 7, windowId: 100, active: true },
      { ref: "e1" },
      "test",
    );
    vi.mocked(resolveActionTarget)
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce({
        code: "not_found",
        message: "No destination",
        data: { reason: "selector_not_found", recovery: "Choose an existing destination." },
      });
    expect(
      await f.run({ source: { ref: "e1" }, target: { selector: "#missing" } }, "tool.drag"),
    ).toMatchObject({
      code: "not_found",
      data: {
        reason: "selector_not_found",
        phase: "target",
        effect_state: "none",
        recovery: "Choose an existing destination.",
      },
    });
    expect(f.send).not.toHaveBeenCalled();
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
    expect(checkActionTarget).toHaveBeenCalledTimes(4);
    expect(f.readFrames).toHaveBeenCalledTimes(2);
    expect(handleSnapshot).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    false,
    true,
  ])("checks unreported human input in an iframe at dispatch (existing: %s)", async (existing) => {
    const f = await fixture();
    const { frames } = await f.readFrames.mock.results.at(-1)!.value;
    const child = { ...frames.get(0)!, document: "child" };
    if (existing) frames.set(2, child);
    f.readFrames.mockImplementation(async () => ({ frames: structuredClone(frames), gaps: [] }));
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

describe("whether a click was pressed", () => {
  const covered = () =>
    new ActionCheckError(
      actionError("target_covered", "covered", "target", "Synchronize before clicking."),
    );

  it("says so when a click failed after only preparing to press", async () => {
    const f = await fixture();
    const result = await f.run({}, "tool.click", async (runner) => {
      await runner.send(7, "DOM.scrollIntoViewIfNeeded", { backendNodeId: 4 });
      await runner.send(7, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 20 });
      throw covered();
    });
    expect(result).toMatchObject({
      data: { reason: "target_covered", effect_state: "unknown", press_sent: false },
    });
  });

  it("makes no such claim once the press was sent", async () => {
    const f = await fixture();
    const result = (await f.run({}, "tool.click", async (runner) => {
      await runner.send(7, "DOM.scrollIntoViewIfNeeded", { backendNodeId: 4 });
      await runner.send(7, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        x: 10,
        y: 20,
      });
      throw covered();
    })) as { data: Record<string, unknown> };
    expect(result.data.effect_state).toBe("unknown");
    expect(result.data).not.toHaveProperty("press_sent");
  });

  it("makes no such claim for an action whose effect is not a press", async () => {
    const f = await fixture();
    const result = (await f.run({ ref: "e1" }, "tool.fill", async (runner) => {
      await runner.send(7, "DOM.scrollIntoViewIfNeeded", { backendNodeId: 4 });
      throw covered();
    })) as { data: Record<string, unknown> };
    expect(result.data.effect_state).toBe("unknown");
    expect(result.data).not.toHaveProperty("press_sent");
  });
});

it("passive DOM reads do not revive contexts retained only as strict baselines", async () => {
  const f = await fixture();
  const invoke = vi.fn(async () => ({ scope: "current_dom" }));
  f.controller.invalidate(7);
  expect(await f.run({}, "tool.read", invoke)).toMatchObject({
    data: { reason: "control_context_invalid", effect_state: "none" },
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(await f.run({ context_id: undefined }, "tool.read", invoke)).toEqual({
    scope: "current_dom",
  });
  expect(invoke).toHaveBeenCalledOnce();
});

describe("pre-write validation failures", () => {
  it("keep the control context when select rejects an option after focusing", async () => {
    const f = await fixture();
    const result = await f.run({ ref: "e1", values: ["zz"] }, "tool.select", async (runner) => {
      await runner.send(7, "DOM.scrollIntoViewIfNeeded", { backendNodeId: 4 });
      await runner.send(7, "DOM.focus", { backendNodeId: 4 });
      return {
        code: "invalid_params",
        message: "option value zz not found in <select>",
        data: { reason: "option_not_found", effect_state: "none", phase: "precondition" },
      };
    });
    expect(result).toMatchObject({
      code: "invalid_params",
      data: { reason: "option_not_found", effect_state: "none", phase: "precondition" },
    });
    expect((result as { data: Record<string, unknown> }).data).not.toHaveProperty("press_sent");
    // The same decision remains usable for the corrected value.
    expect(
      await f.run({ ref: "e1", values: ["us"] }, "tool.select", async () => ({ tab_id: 7 })),
    ).toEqual({ tab_id: 7 });
  });
});

describe("targeted optimistic fast-path", () => {
  afterEach(() => {
    vi.mocked(checkExpectations).mockImplementation(async () => undefined);
  });

  it("skips cross-frame readFrames broadcasts and target resampling on internal CDP steps", async () => {
    const f = await fixture("target");
    f.readFrames.mockClear();
    vi.mocked(checkActionTarget).mockClear();
    vi.mocked(checkExpectations).mockClear();

    const result = await f.run({ ref: "e1" }, "tool.fill", async (runner) => {
      await runner.send(7, "DOM.resolveNode", { backendNodeId: 4 });
      await runner.send(7, "Runtime.callFunctionOn", {
        objectId: "obj-1",
        functionDeclaration: "function() { this.focus(); return true; }",
      });
      await runner.send(7, "DOM.focus", { backendNodeId: 4 });
      await runner.beginDomMutation?.();
      await runner.send(7, "Input.insertText", { text: "hello" });
      await runner.send(7, "Runtime.callFunctionOn", {
        objectId: "obj-1",
        functionDeclaration: "function() { return this.value; }",
      });
      return { tab_id: 7, value_length: 5 };
    });

    expect(result).toEqual({ tab_id: 7, value_length: 5 });
    // Entry preflight runs checkActionTarget & checkExpectations once.
    expect(checkActionTarget).toHaveBeenCalledTimes(1);
    expect(checkExpectations).toHaveBeenCalledTimes(1);
    // readFrames is called at entry refresh (undefined), once to arm beforeinput (not twice),
    // plus non-blocking clear cleanup for beforeinput.
    const armCalls = f.readFrames.mock.calls.filter(
      ([, input]) => input !== undefined && input.type !== "clear",
    );
    const pollCalls = f.readFrames.mock.calls.filter(([, input]) => input === undefined);
    expect(pollCalls).toHaveLength(1);
    expect(armCalls).toHaveLength(1);
    expect(armCalls[0]?.[1]).toMatchObject({ type: "beforeinput", text: "hello" });
  });

  it("immediately aborts internal targeted steps when push-based receive() reports human input", async () => {
    const f = await fixture("target");
    const result = await f.run({ ref: "e1" }, "tool.fill", async (runner) => {
      await runner.send(7, "DOM.focus", { backendNodeId: 4 });
      // Human intervenes via content-script push while internal scripts are running.
      f.change({ human: 1, editing: true, lastInput: 10_000 }, true);
      await runner.send(7, "Runtime.callFunctionOn", {
        objectId: "obj-1",
        functionDeclaration: "function() { this.value = ''; }",
      });
      await runner.send(7, "Input.insertText", { text: "never-sent" });
      return { tab_id: 7, value_length: 10 };
    });

    expect(result).toMatchObject({
      code: "permission_denied",
      data: { reason: "human_intervention", effect_state: "unknown" },
    });
    expect(f.send).toHaveBeenCalledExactlyOnceWith(7, "DOM.focus", { backendNodeId: 4 });
    f.advance();
    expect(await f.run()).toMatchObject({ data: { reason: "control_context_invalid" } });
  });

  it("re-verifies --expect before mousePressed when preparation hover mutates a fact", async () => {
    const f = await fixture("target");
    const expectCheck = [{ target: "#price", field: "text" as const, equals: "100" }];
    let price = "100";
    vi.mocked(checkExpectations).mockImplementation(async () =>
      price === "100"
        ? undefined
        : {
            code: "permission_denied",
            message: "Action condition 0 failed: #price text changed",
            data: { reason: "precondition_failed", phase: "precondition" },
          },
    );

    const result = await f.run({ ref: "e1", expect: expectCheck }, "tool.click", async (runner) => {
      await runner.send(7, "DOM.scrollIntoViewIfNeeded", { backendNodeId: 4 });
      await runner.send(7, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 20 });
      // Hovering over the button mutates #price in mouseover before mousePressed.
      price = "120";
      await runner.send(7, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        x: 10,
        y: 20,
      });
      return { tab_id: 7 };
    });

    expect(result).toMatchObject({
      code: "permission_denied",
      data: {
        reason: "precondition_failed",
        effect_state: "unknown",
        press_sent: false,
      },
    });
    expect(checkExpectations).toHaveBeenCalledTimes(2);
    expect(
      f.send.mock.calls.some(
        (call: unknown[]) =>
          call[1] === "Input.dispatchMouseEvent" &&
          (call[2] as { type?: string } | undefined)?.type === "mousePressed",
      ),
    ).toBe(false);
  });

  it("re-verifies --expect in beginDomMutation before marking nativeInputStarted", async () => {
    const f = await fixture("target");
    const expectCheck = [{ target: "#price", field: "text" as const, equals: "100" }];
    let price = "100";
    vi.mocked(checkExpectations).mockImplementation(async () =>
      price === "100"
        ? undefined
        : {
            code: "permission_denied",
            message: "Action condition 0 failed: #price text changed",
            data: { reason: "precondition_failed", phase: "precondition" },
          },
    );

    const result = await f.run(
      { ref: "e1", expect: expectCheck },
      "tool.select",
      async (runner) => {
        await runner.send(7, "DOM.scrollIntoViewIfNeeded", { backendNodeId: 4 });
        await runner.send(7, "DOM.focus", { backendNodeId: 4 });
        price = "200";
        await runner.beginDomMutation?.();
        await runner.send(7, "Runtime.callFunctionOn", {
          objectId: "obj-1",
          functionDeclaration: "function() { this.value = 'mutated'; }",
        });
        return { tab_id: 7 };
      },
    );

    expect(result).toMatchObject({
      code: "permission_denied",
      data: {
        reason: "precondition_failed",
        effect_state: "unknown",
      },
    });
    expect((result as { data: Record<string, unknown> }).data).not.toHaveProperty("press_sent");
    expect(checkExpectations).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls.some((call: unknown[]) => call[1] === "Runtime.callFunctionOn")).toBe(
      false,
    );
  });

  it("re-verifies --expect with effect_state none in pre-effect beginDomMutation and before primaryEffect internal steps", async () => {
    const f = await fixture("target");
    const expectCheck = [{ target: "#price", field: "text" as const, equals: "100" }];
    let price = "100";
    let advanceAfterInitialCheck = false;
    vi.mocked(checkExpectations).mockImplementation(async () => {
      const current = price;
      if (advanceAfterInitialCheck) {
        price = "200";
        advanceAfterInitialCheck = false;
      }
      return current === "100"
        ? undefined
        : {
            code: "permission_denied",
            message: "Action condition 0 failed: #price text changed",
            data: { reason: "precondition_failed", phase: "precondition" },
          };
    });

    // 1. Main-frame fill / evaluate calls beginDomMutation before any CDP effect (`sent === false`),
    // so failing --expect reports `effect_state: "none"` (never freezing Intent WAL) and keeps context reusable.
    advanceAfterInitialCheck = true;
    const preEffectFill = await f.run(
      { ref: "e1", expect: expectCheck },
      "tool.fill",
      async (runner) => {
        await runner.beginDomMutation?.();
        await runner.send(7, "Runtime.callFunctionOn", {
          objectId: "obj-1",
          functionDeclaration: "function() { this.value = 'mutated'; }",
        });
        return { tab_id: 7 };
      },
    );
    expect(preEffectFill).toMatchObject({
      code: "permission_denied",
      data: {
        reason: "precondition_failed",
        effect_state: "none",
      },
    });
    expect(f.send).not.toHaveBeenCalled();

    // 2. `tool.hover` / `tool.focus` primaryEffect internal steps must not bypass --expect after scroll preparation.
    price = "100";
    vi.mocked(checkExpectations).mockClear();
    const hoverResult = await f.run(
      { ref: "e1", expect: expectCheck },
      "tool.hover",
      async (runner) => {
        await runner.send(7, "DOM.scrollIntoViewIfNeeded", { backendNodeId: 4 });
        // IntersectionObserver / scroll handler mutates #price before hover mouseMoved.
        price = "300";
        await runner.send(7, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 20 });
        return { tab_id: 7 };
      },
    );
    expect(hoverResult).toMatchObject({
      code: "permission_denied",
      data: {
        reason: "precondition_failed",
        effect_state: "unknown",
      },
    });
    expect(checkExpectations).toHaveBeenCalledTimes(2);
    expect(
      f.send.mock.calls.some(
        (call: unknown[]) =>
          call[1] === "Input.dispatchMouseEvent" &&
          (call[2] as { type?: string } | undefined)?.type === "mouseMoved",
      ),
    ).toBe(false);
  });
});

describe("text deltas under target control", () => {
  const VOM = [
    "L1 page",
    '  banner "Board Version: rev-0"',
    '    StaticText "Board"',
    '    StaticText "Version: rev-0"',
    '  @e1 button "Continue"',
  ].join("\n");
  const logged = (sequence: number, previous_value: string, value: string) => ({
    sequence,
    id: "9",
    label: "span#cell",
    previous_value,
    value,
  });
  const snapshots = vi.mocked(handleSnapshot);
  let original: ReturnType<typeof snapshots.getMockImplementation>;
  beforeEach(() => {
    original = snapshots.getMockImplementation();
    snapshots.mockImplementation(async () => ({
      text: VOM,
      ref_count: 1,
      tab_id: 7,
      truncated: false,
    }));
  });
  afterEach(() => {
    snapshots.mockImplementation(original!);
  });
  /** A page whose collector vouches for focus styles, observed once in full. */
  async function observed() {
    const f = await fixture();
    f.change({ focus: "1", focusIsDocument: true, focusNeutral: true, textual: 0, texts: [] });
    // A collector that never vouched for focus styles cannot have its focus move patched.
    const full = await f.sync();
    expect(full).toMatchObject({ kind: "baseline", baseline_reason: "focus_changed" });
    return { f, full, captures: snapshots.mock.calls.length };
  }

  it("answers baseline, unchanged, delta, delta, unchanged with one capture", async () => {
    const { f, full, captures } = await observed();
    expect(f.first).toMatchObject({ kind: "baseline", baseline_reason: "no_previous_observation" });
    const same = await f.sync();
    expect(same).toMatchObject({ kind: "unchanged", previous_observation_id: full.observation_id });

    // The agent's click: pointer events, focus on the button, one text replaced.
    f.change({
      revision: 9,
      structure: 1,
      textual: 1,
      texts: [logged(1, "Version: rev-0", "Version: rev-1")],
      focus: "5",
      focusIsDocument: false,
    });
    const first = await f.sync();
    expect(first).toMatchObject({
      kind: "delta",
      context_id: full.context_id,
      previous_context_id: full.context_id,
      previous_observation_id: same.observation_id,
      observation_patch: {
        lines: [
          {
            line: 2,
            previous: '  banner "Board Version: rev-0"',
            text: '  banner "Board Version: rev-1"',
          },
          {
            line: 4,
            previous: '    StaticText "Version: rev-0"',
            text: '    StaticText "Version: rev-1"',
          },
        ],
      },
      changes: [
        {
          frame_id: 0,
          kind: "text",
          label: "span#cell",
          previous_value: "Version: rev-0",
          value: "Version: rev-1",
          lines: [2, 4],
        },
      ],
    });
    expect(first).not.toHaveProperty("observation");
    expect(first).not.toHaveProperty("baseline_reason");

    f.change({
      structure: 2,
      textual: 2,
      texts: [
        logged(1, "Version: rev-0", "Version: rev-1"),
        logged(2, "Version: rev-1", "Version: rev-2"),
      ],
    });
    const second = await f.sync();
    expect(second).toMatchObject({
      kind: "delta",
      previous_observation_id: first.observation_id,
      observation_patch: {
        lines: [
          { line: 2, previous: '  banner "Board Version: rev-1"' },
          { line: 4, text: '    StaticText "Version: rev-2"' },
        ],
      },
    });
    expect(await f.sync()).toMatchObject({
      kind: "unchanged",
      changes: [],
      previous_observation_id: second.observation_id,
    });
    expect(snapshots).toHaveBeenCalledTimes(captures);
  });

  it.each<[string, Partial<FrameState>]>([
    // A node was added or removed, or an attribute the page can show changed.
    ["structure_changed", { structure: 1 }],
    ["structure_changed", { structure: 2, textual: 1, texts: [logged(1, "Board", "Panel")] }],
    ["human_activity", { human: 1 }],
    ["focus_changed", { focus: "5", focusIsDocument: false, focusNeutral: false }],
    // The bounded log dropped replacements this agent never received.
    ["text_log_gap", { structure: 3, textual: 3, textFloor: 2, texts: [logged(3, "a", "b")] }],
    // Hidden, or beyond where the observation was cut.
    [
      "text_outside_observation",
      { structure: 1, textual: 1, texts: [logged(1, "Hidden: 1", "Hidden: 2")] },
    ],
    // The text names a control, whose ref keeps that name.
    ["text_ambiguous", { structure: 1, textual: 1, texts: [logged(1, "Continue", "Next")] }],
  ])("captures afresh and says %s", async (reason, patch) => {
    const { f, captures } = await observed();
    f.change(patch);
    const reply = await f.sync();
    expect(reply).toMatchObject({
      kind: "baseline",
      baseline_reason: reason,
      observation: { text: VOM },
    });
    expect(reply).not.toHaveProperty("observation_patch");
    expect(snapshots).toHaveBeenCalledTimes(captures + 1);
  });

  it("captures afresh when the document, the refs or the token budget were replaced", async () => {
    const text = [logged(1, "Version: rev-0", "Version: rev-1")];
    const { f } = await observed();
    f.change({ structure: 1, textual: 1, texts: text });
    f.session.refStore.clear();
    expect(await f.sync()).toMatchObject({ kind: "baseline", baseline_reason: "refs_replaced" });
    f.change({ structure: 2, textual: 2, texts: text });
    expect(
      await f.controller.command(
        { session_id: "s", tab_id: 7, action: "sync", max_tokens: 500 },
        f.cdp,
        f.signal,
      ),
    ).toMatchObject({ kind: "baseline", baseline_reason: "token_budget_changed" });
    // A new document in the frame: nothing logged for the old one applies.
    f.change({ document: "next", structure: 0, textual: 1, texts: text }, false);
    const replaced = await f.sync();
    expect(replaced).toMatchObject({ kind: "baseline", observation: { text: VOM } });
    expect(replaced).not.toHaveProperty("observation_patch");
  });

  it("leaves strict control re-capturing on every structural batch", async () => {
    const f = await fixture("strict");
    f.change({ focusNeutral: true, textual: 0, texts: [] });
    await f.sync();
    f.change({ structure: 1, textual: 1, texts: [logged(1, "Version: rev-0", "Version: rev-1")] });
    const reply = await f.sync();
    expect(reply).toMatchObject({ kind: "baseline", baseline_reason: "structure_changed" });
    expect(reply).not.toHaveProperty("observation_patch");
  });

  it("keeps the action guards: target identity is checked, a stale strict observation refused", async () => {
    const { f } = await observed();
    f.change({ structure: 1, textual: 1, texts: [logged(1, "Version: rev-0", "Version: rev-1")] });
    const delta = await f.sync();
    expect(delta).toMatchObject({ kind: "delta" });

    // A DOM-targeted action still passes through the target identity check.
    vi.mocked(checkActionTarget).mockClear();
    expect(await f.run({ context_id: delta.context_id })).not.toHaveProperty("code");
    expect(checkActionTarget).toHaveBeenCalled();

    // The page moved on after the delta. An action bound to that strict
    // observation has no evidence to compare against and is refused untouched.
    f.send.mockClear();
    f.change({});
    const script = (runner: CdpRunner) =>
      runner.send(7, "Runtime.evaluate", { expression: "submit()" });
    expect(
      await f.run(
        { context_id: delta.context_id, ref: "e1", observation_id: delta.observation_id },
        "tool.evaluate",
        script,
      ),
    ).toMatchObject({ code: expect.any(String), data: { effect_state: "none" } });
    expect(f.send).not.toHaveBeenCalled();

    // A ref whose row reads differently after the delta: the next sync
    // republishes the refs instead of answering unchanged.
    const row = await observed();
    row.f.change({
      structure: 1,
      textual: 1,
      texts: [logged(1, "Version: rev-0", "Version: rev-1")],
    });
    const patched = await row.f.sync();
    expect(patched).toMatchObject({ kind: "delta" });
    vi.mocked(checkActionTarget).mockResolvedValueOnce({
      code: "permission_denied",
      message: "row",
      data: { reason: "virtual_row_recycled", effect_state: "none" },
    });
    expect(await row.f.run({ context_id: patched.context_id })).toMatchObject({
      data: { reason: "virtual_row_recycled" },
    });
    expect(await row.f.sync()).toMatchObject({
      kind: "baseline",
      baseline_reason: "no_previous_observation",
    });

    // That refusal ends the patching: the next sync captures the page, with
    // evidence, so a page that keeps changing cannot refuse the action forever.
    f.change({
      structure: 2,
      textual: 2,
      texts: [
        logged(1, "Version: rev-0", "Version: rev-1"),
        logged(2, "Version: rev-1", "Version: rev-2"),
      ],
    });
    expect(await f.sync()).toMatchObject({ kind: "baseline", baseline_reason: "no_held_text" });
  });
});
