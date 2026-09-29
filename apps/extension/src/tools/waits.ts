// `tool.wait_for_navigation` — subscribe to CDP `Page.lifecycleEvent`
// on the target tab and wait until the requested phase fires. Design
// §4 / §7, plan M9.2.
//
// Sandbox follows the same rules as the navigate / interaction tools:
// `resolveTargetTab` + `enforceAgentWindow`. Borrowed tabs already
// inside the Agent Window are allowed; user-window tabs are refused
// with `permission_denied`.
//
// Implementation: reuses the M7 helpers `ensureCdpReady` +
// `waitForLifecyclePassive` (readyState probe + event listener) from
// navigation.ts. Reads the main frame via `Page.getFrameTree` so
// subframe lifecycle events cannot satisfy a page-level wait.
//
// `tool.wait_for_element` — wait until one element reaches a requested
// state (`visible` / `hidden` / `attached` / `detached`). It is the
// element-level counterpart of the lifecycle wait, and it exists so a
// caller does not have to write its own `evaluate` + `wait-ms` polling
// loop: that loop spends one full round trip per probe (agent → daemon
// → extension → page) and, when it runs its clock inside the page, it
// is at the mercy of background-tab timer throttling. Here the loop
// lives next to the browser, so a ten-second wait costs one RPC instead
// of one per probe, and no page timer is involved at all.
//
// `wait_for_element` probes deliberately go through the shared
// `resolveBackendNode` instead of a page-side promise. That keeps ref /
// selector / frame handling identical to every other tool, and it keeps
// the loop completely independent of page timers (a
// `MutationObserver`-driven in-page wait would be cheaper per probe,
// but only for the selector path — see the note on `probeState`).

import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { type CdpTarget, cdpTargetKey } from "@/browser-driver/frame-graph";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import type {
  RpcError,
  WaitForNavigationParams,
  WaitForNavigationResult,
  WaitForElementParams,
  WaitForElementResult,
  ElementState,
  WaitUntil,
} from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { cdpError } from "./errors";
import { resolveBackendNode } from "./interaction";
import { cdpLifecycleName, ensureCdpReady, waitForLifecyclePassive } from "./navigation";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
  sendToCdpTarget,
} from "./shared";

export interface WaitForNavigationDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  /** Abort hook (full chain wired in M10.2). */
  signal?: AbortSignal;
  defaultTimeoutMs?: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

interface FrameTreeReply {
  frameTree?: {
    frame?: {
      id?: string;
    };
  };
}

let defaultDeps: { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } | null = null;
function getDefaultDeps(): { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } {
  if (!defaultDeps) {
    defaultDeps = { cdp: new ChromiumCdp(), tabsApi: chromeTabsApi };
  }
  return defaultDeps;
}

export async function handleWaitForNavigation(
  manager: SessionManager,
  params: WaitForNavigationParams,
  deps: WaitForNavigationDeps = getDefaultDeps(),
): Promise<WaitForNavigationResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "wait_for_navigation");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  if (deps.signal?.aborted) {
    return { code: "cancelled", message: "wait_for_navigation aborted" };
  }
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "wait_for_navigation");
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  const waitUntil: WaitUntil = params.wait_until ?? "load";
  const timeoutMs = params.timeout_ms ?? deps.defaultTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const expected = cdpLifecycleName(waitUntil);

  try {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    await ensureCdpReady(deps.cdp, target.tabId);
    if (deps.signal?.aborted) {
      return { code: "cancelled", message: "wait_for_navigation aborted" };
    }
    const frameTree = await deps.cdp.send<FrameTreeReply>(target.tabId, "Page.getFrameTree", {});
    const mainFrameId = frameTree.frameTree?.frame?.id;
    if (!mainFrameId) {
      return { code: "cdp_failed", message: "Page.getFrameTree did not return a main frame id" };
    }
    if (deps.signal?.aborted) {
      return { code: "cancelled", message: "wait_for_navigation aborted" };
    }
    const outcome = await waitForLifecyclePassive(
      deps.cdp,
      target.tabId,
      mainFrameId,
      expected,
      timeoutMs,
      deps.signal,
    );
    if (outcome.reached === "cancelled") {
      return { code: "cancelled", message: "wait_for_navigation aborted" };
    }
    if (outcome.reached === "match") {
      return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
        tab_id: target.tabId,
        reached: waitUntil,
      });
    }
    return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
      tab_id: target.tabId,
      reached: "timeout",
      error_text: `timed out waiting for lifecycle "${expected}" after ${timeoutMs}ms${
        outcome.lastLifecycle ? `; last observed "${outcome.lastLifecycle}"` : ""
      }`,
    });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// tool.wait_for_element
