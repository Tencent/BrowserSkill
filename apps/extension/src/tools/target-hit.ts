import {
  type CdpFrameTreeNode,
  cdpTargetKey,
  type FrameDocumentHandle,
  type FrameNodeHandle,
} from "@/browser-driver/frame-graph";
import { type Point, unprojectPoint } from "./geometry";
import { cssViewport, GeometryContext, type LayoutMetrics } from "./geometry/frame-context";
import { type CdpRunner, sendToFrameHandle } from "./shared";

interface RuntimeReply {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

/** Input uses viewport CSS pixels; DOM hit testing uses document CSS pixels. */
async function nodeAtViewportPoint(
  cdp: CdpRunner,
  handle: FrameDocumentHandle,
  x: number,
  y: number,
  includeUserAgentShadowDOM = true,
): Promise<{ backendNodeId?: number; frameId?: string }> {
  const metrics = await sendToFrameHandle<LayoutMetrics>(cdp, handle, "Page.getLayoutMetrics", {});
  const viewport = cssViewport(metrics);
  if (
    ![x, y, viewport.scrollX, viewport.scrollY].every(Number.isFinite) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    throw new Error("The hit-test viewport is unavailable");
  return sendToFrameHandle(cdp, handle, "DOM.getNodeForLocation", {
    x: Math.round(x + viewport.scrollX),
    y: Math.round(y + viewport.scrollY),
    includeUserAgentShadowDOM,
  });
}

export async function pointBelongsToTarget(
  cdp: CdpRunner,
  actionTarget: { handle: FrameNodeHandle },
  x: number,
  y: number,
  objectGroup: string,
  includeUserAgentShadowDOM = true,
): Promise<boolean> {
  const { handle } = actionTarget;
  const hit = await nodeAtViewportPoint(cdp, handle, x, y, includeUserAgentShadowDOM);
  if (typeof hit.backendNodeId !== "number") return false;
  // Frameless addresses (CSS selectors) belong to the target's root document.
  // Hit testing can descend into an iframe in the same CDP target; its object
  // cannot be passed to a function in the root document's JavaScript world.
  const frameId =
    handle.frameId ||
    (
      await sendToFrameHandle<{ frameTree?: CdpFrameTreeNode }>(
        cdp,
        handle,
        "Page.getFrameTree",
        {},
      )
    ).frameTree?.frame.id;
  if (!frameId || hit.frameId !== frameId) return false;

  const [resolvedTarget, resolvedHit] = await Promise.all([
    sendToFrameHandle<{ object?: { objectId?: string } }>(cdp, handle, "DOM.resolveNode", {
      backendNodeId: handle.backendNodeId,
      objectGroup,
    }),
    sendToFrameHandle<{ object?: { objectId?: string } }>(cdp, handle, "DOM.resolveNode", {
      backendNodeId: hit.backendNodeId,
      objectGroup,
    }),
  ]);
  const targetObjectId = resolvedTarget.object?.objectId;
  const hitObjectId = resolvedHit.object?.objectId;
  if (!targetObjectId || !hitObjectId) return false;

  const reply = await sendToFrameHandle<RuntimeReply>(cdp, handle, "Runtime.callFunctionOn", {
    objectId: targetObjectId,
    functionDeclaration: `function(hit) {
        // CDP may resolve ::before/::after as CSSPseudoElement, not Node.
        // Native input belongs to its originating element, including descendants.
        const origin = hit instanceof Node ? hit : hit?.element;
        for (let node = origin; node instanceof Node; ) {
          if (node === this) return true;
          if (this.contains?.(node)) return true;
          const root = node.getRootNode?.();
          node = node.parentNode || (root && root !== node ? root.host : null);
        }
        return false;
      }`,
    arguments: [{ objectId: hitObjectId }],
    returnByValue: true,
  });
  if (reply.exceptionDetails) return false;
  return reply.result?.value === true;
}

/** Check the actual root input point through every target boundary, including
 * parent-page overlays that an OOPIF-local hit test cannot see. */
export async function pointReachesTarget(
  cdp: CdpRunner,
  target: { handle: FrameNodeHandle },
  point: Point,
): Promise<boolean> {
  const objectGroup = `pointer-hit-${crypto.randomUUID()}`;
  const touched = new Map<string, FrameDocumentHandle>();
  const hit = async (node: { handle: FrameNodeHandle }, local: Point) => {
    const doc: FrameDocumentHandle = {
      tabId: node.handle.tabId,
      frameId: node.handle.frameId,
      loaderId: node.handle.loaderId,
      ...(node.handle.documentElementBackendNodeId !== undefined
        ? { documentElementBackendNodeId: node.handle.documentElementBackendNodeId }
        : {}),
    };
    touched.set(`${doc.tabId}:${doc.frameId}:${doc.loaderId}`, doc);
    return pointBelongsToTarget(cdp, node, local.x, local.y, objectGroup, false);
  };
  try {
    let local = point;
    if (target.handle.frameId && cdp.getFrameGraph) {
      const context = new GeometryContext(cdp, target.handle.tabId);
      const frame = await context.frame(target.handle.frameId);
      if (!frame) return false;
      if (target.handle.loaderId && frame.loaderId && frame.loaderId !== target.handle.loaderId) {
        return false;
      }
      if (frame.target.sessionId) {
        const ancestry = await context.ancestry(target.handle.frameId);
        const projection = await context.targetProjection(target.handle.frameId);
        if (!ancestry || !projection) return false;
        const owners: { handle: FrameNodeHandle }[] = [];
        for (const child of ancestry) {
          const parent = child.parentFrameId && (await context.frame(child.parentFrameId));
          if (!parent) return false;
          if (cdpTargetKey(child.target) === cdpTargetKey(parent.target)) continue;
          if (child.ownerBackendNodeId === undefined) return false;
          owners.push({
            handle: {
              tabId: target.handle.tabId,
              frameId: parent.frameId,
              loaderId: parent.loaderId ?? "",
              backendNodeId: child.ownerBackendNodeId,
            },
          });
        }
        if (owners.length !== projection.edges.length) return false;
        // Descend from the dispatched point, not from an independently clipped
        // element centroid: clipping and CSS transforms can make those differ.
        for (let index = owners.length - 1; index >= 0; index--) {
          if (!(await hit(owners[index], local))) return false;
          const projected = unprojectPoint(local, projection.edges[index]);
          if (!projected) return false;
          local = projected;
        }
      }
    }
    return await hit(target, local);
  } finally {
    const cleanup = cdp.resourceCleanup ?? cdp;
    await Promise.all(
      [...touched.values()].map((address) =>
        sendToFrameHandle(cleanup, address, "Runtime.releaseObjectGroup", { objectGroup }).catch(
          () => {},
        ),
      ),
    );
  }
}
