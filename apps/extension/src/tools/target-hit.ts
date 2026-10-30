import { type CdpFrameTreeNode, type CdpTarget, cdpTargetKey } from "@/browser-driver/frame-graph";
import { type Point, unprojectPoint } from "./geometry";
import { cssViewport, GeometryContext, type LayoutMetrics } from "./geometry/frame-context";
import { type CdpRunner, sendToCdpTarget } from "./shared";

interface RuntimeReply {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

/** Input uses viewport CSS pixels; DOM hit testing uses document CSS pixels. */
async function nodeAtViewportPoint(
  cdp: CdpRunner,
  target: CdpTarget,
  x: number,
  y: number,
  includeUserAgentShadowDOM = true,
): Promise<{ backendNodeId?: number; frameId?: string }> {
  const metrics = await sendToCdpTarget<LayoutMetrics>(cdp, target, "Page.getLayoutMetrics", {});
  const viewport = cssViewport(metrics);
  if (
    ![x, y, viewport.scrollX, viewport.scrollY].every(Number.isFinite) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    throw new Error("The hit-test viewport is unavailable");
  return sendToCdpTarget(cdp, target, "DOM.getNodeForLocation", {
    x: Math.round(x + viewport.scrollX),
    y: Math.round(y + viewport.scrollY),
    includeUserAgentShadowDOM,
  });
}

export async function pointBelongsToTarget(
  cdp: CdpRunner,
  actionTarget: { cdpTarget: CdpTarget; backendNodeId: number; frameId?: string },
  x: number,
  y: number,
  objectGroup: string,
  includeUserAgentShadowDOM = true,
): Promise<boolean> {
  const target = actionTarget.cdpTarget;
  const hit = await nodeAtViewportPoint(cdp, target, x, y, includeUserAgentShadowDOM);
  if (typeof hit.backendNodeId !== "number") return false;
  // Frameless addresses (CSS selectors) belong to the target's root document.
  // Hit testing can descend into an iframe in the same CDP target; its object
  // cannot be passed to a function in the root document's JavaScript world.
  const frameId =
    actionTarget.frameId ??
    (await sendToCdpTarget<{ frameTree?: CdpFrameTreeNode }>(cdp, target, "Page.getFrameTree", {}))
      .frameTree?.frame.id;
  if (!frameId || hit.frameId !== frameId) return false;

  const [resolvedTarget, resolvedHit] = await Promise.all([
    sendToCdpTarget<{ object?: { objectId?: string } }>(cdp, target, "DOM.resolveNode", {
      backendNodeId: actionTarget.backendNodeId,
      objectGroup,
    }),
    sendToCdpTarget<{ object?: { objectId?: string } }>(cdp, target, "DOM.resolveNode", {
      backendNodeId: hit.backendNodeId,
      objectGroup,
    }),
  ]);
  const targetObjectId = resolvedTarget.object?.objectId;
  const hitObjectId = resolvedHit.object?.objectId;
  if (!targetObjectId || !hitObjectId) return false;

  const reply = await sendToCdpTarget<RuntimeReply>(cdp, target, "Runtime.callFunctionOn", {
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
  target: { tabId: number; cdpTarget: CdpTarget; backendNodeId: number; frameId?: string },
  point: Point,
): Promise<boolean> {
  const objectGroup = `pointer-hit-${crypto.randomUUID()}`;
  const touched = new Map<string, CdpTarget>();
  const hit = async (node: typeof target, local: Point) => {
    touched.set(cdpTargetKey(node.cdpTarget), node.cdpTarget);
    return pointBelongsToTarget(cdp, node, local.x, local.y, objectGroup, false);
  };
  try {
    let local = point;
    if (target.cdpTarget.sessionId) {
      if (!target.frameId) return false;
      const context = new GeometryContext(cdp, target.tabId);
      const frame = await context.frame(target.frameId);
      if (!frame || cdpTargetKey(frame.target) !== cdpTargetKey(target.cdpTarget)) return false;
      const ancestry = await context.ancestry(target.frameId);
      const projection = await context.targetProjection(target.frameId);
      if (!ancestry || !projection) return false;
      const owners: (typeof target)[] = [];
      for (const child of ancestry) {
        const parent = child.parentFrameId && (await context.frame(child.parentFrameId));
        if (!parent) return false;
        if (cdpTargetKey(child.target) === cdpTargetKey(parent.target)) continue;
        if (child.ownerBackendNodeId === undefined) return false;
        owners.push({
          tabId: target.tabId,
          cdpTarget: parent.target,
          backendNodeId: child.ownerBackendNodeId,
          frameId: parent.frameId,
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
    return await hit(target, local);
  } finally {
    const cleanup = cdp.resourceCleanup ?? cdp;
    await Promise.all(
      [...touched.values()].map((address) =>
        sendToCdpTarget(cleanup, address, "Runtime.releaseObjectGroup", { objectGroup }).catch(
          () => {},
        ),
      ),
    );
  }
}
