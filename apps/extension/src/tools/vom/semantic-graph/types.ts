import type { Viewport, VomNode } from "@browser-skill/vom";
import type { CdpTarget } from "@/browser-driver/frame-graph";
import type { CapturedNode } from "../capture";

export interface SemanticAxNode {
  nodeId: string;
  frameId?: string;
  parentId?: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: { type: string; value?: string };
  name?: { type: string; value?: string };
  description?: { value?: string };
  value?: { value?: string | number | boolean };
  properties?: Array<{ name?: string; value?: { value?: string | number | boolean } }>;
  childIds?: string[];
}

export type SemanticNodeId = string;

export interface SemanticFrame {
  frameId: string;
  parentFrameId?: string;
  ownerBackendNodeId?: number;
  ownerNodeId?: SemanticNodeId;
  contextScopeId: string;
  target: CdpTarget;
  url?: string;
  order: number;
}

export interface SemanticGraphNode {
  id: SemanticNodeId;
  frameId: string;
  backendNodeId?: number;
  axNodeId?: string;
  ax?: SemanticAxNode;
  dom?: CapturedNode;
  axParentId?: SemanticNodeId;
  domParentId?: SemanticNodeId;
  sourceOrder: number;
  excluded: boolean;
}

export interface SemanticGraph {
  viewport: Viewport;
  rootFrameId: string;
  frames: Map<string, SemanticFrame>;
  nodes: Map<SemanticNodeId, SemanticGraphNode>;
  nodeIdsByFrame: Map<string, SemanticNodeId[]>;
  nodeByFrameBackend: Map<string, SemanticNodeId>;
}

export interface ResolvedSemanticNode extends SemanticGraphNode {
  vom: Omit<VomNode, "id" | "parentId" | "backendNodeId" | "frameId" | "contextScopeId">;
  referenceable: boolean;
  roleSource: "ax" | "ax-ignored" | "dom-explicit" | "dom-native" | "none";
}

export interface ResolvedSemanticGraph extends Omit<SemanticGraph, "nodes"> {
  nodes: Map<SemanticNodeId, ResolvedSemanticNode>;
}

export type StructureDecision =
  | { kind: "keep"; reason: "semantic" | "frame-owner" }
  | { kind: "inferred-group"; reason: "independent-interaction-branches" }
  | { kind: "transparent"; reason: "wrapper" | "child-document-root" | "ax-ignored" }
  | {
      kind: "excluded";
      reason: "excluded" | "redundant-source" | "non-rendered-dom-fallback";
    };

export interface StructuredSemanticNode extends ResolvedSemanticNode {
  structure: StructureDecision;
  semanticParentId?: SemanticNodeId;
}

export interface StructuredSemanticGraph extends Omit<ResolvedSemanticGraph, "nodes"> {
  nodes: Map<SemanticNodeId, StructuredSemanticNode>;
}

export function frameBackendKey(frameId: string, backendNodeId: number): string {
  return `${frameId}\u0000${backendNodeId}`;
}

export function frameAxKey(frameId: string, axNodeId: string): string {
  return `${frameId}\u0000${axNodeId}`;
}
