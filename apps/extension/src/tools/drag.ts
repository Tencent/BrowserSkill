import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import type { DragParams, DragPoint, DragResult, DragTarget, RpcError } from "@/transport/types";
import { withClickOverlay } from "./click-overlay";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { resolveNodeGeometry, scrollElementAndFramesIntoView } from "./frame-geometry";
import { withInputReady } from "./input-readiness";
import { type InteractionDeps, modifiersBitfield, resolveActionTarget } from "./interaction";
import { pointerTransactionDeps } from "./pointer-transaction";
import {
  type CdpRunner,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
  sendToCdpTarget,
} from "./shared";
import { pointReachesTarget } from "./target-hit";
import { BoundedWaitError, waitBounded } from "./transfer-transaction";

const validPoint = (p: DragPoint | undefined) =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
function validTarget(t: DragTarget | undefined): boolean {
  return (
    !!t &&
    [t.ref, t.selector].filter((v) => typeof v === "string" && v.trim()).length === 1 &&
    !(t.ref !== undefined && t.selector !== undefined) &&
    (t.offset === undefined || validPoint(t.offset))
  );
}
export function validateDrag(p: DragParams): RpcError | null {
  if (
    !p ||
    !validTarget(p.source) ||
    (p.target !== undefined && !validTarget(p.target)) ||
    (p.target !== undefined) === (p.delta !== undefined) ||
    (p.delta !== undefined && (!validPoint(p.delta) || (p.delta.x === 0 && p.delta.y === 0)))
  )
    return {
      code: "invalid_params",
      message: "drag requires a source and exactly one target or finite nonzero delta",
    };
  for (const [value, min, max] of [
    [p.hold_ms ?? 0, 0, 5000],
    [p.duration_ms ?? 500, 1, 5000],
    [p.timeout_ms ?? 30000, 1, 2147483647],
  ])
    if (!Number.isSafeInteger(value) || value < min || value > max)
      return {
        code: "invalid_params",
        message: "drag requires hold 0..5000ms, duration 1..5000ms and a positive timeout",
      };
  if (
    (p.button !== undefined && !["left", "middle", "right"].includes(p.button)) ||
    (p.modifiers !== undefined &&
      (!Array.isArray(p.modifiers) ||
        p.modifiers.some((m) => !["alt", "ctrl", "shift", "meta"].includes(m)))) ||
    (p.observation_id !== undefined && (typeof p.observation_id !== "string" || !p.observation_id))
  )
    return { code: "invalid_params", message: "invalid drag button, modifiers or observation_id" };
  return null;
}

