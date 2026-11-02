import type { Viewport, VomScene } from "@browser-skill/vom";
import type { FrameDocument } from "../frame-document";
import { buildSemanticGraph as buildGraph } from "./build";
import { projectSemanticGraph as projectGraph } from "./project";
import { resolveSemanticGraph as resolveGraph } from "./resolve";
import { normalizeSemanticStructure as normalizeStructure } from "./structure";
import type {
  ResolvedSemanticGraph,
  SemanticAxNode,
  SemanticGraph,
  StructuredSemanticGraph,
} from "./types";

export type { SemanticAxNode } from "./types";

export interface SemanticVomInput {
  documents: FrameDocument<SemanticAxNode>[];
  viewport: Viewport;
  rootFrameId?: string;
  excludedBackendNodeIds?: ReadonlySet<number>;
}

export function buildSemanticGraph(input: SemanticVomInput): SemanticGraph {
  return buildGraph(input);
}

export function resolveSemanticGraph(
  graph: SemanticGraph,
  options: {
    supplementalNames?: ReadonlyMap<string, string>;
    identifierFallback?: boolean;
  } = {},
): ResolvedSemanticGraph {
  return resolveGraph(graph, options);
}

export function normalizeSemanticStructure(graph: ResolvedSemanticGraph): StructuredSemanticGraph {
  return normalizeStructure(graph);
}

export function projectSemanticGraph(graph: StructuredSemanticGraph): VomScene {
  return projectGraph(graph);
}

export function buildSemanticVomScene(
  input: SemanticVomInput & {
    supplementalNames?: ReadonlyMap<string, string>;
    identifierFallback?: boolean;
  },
): VomScene {
  return projectSemanticGraph(
    normalizeSemanticStructure(
      resolveSemanticGraph(buildSemanticGraph(input), {
        supplementalNames: input.supplementalNames,
        identifierFallback: input.identifierFallback,
      }),
    ),
  );
}
