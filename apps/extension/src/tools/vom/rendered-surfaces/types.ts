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
  parentBackendNodeId: number | null;
  representative: RenderedSurface;
  label?: string;
  memberCount: number;
}

export interface ClusteredRenderedSurfaces {
  groups: RenderedSurfaceGroup[];
  truncated: boolean;
  omittedCount?: number;
}
