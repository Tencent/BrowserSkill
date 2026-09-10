import type { CdpFrame } from "@/browser-driver/frame-graph";
import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import {
  type GeometryProjection,
  projectRectToViewport,
  type Size,
  type ViewportRect,
} from "./geometry";
import { type CssViewport } from "./geometry/coordinate-types";
import { cssViewport, GeometryContext } from "./geometry/frame-context";
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
  scrollX?: number;
  scrollY?: number;
  width?: number;
  height?: number;
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
  return { top: window === window.top, dpr: devicePixelRatio, scrollX, scrollY, width: innerWidth, height: innerHeight, rows };
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

export function sameIdentity(a: DocumentIdentity, b: DocumentIdentity): boolean {
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
export async function resolveVisualRegionNow(
  cdp: CdpRunner,
  candidate: VisualCandidate,
  signal?: AbortSignal,
  allowGeometryChange = false,
): Promise<VisualTargetState | RpcError> {
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
  const mappings: VisualTargetState["mappings"] = [];
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
    const unit = projectVisualBox({ x: 0, y: 0, width: 1, height: 1 }, projections);
    if (!unit || !(unit.width > 0 && unit.height > 0)) return stale("visual mapping unavailable");
    mappings.push({
      document: frame.document,
      anchor,
      unit,
      viewport: {
        ...viewport,
        scrollX: live.scrollX ?? viewport.scrollX,
        scrollY: live.scrollY ?? viewport.scrollY,
        width: live.width ?? viewport.width,
        height: live.height ?? viewport.height,
      },
    });
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
    (!allowGeometryChange &&
      (!closeRect(candidate.region.borderBox, finalRegion.borderBox) ||
        !closeRect(candidate.region.crop, finalRegion.crop) ||
        !sameClips(candidate.region.clips, finalRegion.clips)))
  )
    return stale("visual region changed");
  const viewport = cssViewport(await geometry.layoutMetrics(frames[0].target));
  return { crop: finalRegion.crop, region: finalRegion, viewport, dpr: topDpr, mappings };
}

/** Check identity only: repainting and post-capture layout changes are allowed. */
export async function verifyCapturedTarget(
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

export interface VisualTargetState {
  crop: ViewportRect;
  region: VisualCandidate["region"];
  viewport: CssViewport;
  dpr: number;
  mappings: {
    document: DocumentIdentity;
    anchor: number;
    unit: ViewportRect;
    viewport: CssViewport;
  }[];
}
function sameViewport(a: CssViewport, b: CssViewport): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.scrollX === b.scrollX &&
    a.scrollY === b.scrollY &&
    a.cssToDip === b.cssToDip
  );
}
export function sameVisualMapping(a: VisualTargetState, b: VisualTargetState): boolean {
  return (
    a.dpr === b.dpr &&
    sameViewport(a.viewport, b.viewport) &&
    closeRect(a.crop, b.crop) &&
    closeRect(a.region.borderBox, b.region.borderBox) &&
    sameClips(a.region.clips, b.region.clips) &&
    a.mappings.length === b.mappings.length &&
    a.mappings.every((m, i) => {
      const n = b.mappings[i];
      return (
        m.anchor === n.anchor &&
        sameIdentity(m.document, n.document) &&
        closeRect(m.unit, n.unit) &&
        Math.abs(m.unit.width - n.unit.width) < 1e-6 &&
        Math.abs(m.unit.height - n.unit.height) < 1e-6 &&
        sameViewport(m.viewport, n.viewport)
      );
    })
  );
}
/** Browser hit testing follows each verified frame, including open shadow roots. */
export async function verifyVisualHit(
  cdp: CdpRunner,
  state: VisualTargetState,
  point: { x: number; y: number },
  signal?: AbortSignal,
): Promise<boolean> {
  for (const mapping of state.mappings) {
    throwIfAborted(signal);
    const { unit, document, anchor } = mapping;
    if (!(unit.width > 0 && unit.height > 0)) return false;
    const verified = await resolveVerifiedNode(cdp, document, anchor, signal);
    if (verified.status !== "current") return false;
    try {
      const result = await sendToCdpTarget<{
        result?: { value?: boolean };
        exceptionDetails?: unknown;
      }>(cdp, document.target, "Runtime.callFunctionOn", {
        objectId: verified.objectId,
        objectGroup: verified.objectGroup,
        functionDeclaration: `function(x,y) {
          if (!this.isConnected || this.ownerDocument !== document) return false;
          for(let n=this;n;n=n.parentElement || n.getRootNode().host) if(n.inert) return false;
          let hit=document.elementFromPoint(x,y);
          while(hit && hit.shadowRoot) {
            const inner=hit.shadowRoot.elementFromPoint(x,y);
            if(!inner || inner===hit) break;
            hit=inner;
          }
          return hit===this;
        }`,
        arguments: [
          { value: (point.x - unit.x) / unit.width },
          { value: (point.y - unit.y) / unit.height },
        ],
        returnByValue: true,
      });
      if (result.exceptionDetails || result.result?.value !== true) return false;
    } finally {
      await sendToCdpTarget(cdp, document.target, "Runtime.releaseObjectGroup", {
        objectGroup: verified.objectGroup,
      }).catch(() => {});
      throwIfAborted(signal);
    }
  }
  return true;
}
