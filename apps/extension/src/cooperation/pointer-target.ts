import { cdpTargetKey } from "@/browser-driver/frame-graph";
import { resolveNodeGeometry } from "@/tools/frame-geometry";
import { projectPolygon } from "@/tools/geometry";
import { GeometryContext } from "@/tools/geometry/frame-context";
import { type CdpRunner, isRpcError, sendToCdpTarget } from "@/tools/shared";
import { pointBelongsToTarget } from "@/tools/target-hit";

export function pointerTargetValidator(
  cdp: CdpRunner,
): NonNullable<CdpRunner["verifyPointerTarget"]> {
  return async (target, point) => {
    const geometry = await resolveNodeGeometry(cdp, target.tabId, {
      target: target.cdpTarget,
      backendNodeId: target.backendNodeId,
      frameId: target.frameId,
    });
    if (
      isRpcError(geometry) ||
      Math.abs(geometry.actionPoint.x - point.x) > 2 ||
      Math.abs(geometry.actionPoint.y - point.y) > 2
    )
      throw new Error("The pointer target moved or disappeared; synchronize before clicking");
    const objectGroup = `shared-hit-${crypto.randomUUID()}`;
    try {
      if (
        !(await pointBelongsToTarget(
          cdp,
          target,
          geometry.targetActionPoint.x,
          geometry.targetActionPoint.y,
          objectGroup,
          false,
        ))
      )
        throw new Error(
          "The pointer no longer hits the observed target; synchronize before clicking",
        );
      if (target.frameId && target.cdpTarget.sessionId) {
        const context = new GeometryContext(cdp, target.tabId);
        const ancestry = await context.ancestry(target.frameId);
        const projection = await context.targetProjection(target.frameId);
        if (!ancestry || !projection) throw new Error("The pointer frame path is unavailable");
        let local = geometry.targetActionPoint;
        let edge = 0;
        for (const child of ancestry) {
          const parent = await context.frame(child.parentFrameId!);
          if (!parent) throw new Error("The pointer frame path changed");
          if (cdpTargetKey(child.target) === cdpTargetKey(parent.target)) continue;
          const mapping = projection.edges[edge++];
          if (!mapping || child.ownerBackendNodeId === undefined)
            throw new Error("The pointer frame mapping is unavailable");
          local = projectPolygon([local], mapping)[0];
          // OOPIF hit testing stops at its owning iframe. Verify that owner in
          // every parent target, rather than comparing unrelated frame ids.
          try {
            if (
              !(await pointBelongsToTarget(
                cdp,
                {
                  cdpTarget: parent.target,
                  backendNodeId: child.ownerBackendNodeId,
                  frameId: parent.frameId,
                },
                local.x,
                local.y,
                objectGroup,
                false,
              ))
            )
              throw new Error("The pointer target is covered; synchronize before clicking");
          } finally {
            await sendToCdpTarget(cdp, parent.target, "Runtime.releaseObjectGroup", {
              objectGroup,
            }).catch(() => {});
          }
        }
        if (Math.abs(local.x - point.x) > 2 || Math.abs(local.y - point.y) > 2)
          throw new Error("The pointer frame projection changed; synchronize before clicking");
      }
    } finally {
      await sendToCdpTarget(cdp, target.cdpTarget, "Runtime.releaseObjectGroup", {
        objectGroup,
      }).catch(() => {});
    }
  };
}