// ---------------------------------------------------------------------------

export interface WaitForElementDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  signal?: AbortSignal;
  defaultTimeoutMs?: number;
}

/** Defaults mirror `bsk-protocol`'s documented ones. */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 100;
/** A probe is several CDP calls; anything faster just burns the renderer. */
const MIN_POLL_MS = 16;
const MAX_POLL_MS = 2_000;
/** Same ceiling as `wait_ms` — a single RPC should not park a tab for longer. */
const MAX_TIMEOUT_MS = 300_000;

const WAIT_FOR_STATES: readonly ElementState[] = [
  "visible",
  "hidden",
  "attached",
  "detached",
] as const;

/**
 * Visibility predicate, kept in step with `scroll-visibility.ts`:
 * `checkVisibility` covers `display` / `visibility` / `opacity` /
 * `content-visibility`, and the rect check rejects the zero-box node that
 * still reports visible. `isConnected` is what separates "detached" from
 * "attached but hidden" — a detached node is not visible either, so the
 * order of these checks is what keeps the two states distinguishable.
 */
const STATE_PROBE = `function() {
  const element = this;
  if (!element || !element.isConnected) return { attached: false, visible: false };
  const visible = typeof element.checkVisibility === 'function'
    ? element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true,
      })
    : true;
  if (!visible) return { attached: true, visible: false };
  const rect = element.getBoundingClientRect();
  return { attached: true, visible: rect.width > 0 && rect.height > 0 };
}`;

interface Probe {
  attached: boolean;
  visible: boolean;
  usedRef?: string;
  usedSelector?: string;
}

/**
 * `used_ref` on the wire is bare (`e1`); the CLI's `format_used_target`
 * adds the `@`. Echoing the caller's `@e1` verbatim would render as `@@e1`.
 */
function normaliseRef(ref: string | undefined): string | undefined {
  const trimmed = ref?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^@+/, "");
}

/** Does an observation of `(attached, visible)` satisfy `state`? */
export function satisfiesState(
  state: ElementState,
  attached: boolean,
  visible: boolean,
): boolean {
  switch (state) {
    case "visible":
      return visible;
    case "hidden":
      return attached && !visible;
    case "attached":
      return attached;
    case "detached":
      return !attached;
  }
}

function abortError(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("wait-for-element aborted", "AbortError");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("wait-for-element aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function handleWaitForElement(
  manager: SessionManager,
  params: WaitForElementParams,
  deps: WaitForElementDeps = getDefaultDeps(),
): Promise<WaitForElementResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "wait-for-element");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;

  const hasRef = typeof params.ref === "string" && params.ref.trim().length > 0;
  const hasSelector = typeof params.selector === "string" && params.selector.trim().length > 0;
  // Exactly one, not "at least one": a caller that passes both has a bug
  // upstream, and silently preferring one of them would hide it.
  if (hasRef === hasSelector) {
    return {
      code: "invalid_params",
      message: "wait-for-element requires exactly one nonempty ref or selector",
    };
  }
  if (!WAIT_FOR_STATES.includes(params.state)) {
    return { code: "invalid_params", message: `wait-for-element: unknown state "${params.state}"` };
  }
  const timeoutMs = params.timeout_ms ?? deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    return {
      code: "invalid_params",
      message: `wait-for-element: timeout_ms must be an integer in 1..${MAX_TIMEOUT_MS}`,
    };
  }
  const pollMs = params.poll_ms ?? DEFAULT_POLL_MS;
  if (!Number.isInteger(pollMs) || pollMs < MIN_POLL_MS || pollMs > MAX_POLL_MS) {
    return {
      code: "invalid_params",
      message: `wait-for-element: poll_ms must be an integer in ${MIN_POLL_MS}..${MAX_POLL_MS}`,
    };
  }
  abortError(deps.signal);

  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "wait-for-element");
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  const started = Date.now();
  const deadline = started + timeoutMs;
  // One object group for the whole wait, released in `finally`: probes
  // allocate a node handle each time, and a 10s wait at 100ms is ~100 of
  // them (same pattern as `wheel.ts`).
  const objectGroup = `bsk-wait-for-element-${crypto.randomUUID()}`;
  const objectTargets = new Map<string, CdpTarget>();

  const finish = (probe: Probe, satisfied: boolean) =>
    attachDialogs(deps.cdp, target.tabId, dialogCursor, {
      tab_id: target.tabId,
      ...(probe.usedRef ? { used_ref: probe.usedRef } : {}),
      ...(probe.usedSelector ? { used_selector: probe.usedSelector } : {}),
      satisfied,
      attached: probe.attached,
      visible: probe.visible,
      elapsed_ms: Date.now() - started,
    });

  try {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    let probe: Probe = { attached: false, visible: false };
    for (;;) {
      abortError(deps.signal);
      // Probe before checking the deadline: when the wait times out, the
      // evidence we report has to describe the moment we stopped looking,
      // not the moment before it.
      const next = await probeState(deps.cdp, ctx, target, params, objectGroup, objectTargets);
      if (isRpcError(next)) return next;
      probe = next;
      if (satisfiesState(params.state, next.attached, next.visible)) {
        return finish(probe, true);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollMs, remaining), deps.signal);
      if (Date.now() >= deadline) break;
    }
    return finish(probe, false);
  } catch (error) {
    if (deps.signal?.aborted) return { code: "cancelled", message: "wait-for-element aborted" };
    return cdpError(error);
  } finally {
    for (const objectTarget of objectTargets.values()) {
      await sendToCdpTarget(deps.cdp, objectTarget, "Runtime.releaseObjectGroup", {
        objectGroup,
      }).catch(() => {});
    }
  }
}

