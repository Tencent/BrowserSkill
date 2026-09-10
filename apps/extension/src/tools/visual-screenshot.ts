import type { CdpFrame } from "@/browser-driver/frame-graph";
import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import {
  type GeometryProjection,
  projectRectToViewport,
  type Size,
  type ViewportRect,
} from "./geometry";
import { type CssViewport, screenshotPageRect } from "./geometry/coordinate-types";
import { cssViewport, GeometryContext } from "./geometry/frame-context";
import { parsePngDimensions } from "./png";
import { type CdpRunner, sendToCdpTarget } from "./shared";
import { isAbortError, throwIfAborted } from "./vom/capture-abort";
import { resolveVerifiedNode } from "./vom/document-identity";
import type { DocumentIdentity } from "./vom/facts";
import { VISUAL_STYLES } from "./vom/snapshot";
import type { VisualCandidate, VisualFramePath } from "./vom/visual-discovery";
import {
  EMPTY_VISUAL_CONTEXT,
  extendVisualContext,
  projectVisualBox,
  resolveVisualRegion,
  type VisualClipSource,
  type VisualContext,
  visualProjectionIssue,
} from "./vom/visual-region";

interface LiveRow {
  node: number;
  tag: string;
  box: ViewportRect;
  client: ViewportRect;
  contentSize: Size;
  styles: Record<string, string>;
}
interface LiveFrame {
  top: boolean;
  dpr: number;
  rows: LiveRow[]; // Anchor first, root last.
}

// Read only one current ancestry, including shadow hosts, in the verified isolated world.
const READ_ANCESTRY = `function(styleNames) {
  if (!this.isConnected || this.ownerDocument !== document) return null;
  const rows = [];
  for (let node = this; node; node = node.parentElement || node.getRootNode().host) {
    if (!(node instanceof Element)) return null;
    const s = getComputedStyle(node), r = node.getBoundingClientRect();
    rows.push({ node, tag: node.localName,
      box: { x:r.x, y:r.y, width:r.width, height:r.height },
      client: { x:r.x+node.clientLeft, y:r.y+node.clientTop, width:node.clientWidth, height:node.clientHeight },
      contentSize: { width:node.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight), height:node.clientHeight-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom) },
      styles: Object.fromEntries(styleNames.map(key => [key,s.getPropertyValue(key)])) });
  }
  return { top: window === window.top, dpr: devicePixelRatio, rows };
}`;

interface DeepValue {
  type: string;
  value?: unknown;
}
/** This read returns JSON primitives plus DOM nodes (backend IDs), never remote object handles. */
function decode(value: DeepValue): unknown {
  if (value.type === "node") return (value.value as { backendNodeId?: number })?.backendNodeId;
  if (value.type === "array") return (value.value as DeepValue[]).map(decode);
  if (value.type === "object")
    return Object.fromEntries(
      (value.value as [string, DeepValue][]).map(([key, item]) => [key, decode(item)]),
    );
  if (value.type === "null") return null;
  if (["string", "number", "boolean"].includes(value.type)) return value.value;
  throw new Error("unexpected live ancestry serialization");
}

function stale(message: string): RpcError {
  return rpcError(
    "not_found",
    "visual_target_changed",
    `${message}; observe again before requesting a screenshot`,
  );
}

function sameIdentity(a: DocumentIdentity, b: DocumentIdentity): boolean {
  return (
    a.attachmentId === b.attachmentId &&
    a.frameId === b.frameId &&
    a.target.tabId === b.target.tabId &&
    a.target.sessionId === b.target.sessionId &&
    a.documentElementBackendNodeId === b.documentElementBackendNodeId
  );
}

function closeRect(a: ViewportRect, b: ViewportRect): boolean {
  return [
    a.x - b.x,
    a.y - b.y,
    a.x + a.width - b.x - b.width,
    a.y + a.height - b.y - b.height,
  ].every((delta) => Number.isFinite(delta) && Math.abs(delta) <= 0.25);
}

