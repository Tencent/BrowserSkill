// `tool.emulate` — apply or clear CDP Emulation-domain overrides
// (viewport metrics, user agent, touch) on a session tab, so agents can
// debug mobile page behaviour. Overrides are per-target: new tabs do
// not inherit them, and `off` restores the tab's real environment.
//
// Device presets are resolved CLI-side; this handler only executes the
// concrete override parameters it receives. Each request is merged
// field by field onto the tab's remembered emulation state and the
// merged state is applied as a whole, so a partial request does not
// reset fields set by an earlier one.

import type { DeviceMetricsOverride, UserAgentOverride } from "@/browser-driver/chromium-cdp";
import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import type {
  EmulateOverrides,
  EmulateParams,
  EmulateResult,
  RpcError,
  UserAgentMetadata,
} from "@/transport/types";
import {
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

/**
 * Emulation-domain surface the handler needs. Backed by `ChromiumCdp`
 * in production; tests inject a fake. `trackSessionTab` is optional so
 * test doubles need not implement it.
 */
export interface EmulateCdpRunner {
  setDeviceMetricsOverride(tabId: number, metrics: DeviceMetricsOverride): Promise<void>;
  clearDeviceMetricsOverride(tabId: number): Promise<void>;
  setUserAgentOverride(tabId: number, override: UserAgentOverride): Promise<void>;
  setTouchEmulationEnabled(tabId: number, enabled: boolean, maxTouchPoints?: number): Promise<void>;
  trackSessionTab?(sessionId: string, tabId: number): void;
}

export interface EmulateDeps {
  cdp: EmulateCdpRunner;
  tabsApi: ChromeTabsApi;
}

function defaultEmulateDeps(): EmulateDeps {
  return {
    cdp: new ChromiumCdp(),
    tabsApi: chromeTabsApi,
  };
}

/**
 * Result note explaining the per-target scope of CDP emulation
 * overrides, echoed on every successful call so agents know to
 * re-apply emulation after opening a new tab.
 */
export const EMULATE_SCOPE_NOTE =
  "emulation overrides are per-tab (CDP target): new tabs do not inherit them — re-run `bsk emulate` on each new tab";

/** Convert the wire (snake_case) UA metadata to CDP's camelCase shape. */
export function toCdpUserAgentMetadata(meta: UserAgentMetadata): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (meta.brands !== undefined) out.brands = meta.brands;
  if (meta.full_version !== undefined) out.fullVersion = meta.full_version;
  if (meta.platform !== undefined) out.platform = meta.platform;
  if (meta.platform_version !== undefined) out.platformVersion = meta.platform_version;
  if (meta.architecture !== undefined) out.architecture = meta.architecture;
  if (meta.model !== undefined) out.model = meta.model;
  if (meta.mobile !== undefined) out.mobile = meta.mobile;
  return out;
}

function invalidParams(message: string): RpcError {
  return { code: "invalid_params", message };
}

/**
 * Per-tab record of the emulation state applied so far. New requests
 * are merged onto it field by field (see `mergeEmulateOverrides`) and
 * the merged state is applied as a whole, so e.g. a later
 * `--width/--height` does not silently reset the dpr/mobile of an
 * earlier `--device` preset.
 *
 * The record is best-effort: an entry left behind by a closed tab is
 * simply overwritten by the next emulate call that targets the same tab
 * id, and the whole map is lost when the extension service worker
 * reloads — after a reload the next emulate is equivalent to a full
 * (re)set of just the fields it carries.
 */
const tabEmulationStates = new Map<number, EmulateOverrides>();

/** Test hook: drop every per-tab emulation state record. */
export function resetEmulateStatesForTests(): void {
  tabEmulationStates.clear();
}

/**
 * Merge one validated request onto the tab's stored state: fields
 * present in `overrides` overwrite the stored value, absent fields keep
 * it. Returns a fresh object; `stored` is not mutated.
 */
export function mergeEmulateOverrides(
  stored: EmulateOverrides | undefined,
  overrides: EmulateOverrides,
): EmulateOverrides {
  const merged: EmulateOverrides = { ...stored };
  if (overrides.width !== undefined) merged.width = overrides.width;
  if (overrides.height !== undefined) merged.height = overrides.height;
  if (overrides.device_scale_factor !== undefined) {
    merged.device_scale_factor = overrides.device_scale_factor;
  }
  if (overrides.mobile !== undefined) merged.mobile = overrides.mobile;
  if (overrides.user_agent !== undefined) merged.user_agent = overrides.user_agent;
  if (overrides.accept_language !== undefined) {
    merged.accept_language = overrides.accept_language;
  }
  if (overrides.user_agent_metadata !== undefined) {
    merged.user_agent_metadata = overrides.user_agent_metadata;
  }
  if (overrides.touch !== undefined) merged.touch = overrides.touch;
  if (overrides.max_touch_points !== undefined) {
    merged.max_touch_points = overrides.max_touch_points;
  }
  return merged;
}

/**
 * CDP calls run in sequence without rollback: on a mid-way failure the
 * overrides already applied stay in effect, so the error says how to
 * reset them.
 */
