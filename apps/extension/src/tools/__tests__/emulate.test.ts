import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceMetricsOverride, UserAgentOverride } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import type { EmulateOverrides, RpcError } from "@/transport/types";
import {
  EMULATE_SCOPE_NOTE,
  type EmulateCdpRunner,
  handleEmulate,
  resetEmulateStatesForTests,
  toCdpUserAgentMetadata,
  validateOverrides,
} from "../emulate";

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  return {
    create: vi.fn(async () => {
      const id = ids[i++];
      if (id === undefined) throw new Error("ran out of fake ids");
      return id;
    }),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => 1),
  };
}

interface CdpCalls {
  metrics: Array<{ tabId: number; metrics: DeviceMetricsOverride }>;
  clearedMetrics: number[];
  ua: Array<{ tabId: number; override: UserAgentOverride }>;
  touch: Array<{ tabId: number; enabled: boolean; maxTouchPoints?: number }>;
}

function makeDeps(opts: { throwOn?: string; tabWindowId?: number } = {}) {
  const calls: CdpCalls = { metrics: [], clearedMetrics: [], ua: [], touch: [] };
  const maybeThrow = (kind: string) => {
    if (opts.throwOn === kind) throw new Error(`simulated ${kind} failure`);
  };
  const cdp: EmulateCdpRunner = {
    setDeviceMetricsOverride: vi.fn(async (tabId, metrics) => {
      maybeThrow("metrics");
      calls.metrics.push({ tabId, metrics });
    }),
    clearDeviceMetricsOverride: vi.fn(async (tabId) => {
      maybeThrow("metrics");
      calls.clearedMetrics.push(tabId);
    }),
    setUserAgentOverride: vi.fn(async (tabId, override) => {
      maybeThrow("ua");
      calls.ua.push({ tabId, override });
    }),
    setTouchEmulationEnabled: vi.fn(async (tabId, enabled, maxTouchPoints) => {
      maybeThrow("touch");
      calls.touch.push({ tabId, enabled, maxTouchPoints });
    }),
    trackSessionTab: vi.fn(),
  };
  const tabsApi = {
    get: vi.fn(
      async (tabId: number) =>
        ({ id: tabId, windowId: opts.tabWindowId ?? 100, active: true }) as chrome.tabs.Tab,
    ),
    query: vi.fn(async () => [
      { id: 7, windowId: opts.tabWindowId ?? 100, active: true } as chrome.tabs.Tab,
    ]),
  };
  return { cdp, tabsApi, calls };
}

async function makeManager(): Promise<SessionManager> {
  const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
  await sm.start("aa11");
  return sm;
}

const fullOverrides: EmulateOverrides = {
  width: 390,
  height: 844,
  device_scale_factor: 3,
  mobile: true,
  user_agent: "Mozilla/5.0 (iPhone)",
  accept_language: "zh-CN",
  touch: true,
  max_touch_points: 5,
};