function sameClips(a?: VisualClipSource, b?: VisualClipSource): boolean {
  while (a && b) {
    if (
      !sameIdentity(a.document, b.document) ||
      a.backendNodeId !== b.backendNodeId ||
      a.x !== b.x ||
      a.y !== b.y ||
      a.overflowX !== b.overflowX ||
      a.overflowY !== b.overflowY ||
      !closeRect(a.box, b.box)
    )
      return false;
    a = a.parent;
    b = b.parent;
  }
  return !a && !b;
}

/** Scale affects raster size only, never the selected CSS region. */
export function visualScreenshotScale(width: number, height: number, pixelsPerCss: number): number {
  if (![width, height, pixelsPerCss].every((n) => Number.isFinite(n) && n > 0))
    throw new Error("invalid screenshot pixel dimensions");
  return Math.min(
    1,
    2048 / (Math.max(width, height) * pixelsPerCss),
    Math.sqrt(4_000_000 / (width * height * pixelsPerCss * pixelsPerCss)),
  );
}

async function readFrame(
  cdp: CdpRunner,
  document: DocumentIdentity,
  anchor: number,
  signal?: AbortSignal,
): Promise<LiveFrame | RpcError> {
  const verified = await resolveVerifiedNode(cdp, document, anchor, signal);
  if (verified.status !== "current") return stale(`visual DOM identity ${verified.status}`);
  try {
    throwIfAborted(signal);
    const reply = await sendToCdpTarget<{
      result?: { deepSerializedValue?: DeepValue };
      exceptionDetails?: unknown;
    }>(cdp, document.target, "Runtime.callFunctionOn", {
      objectId: verified.objectId,
      objectGroup: verified.objectGroup,
      functionDeclaration: READ_ANCESTRY,
      arguments: [{ value: VISUAL_STYLES }],
      serializationOptions: {
        serialization: "deep",
        additionalParameters: { maxNodeDepth: 0, includeShadowTree: "none" },
      },
    });
    throwIfAborted(signal);
    if (reply.exceptionDetails || !reply.result?.deepSerializedValue)
      return stale("visual ancestry unavailable");
    const result = decode(reply.result.deepSerializedValue) as LiveFrame | null;
    if (
      !result?.rows?.length ||
      result.rows[0].node !== anchor ||
      result.rows.at(-1)?.node !== document.documentElementBackendNodeId ||
      !result.rows.every((row) => Number.isSafeInteger(row.node) && row.node > 0)
    )
      return stale("visual ancestry incomplete");
    if (cdp.getAttachmentId?.(document.target.tabId) !== document.attachmentId)
      return stale("visual attachment changed");
    return result;
  } finally {
    await sendToCdpTarget(cdp, document.target, "Runtime.releaseObjectGroup", {
      objectGroup: verified.objectGroup,
    }).catch(() => {});
    throwIfAborted(signal);
  }
}

