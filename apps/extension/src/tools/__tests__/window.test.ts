import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERACTION_STORAGE_KEY, InteractionPreferenceStore } from "@/lib/interaction-preferences";
import { SessionManager } from "@/session-manager/manager";
import { handleSessionStart } from "../session";
import type { CdpRunner, ChromeTabsApi } from "../shared";
import { handleWindowResize, type WindowResizeDeps } from "../window";

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  const create = vi.fn(async () => {
    const id = ids[i++];
    if (id === undefined) throw new Error("ran out of fake ids");
    return { windowId: id, initialTabIds: [1] };
  });
  const remove = vi.fn(async () => {});
  const ensureActiveTab = vi.fn(async () => 1);
  return { create, remove, ensureActiveTab };
}

async function makeManager(): Promise<SessionManager> {
  const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
  await sm.start("aa11");
  return sm;
}

function resizeFixture(
  opts: {
    inactive?: boolean;
    throwOnUpdate?: boolean;
    actual?: { width: number; height: number };
    frozenViewport?: boolean;
    delayViewport?: boolean;
    zoom?: number;
  } = {},
) {
  const state = {
    bounds: { width: 900, height: 700 },
    viewport: { width: 900, height: 557 },
    active: !opts.inactive,
    waits: 0,
  };
  const tab = () =>
    ({
      id: 1,
      windowId: 100,
      active: state.active,
      url: "https://example.test",
    }) as chrome.tabs.Tab;
  const tabs: ChromeTabsApi = { get: vi.fn(async () => tab()), query: vi.fn(async () => [tab()]) };
  const windows = {
    get: vi.fn(async () => ({ ...state.bounds })),
    update: vi.fn(async (_id: number, requested: { width: number; height: number }) => {
      if (opts.throwOnUpdate) throw new Error("simulated chrome failure");
      state.bounds = opts.actual ?? requested;
      if (!opts.frozenViewport && !opts.delayViewport)
        state.viewport = { width: state.bounds.width, height: state.bounds.height - 143 };
    }),
  };
  const cdp: CdpRunner = {
    send: vi.fn(async () => ({
      cssLayoutViewport: { clientWidth: state.viewport.width, clientHeight: state.viewport.height },
      cssVisualViewport: { zoom: opts.zoom ?? 1 },
    })) as CdpRunner["send"],
  };
  const wait = vi.fn(async () => {
    state.waits++;
    if (opts.delayViewport && state.waits === 2)
      state.viewport = { width: state.bounds.width, height: state.bounds.height - 143 };
  });
  return {
    state,
    windows,
    tabs,
    cdp,
    wait,
    deps: { windows, tabs, cdp, wait } satisfies WindowResizeDeps,
  };
}

