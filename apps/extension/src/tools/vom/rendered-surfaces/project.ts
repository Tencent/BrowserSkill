import type { VomScene, VomVisualSurface } from "@browser-skill/vom";
import type { CapturedFrameDocument } from "../frame-capture";
import type { SemanticAxNode } from "../semantic-graph";
import type { RenderedSurfaceGroup } from "./types";

function frameBackendKey(frameId: string, backendNodeId: number): string {
  return `${frameId}\u0000${backendNodeId}`;
}

interface ProjectionIndex {
  sceneByBackend: ReadonlyMap<string, number>;
  documentByFrame: ReadonlyMap<string, CapturedFrameDocument<SemanticAxNode>>;
  domByFrame: ReadonlyMap<
    string,
    ReadonlyMap<number, CapturedFrameDocument<SemanticAxNode>["domNodes"][number]>
  >;
  rootSceneIdByFrame: ReadonlyMap<string, number>;
}

function nearestSceneParent(index: ProjectionIndex, group: RenderedSurfaceGroup): number | null {
  const document = index.documentByFrame.get(group.frameId);
  const domByBackend = index.domByFrame.get(group.frameId) ?? new Map();
  let parentBackendNodeId = group.representative.parentBackendNodeId;
  let guard = 0;
  while (parentBackendNodeId !== null && guard <= domByBackend.size) {
    const sceneId = index.sceneByBackend.get(frameBackendKey(group.frameId, parentBackendNodeId));
    if (sceneId !== undefined) return sceneId;
    parentBackendNodeId = domByBackend.get(parentBackendNodeId)?.parentBackendNodeId ?? null;
    guard += 1;
  }

  if (document?.parentFrameId && document.ownerBackendNodeId !== undefined) {
    const owner = index.sceneByBackend.get(
      frameBackendKey(document.parentFrameId, document.ownerBackendNodeId),
    );
    if (owner !== undefined) return owner;
  }

  return index.rootSceneIdByFrame.get(group.frameId) ?? null;
}

function buildProjectionIndex(
  scene: VomScene,
  documents: CapturedFrameDocument<SemanticAxNode>[],
): ProjectionIndex {
  const rootSceneIdByFrame = new Map<string, number>();
  for (const node of scene.nodes) {
    if (
      node.frameId &&
      !rootSceneIdByFrame.has(node.frameId) &&
      ["rootwebarea", "webarea"].includes(node.role?.toLowerCase() ?? "")
    ) {
      rootSceneIdByFrame.set(node.frameId, node.id);
    }
  }
  return {
    sceneByBackend: new Map(
      scene.nodes.flatMap((node) =>
        node.backendNodeId === undefined
          ? []
          : [[frameBackendKey(node.frameId ?? "", node.backendNodeId), node.id] as const],
      ),
    ),
    documentByFrame: new Map(documents.map((document) => [document.frameId, document])),
    domByFrame: new Map(
      documents.map((document) => [
        document.frameId,
        new Map(document.domNodes.map((node) => [node.backendNodeId, node])),
      ]),
    ),
    rootSceneIdByFrame,
  };
}

export function projectRenderedSurfaces(
  scene: VomScene,
  documents: CapturedFrameDocument<SemanticAxNode>[],
  groups: RenderedSurfaceGroup[],
): VomScene {
  const index = buildProjectionIndex(scene, documents);
  const visualSurfaces: VomVisualSurface[] = [];

  for (const group of groups) {
    const parentId = nearestSceneParent(index, group);
    visualSurfaces.push({
      parentId,
      backendNodeId: group.representative.backendNodeId,
      frameId: group.frameId,
      renderingKind: "canvas",
      visibleRect: group.representative.visibleRect,
      ...(group.label ? { label: group.label } : {}),
      memberCount: group.members.length,
    });
  }

  return {
    ...scene,
    ...(visualSurfaces.length > 0 ? { visualSurfaces } : {}),
  };
}
