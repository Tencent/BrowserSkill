/** Viewport-relative layout box, CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export type LayerKind = "page" | "modal" | "mask";

/**
 * CDP-free data slice consumed by packages/vom.
 * The extension joins AX semantics and DOMSnapshot geometry by backendNodeId
 * before constructing these nodes.
 */
export interface VomNode {
  id: number;
  parentId: number | null;

  role?: string;
  name?: string;
  value?: string;
  href?: string; // hostname of external link target; omitted for same-origin links

  tag: string;
  rect: Rect | null;
  paintOrder: number;
  position: string;
  pointerEvents: string;

  modal?: boolean;
  sensitive?: boolean;
}

export interface VomScene {
  viewport: Viewport;
  nodes: VomNode[];
}

export interface VomOptions {
  maxDepth?: number;
  maxTokens?: number;
}

export interface VomResult {
  text: string;
  refs: Array<{ ref: string; backendNodeId: number }>;
  truncated: boolean;
}

export interface BlockingLayer {
  rootId: number;
  kind: Exclude<LayerKind, "page">;
  coverage: number;
  members: Set<number>;
}
