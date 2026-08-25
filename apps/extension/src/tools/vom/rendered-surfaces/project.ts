import type { VomScene, VomVisualSurface, VomVisualSurfaceSummary } from "@browser-skill/vom";
import type { CapturedFrameDocument } from "../frame-capture";
import type { SemanticAxNode } from "../semantic-graph";
import type { RenderedSurfaceGroup } from "./types";

function frameBackendKey(frameId: string, backendNodeId: number): string {
  return `${frameId}\u0000${backendNodeId}`;
}

function nearestSceneParent(
  scene: VomScene,
  documents: CapturedFrameDocument<SemanticAxNode>[],
  group: RenderedSurfaceGroup,
): number | null {
  const sceneByBackend = new Map(
    scene.nodes.flatMap((node) =>
      node.backendNodeId === undefined
        ? []
        : [[frameBackendKey(node.frameId ?? "", node.backendNodeId), node.id] as const],
    ),
  );
  const document = documents.find((candidate) => candidate.frameId === group.frameId);
  const domByBackend = new Map(document?.domNodes.map((node) => [node.backendNodeId, node]) ?? []);
  let parentBackendNodeId = group.representative.parentBackendNodeId;
  let guard = 0;
  while (parentBackendNodeId !== null && guard <= domByBackend.size) {
    const sceneId = sceneByBackend.get(frameBackendKey(group.frameId, parentBackendNodeId));
    if (sceneId !== undefined) return sceneId;
    parentBackendNodeId = domByBackend.get(parentBackendNodeId)?.parentBackendNodeId ?? null;
    guard += 1;
  }

  if (document?.parentFrameId && document.ownerBackendNodeId !== undefined) {
    const owner = sceneByBackend.get(
      frameBackendKey(document.parentFrameId, document.ownerBackendNodeId),
    );
    if (owner !== undefined) return owner;
  }

  return (
    scene.nodes.find(
      (node) =>
        node.frameId === group.frameId &&
        ["rootwebarea", "webarea"].includes(node.role?.toLowerCase() ?? ""),
    )?.id ?? null
  );
}

export function projectRenderedSurfaces(
  scene: VomScene,
  documents: CapturedFrameDocument<SemanticAxNode>[],
  groups: RenderedSurfaceGroup[],
): VomScene {
  const visualSurfaces: VomVisualSurface[] = [];
  const summaryCounts = new Map<
    string,
    { parentId: number | null; frameId: string; count: number }
  >();

  for (const group of groups) {
    const parentId = nearestSceneParent(scene, documents, group);
    if (group.existenceConfidence === "low") {
      const key = `${group.frameId}\u0000${parentId ?? "root"}`;
      const current = summaryCounts.get(key) ?? { parentId, frameId: group.frameId, count: 0 };
      current.count += group.members.length;
      summaryCounts.set(key, current);
      continue;
    }
    visualSurfaces.push({
      parentId,
      backendNodeId: group.representative.backendNodeId,
      frameId: group.frameId,
      renderingKind: "canvas",
      rect: group.visibleRect,
      ...(group.representative.localRect ? { localRect: group.representative.localRect } : {}),
      ...(group.label ? { label: group.label } : {}),
      memberCount: group.members.length,
    });
  }

  const visualSurfaceSummaries: VomVisualSurfaceSummary[] = [...summaryCounts.values()];
  return {
    ...scene,
    ...(visualSurfaces.length > 0 ? { visualSurfaces } : {}),
    ...(visualSurfaceSummaries.length > 0 ? { visualSurfaceSummaries } : {}),
  };
}
