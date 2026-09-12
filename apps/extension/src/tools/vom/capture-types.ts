import type { Rect } from "@browser-skill/vom";

export interface CapturedNode {
  backendNodeId: number;
  parentBackendNodeId: number | null;
  frameId?: string;
  /** Owning iframe backend node id; `null` for the top-level document. */
  ownerFrameBackendNodeId?: number | null;
  tag: string;
  attrs: Record<string, string>;
  /** Top-level viewport-relative CSS px, clipped to the owning frame viewport. */
  rect: Rect | null;
  /** Frame-local viewport-relative CSS px before top-level projection. */
  localRect?: Rect | null;
  paintOrder: number;
  position: string;
  pointerEvents: string;
  /**
   * computed `cursor`. `cursor: pointer` is the strongest CDP-free signal
   * that a non-semantic element (a `<div>`/`<span>` with a click handler)
   * is actually an interactive control — used by the adapter to surface
   * custom buttons/checkboxes the AX tree drops as `generic`. Optional like
   * `textContent`: the live parser always sets it, hand-built fixtures may not.
   */
  cursor?: string;
  /**
   * Whether the live DOM snapshot provides a painted, non-hidden box for this
   * node. Semantic resolution uses this only for DOM fallback nodes; AX-backed
   * nodes remain authoritative even when they are outside the viewport.
   */
  rendered?: boolean;
  textContent?: string;
  formState?: "empty" | "filled" | "default";
  formValue?: string;
  formDefaultValue?: string;
  formPlaceholder?: string;
}
