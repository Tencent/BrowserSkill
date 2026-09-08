import {
  type CdpFrame,
  type CdpFrameGraph,
  type CdpTarget,
  cdpTargetKey,
} from "@/browser-driver/frame-graph";
import {
  type GeometryProjection,
  type Polygon,
  type ProjectiveEdge,
  parseCdpQuad,
  type Quad,
  type Size,
} from "../geometry";
import { type CdpRunner, sendToCdpTarget } from "../shared";
import type { CoordinateOwner, CssViewport, SnapshotProjection } from "./coordinate-types";

export interface LayoutMetrics {
  cssVisualViewport?: { zoom?: number };
  visualViewport?: { zoom?: number };
  cssLayoutViewport?: {
    clientWidth?: number;
    clientHeight?: number;
    pageX?: number;
    pageY?: number;
  };
  layoutViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
}

/** The legacy field is a compatibility fallback, never a source of raster DPR. */
export function cssViewport(metrics: LayoutMetrics): CssViewport {
  const value = metrics.cssLayoutViewport ?? metrics.layoutViewport;
  return {
    width: value?.clientWidth ?? 0,
    height: value?.clientHeight ?? 0,
    scrollX: value?.pageX ?? 0,
    scrollY: value?.pageY ?? 0,
    cssToDip: metrics.cssVisualViewport?.zoom ?? metrics.visualViewport?.zoom ?? 1,
  };
}

/** One read-only measurement phase. Discard after scrolling or any later operation. */
export class GeometryContext {
  private readonly metrics = new Map<string, Promise<LayoutMetrics>>();
  private readonly owners = new Map<string, Promise<Quad | null>>();
  private readonly projections = new Map<string, Promise<GeometryProjection | null>>();
  private readonly snapshotOwners = new Map<string, Promise<{ quad: Quad; size: Size } | null>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private graphPromise?: Promise<CdpFrameGraph | null>;
  private framesPromise?: Promise<Map<string, CdpFrame>>;

  constructor(
    private readonly cdp: CdpRunner,
    private readonly tabId: number,
    graph?: CdpFrameGraph,
    private readonly signal?: AbortSignal,
  ) {
    if (graph) this.graphPromise = Promise.resolve(graph);
  }