describe("handleEmulate", () => {
  beforeEach(() => {
    resetEmulateStatesForTests();
  });

  it("applies viewport, UA and touch overrides to the active tab", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    const result = await handleEmulate(sm, { session_id: "aa11", overrides: fullOverrides }, deps);
    expect(result).toEqual({
      tab_id: 7,
      cleared: false,
      applied: fullOverrides,
      note: EMULATE_SCOPE_NOTE,
    });
    expect(deps.calls.metrics).toEqual([
      { tabId: 7, metrics: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true } },
    ]);
    expect(deps.calls.ua).toEqual([
      {
        tabId: 7,
        override: { userAgent: "Mozilla/5.0 (iPhone)", acceptLanguage: "zh-CN" },
      },
    ]);
    expect(deps.calls.touch).toEqual([{ tabId: 7, enabled: true, maxTouchPoints: 5 }]);
    expect(deps.cdp.trackSessionTab).toHaveBeenCalledWith("aa11", 7);
  });

  it("defaults deviceScaleFactor to 0 and mobile to false when omitted", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    const result = await handleEmulate(
      sm,
      { session_id: "aa11", overrides: { width: 800, height: 1280 } },
      deps,
    );
    expect(result).toMatchObject({ tab_id: 7, cleared: false });
    expect(deps.calls.metrics).toEqual([
      { tabId: 7, metrics: { width: 800, height: 1280, deviceScaleFactor: 0, mobile: false } },
    ]);
    expect(deps.calls.ua).toEqual([]);
    expect(deps.calls.touch).toEqual([]);
  });

  it("applies a UA-only override", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    const result = await handleEmulate(
      sm,
      { session_id: "aa11", overrides: { user_agent: "custom-ua" } },
      deps,
    );
    expect(result).toMatchObject({ tab_id: 7, cleared: false });
    expect(deps.calls.metrics).toEqual([]);
    expect(deps.calls.ua).toEqual([{ tabId: 7, override: { userAgent: "custom-ua" } }]);
  });

  it("converts user_agent_metadata to CDP camelCase", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    const result = await handleEmulate(
      sm,
      {
        session_id: "aa11",
        overrides: {
          user_agent: "custom-ua",
          user_agent_metadata: {
            brands: [{ brand: "Chromium", version: "120" }],
            full_version: "120.0.0.0",
            platform: "Android",
            platform_version: "14",
            mobile: true,
          },
        },
      },
      deps,
    );
    expect(result).toMatchObject({ tab_id: 7 });
    expect(deps.calls.ua[0].override.userAgentMetadata).toEqual({
      brands: [{ brand: "Chromium", version: "120" }],
      fullVersion: "120.0.0.0",
      platform: "Android",
      platformVersion: "14",
      mobile: true,
    });
  });

  it("max_touch_points without touch enables touch emulation", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    const result = await handleEmulate(
      sm,
      { session_id: "aa11", overrides: { max_touch_points: 5 } },
      deps,
    );
    expect(result).toMatchObject({ tab_id: 7, cleared: false });
    expect(deps.calls.touch).toEqual([{ tabId: 7, enabled: true, maxTouchPoints: 5 }]);
  });

  it("touch: false only disables touch emulation", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    const result = await handleEmulate(
      sm,
      { session_id: "aa11", overrides: { touch: false } },
      deps,
    );
    expect(result).toMatchObject({ tab_id: 7, cleared: false });
    expect(deps.calls.touch).toEqual([{ tabId: 7, enabled: false, maxTouchPoints: undefined }]);
  });

  it("targets an explicit tab_id", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    const result = await handleEmulate(
      sm,
      { session_id: "aa11", tab_id: 9, overrides: { user_agent: "custom-ua" } },
      deps,
    );
    expect(result).toMatchObject({ tab_id: 9 });
    expect(deps.calls.ua).toEqual([{ tabId: 9, override: { userAgent: "custom-ua" } }]);
  });

  it("off clears metrics, touch and UA overrides", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    const result = await handleEmulate(sm, { session_id: "aa11", off: true }, deps);
    expect(result).toEqual({ tab_id: 7, cleared: true, note: EMULATE_SCOPE_NOTE });
    expect(deps.calls.clearedMetrics).toEqual([7]);
    expect(deps.calls.touch).toEqual([{ tabId: 7, enabled: false, maxTouchPoints: undefined }]);
    expect(deps.calls.ua).toEqual([{ tabId: 7, override: { userAgent: "" } }]);
  });

  it("rejects off combined with overrides", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    const result = await handleEmulate(
      sm,
      { session_id: "aa11", off: true, overrides: { touch: true } },
      deps,
    );
    expect(result).toMatchObject({ code: "invalid_params" });
    expect(deps.calls.clearedMetrics).toEqual([]);
  });

  it("rejects missing overrides and missing off", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    const result = await handleEmulate(sm, { session_id: "aa11" }, deps);
    expect(result).toMatchObject({ code: "invalid_params" });
  });

  it("rejects an unknown session", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    const result = await handleEmulate(sm, { session_id: "zz99", off: true }, deps);
    expect(result).toMatchObject({ code: "not_found" });
  });

  it("rejects a tab outside the Agent Window", async () => {
    const sm = await makeManager();
    const deps = makeDeps({ tabWindowId: 200 });
    const result = await handleEmulate(sm, { session_id: "aa11", tab_id: 9, off: true }, deps);
    expect(result).toMatchObject({ code: "permission_denied" });
    expect(deps.calls.clearedMetrics).toEqual([]);
  });

  it("merges onto the tab's stored state: later width/height keep the earlier dpr/mobile", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    await handleEmulate(sm, { session_id: "aa11", overrides: fullOverrides }, deps);
    const result = await handleEmulate(
      sm,
      { session_id: "aa11", overrides: { width: 500, height: 900 } },
      deps,
    );
    expect(result).toMatchObject({
      tab_id: 7,
      cleared: false,
      applied: { width: 500, height: 900, device_scale_factor: 3, mobile: true },
    });
    expect(deps.calls.metrics).toEqual([
      { tabId: 7, metrics: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true } },
      { tabId: 7, metrics: { width: 500, height: 900, deviceScaleFactor: 3, mobile: true } },
    ]);
    // The merged state is applied as a whole: UA and touch are re-applied too.
    expect(deps.calls.ua).toHaveLength(2);
    expect(deps.calls.touch).toHaveLength(2);
  });

  it("keeps emulation state per tab", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    await handleEmulate(sm, { session_id: "aa11", overrides: fullOverrides }, deps);
    await handleEmulate(
      sm,
      { session_id: "aa11", tab_id: 9, overrides: { width: 500, height: 900 } },
      deps,
    );
    // Tab 9 has no stored state, so dpr/mobile fall back to the CDP defaults.
    expect(deps.calls.metrics.at(-1)).toEqual({
      tabId: 9,
      metrics: { width: 500, height: 900, deviceScaleFactor: 0, mobile: false },
    });
  });

  it("off clears the stored state: a later request starts from scratch", async () => {
    const sm = await makeManager();
    const deps = makeDeps();
    await handleEmulate(sm, { session_id: "aa11", overrides: fullOverrides }, deps);
    await handleEmulate(sm, { session_id: "aa11", off: true }, deps);
    const result = await handleEmulate(
      sm,
      { session_id: "aa11", overrides: { width: 500, height: 900 } },
      deps,
    );
    expect(result).toEqual({
      tab_id: 7,
      cleared: false,
      applied: { width: 500, height: 900 },
      note: EMULATE_SCOPE_NOTE,
    });
    // dpr/mobile fell back to the CDP defaults instead of the cleared values,
    // and the cleared UA/touch were not re-applied.
    expect(deps.calls.metrics.at(-1)).toEqual({
      tabId: 7,
      metrics: { width: 500, height: 900, deviceScaleFactor: 0, mobile: false },
    });
    expect(deps.calls.ua).toHaveLength(2); // preset + the clearing empty UA
    expect(deps.calls.touch).toHaveLength(2); // preset + the disabling call
  });

  it("maps CDP failures to cdp_failed and points at --off", async () => {
    const sm = await makeManager();
    const deps = makeDeps({ throwOn: "ua" });
    const result = await handleEmulate(
      sm,
      { session_id: "aa11", overrides: { user_agent: "custom-ua" } },
      deps,
    );
    expect(result).toMatchObject({ code: "cdp_failed" });
    const message = (result as RpcError).message;
    expect(message).toContain("simulated ua failure");
    expect(message).toContain("not rolled back");
    expect(message).toContain("--off");
  });

  it("reports an off-branch CDP failure with the same not-rolled-back note", async () => {
    const sm = await makeManager();
    const deps = makeDeps({ throwOn: "metrics" });
    const result = await handleEmulate(sm, { session_id: "aa11", off: true }, deps);
    expect(result).toMatchObject({ code: "cdp_failed" });
    const message = (result as RpcError).message;
    expect(message).toContain("simulated metrics failure");
    expect(message).toContain("not rolled back");
    expect(message).toContain("--off");
  });
});

