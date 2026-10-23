import type { CdpTarget } from "@/browser-driver/frame-graph";
import { cssViewport, type LayoutMetrics } from "./geometry/frame-context";
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
  if (actionTarget.frameId && hit.frameId !== actionTarget.frameId) return false;

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
