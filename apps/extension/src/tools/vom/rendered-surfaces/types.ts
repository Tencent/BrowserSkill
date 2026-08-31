import type { Rect } from "@browser-skill/vom";

export interface RenderedSurface {
  renderingKind: "canvas";
  frameId: string;
  backendNodeId: number;
  parentBackendNodeId: number | null;
  visibleRect: Rect;
  paintOrder: number;
  label?: string;
}

export interface RenderedSurfaceGroup {
  frameId: string;
  members: RenderedSurface[];
  representative: RenderedSurface;
  label?: string;
}
