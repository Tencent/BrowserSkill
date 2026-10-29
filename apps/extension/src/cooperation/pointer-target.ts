import { resolveNodeGeometry } from "@/tools/frame-geometry";
import { type CdpRunner, isRpcError } from "@/tools/shared";
import { pointReachesTarget } from "@/tools/target-hit";

export function pointerTargetValidator(
  cdp: CdpRunner,
): NonNullable<CdpRunner["verifyPointerTarget"]> {
  return async (target, point, offset = { x: 0, y: 0 }) => {
    const geometry = await resolveNodeGeometry(cdp, target.tabId, {
      target: target.cdpTarget,
      backendNodeId: target.backendNodeId,
      frameId: target.frameId,
    });
    if (
      isRpcError(geometry) ||
      Math.abs(geometry.actionPoint.x + offset.x - point.x) > 2 ||
      Math.abs(geometry.actionPoint.y + offset.y - point.y) > 2
    )
      throw new Error("The pointer target moved or disappeared; synchronize before clicking");
    if (!(await pointReachesTarget(cdp, target, point)))
      throw new Error("The pointer target is covered or unavailable; synchronize before clicking");
  };
}
