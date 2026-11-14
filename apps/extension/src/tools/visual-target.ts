import {
  type CdpFrame,
  type FrameDocumentHandle,
  isStaleFrameHandleError,
} from "@/browser-driver/frame-graph";
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
import { type CdpRunner, sendToFrameHandle } from "./shared";
import { isCaptureTerminalError, throwIfAborted } from "./vom/capture-abort";
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
  viewportOverflowSource,
  visualProjectionIssue,
} from "./vom/visual-region";

interface LiveRow {
  node: number;
  isBody?: boolean;
  parentIsElement?: boolean;
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

// Follow the rendered ancestry, including slot distribution, in the verified world.
// Closed slots supplied by CDP are rechecked here against the current assignment.
const READ_ANCESTRY = `function(styleNames, ...closedSlots) {
  if (!this.isConnected || this.ownerDocument !== document) return null;
  const rows = [];
  const parent = node => node.assignedSlot ||
    closedSlots.find(slot => slot.isConnected && slot.ownerDocument === document &&
      slot.getRootNode().host === node.parentElement && slot.assignedElements().includes(node)) ||
    node.parentElement || node.getRootNode().host;
  for (let node = this; node; node = parent(node)) {
    if (!(node instanceof Element)) return null;
    const s = getComputedStyle(node), r = node.getBoundingClientRect();
    rows.push({ node, tag: node.localName, isBody: node === document.body, parentIsElement: !!node.parentElement,
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
function decode(value: DeepValue, closedHosts: Set<number>): unknown {
  if (value.type === "node") {
    const node = value.value as {
      backendNodeId?: number;
      shadowRoot?: { value?: { mode?: string } };
    };
    if (node?.backendNodeId && node.shadowRoot?.value?.mode === "closed")
      closedHosts.add(node.backendNodeId);
    return node?.backendNodeId;
  }
  if (value.type === "array")
    return (value.value as DeepValue[]).map((item) => decode(item, closedHosts));
  if (value.type === "object")
    return Object.fromEntries(
      (value.value as [string, DeepValue][]).map(([key, item]) => [key, decode(item, closedHosts)]),
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
    a.tabId === b.tabId &&
    a.frameId === b.frameId &&
    a.loaderId === b.loaderId &&
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
  const guard = { attachmentId: document.attachmentId, signal };
  try {
    const slots = new Map<number, string>();
    while (true) {
      throwIfAborted(signal);
      const reply = await sendToFrameHandle<{
        result?: { deepSerializedValue?: DeepValue };
        exceptionDetails?: unknown;
      }>(
        cdp,
        document,
        "Runtime.callFunctionOn",
        {
          objectId: verified.objectId,
          objectGroup: verified.objectGroup,
          functionDeclaration: READ_ANCESTRY,
          arguments: [
            { value: VISUAL_STYLES },
            ...Array.from(slots.values(), (objectId) => ({ objectId })),
          ],
          serializationOptions: {
            serialization: "deep",
            // At depth zero only shadow-root metadata is included, never its descendants.
            additionalParameters: { maxNodeDepth: 0, includeShadowTree: "all" },
          },
        },
        guard,
      );
      throwIfAborted(signal);
      if (reply.exceptionDetails || !reply.result?.deepSerializedValue)
        return stale("visual ancestry unavailable");
      const closedHosts = new Set<number>();
      const result = decode(reply.result.deepSerializedValue, closedHosts) as LiveFrame | null;
      if (
        !result?.rows?.length ||
        result.rows[0].node !== anchor ||
        result.rows.at(-1)?.node !== document.documentElementBackendNodeId ||
        !result.rows.every((row) => Number.isSafeInteger(row.node) && row.node > 0)
      )
        return stale("visual ancestry incomplete");
      if (cdp.getAttachmentId?.(document.tabId) !== document.attachmentId)
        return stale("visual attachment changed");
      // assignedSlot is null for light children of a closed shadow host. Query only
      // these missing edges, then reread geometry and validate the assignment together.
      const missing = result.rows.filter(
        (row, i) => row.parentIsElement && closedHosts.has(result.rows[i + 1]?.node),
      );
      if (!missing.length) return result;
      for (const row of missing) {
        if (slots.has(row.node)) return stale("visual slot assignment changed");
        throwIfAborted(signal);
        const described = await sendToFrameHandle<{
          node?: { assignedSlot?: { backendNodeId?: number } };
        }>(cdp, document, "DOM.describeNode", { backendNodeId: row.node, depth: 0 }, guard);
        const backendNodeId = described.node?.assignedSlot?.backendNodeId;
        if (!backendNodeId) return stale("visual slot assignment unavailable");
        throwIfAborted(signal);
        const resolved = await sendToFrameHandle<{ object?: { objectId?: string } }>(
          cdp,
          document,
          "DOM.resolveNode",
          {
            backendNodeId,
            executionContextId: verified.executionContextId,
            objectGroup: verified.objectGroup,
          },
          guard,
        );
        if (!resolved.object?.objectId) return stale("visual slot unavailable");
        slots.set(row.node, resolved.object.objectId);
      }
    }
  } catch (error) {
    throwIfAborted(signal);
    if (isStaleFrameHandleError(error)) return stale("visual frame changed");
    throw error;
  } finally {
    if (cdp.getAttachmentId?.(document.tabId) === document.attachmentId) {
      await sendToFrameHandle(
        cdp,
        document,
        "Runtime.releaseObjectGroup",
        { objectGroup: verified.objectGroup },
        { attachmentId: document.attachmentId },
      ).catch(() => {});
    }
    throwIfAborted(signal);
  }
}

/** All live reads for one screenshot use this one measurement context. */
export async function resolveVisualRegionNow(
  cdp: CdpRunner,
  candidate: VisualCandidate,
  signal?: AbortSignal,
  allowGeometryChange = false,
  onIdentityVerified?: () => void,
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
      frame.document.tabId !== candidate.document.tabId ||
      frame.document.attachmentId !== candidate.document.attachmentId
    )
      return stale("invalid visual frame path");
    seen.add(frame.document.frameId);
    path.push({ frame, anchor });
    anchor = frame.parent?.ownerBackendNodeId ?? 0;
    frame = frame.parent?.frame;
  }
  path.reverse();
  const tabId = candidate.document.tabId;
  const frameHandles = new Map<string, FrameDocumentHandle>(
    path.map(({ frame: item }) => [item.document.frameId, item.document]),
  );
  const frames: CdpFrame[] = path.map(({ frame: item }) => ({
    frameId: item.document.frameId,
    loaderId: item.document.loaderId,
    target: { tabId },
    ...(item.parent
      ? {
          parentFrameId: item.parent.frame.document.frameId,
          ownerBackendNodeId: item.parent.ownerBackendNodeId,
        }
      : {}),
  }));
  // Validate each recorded edge instead of asking the driver to fill all page owners.
  for (const { frame: item } of path) {
    if (!item.parent) continue;
    throwIfAborted(signal);
    const parentDoc = item.parent.frame.document;
    let owner: { backendNodeId?: number };
    try {
      owner = await sendToFrameHandle<{ backendNodeId?: number }>(
        cdp,
        parentDoc,
        "DOM.getFrameOwner",
        { frameId: item.document.frameId },
        { attachmentId: parentDoc.attachmentId, signal },
      );
    } catch (error) {
      throwIfAborted(signal);
      if (isCaptureTerminalError(error)) throw error;
      return stale("visual frame owner unavailable");
    }
    if (owner.backendNodeId !== item.parent.ownerBackendNodeId)
      return stale("visual frame owner changed");
  }
  const geometry = new GeometryContext(
    cdp,
    tabId,
    { rootFrameId: frames[0].frameId, frames },
    signal,
    frameHandles,
  );
  let context: VisualContext = EMPTY_VISUAL_CONTEXT;
  let parentRead: LiveFrame | undefined;
  let finalRegion: VisualCandidate["region"] | undefined;
  let topDpr = 0;
  const mappings: VisualTargetState["mappings"] = [];
  // Finish validating the recorded path before optional geometry reads. The
  // screenshot caller can then retain viewing-only pixels if geometry times
  // out, without issuing another identity read behind the stuck command.
  const liveFrames: LiveFrame[] = [];
  for (let i = 0; i < path.length; i++) {
    const { frame: item, anchor: itemAnchor } = path[i];
    const live = await readFrame(cdp, item.document, itemAnchor, signal);
    if ("code" in live) return live;
    if (live.top !== (i === 0)) return stale("visual root frame changed");
    liveFrames.push(live);
  }
  if (cdp.getAttachmentId?.(tabId) !== candidate.document.attachmentId)
    return stale("visual attachment changed");
  throwIfAborted(signal);
  onIdentityVerified?.();
  for (let i = 0; i < path.length; i++) {
    const { frame: item, anchor: itemAnchor } = path[i];
    const live = liveFrames[i];
    if (i === 0) topDpr = live.dpr;
    const metrics = await geometry.layoutMetrics(item.document);
    const viewport = cssViewport(metrics);
    const projections: GeometryProjection[] = [];
    if (item.parent) {
      const parent = item.parent.frame.document;
      const size = parentRead!.rows[0].contentSize;
      if (![size.width, size.height].every((n) => Number.isFinite(n) && n > 0))
        return stale("iframe content size unavailable");
      const parentViewport = await geometry.viewport(parent);
      if (!parentViewport) return stale("parent viewport unavailable");
      const local = await geometry.snapshotProjection(
        { target: { tabId }, frameId: item.document.frameId },
        item.parent.ownerBackendNodeId,
        [],
        parentViewport,
        size,
        parent,
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
      document: item.document,
      anchor: itemAnchor,
      unit,
      viewport: {
        ...viewport,
        scrollX: live.scrollX ?? viewport.scrollX,
        scrollY: live.scrollY ?? viewport.scrollY,
        width: live.width ?? viewport.width,
        height: live.height ?? viewport.height,
      },
    });
    const overflowElement = (row: LiveRow | undefined) =>
      row && {
        backendNodeId: row.node,
        tag: row.tag,
        styles: row.styles,
      };
    const overflowSource = viewportOverflowSource(
      overflowElement(live.rows.at(-1)),
      overflowElement(live.rows.find((row) => row.isBody)),
    );
    for (let j = live.rows.length - 1; j >= 0; j--) {
      const row = live.rows[j];
      const isAnchor = j === 0;
      const node = {
        document: item.document,
        backendNodeId: row.node,
        styles: row.styles,
        clientBox: projectVisualBox(row.client, projections),
      };
      context = extendVisualContext(
        context,
        node,
        !isAnchor && row.tag !== "iframe" && row.tag !== "frame" && row.node !== overflowSource,
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
  const viewport = cssViewport(await geometry.layoutMetrics(path[0].frame.document));
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
      await sendToFrameHandle(
        cdp,
        frame.document,
        "Runtime.releaseObjectGroup",
        { objectGroup: verified.objectGroup },
        { attachmentId: frame.document.attachmentId },
      ).catch(() => {});
      throwIfAborted(signal);
      if (frame.parent) {
        const parentDoc = frame.parent.frame.document;
        const owner = await sendToFrameHandle<{ backendNodeId?: number }>(
          cdp,
          parentDoc,
          "DOM.getFrameOwner",
          { frameId: frame.document.frameId },
          { attachmentId: parentDoc.attachmentId, signal },
        );
        throwIfAborted(signal);
        if (owner.backendNodeId !== frame.parent.ownerBackendNodeId)
          return stale("visual frame owner changed");
        anchor = frame.parent.ownerBackendNodeId;
      }
      frame = frame.parent?.frame;
    }
    throwIfAborted(signal);
    return cdp.getAttachmentId?.(candidate.document.tabId) === candidate.document.attachmentId
      ? null
      : stale("visual attachment changed");
  } catch (error) {
    throwIfAborted(signal);
    if (isCaptureTerminalError(error)) throw error;
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
/** Browser hit testing follows each verified frame, including open and closed shadow roots. */
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
      const result = await sendToFrameHandle<{
        result?: { value?: boolean };
        exceptionDetails?: unknown;
      }>(
        cdp,
        document,
        "Runtime.callFunctionOn",
        {
          objectId: verified.objectId,
          objectGroup: verified.objectGroup,
          functionDeclaration: `function(x,y) {
          if (!this.isConnected || this.ownerDocument !== document) return false;
          for(let n=this;n;n=n.parentElement || n.getRootNode().host) if(n.inert) return false;
          // Resolve roots from the verified target; closed hosts expose no shadowRoot.
          const path=[];
          for(let node=this;node;) {
            const root=node.getRootNode();
            path.push({root,node});
            if(root===document) break;
            if(!root.host) return false;
            node=root.host;
          }
          // Check every outer scope as well, so internal hits cannot bypass an overlay.
          return path.reverse().every(({root,node}) => root.elementFromPoint(x,y)===node);
        }`,
          arguments: [
            { value: (point.x - unit.x) / unit.width },
            { value: (point.y - unit.y) / unit.height },
          ],
          returnByValue: true,
        },
        { attachmentId: document.attachmentId, signal },
      );
      if (result.exceptionDetails || result.result?.value !== true) return false;
    } catch {
      return false;
    } finally {
      if (cdp.getAttachmentId?.(document.tabId) === document.attachmentId) {
        await sendToFrameHandle(
          cdp,
          document,
          "Runtime.releaseObjectGroup",
          { objectGroup: verified.objectGroup },
          { attachmentId: document.attachmentId },
        ).catch(() => {});
      }
      throwIfAborted(signal);
    }
  }
  return true;
}