  private async request<T>(
    target: CdpTarget,
    method: string,
    params: object,
    cleanup = false,
  ): Promise<T> {
    if (!cleanup && this.signal?.aborted) throw new DOMException("geometry aborted", "AbortError");
    if (this.active >= 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      if (!cleanup && this.signal?.aborted)
        throw new DOMException("geometry aborted", "AbortError");
      return await sendToCdpTarget<T>(this.cdp, target, method, params);
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  graph(): Promise<CdpFrameGraph | null> {
    this.graphPromise ??=
      this.cdp.getFrameGraph?.(this.tabId).catch(() => null) ?? Promise.resolve(null);
    return this.graphPromise;
  }

  private frames(): Promise<Map<string, CdpFrame>> {
    this.framesPromise ??= this.graph().then(
      (graph) => new Map(graph?.frames.map((frame) => [frame.frameId, frame]) ?? []),
    );
    return this.framesPromise;
  }

  async frame(frameId: string): Promise<CdpFrame | undefined> {
    return (await this.frames()).get(frameId);
  }

  /** Topology only: safe to resolve before the caller scrolls frame owners. */
  async ancestry(frameId: string): Promise<CdpFrame[] | null> {
    const frames = await this.frames();
    const path: CdpFrame[] = [];
    const seen = new Set<string>();
    let current = frames.get(frameId);
    if (!current) return null;
    while (current.parentFrameId) {
      if (seen.has(current.frameId)) return null;
      seen.add(current.frameId);
      path.push(current);
      const parent = frames.get(current.parentFrameId);
      if (!parent) return null;
      current = parent;
    }
    return path;
  }

  layoutMetrics(target: CdpTarget): Promise<LayoutMetrics> {
    const key = cdpTargetKey(target);
    let promise = this.metrics.get(key);
    if (!promise) {
      promise = this.request<LayoutMetrics>(target, "Page.getLayoutMetrics", {});
      this.metrics.set(key, promise);
    }
    return promise;
  }

  async viewport(target: CdpTarget): Promise<Size | null> {
    const { width, height } = cssViewport(await this.layoutMetrics(target));
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? { width, height }
      : null;
  }

  ownerContent(target: CdpTarget, backendNodeId: number): Promise<Quad | null> {
    const key = `${cdpTargetKey(target)}:${backendNodeId}`;
    let promise = this.owners.get(key);
    if (!promise) {
      promise = this.request<{ model?: { content?: number[] } }>(target, "DOM.getBoxModel", {
        backendNodeId,
      }).then((reply) => parseCdpQuad(reply.model?.content));
      this.owners.set(key, promise);
    }
    return promise;
  }

  /** Same-target owner quads are already target-relative, including nested owners. */
  async snapshotProjection(
    source: CoordinateOwner,
    ownerBackendNodeId: number,
    ancestorClips: Polygon[],
    viewport: Size,
  ): Promise<SnapshotProjection | null> {
    const key = `${cdpTargetKey(source.target)}:${ownerBackendNodeId}`;
    let promise = this.snapshotOwners.get(key);
    if (!promise) {
      promise = this.snapshotOwner(source.target, ownerBackendNodeId);
      this.snapshotOwners.set(key, promise);
    }
    const owner = await promise;
    return owner
      ? {
          source,
          geometry: {
            sourceClips: [],
            edges: [
              {
                sourceViewport: owner.size,
                destinationQuad: owner.quad,
                destinationClips: ancestorClips,
              },
            ],
            topViewport: viewport,
          },
        }
      : null;
  }

  private async snapshotOwner(
    target: CdpTarget,
    backendNodeId: number,
  ): Promise<{ quad: Quad; size: Size } | null> {
    const quad = await this.ownerContent(target, backendNodeId);
    if (!quad) return null;
    const resolved = await this.request<{ object?: { objectId?: string } }>(
      target,
      "DOM.resolveNode",
      { backendNodeId },
    );
    const objectId = resolved.object?.objectId;
    if (!objectId) return null;
    try {
      const reply = await this.request<{ result?: { value?: Size }; exceptionDetails?: unknown }>(
        target,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function() {
          if (!this.isConnected) return null;
          const style = getComputedStyle(this);
          return {
            width: this.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            height: this.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
          };
        }`,
          returnByValue: true,
        },
      );
      const size = reply.result?.value;
      return !reply.exceptionDetails &&
        size &&
        Number.isFinite(size.width) &&
        Number.isFinite(size.height) &&
        size.width > 0 &&
        size.height > 0
        ? { quad, size }
        : null;
    } finally {
      // Cleanup must still run if cancellation arrived after resolving the object.
      await this.request(target, "Runtime.releaseObject", { objectId }, true).catch(() => {});
    }
  }

  private targetRoot(frames: Map<string, CdpFrame>, frame: CdpFrame): CdpFrame | null {
    const seen = new Set<string>();
    let current = frame;
    while (current.parentFrameId) {
      if (seen.has(current.frameId)) return null;
      seen.add(current.frameId);
      const parent = frames.get(current.parentFrameId);
      if (!parent) return null;
      if (cdpTargetKey(parent.target) !== cdpTargetKey(current.target)) break;
      current = parent;
    }
    return current;
  }

  private async clips(
    frames: Map<string, CdpFrame>,
    frame: CdpFrame,
    root: CdpFrame,
  ): Promise<Polygon[] | null> {
    const clips: Polygon[] = [];
    let current = frame;
    const seen = new Set<string>();
    while (current.frameId !== root.frameId) {
      if (seen.has(current.frameId) || !current.parentFrameId) return null;
      seen.add(current.frameId);
      const parent = frames.get(current.parentFrameId);
      if (!parent || current.ownerBackendNodeId === undefined) return null;
      const quad = await this.ownerContent(parent.target, current.ownerBackendNodeId);
      if (!quad) return null;
      clips.push(quad);
      current = parent;
    }
    return clips;
  }

  /** Input is already in the frame's CDP target viewport, not its local viewport. */
  targetProjection(frameId: string): Promise<GeometryProjection | null> {
    let promise = this.projections.get(frameId);
    if (!promise) {
      promise = this.buildTargetProjection(frameId);
      this.projections.set(frameId, promise);
    }
    return promise;
  }

  private async buildTargetProjection(frameId: string): Promise<GeometryProjection | null> {
    const frames = await this.frames();
    const frame = frames.get(frameId);
    if (!frame) return null;
    let root = this.targetRoot(frames, frame);
    if (!root) return null;
    const sourceViewport = await this.viewport(root.target);
    if (!sourceViewport) return null;
    const sourceClips = await this.clips(frames, frame, root);
    if (!sourceClips) return null;
    const edges: ProjectiveEdge[] = [];
    const seen = new Set<string>();
    while (root.parentFrameId) {
      if (seen.has(root.frameId)) return null;
      seen.add(root.frameId);
      const parent = frames.get(root.parentFrameId);
      if (!parent || root.ownerBackendNodeId === undefined) return null;
      const destinationQuad = await this.ownerContent(parent.target, root.ownerBackendNodeId);
      const source = await this.viewport(root.target);
      const parentRoot = this.targetRoot(frames, parent);
      if (!destinationQuad || !source || !parentRoot) return null;
      const destinationClips = await this.clips(frames, parent, parentRoot);
      if (!destinationClips) return null;
      edges.push({ sourceViewport: source, destinationQuad, destinationClips });
      root = parentRoot;
    }
    const topViewport = await this.viewport(root.target);
    return topViewport ? { sourceClips, edges, topViewport } : null;
  }
}
