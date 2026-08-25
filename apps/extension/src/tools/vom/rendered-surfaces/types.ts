import type { Rect } from "@browser-skill/vom";

export type SurfaceExistenceConfidence = "high" | "low";

export interface RenderedSurface {
  renderingKind: "canvas";
  frameId: string;
  backendNodeId: number;
  parentBackendNodeId: number | null;
  rect: Rect;
  localRect?: Rect;
  visibleRect: Rect;
  paintOrder: number;
  label?: string;
  existenceConfidence: SurfaceExistenceConfidence;
}

export interface RenderedSurfaceGroup {
  frameId: string;
  members: RenderedSurface[];
  representative: RenderedSurface;
  rect: Rect;
  visibleRect: Rect;
  label?: string;
  existenceConfidence: SurfaceExistenceConfidence;
}