describe("handleWindowResize", () => {
  it("resizes the session's Agent Window", async () => {
    const sm = await makeManager();
    const f = resizeFixture();
    const result = await handleWindowResize(
      sm,
      { session_id: "aa11", width: 1280, height: 800 },
      f.deps,
    );
    expect(result).toEqual({ window_id: 100, width: 1280, height: 800 });
    expect(f.windows.update).toHaveBeenCalledExactlyOnceWith(100, { width: 1280, height: 800 });
  });

  it("rejects an unknown session", async () => {
    const sm = await makeManager();
    const f = resizeFixture();
    const result = await handleWindowResize(
      sm,
      { session_id: "zz99", width: 1280, height: 800 },
      f.deps,
    );
    expect(result).toMatchObject({ code: "not_found" });
  });

  it("rejects missing session_id", async () => {
    const sm = await makeManager();
    const f = resizeFixture();
    const result = await handleWindowResize(
      sm,
      { session_id: "", width: 1280, height: 800 },
      f.deps,
    );
    expect(result).toMatchObject({ code: "invalid_params" });
  });

  it("rejects missing dimensions", async () => {
    const sm = await makeManager();
    const f = resizeFixture();
    const result = await handleWindowResize(
      sm,
      { session_id: "aa11" } as unknown as { session_id: string; width: number; height: number },
      f.deps,
    );
    expect(result).toMatchObject({ code: "invalid_params" });
    expect(f.windows.update).not.toHaveBeenCalled();
  });

  it.each([
    [99, 800],
    [100, 7681],
    [1280.5, 800],
    [Number.NaN, 800],
  ])("rejects out-of-range or non-integer dimensions (%s, %s)", async (width, height) => {
    const sm = await makeManager();
    const f = resizeFixture();
    const result = await handleWindowResize(sm, { session_id: "aa11", width, height }, f.deps);
    expect(result).toMatchObject({ code: "invalid_params" });
    expect(f.windows.update).not.toHaveBeenCalled();
  });

  it("maps chrome API failures to protocol_error", async () => {
    const sm = await makeManager();
    const f = resizeFixture({ throwOnUpdate: true });
    const result = await handleWindowResize(
      sm,
      { session_id: "aa11", width: 1280, height: 800 },
      f.deps,
    );
    expect(result).toMatchObject({ code: "protocol_error", message: "simulated chrome failure" });
  });

  it("refuses an inactive target before changing the window", async () => {
    const sm = await makeManager();
    const f = resizeFixture({ inactive: true });
    const result = await handleWindowResize(
      sm,
      { session_id: "aa11", tab_id: 1, width: 1280, height: 800 },
      f.deps,
    );
    expect(result).toMatchObject({
      code: "invalid_params",
      data: { reason: "window_resize_inactive_tab", effect_state: "none", tab_id: 1 },
    });
    expect(f.windows.update).not.toHaveBeenCalled();
  });

  it("reports constrained window bounds instead of echoing the request", async () => {
    const sm = await makeManager();
    const f = resizeFixture({ actual: { width: 1200, height: 800 } });
    const result = await handleWindowResize(
      sm,
      { session_id: "aa11", width: 1280, height: 800 },
      f.deps,
    );
    expect(result).toMatchObject({
      code: "protocol_error",
      data: {
        reason: "window_resize_constrained",
        effect_state: "committed",
        requested: { width: 1280, height: 800 },
        actual_window: { width: 1200, height: 800 },
      },
    });
    expect(f.wait).toHaveBeenCalledTimes(20);
  });

  it("reports a viewport that remains fixed despite the window changing", async () => {
    const sm = await makeManager();
    const f = resizeFixture({ frozenViewport: true });
    const result = await handleWindowResize(
      sm,
      { session_id: "aa11", width: 1280, height: 800 },
      f.deps,
    );
    expect(result).toMatchObject({
      code: "cdp_failed",
      data: {
        reason: "window_resize_viewport_unchanged",
        effect_state: "committed",
        before_viewport: { width: 900, height: 557 },
        actual_viewport: { width: 900, height: 557 },
      },
    });
  });

  it("does not turn an unchanged viewport into success when the same size is retried", async () => {
    const sm = await makeManager();
    const f = resizeFixture({ frozenViewport: true });
    const params = { session_id: "aa11", width: 1280, height: 800 };
    expect(await handleWindowResize(sm, params, f.deps)).toMatchObject({
      data: { reason: "window_resize_viewport_unchanged", effect_state: "committed" },
    });
    expect(await handleWindowResize(sm, params, f.deps)).toMatchObject({
      data: { reason: "window_resize_viewport_unchanged", effect_state: "none" },
    });
    expect(f.windows.update).toHaveBeenCalledOnce();
    f.state.viewport = { width: 1280, height: 657 };
    expect(await handleWindowResize(sm, params, f.deps)).toEqual({
      window_id: 100,
      width: 1280,
      height: 800,
    });
  });

  it("does not change the window when its viewport cannot be read", async () => {
    const sm = await makeManager();
    const f = resizeFixture();
    f.cdp.send = vi.fn(async () => {
      throw new Error("renderer unavailable");
    }) as CdpRunner["send"];
    const result = await handleWindowResize(
      sm,
      { session_id: "aa11", width: 1280, height: 800 },
      f.deps,
    );
    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { reason: "window_resize_unconfirmed", effect_state: "none" },
    });
    expect(f.windows.update).not.toHaveBeenCalled();
  });

  it("keeps a failed post-resize read from becoming a false same-size success", async () => {
    const sm = await makeManager();
    const f = resizeFixture({ frozenViewport: true });
    const read = f.cdp.send;
    let calls = 0;
    f.cdp.send = (async (...args: Parameters<CdpRunner["send"]>) => {
      if (++calls === 2) throw new Error("renderer unavailable");
      return read(...args);
    }) as CdpRunner["send"];
    const params = { session_id: "aa11", width: 1280, height: 800 };
    expect(await handleWindowResize(sm, params, f.deps)).toMatchObject({
      data: { reason: "window_resize_unconfirmed", effect_state: "unknown" },
    });
    f.cdp.send = read;
    expect(await handleWindowResize(sm, params, f.deps)).toMatchObject({
      data: { reason: "window_resize_viewport_unchanged", effect_state: "none" },
    });
    expect(f.windows.update).toHaveBeenCalledOnce();
  });

  it.each([
    "update",
    "viewport",
  ])("allows an idempotent resize to recover after a transient %s failure", async (failure) => {
    const sm = await makeManager();
    const f = resizeFixture({ frozenViewport: true });
    const read = f.cdp.send;
    if (failure === "update") {
      f.windows.update.mockRejectedValueOnce(new Error("window update unavailable"));
    } else {
      let calls = 0;
      f.cdp.send = (async (...args: Parameters<CdpRunner["send"]>) => {
        if (++calls === 2) throw new Error("renderer unavailable");
        return read(...args);
      }) as CdpRunner["send"];
    }
    const params = { session_id: "aa11", width: 900, height: 700 };
    expect(await handleWindowResize(sm, params, f.deps)).toMatchObject({
      code: failure === "update" ? "protocol_error" : "cdp_failed",
      data: { effect_state: "unknown" },
    });
    f.cdp.send = read;
    expect(await handleWindowResize(sm, params, f.deps)).toEqual({
      window_id: 100,
      width: 900,
      height: 700,
    });
    expect(f.windows.update).toHaveBeenCalledTimes(2);
  });

  it.each([
    { width: 903, height: 700 },
    { width: 900, height: 703 },
  ])("allows CSS pixel rounding at high page zoom for %j", async (requested) => {
    const sm = await makeManager();
    const f = resizeFixture({ frozenViewport: true, zoom: 5 });
    f.state.viewport = { width: 180, height: 111 };
    expect(await handleWindowResize(sm, { session_id: "aa11", ...requested }, f.deps)).toEqual({
      window_id: 100,
      ...requested,
    });
  });

  it("still rejects a pinned viewport for a larger resize at 500% zoom", async () => {
    const sm = await makeManager();
    const f = resizeFixture({ frozenViewport: true, zoom: 5 });
    f.state.viewport = { width: 180, height: 111 };
    const params = { session_id: "aa11", width: 920, height: 720 };
    expect(await handleWindowResize(sm, params, f.deps)).toMatchObject({
      data: { reason: "window_resize_viewport_unchanged", effect_state: "committed" },
    });
    expect(await handleWindowResize(sm, params, f.deps)).toMatchObject({
      data: { reason: "window_resize_viewport_unchanged", effect_state: "none" },
    });
    expect(f.windows.update).toHaveBeenCalledOnce();
  });

  it("distinguishes cancellation before and after dispatch", async () => {
    const sm = await makeManager();
    const before = resizeFixture();
    const beforeSignal = new AbortController();
    before.cdp.runBrowserMutation = async () => {
      beforeSignal.abort();
      throw new Error("cancelled before dispatch");
    };
    expect(
      await handleWindowResize(
        sm,
        { session_id: "aa11", width: 1280, height: 800 },
        before.deps,
        beforeSignal.signal,
      ),
    ).toMatchObject({
      code: "cancelled",
      data: { effect_state: "none" },
    });
    expect(before.windows.update).not.toHaveBeenCalled();
    const after = resizeFixture();
    const afterSignal = new AbortController();
    after.windows.update.mockImplementation(async () => {
      afterSignal.abort();
    });
    expect(
      await handleWindowResize(
        sm,
        { session_id: "aa11", width: 1280, height: 800 },
        after.deps,
        afterSignal.signal,
      ),
    ).toMatchObject({
      code: "cancelled",
      data: { effect_state: "unknown" },
    });
  });

  it("waits for a delayed viewport update", async () => {
    const sm = await makeManager();
    const f = resizeFixture({ delayViewport: true });
    expect(
      await handleWindowResize(sm, { session_id: "aa11", width: 1280, height: 800 }, f.deps),
    ).toEqual({ window_id: 100, width: 1280, height: 800 });
    expect(f.wait).toHaveBeenCalledTimes(2);
  });

  it("does not require a viewport change for an idempotent resize", async () => {
    const sm = await makeManager();
    const f = resizeFixture({ frozenViewport: true });
    expect(
      await handleWindowResize(sm, { session_id: "aa11", width: 900, height: 700 }, f.deps),
    ).toEqual({ window_id: 100, width: 900, height: 700 });
  });

  it("reports a tab becoming inactive after the window update", async () => {
    const sm = await makeManager();
    const f = resizeFixture();
    f.windows.update.mockImplementation(async () => {
      f.state.active = false;
    });
    const result = await handleWindowResize(
      sm,
      { session_id: "aa11", width: 1280, height: 800 },
      f.deps,
    );
    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { reason: "window_resize_inactive_tab", effect_state: "unknown" },
    });
  });
});

