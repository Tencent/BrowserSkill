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
  backendNodeId?: number;
  frameId?: string;
  contextScopeId?: string;
  /** False for semantic-only nodes that cannot be addressed through CDP. */
  referenceable?: boolean;

  role?: string;
  name?: string;
  value?: string;
  placeholder?: string;
  inputState?: "empty" | "filled" | "default" | "unknown";
  href?: string; // hostname of external link target; omitted for same-origin links
  text?: string;
  nearbyText?: string;

  tag: string;
  rect: Rect | null;
  paintOrder: number;
  position: string;
  pointerEvents: string;
  cursor?: string;
  attrs?: Record<string, string>;
  domParentId?: number | null;
  domAncestorIds?: number[];

  modal?: boolean;
  sensitive?: boolean;
  disabled?: boolean;
  inert?: boolean;
  hasNativeDescendant?: boolean;
  insideNative?: boolean;
}

export interface VomScene {
  viewport: Viewport;
  nodes: VomNode[];
  /** Root document whose paint order defines page-level blocking layers. */
  rootFrameId?: string;
  surfaces?: CondSurface[];
  activeScopeBlocks?: ActiveScopeBlock[];
  /** Non-semantic rendered regions discovered alongside the AX/DOM tree. */
  visualSurfaces?: VomVisualSurface[];
}

export interface VomOptions {
  maxDepth?: number;
  maxTokens?: number;
  /**
   * When true, form values are rendered as masks instead of literal values.
   */
  redactValues?: boolean;
  /**
   * Experimental: filter refs that are geometrically blocked by foreground
   * fixed/absolute/sticky regions. Disabled by default and does not alter the
   * public layer header format.
   */
  activeRegionPolicy?: boolean;
}

export interface CondSurface {
  triggerId: number;
  triggerAction: "hover" | "focus" | string;
  subItems: string[];
}

export interface ActiveScopeBlock {
  triggerId: number;
  label: string;
  lines: string[];
}

export interface VomRef {
  ref: string;
  backendNodeId: number;
  frameId?: string;
  /** Observation-time top-viewport crop for screenshot-only surfaces. */
  visibleRect?: Rect;
  kind?: "dom" | "surface";
  capabilities?: VomRefCapability[];
}

export type VomRefCapability = "interact" | "screenshot";

export interface VomVisualSurface {
  parentId: number | null;
  backendNodeId: number;
  frameId: string;
  renderingKind: "canvas";
  visibleRect: Rect;
  label?: string;
  memberCount: number;
}

export interface RenderedRef extends VomRef {
  role?: string;
  name?: string;
  ctx?: string;
  /** Zero-based line index in `VomResult.text`. */
  line: number;
}

export interface VomResult {
  text: string;
  refs: RenderedRef[];
  truncated: boolean;
}

export interface BlockingLayer {
  rootId: number;
  kind: Exclude<LayerKind, "page">;
  coverage: number;
  members: Set<number>;
}
