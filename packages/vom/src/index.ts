export {
  applyVomInteractionRecovery,
  isVomReferenceNode,
  isVomStructuralRole,
  renderVom,
} from "./render";
export type {
  ActiveScopeBlock,
  BlockingLayer,
  CondSurface,
  LayerKind,
  Rect,
  RenderedRef,
  Viewport,
  VomNode,
  VomOptions,
  VomRef,
  VomRefCapability,
  VomResult,
  VomScene,
  VomVisualSurface,
} from "./types";
export {
  compareVisualSurfacePriority,
  selectHighestPriorityVisualSurfaces,
  type VisualSurfacePriorityInput,
} from "./visual-surface-priority";
