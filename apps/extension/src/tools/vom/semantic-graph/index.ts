import type { Viewport, VomScene } from "@browser-skill/vom";
import type { FrameDocument } from "../frame-document";
import { buildSemanticGraph } from "./build";
import { projectSemanticGraph } from "./project";
import { resolveSemanticGraph } from "./resolve";
import type { SemanticAxNode } from "./types";

export type { SemanticAxNode } from "./types";

export function buildSemanticVomScene(input: {
  documents: FrameDocument<SemanticAxNode>[];
  viewport: Viewport;
  rootFrameId?: string;
  excludedBackendNodeIds?: ReadonlySet<number>;
}): VomScene {
  return projectSemanticGraph(
    resolveSemanticGraph(
      buildSemanticGraph({
        documents: input.documents,
        viewport: input.viewport,
        rootFrameId: input.rootFrameId,
        excludedBackendNodeIds: input.excludedBackendNodeIds,
      }),
    ),
  );
}