/** All live reads for one screenshot use this one measurement context. */
async function resolveVisualRegionNow(
  cdp: CdpRunner,
  candidate: VisualCandidate,
  signal?: AbortSignal,
): Promise<{ crop: ViewportRect; viewport: CssViewport; dpr: number } | RpcError> {
  throwIfAborted(signal);
  if (!candidate.framePath || !sameIdentity(candidate.document, candidate.framePath.document))
    return stale("visual frame path unavailable");
  const path: { frame: VisualFramePath; anchor: number }[] = [];
  const seen = new Set<string>();
  let frame: VisualFramePath | undefined = candidate.framePath;
  let anchor = candidate.backendNodeId;
  while (frame) {
    if (
      seen.has(frame.document.frameId) ||
      frame.document.target.tabId !== candidate.document.target.tabId ||
      cdp.getAttachmentId?.(frame.document.target.tabId) !== frame.document.attachmentId
    )
      return stale("invalid visual frame path");
    seen.add(frame.document.frameId);
    path.push({ frame, anchor });
    anchor = frame.parent?.ownerBackendNodeId ?? 0;
    frame = frame.parent?.frame;
  }
  path.reverse();
  const frames: CdpFrame[] = path.map(({ frame }) => ({
    frameId: frame.document.frameId,
    target: frame.document.target,
    ...(frame.parent
      ? {
          parentFrameId: frame.parent.frame.document.frameId,
          ownerBackendNodeId: frame.parent.ownerBackendNodeId,
        }
      : {}),
  }));
  // Validate each recorded edge instead of asking the driver to fill all page owners.
  for (const { frame } of path) {
    if (!frame.parent) continue;
    throwIfAborted(signal);
    const owner = await sendToCdpTarget<{ backendNodeId?: number }>(
      cdp,
      frame.parent.frame.document.target,
      "DOM.getFrameOwner",
      { frameId: frame.document.frameId },
    );
    if (owner.backendNodeId !== frame.parent.ownerBackendNodeId)
      return stale("visual frame owner changed");
  }
  const geometry = new GeometryContext(
    cdp,
    candidate.document.target.tabId,
    { rootFrameId: frames[0].frameId, frames },
    signal,
  );
  let context: VisualContext = EMPTY_VISUAL_CONTEXT;
  let parentRead: LiveFrame | undefined;
  let finalRegion: VisualCandidate["region"] | undefined;
  let topDpr = 0;
  for (let i = 0; i < path.length; i++) {
    const { frame, anchor } = path[i];
    const live = await readFrame(cdp, frame.document, anchor, signal);
    if ("code" in live) return live;
    if (live.top !== (i === 0)) return stale("visual root frame changed");
    if (i === 0) topDpr = live.dpr;
    const metrics = await geometry.layoutMetrics(frame.document.target);
    const viewport = cssViewport(metrics);
    const projections: GeometryProjection[] = [];
    if (frame.parent) {
      const parent = frame.parent.frame.document;
      const size = parentRead!.rows[0].contentSize;
      if (![size.width, size.height].every((n) => Number.isFinite(n) && n > 0))
        return stale("iframe content size unavailable");
      const parentViewport = await geometry.viewport(parent.target);
      if (!parentViewport) return stale("parent viewport unavailable");
      const local = await geometry.snapshotProjection(
        { target: parent.target, frameId: frame.document.frameId },
        frame.parent.ownerBackendNodeId,
        [],
        parentViewport,
        size,
      );
      const outer = await geometry.targetProjection(parent.frameId);
      if (local.status !== "available" || !outer)
        return stale("visual frame projection unavailable");
      projections.push(local.projection.geometry, outer);
    } else projections.push({ sourceClips: [], edges: [], topViewport: viewport });
    const issue = visualProjectionIssue({
      projections,
      coordinates: { layoutUnitsPerCssPixel: 1, scrollCss: { x: 0, y: 0 } },
      pageScale: metrics.cssVisualViewport?.scale ?? metrics.visualViewport?.scale,
    });
    if (issue) return stale(issue);
    for (let j = live.rows.length - 1; j >= 0; j--) {
      const row = live.rows[j];
      const isAnchor = j === 0;
      const node = {
        document: frame.document,
        backendNodeId: row.node,
        styles: row.styles,
        clientBox: projectVisualBox(row.client, projections),
      };
      context = extendVisualContext(
        context,
        node,
        !isAnchor && row.tag !== "iframe" && row.tag !== "frame",
      );
    }
    if (i < path.length - 1) {
      const owner = live.rows[0];
      context = {
        ...context,
        hidden:
          context.hidden ||
          owner.styles.visibility === "hidden" ||
          owner.styles.visibility === "collapse",
        transformed: false,
        localClip: false,
        unpositionedClip: false,
      };
    } else {
      const row = live.rows[0];
      if (row.tag !== "canvas") return stale("visual anchor is no longer Canvas");
      let visible: ViewportRect | null = row.box;
      for (const projection of projections)
        visible = visible
          ? projectRectToViewport(
              { x: visible.x, y: visible.y, w: visible.width, h: visible.height },
              projection,
            )
          : null;
      const region = resolveVisualRegion({
        borderBox: projectVisualBox(row.box, projections),
        frameVisibleBox: visible,
        context,
        visibility: row.styles.visibility,
      });
      if (region.status !== "available")
        return stale(
          `visual region ${region.status}${region.status === "unavailable" ? `: ${region.reason}` : ""}`,
        );
      finalRegion = region;
    }
    parentRead = live;
  }
  if (
    !finalRegion ||
    !closeRect(candidate.region.borderBox, finalRegion.borderBox) ||
    !closeRect(candidate.region.crop, finalRegion.crop) ||
    !sameClips(candidate.region.clips, finalRegion.clips)
  )
    return stale("visual region changed");
  const viewport = cssViewport(await geometry.layoutMetrics(frames[0].target));
  return { crop: finalRegion.crop, viewport, dpr: topDpr };
}

