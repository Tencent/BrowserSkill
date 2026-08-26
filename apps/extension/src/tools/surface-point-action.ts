import type { CdpFrameGraph } from "@/browser-driver/frame-graph";
import type { SessionManager } from "@/session-manager/manager";
import type { ClickParams, ClickResult, RpcError } from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { rpcError } from "./errors";
import { resolveNodeGeometry } from "./frame-geometry";
import { dispatchMouseClick } from "./mouse-input";
import {
  type CdpRunner,
  type ChromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  normaliseRef,
  resolveTargetTab,
} from "./shared";
import { resolveSnapshotRef } from "./snapshot-ref";
import {
  mapImagePointToViewport,
  pointInRegion,
  sameRect,
  surfaceVisibleRect,
} from "./surface-coordinate";

export interface SurfaceCaptureEnvironment {
  navigationIdentity: string;
  viewportSignature: string;
  frameProjectionSignature: string;
}

export interface SurfacePointActionDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  signal?: AbortSignal;
  bypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
}

// Canvas-style controls commonly update their pointer hit-test on the next
// animation frame. Leave a scheduling boundary after moving and before pressing.
const SURFACE_POINTER_MOVE_SETTLE_MS = 32;

function stale(message: string): RpcError {
  return rpcError("permission_denied", "surface_capture_stale", message);
}

function finiteObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(finiteObject);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([, entry]) => entry !== undefined && (typeof entry !== "number" || Number.isFinite(entry)),
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, finiteObject(entry)]),
  );
}

function framePathSignature(graph: CdpFrameGraph, frameId: string | undefined): string | null {
  if (!frameId) return "top";
  const frames = new Map(graph.frames.map((frame) => [frame.frameId, frame]));
  const path: Array<{
    frameId: string;
    parentFrameId?: string;
    ownerBackendNodeId?: number;
    targetSessionId?: string;
  }> = [];
  const seen = new Set<string>();
  let current = frames.get(frameId);
  while (current) {
    if (seen.has(current.frameId)) return null;
    seen.add(current.frameId);
    path.push({
      frameId: current.frameId,
      ...(current.parentFrameId ? { parentFrameId: current.parentFrameId } : {}),
      ...(current.ownerBackendNodeId !== undefined
        ? { ownerBackendNodeId: current.ownerBackendNodeId }
        : {}),
      ...(current.target.sessionId ? { targetSessionId: current.target.sessionId } : {}),
    });
    if (!current.parentFrameId) return JSON.stringify(path);
    const parent = frames.get(current.parentFrameId);
    if (!parent) return null;
    current = parent;
  }
  return null;
}