/**
 * One state observation.
 *
 * Resolution goes through the shared `resolveBackendNode`, so a selector
 * is re-queried on every probe (that is how "wait until it appears"
 * works) and a ref keeps the same staleness rules as every other tool.
 *
 * "Not found" is reported as a state, not an error — it is precisely
 * what `detached` and the not-yet-`attached` case look like. Every other
 * failure propagates: folding a real CDP fault into `attached: false`
 * would let a broken probe masquerade as "the element really is gone",
 * and the caller uses exactly this distinction to decide whether the
 * case fails or is retried.
 */
async function probeState(
  cdp: CdpRunner,
  ctx: SessionContext,
  target: { tabId: number },
  params: WaitForElementParams,
  objectGroup: string,
  objectTargets: Map<string, CdpTarget>,
): Promise<Probe | RpcError> {
  const node = await resolveBackendNode(cdp, ctx, target, params, "wait-for-element");
  if (isRpcError(node)) {
    if (node.code === "not_found") {
      // The target is not there (yet, or any more). Echoing which target
      // was asked about matters most on this path: a timeout report has to
      // name what was being waited for, or the CLI renders `target=?`.
      const ref = normaliseRef(params.ref);
      return {
        attached: false,
        visible: false,
        ...(ref ? { usedRef: ref } : {}),
        ...(params.selector ? { usedSelector: params.selector } : {}),
      };
    }
    return node;
  }

  let objectId: string | undefined;
  try {
    const resolved = await sendToCdpTarget<{ object?: { objectId?: string } }>(
      cdp,
      node.cdpTarget,
      "DOM.resolveNode",
      { backendNodeId: node.backendNodeId, objectGroup },
    );
    objectId = resolved.object?.objectId;
  } catch {
    // The node left the document between the lookup and the handle
    // request. That is the `detached` transition itself — the one case
    // where a failing CDP call is an observation rather than a fault.
    return { attached: false, visible: false };
  }
  if (!objectId) return { attached: false, visible: false };
  objectTargets.set(cdpTargetKey(node.cdpTarget), node.cdpTarget);

  const reply = await sendToCdpTarget<{
    result?: { value?: { attached?: boolean; visible?: boolean } };
    exceptionDetails?: { text?: string };
  }>(cdp, node.cdpTarget, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: STATE_PROBE,
    returnByValue: true,
  });
  const value = reply.result?.value;
  if (!value || typeof value.attached !== "boolean") {
    // No usable shape: report a fault instead of inventing a state.
    return {
      code: "cdp_failed",
      message: reply.exceptionDetails?.text ?? "wait-for-element state probe returned nothing",
    };
  }
  return {
    attached: value.attached,
    visible: value.visible === true,
    ...(node.usedRef ? { usedRef: node.usedRef } : {}),
    ...(node.usedSelector ? { usedSelector: node.usedSelector } : {}),
  };
}

export const __testing__ = {
  DEFAULT_WAIT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  MIN_POLL_MS,
  MAX_POLL_MS,
  MAX_TIMEOUT_MS,
  STATE_PROBE,
};