describe("validateOverrides", () => {
  it("accepts a full override set", () => {
    expect(validateOverrides(fullOverrides)).toBeNull();
  });

  it("rejects width without height and vice versa", () => {
    expect(validateOverrides({ width: 390 })).toMatchObject({ code: "invalid_params" });
    expect(validateOverrides({ height: 844 })).toMatchObject({ code: "invalid_params" });
  });

  it("rejects non-positive or non-integer dimensions", () => {
    expect(validateOverrides({ width: 0, height: 844 })).toMatchObject({
      code: "invalid_params",
    });
    expect(validateOverrides({ width: 390.5, height: 844 })).toMatchObject({
      code: "invalid_params",
    });
  });

  it("rejects metrics extras without dimensions", () => {
    expect(validateOverrides({ device_scale_factor: 3 })).toMatchObject({
      code: "invalid_params",
    });
    expect(validateOverrides({ mobile: true })).toMatchObject({ code: "invalid_params" });
  });

  it("rejects a non-positive device_scale_factor", () => {
    expect(validateOverrides({ width: 390, height: 844, device_scale_factor: 0 })).toMatchObject({
      code: "invalid_params",
    });
    expect(
      validateOverrides({ width: 390, height: 844, device_scale_factor: Number.NaN }),
    ).toMatchObject({ code: "invalid_params" });
  });

  it("rejects accept_language / user_agent_metadata without user_agent", () => {
    expect(validateOverrides({ accept_language: "zh-CN" })).toMatchObject({
      code: "invalid_params",
    });
    expect(validateOverrides({ user_agent_metadata: { platform: "Android" } })).toMatchObject({
      code: "invalid_params",
    });
  });

  it("rejects invalid max_touch_points", () => {
    expect(validateOverrides({ touch: true, max_touch_points: 0 })).toMatchObject({
      code: "invalid_params",
    });
  });

  it("rejects an empty override set", () => {
    expect(validateOverrides({})).toMatchObject({ code: "invalid_params" });
  });
});

describe("toCdpUserAgentMetadata", () => {
  it("maps snake_case fields to camelCase and drops absent ones", () => {
    expect(
      toCdpUserAgentMetadata({
        brands: [{ brand: "Chromium", version: "120" }],
        platform: "Android",
        mobile: true,
      }),
    ).toEqual({
      brands: [{ brand: "Chromium", version: "120" }],
      platform: "Android",
      mobile: true,
    });
    expect(toCdpUserAgentMetadata({})).toEqual({});
  });
});
