import type { CdpFrameGraph } from "@/browser-driver/frame-graph";
import type { SessionContext } from "@/session-manager/manager";
import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import { resolveNodeGeometry } from "./frame-geometry";
import { type CdpRunner, isRpcError, normaliseRef } from "./shared";
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

export interface SurfaceTargetResolverDeps {
  cdp: CdpRunner;
  signal?: AbortSignal;
}

export interface SurfacePointerTargetInput {
  ref?: string;
  selector?: string;
  captureId?: string;
  imageX?: number;
  imageY?: number;
}

export interface ResolvedSurfacePointerTarget {
  point: { x: number; y: number };
  usedRef: string;
  moveSettleMs: number;
  capture: {
    id: string;
    imageX: number;
    imageY: number;
  };
}

// Canvas-style controls commonly update their pointer hit-test on the next
// animation frame. Leave a scheduling boundary after moving and before pressing.
export const SURFACE_POINTER_MOVE_SETTLE_MS = 32;

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

function validatePointParams(input: SurfacePointerTargetInput): RpcError | null {
  if (!input.captureId || typeof input.captureId !== "string") {
    return { code: "invalid_params", message: "surface point click requires capture_id" };
  }
  if (typeof input.imageX !== "number" || !Number.isFinite(input.imageX)) {
    return { code: "invalid_params", message: "image_x must be a finite number" };
  }
  if (typeof input.imageY !== "number" || !Number.isFinite(input.imageY)) {
    return { code: "invalid_params", message: "image_y must be a finite number" };
  }
  if (!input.ref || input.selector) {
    return {
      code: "invalid_params",
      message: "surface point click requires one Surface ref and does not accept a selector",
    };
  }
  return null;
}

function captureConsumeError(reason: "not_found" | "expired" | "consumed"): RpcError {
  const code = reason === "not_found" ? "not_found" : "permission_denied";
  return rpcError(code, `surface_capture_${reason}`, `surface capture is ${reason}`);
}

function aborted(signal: AbortSignal | undefined): RpcError | null {
  return signal?.aborted
    ? { code: "cancelled", message: "surface target resolution aborted" }
    : null;
}

/** Resolve one fresh Surface capture coordinate into a validated top-viewport pointer target. */
export async function resolveSurfacePointerTarget(
  ctx: SessionContext,
  target: { tabId: number; url?: string },
  input: SurfacePointerTargetInput,
  deps: SurfaceTargetResolverDeps,
): Promise<ResolvedSurfacePointerTarget | RpcError> {
  const invalid = validatePointParams(input);
  if (invalid) return invalid;
  const earlyAbort = aborted(deps.signal);
  if (earlyAbort) return earlyAbort;

  const consumed = ctx.surfaceCaptures.consume(input.captureId as string);
  if (!consumed.ok) return captureConsumeError(consumed.reason);
  const capture = consumed.capture;
  const postConsumeAbort = aborted(deps.signal);
  if (postConsumeAbort) return postConsumeAbort;

  if (capture.sessionId !== ctx.sessionId || capture.tabId !== target.tabId) {
    return stale("surface capture belongs to a different session or tab");
  }
  if (normaliseRef(input.ref as string) !== capture.surface.ref) {
    return stale("surface ref does not match the capture");
  }
  const node = resolveSnapshotRef(ctx, input.ref as string, target.tabId, "screenshot");
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
    input.imageX as number,
    input.imageY as number,
  );
  if (!point || !pointInRegion(point, geometry.topVisibleRegions)) {
    return rpcError(
      "invalid_params",
      "surface_coordinate_invalid",
      "image coordinate is outside the captured Surface",
    );
  }

  return {
    point,
    usedRef: capture.surface.ref,
    moveSettleMs: SURFACE_POINTER_MOVE_SETTLE_MS,
    capture: {
      id: capture.id,
      imageX: input.imageX as number,
      imageY: input.imageY as number,
    },
  };
}