/** Check identity only: repainting and post-capture layout changes are allowed. */
async function verifyCapturedTarget(
  cdp: CdpRunner,
  candidate: VisualCandidate,
  signal?: AbortSignal,
): Promise<RpcError | null> {
  try {
    let frame = candidate.framePath;
    let anchor = candidate.backendNodeId;
    // The path was validated before capture; never rebuild it from the current page.
    while (frame) {
      const verified = await resolveVerifiedNode(cdp, frame.document, anchor, signal);
      if (verified.status !== "current") return stale(`visual DOM identity ${verified.status}`);
      await sendToCdpTarget(cdp, frame.document.target, "Runtime.releaseObjectGroup", {
        objectGroup: verified.objectGroup,
      }).catch(() => {});
      throwIfAborted(signal);
      if (frame.parent) {
        const owner = await sendToCdpTarget<{ backendNodeId?: number }>(
          cdp,
          frame.parent.frame.document.target,
          "DOM.getFrameOwner",
          { frameId: frame.document.frameId },
        );
        throwIfAborted(signal);
        if (owner.backendNodeId !== frame.parent.ownerBackendNodeId)
          return stale("visual frame owner changed");
        anchor = frame.parent.ownerBackendNodeId;
      }
      frame = frame.parent?.frame;
    }
    throwIfAborted(signal);
    return cdp.getAttachmentId?.(candidate.document.target.tabId) ===
      candidate.document.attachmentId
      ? null
      : stale("visual attachment changed");
  } catch (error) {
    throwIfAborted(signal);
    if (isAbortError(error)) throw error;
    return stale("visual identity unavailable after capture");
  }
}

/** One target only. No frame discovery, scrolling, AX, or snapshot recapture. */
export async function captureVisualScreenshot(
  cdp: CdpRunner,
  candidate: VisualCandidate,
  signal?: AbortSignal,
): Promise<{ image_base64: string; width: number; height: number } | RpcError> {
  try {
    let region = await resolveVisualRegionNow(cdp, candidate, signal);
    if ("code" in region) return region;
    let scale = visualScreenshotScale(region.crop.width, region.crop.height, region.dpr);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        // A new raster attempt needs fresh geometry, not the previous crop/cache.
        region = await resolveVisualRegionNow(cdp, candidate, signal);
        if ("code" in region) return region;
        scale = Math.min(
          scale,
          visualScreenshotScale(region.crop.width, region.crop.height, region.dpr),
        );
      }
      const clip = screenshotPageRect(region.crop, region.viewport);
      if (!clip) return stale("invalid screenshot coordinates");
      throwIfAborted(signal);
      if (
        cdp.getAttachmentId?.(candidate.document.target.tabId) !== candidate.document.attachmentId
      )
        return stale("visual attachment changed");
      const shot = await cdp.send<{ data?: string }>(
        candidate.document.target.tabId,
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false, clip: { ...clip.rect, scale } },
      );
      throwIfAborted(signal);
      if (
        cdp.getAttachmentId?.(candidate.document.target.tabId) !== candidate.document.attachmentId
      )
        return stale("visual attachment changed");
      const identityError = await verifyCapturedTarget(cdp, candidate, signal);
      if (identityError) return identityError;
      const dims = shot.data ? parsePngDimensions(shot.data) : null;
      if (!dims)
        return rpcError(
          "cdp_failed",
          "screenshot_capture_failed",
          "visual screenshot returned invalid PNG dimensions",
        );
      const correction = visualScreenshotScale(dims.width, dims.height, 1);
      if (correction === 1) return { image_base64: shot.data!, ...dims };
      scale *= correction * 0.99;
    }
    return rpcError(
      "cdp_failed",
      "visual_pixel_budget_exceeded",
      "visual screenshot exceeds the pixel budget",
    );
  } catch (error) {
    if (isAbortError(error) || signal?.aborted)
      return { code: "cancelled", message: "visual screenshot aborted" };
    return rpcError(
      "cdp_failed",
      "screenshot_capture_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