/** One request owns all input, including compensation after timeout or human takeover. */
export async function handleDrag(
  manager: SessionManager,
  params: DragParams,
  deps: InteractionDeps = { cdp: new ChromiumCdp(), tabsApi: chromeTabsApi },
): Promise<DragResult | RpcError> {
  if (deps.signal?.aborted)
    return { code: "cancelled", message: "drag aborted", data: { effect_state: "none" } };
  const invalid = validateDrag(params);
  if (invalid) return invalid;
  const ctx = lookupSession(manager, params, "drag");
  if (isRpcError(ctx)) return ctx;
  const observationId = ctx.refStore.observationId;
  if (params.observation_id !== undefined && params.observation_id !== observationId)
    return {
      code: "not_found",
      message: "observation expired; observe again before dragging",
      data: { effect_state: "none" },
    };
  const deadline = Date.now() + (params.timeout_ms ?? 30000);
  const transaction = pointerTransactionDeps(deps, deps.signal, true);
  const inputDeps = transaction.deps;
  let attempted = false;
  let document: { tabId: number; revision: number } | undefined;
  const check = () => {
    if (deps.signal?.aborted) throw new DOMException("drag aborted", "AbortError");
    if (Date.now() >= deadline) throw new DOMException("drag timed out", "TimeoutError");
    if (document && ctx.refStore.documentRevision(document.tabId) !== document.revision)
      throw new Error("document changed during drag");
    if (ctx.refStore.observationId !== observationId)
      throw new Error("observation or document changed during drag");
  };
  // Check identity even between frames of a gesture. The transaction also fences
  // late CDP continuations after the outer time boundary has retired the operation.
  const cdp = new Proxy(inputDeps.cdp, {
    get(target, key) {
      if (key === "resourceCleanup") return deps.cdp.resourceCleanup ?? deps.cdp;
      const value = Reflect.get(target, key);
      return typeof value === "function"
        ? (...args: unknown[]) => {
            check();
            return value.apply(target, args);
          }
        : value;
    },
  }) as CdpRunner;
  let outcome: DragResult | RpcError;
  try {
    outcome = await waitBounded(
      (async (): Promise<DragResult | RpcError> => {
        check();
        const tab = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
        if (isRpcError(tab)) return tab;
        const denied = enforceAgentWindow(ctx, tab, "drag");
        if (denied) return denied;
        document = { tabId: tab.tabId, revision: ctx.refStore.documentRevision(tab.tabId) };
        cdp.trackSessionTab?.(ctx.sessionId, tab.tabId);
        const resolve = (spec: DragTarget) =>
          resolveActionTarget(cdp, ctx, tab, spec, "drag", true);
        const source = await resolve(params.source);
        check();
        if (isRpcError(source)) return source;
        const target = params.target ? await resolve(params.target) : undefined;
        check();
        if (target && isRpcError(target)) return target;
        return withInputReady(
          ctx,
          tab.tabId,
          { ...deps, deadline, registerCleanup: inputDeps.registerClickCleanup },
          async (input): Promise<DragResult | RpcError> => {
            const address = (r: typeof source) => ({
              target: r.cdpTarget,
              backendNodeId: r.backendNodeId,
              frameId: r.frameId,
            });
            // Scroll both ends first, then measure both again. Scrolling the second
            // endpoint must never leave us using stale coordinates for the first.
            for (const node of target ? [source, target] : [source]) {
              const error = await scrollElementAndFramesIntoView(
                cdp,
                tab.tabId,
                node.cdpTarget,
                node.backendNodeId,
                node.frameId,
              );
              if (error) return error;
            }
            const startGeometry = await resolveNodeGeometry(cdp, tab.tabId, address(source));
            if (isRpcError(startGeometry)) return startGeometry;
            const endGeometry = target
              ? await resolveNodeGeometry(cdp, tab.tabId, address(target))
              : undefined;
            if (endGeometry && isRpcError(endGeometry)) return endGeometry;
            const offset = (p: DragPoint, o?: DragPoint): DragPoint => ({
              x: p.x + (o?.x ?? 0),
              y: p.y + (o?.y ?? 0),
            });
            if (
              (source.cdpTarget.sessionId && params.source.offset) ||
              (target?.cdpTarget.sessionId && params.target?.offset)
            )
              return {
                code: "unsupported",
                message:
                  "offsets within out-of-process frames are not supported; use an element ref at the desired point",
              };
            const start = offset(startGeometry.actionPoint, params.source.offset);
            const end = endGeometry
              ? offset(endGeometry.actionPoint, params.target?.offset)
              : offset(start, params.delta);
            const viewport = startGeometry.topViewport;
            if (
              [start, end].some(
                (p) =>
                  !validPoint(p) ||
                  p.x < 0 ||
                  p.y < 0 ||
                  p.x >= viewport.width ||
                  p.y >= viewport.height,
              ) ||
              (start.x === end.x && start.y === end.y)
            )
              return {
                code: "invalid_params",
                message: "drag needs distinct endpoints inside the visible viewport",
              };
            const button = params.button ?? "left";
            const buttons = { left: 1, right: 2, middle: 4 }[button];
            const modifiers = modifiersBitfield(params.modifiers);
            const cursor = markDialogCursor(deps.cdp, tab.tabId);
            return withClickOverlay(
              tab.tabId,
              start,
              { ...inputDeps, cdp },
              async (verifyOverlay): Promise<DragResult | RpcError> => {
                await cdp.send(tab.tabId, "Input.dispatchMouseEvent", {
                  type: "mouseMoved",
                  ...start,
                  modifiers,
                });
                const blocked = await verifyOverlay();
                if (blocked) return blocked;
                const group = `drag-hit-${crypto.randomUUID()}`;
                try {
                  const { object } = await sendToCdpTarget<{ object?: { objectId?: string } }>(
                    cdp,
                    source.cdpTarget,
                    "DOM.resolveNode",
                    { backendNodeId: source.backendNodeId, objectGroup: group },
                  );
                  if (!object?.objectId)
                    return { code: "not_found", message: "drag source is detached" };
                  const state = await sendToCdpTarget<{ result?: { value?: boolean } }>(
                    cdp,
                    source.cdpTarget,
                    "Runtime.callFunctionOn",
                    {
                      objectId: object.objectId,
                      returnByValue: true,
                      functionDeclaration: `function() { return this.isConnected && !this.matches(':disabled,[aria-disabled="true"]') && !this.closest('[inert]'); }`,
                    },
                  );
                  if (state.result?.value !== true)
                    return {
                      code: "permission_denied",
                      message: "drag source is detached, disabled or inert",
                    };
                  const endpoints: [typeof source, DragPoint][] = [[source, start]];
                  if (target) endpoints.push([target, end]);
                  for (const [node, point] of endpoints) {
                    if (!(await pointReachesTarget(cdp, { ...node, tabId: tab.tabId }, point)))
                      return {
                        code: "permission_denied",
                        message:
                          "drag endpoint is covered or no longer belongs to the requested element",
                      };
                  }
                } finally {
                  const cleanup = deps.cdp.resourceCleanup ?? deps.cdp;
                  for (const node of target ? [source, target] : [source])
                    await sendToCdpTarget(cleanup, node.cdpTarget, "Runtime.releaseObjectGroup", {
                      objectGroup: group,
                    }).catch(() => {});
                }
                await cdp.verifyPointerTarget?.(
                  { ...source, tabId: tab.tabId },
                  start,
                  params.source.offset,
                );
                input.markSent();
                attempted = true;
                deps.onInputSent?.(tab.tabId);
                await cdp.send(tab.tabId, "Input.dispatchMouseEvent", {
                  type: "mousePressed",
                  ...start,
                  button,
                  buttons,
                  modifiers,
                  clickCount: 1,
                });
                const pause = async (ms: number) => {
                  check();
                  if (ms <= 0) return;
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  try {
                    await waitBounded(
                      new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, ms);
                      }),
                      deadline,
                      deps.signal,
                      "drag timed out",
                    );
                  } catch (error) {
                    if (error instanceof BoundedWaitError)
                      throw new DOMException(
                        "drag " + error.kind,
                        error.kind === "timeout" ? "TimeoutError" : "AbortError",
                      );
                    throw error;
                  } finally {
                    clearTimeout(timer);
                  }
                  check();
                };
                await pause(params.hold_ms ?? 0);
                const duration = params.duration_ms ?? 500;
                const steps = Math.max(2, Math.ceil(duration / 16));
                const started = Date.now();
                for (let step = 1; step <= steps; step++) {
                  await pause(started + (duration * step) / steps - Date.now());
                  const ratio = step / steps;
                  await cdp.send(tab.tabId, "Input.dispatchMouseEvent", {
                    type: "mouseMoved",
                    x: start.x + (end.x - start.x) * ratio,
                    y: start.y + (end.y - start.y) * ratio,
                    button,
                    buttons,
                    modifiers,
                  });
                }
                // A second move at the destination also serves HTML dragover consumers.
                await cdp.send(tab.tabId, "Input.dispatchMouseEvent", {
                  type: "mouseMoved",
                  ...end,
                  button,
                  buttons,
                  modifiers,
                });
                await cdp.send(tab.tabId, "Input.dispatchMouseEvent", {
                  type: "mouseReleased",
                  ...end,
                  button,
                  buttons: 0,
                  modifiers,
                  clickCount: 1,
                });
                return attachDialogs(deps.cdp, tab.tabId, cursor, {
                  tab_id: tab.tabId,
                  source: start,
                  target: end,
                });
              },
              true,
              (params.hold_ms ?? 0) + (params.duration_ms ?? 500) + 1_000,
            );
          },
        );
      })(),
      deadline,
      deps.signal,
      "drag timed out",
    );
  } catch (error) {
    const aborted =
      deps.signal?.aborted ||
      (error instanceof BoundedWaitError && error.kind === "aborted") ||
      (error instanceof Error && error.name === "AbortError");
    const timeout =
      (error instanceof BoundedWaitError && error.kind === "timeout") ||
      (error instanceof Error && error.name === "TimeoutError");
    outcome = {
      code: aborted ? "cancelled" : timeout ? "timeout" : "cdp_failed",
      message: aborted ? "drag aborted" : error instanceof Error ? error.message : String(error),
    };
  }
  try {
    await transaction.cleanup(Date.now() + 2000);
  } catch {
    outcome = {
      code: "cdp_failed",
      message: "drag cleanup could not be confirmed; observe before further input",
    };
  }
  return isRpcError(outcome)
    ? { ...outcome, data: { ...outcome.data, effect_state: attempted ? "unknown" : "none" } }
    : outcome;
}