function cdpFailed(err: unknown): RpcError {
  const cause = err instanceof Error ? err.message : String(err);
  return {
    code: "cdp_failed",
    message: `${cause} (overrides applied before the failure were not rolled back — use --off to reset)`,
  };
}

/**
 * Cross-field validation for one overrides set. The CLI performs the
 * same checks; the extension re-validates because the wire format is
 * public.
 */
export function validateOverrides(overrides: EmulateOverrides): RpcError | null {
  const hasWidth = overrides.width !== undefined;
  const hasHeight = overrides.height !== undefined;
  if (hasWidth !== hasHeight) {
    return invalidParams("emulate overrides require width and height together");
  }
  if (hasWidth) {
    if (!Number.isSafeInteger(overrides.width) || (overrides.width as number) <= 0) {
      return invalidParams("width must be a positive integer");
    }
    if (!Number.isSafeInteger(overrides.height) || (overrides.height as number) <= 0) {
      return invalidParams("height must be a positive integer");
    }
  }
  if (
    (overrides.device_scale_factor !== undefined || overrides.mobile !== undefined) &&
    !hasWidth
  ) {
    return invalidParams("device_scale_factor and mobile require width and height");
  }
  if (
    overrides.device_scale_factor !== undefined &&
    (!Number.isFinite(overrides.device_scale_factor) || overrides.device_scale_factor <= 0)
  ) {
    return invalidParams("device_scale_factor must be a positive finite number");
  }
  if (
    (overrides.accept_language !== undefined || overrides.user_agent_metadata !== undefined) &&
    overrides.user_agent === undefined
  ) {
    return invalidParams("accept_language and user_agent_metadata require user_agent");
  }
  if (
    overrides.max_touch_points !== undefined &&
    (!Number.isSafeInteger(overrides.max_touch_points) || overrides.max_touch_points < 1)
  ) {
    return invalidParams("max_touch_points must be a positive integer");
  }
  const anyOverride =
    hasWidth ||
    overrides.user_agent !== undefined ||
    overrides.touch !== undefined ||
    overrides.max_touch_points !== undefined;
  if (!anyOverride) {
    return invalidParams(
      "emulate requires at least one override (viewport, user agent, or touch) or off: true",
    );
  }
  return null;
}

/**
 * Handler for `tool.emulate` (called by the daemon over WS).
 *
 * Merges the requested overrides onto the tab's remembered state and
 * applies the merged state in a fixed order — viewport metrics, then
 * UA, then touch — or clears everything (state included) when `off` is
 * set. Raw CDP failures surface as `cdp_failed` (§4.5).
 */
export async function handleEmulate(
  manager: SessionManager,
  params: EmulateParams,
  deps: EmulateDeps = defaultEmulateDeps(),
): Promise<EmulateResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "emulate");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const target = await resolveTargetTab(manager, ctx, params?.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "emulate");
  if (denied) return denied;

  if (params.off === true) {
    if (params.overrides !== undefined) {
      return invalidParams("emulate off cannot be combined with overrides");
    }
    try {
      deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
      await deps.cdp.clearDeviceMetricsOverride(target.tabId);
      await deps.cdp.setTouchEmulationEnabled(target.tabId, false);
      // An empty userAgent string clears the override (CDP convention).
      await deps.cdp.setUserAgentOverride(target.tabId, { userAgent: "" });
    } catch (err) {
      return cdpFailed(err);
    }
    tabEmulationStates.delete(target.tabId);
    return { tab_id: target.tabId, cleared: true, note: EMULATE_SCOPE_NOTE };
  }

  const overrides = params.overrides;
  if (!overrides) {
    return invalidParams("emulate requires overrides or off: true");
  }
  const invalid = validateOverrides(overrides);
  if (invalid) return invalid;

  // Fields absent from this request keep their previously applied
  // values; the merged state is what gets applied (and echoed back).
  const merged = mergeEmulateOverrides(tabEmulationStates.get(target.tabId), overrides);
  try {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    if (merged.width !== undefined && merged.height !== undefined) {
      await deps.cdp.setDeviceMetricsOverride(target.tabId, {
        width: merged.width,
        height: merged.height,
        deviceScaleFactor: merged.device_scale_factor ?? 0,
        mobile: merged.mobile ?? false,
      });
    }
    if (merged.user_agent !== undefined) {
      await deps.cdp.setUserAgentOverride(target.tabId, {
        userAgent: merged.user_agent,
        ...(merged.accept_language !== undefined ? { acceptLanguage: merged.accept_language } : {}),
        ...(merged.user_agent_metadata !== undefined
          ? { userAgentMetadata: toCdpUserAgentMetadata(merged.user_agent_metadata) }
          : {}),
      });
    }
    if (merged.touch !== undefined || merged.max_touch_points !== undefined) {
      await deps.cdp.setTouchEmulationEnabled(
        target.tabId,
        merged.touch ?? true,
        merged.max_touch_points,
      );
    }
  } catch (err) {
    return cdpFailed(err);
  }
  // Record the merged state only once it was fully applied.
  tabEmulationStates.set(target.tabId, merged);
  return {
    tab_id: target.tabId,
    cleared: false,
    applied: merged,
    note: EMULATE_SCOPE_NOTE,
  };
}