describe("handleSessionStart window size", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts an interactive session on read failure and honors preferences after recovery", async () => {
    vi.stubGlobal("chrome", { storage: { onChanged: { addListener: vi.fn() } } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new Error("failed"))
        .mockResolvedValueOnce({
          [INTERACTION_STORAGE_KEY]: { confirmTabBorrow: false, requestHelpEnabled: false },
        }),
      set: vi.fn(),
    };
    const preferences = new InteractionPreferenceStore(storage);
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 101]) });
    expect(await handleSessionStart(sm, { session_id: "first" }, { preferences })).toMatchObject({
      agent_window_id: 100,
      interaction: { borrow_confirmation: "always", request_help: "enabled" },
    });
    expect(await handleSessionStart(sm, { session_id: "second" }, { preferences })).toMatchObject({
      agent_window_id: 101,
      interaction: { borrow_confirmation: "never", request_help: "disabled" },
    });
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("legacy unattended cannot skip preference loading or interactive fallback", async () => {
    const preferences = new InteractionPreferenceStore();
    const read = vi.spyOn(preferences, "ready").mockRejectedValue(new Error("failed"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    expect(
      await handleSessionStart(sm, { session_id: "auto", unattended: true }, { preferences }),
    ).toMatchObject({ interaction: { borrow_confirmation: "always", request_help: "enabled" } });
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    [true, true, "always", "enabled"],
    [true, false, "always", "disabled"],
    [false, true, "never", "enabled"],
    [false, false, "never", "disabled"],
  ] as const)("legacy unattended leaves browser settings authoritative (%s, %s)", async (confirmTabBorrow, requestHelpEnabled, borrow_confirmation, request_help) => {
    const preferences = new InteractionPreferenceStore();
    vi.spyOn(preferences, "ready").mockResolvedValue();
    vi.spyOn(preferences, "get").mockReturnValue({ confirmTabBorrow, requestHelpEnabled });
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 101]) });
    for (const unattended of [false, true]) {
      expect(
        await handleSessionStart(
          sm,
          { session_id: String(unattended), unattended },
          { preferences },
        ),
      ).toMatchObject({ interaction: { borrow_confirmation, request_help } });
    }
  });

  it("passes width/height through to Agent Window creation", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    const result = await handleSessionStart(sm, { session_id: "aa11", width: 1280, height: 800 });
    expect(result).toMatchObject({
      agent_window_id: 100,
      interaction: { borrow_confirmation: "always", request_help: "enabled" },
    });
    expect(aw.create).toHaveBeenCalledWith("about:blank", { size: { width: 1280, height: 800 } });
  });

  it("creates the window without size when width/height are omitted", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    const result = await handleSessionStart(sm, { session_id: "aa11" });
    expect(result).toMatchObject({
      agent_window_id: 100,
      interaction: { borrow_confirmation: "always", request_help: "enabled" },
    });
    expect(aw.create).toHaveBeenCalledWith("about:blank", {});
  });

  it("forwards focused: false to the Agent Window", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    const result = await handleSessionStart(sm, { session_id: "aa11", focused: false });
    expect(result).toMatchObject({
      agent_window_id: 100,
      interaction: { borrow_confirmation: "always", request_help: "enabled" },
    });
    expect(aw.create).toHaveBeenCalledWith("about:blank", { focused: false });
  });

  it("rejects a lone width without height", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const result = await handleSessionStart(sm, { session_id: "aa11", width: 1280 });
    expect(result).toMatchObject({ code: "invalid_params" });
    expect(sm.has("aa11")).toBe(false);
  });

  it.each([
    [99, 800],
    [1280, 7681],
    [1280.5, 800],
  ])("rejects invalid dimensions (%s, %s)", async (width, height) => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const result = await handleSessionStart(sm, { session_id: "aa11", width, height });
    expect(result).toMatchObject({ code: "invalid_params" });
    expect(sm.has("aa11")).toBe(false);
  });
});