export async function captureSurfaceEnvironment(
  cdp: CdpRunner,
  tabId: number,
  frameId: string | undefined,
): Promise<SurfaceCaptureEnvironment | RpcError> {
  try {
    const [tree, metrics, graph] = await Promise.all([
      cdp.send<{
        frameTree?: { frame?: { id?: string; loaderId?: string; url?: string } };
      }>(tabId, "Page.getFrameTree", {}),
      cdp.send<Record<string, unknown>>(tabId, "Page.getLayoutMetrics", {}),
      frameId && cdp.getFrameGraph ? cdp.getFrameGraph(tabId) : Promise.resolve(null),
    ]);
    const root = tree.frameTree?.frame;
    if (!root?.id || !root.loaderId) {
      return { code: "cdp_failed", message: "could not identify the current navigation" };
    }
    const frameProjectionSignature = frameId
      ? graph
        ? framePathSignature(graph, frameId)
        : null
      : "top";
    if (!frameProjectionSignature) {
      return { code: "cdp_failed", message: `could not identify frame projection for ${frameId}` };
    }
    return {
      navigationIdentity: JSON.stringify({ id: root.id, loaderId: root.loaderId, url: root.url }),
      viewportSignature: JSON.stringify(
        finiteObject({
          cssLayoutViewport: metrics.cssLayoutViewport,
          cssVisualViewport: metrics.cssVisualViewport,
        }),
      ),
      frameProjectionSignature,
    };
  } catch (error) {
    return { code: "cdp_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

function validatePointParams(params: ClickParams): RpcError | null {
  if (!params.capture_id || typeof params.capture_id !== "string") {
    return { code: "invalid_params", message: "surface point click requires capture_id" };
  }
  if (typeof params.image_x !== "number" || !Number.isFinite(params.image_x)) {
    return { code: "invalid_params", message: "image_x must be a finite number" };
  }
  if (typeof params.image_y !== "number" || !Number.isFinite(params.image_y)) {
    return { code: "invalid_params", message: "image_y must be a finite number" };
  }
  if (!params.ref || params.selector) {
    return {
      code: "invalid_params",
      message: "surface point click requires one Surface ref and does not accept a selector",
    };
  }
  if ((params.button ?? "left") !== "left" || (params.click_count ?? 1) !== 1) {
    return {
      code: "invalid_params",
      message: "surface point click currently supports one left click only",
    };
  }
  if (params.modifiers && params.modifiers.length > 0) {
    return { code: "invalid_params", message: "surface point click does not accept modifiers" };
  }
  return null;
}

function captureConsumeError(reason: "not_found" | "expired" | "consumed"): RpcError {
  const code = reason === "not_found" ? "not_found" : "permission_denied";
  return rpcError(code, `surface_capture_${reason}`, `surface capture is ${reason}`);
}

function aborted(signal: AbortSignal | undefined): RpcError | null {
  return signal?.aborted ? { code: "cancelled", message: "surface point click aborted" } : null;
}

export async function handleSurfacePointClick(
  manager: SessionManager,
  params: ClickParams,
  deps: SurfacePointActionDeps,
): Promise<ClickResult | RpcError> {
  const invalid = validatePointParams(params);
  if (invalid) return invalid;
  const ctxOrError = lookupSession(manager, params, "click");
  if (isRpcError(ctxOrError)) return ctxOrError;
  const ctx = ctxOrError;
  const earlyAbort = aborted(deps.signal);
  if (earlyAbort) return earlyAbort;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "click");
  if (denied) return denied;

  const consumed = ctx.surfaceCaptures.consume(params.capture_id as string);
  if (!consumed.ok) return captureConsumeError(consumed.reason);
  const capture = consumed.capture;
  const postConsumeAbort = aborted(deps.signal);
  if (postConsumeAbort) return postConsumeAbort;

  if (capture.sessionId !== ctx.sessionId || capture.tabId !== target.tabId) {
    return stale("surface capture belongs to a different session or tab");
  }
  if (normaliseRef(params.ref as string) !== capture.surface.ref) {
    return stale("surface ref does not match the capture");
  }
  const node = resolveSnapshotRef(ctx, params.ref as string, target.tabId, "screenshot");
  if (isRpcError(node)) return stale(node.message);
  if (
    node.kind !== "surface" ||
    node.backendNodeId !== capture.surface.backendNodeId ||
    node.frameId !== capture.surface.frameId ||
    node.generation !== capture.surface.observationGeneration
  ) {
    return stale("surface observation generation or node identity changed");
  }

  deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
  try {
    await deps.cdp.ensureAttachedToUrl?.(target.tabId, target.url);
  } catch (error) {
    return { code: "cdp_failed", message: error instanceof Error ? error.message : String(error) };
  }
  const environment = await captureSurfaceEnvironment(deps.cdp, target.tabId, node.frameId);
  if (isRpcError(environment)) return environment;
  if (
    environment.navigationIdentity !== capture.navigationIdentity ||
    environment.viewportSignature !== capture.viewportSignature ||
    environment.frameProjectionSignature !== capture.frameProjectionSignature
  ) {
    return stale("navigation, viewport, zoom, scroll, or frame projection changed");
  }

  const geometry = await resolveNodeGeometry(
    deps.cdp,
    target.tabId,
    {
      target: {
        tabId: target.tabId,
        ...(node.cdpSessionId ? { sessionId: node.cdpSessionId } : {}),
      },
      backendNodeId: node.backendNodeId,
      ...(node.frameId ? { frameId: node.frameId } : {}),
    },
    { scrollIntoView: false },
  );
  if (isRpcError(geometry)) return stale(geometry.message);
  const currentRect = surfaceVisibleRect(geometry.topBounds, node.visibleRect);
  if (!currentRect || !sameRect(currentRect, capture.topViewportRect)) {
    return stale("surface visible region changed");
  }
  const point = mapImagePointToViewport(
    capture.topViewportRect,
    capture.imageWidth,
    capture.imageHeight,
    params.image_x as number,
    params.image_y as number,
  );
  if (!point || !pointInRegion(point, geometry.topVisibleRegions)) {
    return rpcError(
      "invalid_params",
      "surface_coordinate_invalid",
      "image coordinate is outside the captured Surface",
    );
  }

  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);
  let bypassEnabled = false;
  try {
    if (deps.bypassOverlay) {
      await deps.bypassOverlay(target.tabId, true);
      bypassEnabled = true;
    }
    const dispatch = await dispatchMouseClick(deps.cdp, target.tabId, point, {
      button: "left",
      clickCount: 1,
      modifiers: 0,
      signal: deps.signal,
      moveSettleMs: SURFACE_POINTER_MOVE_SETTLE_MS,
    });
    if (dispatch === "cancelled") {
      return { code: "cancelled", message: "surface point click aborted" };
    }
  } catch (error) {
    return { code: "cdp_failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (bypassEnabled && deps.bypassOverlay) {
      try {
        await deps.bypassOverlay(target.tabId, false);
      } catch (error) {
        console.debug("[bsk surface-point] overlay bypass disable failed", error);
      }
    }
  }

  return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
    tab_id: target.tabId,
    used_ref: capture.surface.ref,
    x: point.x,
    y: point.y,
    capture_id: capture.id,
    image_x: params.image_x,
    image_y: params.image_y,
  });
}
