import {
  type GeometryProjection,
  type Polygon,
  projectPolygon,
  rectPolygon,
  regionBounds,
  type ViewportRect,
} from "../geometry";
import type { DocumentGeometry, DocumentIdentity } from "./facts";

export type VisualIssueReason =
  | "ancestry-incomplete"
  | "facts-unavailable"
  | "geometry-unavailable"
  | "geometry-unsupported"
  | "identity-unverified"
  | "ownership-unresolved";

/** Top viewport CSS coordinates. Unconstrained axes have infinite bounds. */
export interface VisualClip {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Shared persistent chain: one entry per clipping ancestor, not per Canvas. */
export interface VisualClipSource {
  readonly document: DocumentIdentity;
  readonly backendNodeId: number;
  readonly x: boolean;
  readonly y: boolean;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly box: ViewportRect;
  readonly parent?: VisualClipSource;
}

export interface VisualContext {
  readonly clip: VisualClip;
  readonly clips?: VisualClipSource;
  readonly hidden: boolean;
  /** A local CSS scale/zoom makes snapshot client offsets ambiguous. */
  readonly transformed: boolean;
  readonly localClip?: boolean;
  /** Overflow between an absolute target and its nearest positioned ancestor. */
  readonly unpositionedClip?: boolean;
  readonly issue?: VisualIssueReason;
}

export const EMPTY_VISUAL_CONTEXT: VisualContext = {
  clip: { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity },
  hidden: false,
  transformed: false,
};

function axisRect(polygon: Polygon): boolean {
  if (polygon.length !== 4 || polygon.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
    return false;
  const [a, b, c, d] = polygon;
  return a.y === b.y && b.x === c.x && c.y === d.y && d.x === a.x && b.x > a.x && d.y > a.y;
}

/** Check evidence before projectRectToViewport can reduce a polygon to its bounds. */
export function visualProjectionIssue(
  geometry: DocumentGeometry | undefined,
): VisualIssueReason | undefined {
  if (!geometry || !geometry.projections.length || geometry.pageScale === undefined)
    return "geometry-unavailable";
  if (!Number.isFinite(geometry.pageScale) || geometry.pageScale <= 0)
    return "geometry-unavailable";
  if (geometry.pageScale !== 1) return "geometry-unsupported";
  const { layoutUnitsPerCssPixel, scrollCss } = geometry.coordinates;
  if (
    !Number.isFinite(layoutUnitsPerCssPixel) ||
    layoutUnitsPerCssPixel <= 0 ||
    ![scrollCss.x, scrollCss.y].every(Number.isFinite)
  )
    return "geometry-unavailable";
  for (const projection of geometry.projections) {
    if (
      ![projection.topViewport.width, projection.topViewport.height].every(
        (n) => Number.isFinite(n) && n > 0,
      )
    )
      return "geometry-unavailable";
    if (projection.sourceClips.some((clip) => !axisRect(clip))) return "geometry-unsupported";
    for (const edge of projection.edges) {
      if (
        ![edge.sourceViewport.width, edge.sourceViewport.height].every(
          (n) => Number.isFinite(n) && n > 0,
        )
      )
        return "geometry-unavailable";
      if (!axisRect(edge.destinationQuad) || edge.destinationClips?.some((clip) => !axisRect(clip)))
        return "geometry-unsupported";
    }
  }
}

/** Uses the same projection math as DOM geometry, without clipping away box origins. */
export function projectVisualBox(
  box: ViewportRect,
  projections: readonly GeometryProjection[],
): ViewportRect | null {
  let polygon: Polygon = rectPolygon({ x: box.x, y: box.y, w: box.width, h: box.height });
  for (const projection of projections)
    for (const edge of projection.edges) polygon = projectPolygon(polygon, edge);
  // Preserve zero-size client boxes: they can prove a fully clipped axis.
  if (box.width === 0 || box.height === 0) {
    const [a, , c] = polygon;
    return { x: a.x, y: a.y, width: c.x - a.x, height: c.y - a.y };
  }
  return regionBounds([polygon]);
}

function axisTransformScale(value: string): [number, number] | null {
  if (value === "none") return [1, 1];
  const match = /^matrix(3d)?\(([^)]+)\)$/.exec(value);
  if (!match) return null;
  const values = match[2].split(",").map((part) => Number(part.trim()));
  if (!values.every(Number.isFinite)) return null;
  if (match[1])
    return values.length === 16 &&
      values[0] > 0 &&
      values[5] > 0 &&
      values[10] === 1 &&
      values[15] === 1 &&
      [1, 2, 3, 4, 6, 7, 8, 9, 11, 14].every((index) => values[index] === 0)
      ? [values[0], values[5]]
      : null;
  return values.length === 6 && values[0] > 0 && values[3] > 0 && values[1] === 0 && values[2] === 0
    ? [values[0], values[3]]
    : null;
}

export interface VisualAncestor {
  readonly document: DocumentIdentity;
  readonly backendNodeId: number;
  readonly styles: Readonly<Record<string, string>>;
  /** Already in top viewport CSS units, from a source-specific adapter. */
  readonly clientBox?: ViewportRect | null;
}

/** One ancestor step, reusable by discovery and the future live local adapter. */
export function extendVisualContext(
  parent: VisualContext,
  node: VisualAncestor,
  clipContents = true,
): VisualContext {
  const styles = node.styles;
  const opacity = styles.opacity?.trim() ? Number(styles.opacity) : NaN;
  const zoom = styles.zoom === "normal" ? 1 : styles.zoom?.trim() ? Number(styles.zoom) : NaN;
  const scale =
    styles.scale === "none" ? [1] : (styles.scale ?? "").trim().split(/\s+/).map(Number);
  const scaleSupported =
    scale.length >= 1 &&
    scale.length <= 3 &&
    scale.every((n) => Number.isFinite(n) && n > 0) &&
    (scale.length < 3 || scale[2] === 1);
  const transformScale = axisTransformScale(styles.transform ?? "");
  // Identity/translation changes origins, which bounds already capture, but
  // leaves client offsets in the same units. Only scaling makes them ambiguous.
  const transformed =
    parent.transformed ||
    transformScale?.some((n) => n !== 1) === true ||
    zoom !== 1 ||
    scale.some((n) => n !== 1);
  const hidden = parent.hidden || opacity === 0 || styles.display === "none";
  let issue = parent.issue;
  if (
    !Number.isFinite(opacity) ||
    !Number.isFinite(zoom) ||
    zoom <= 0 ||
    !styles.display ||
    !styles.visibility
  )
    issue ??= "facts-unavailable";
  if (!styles.transform || !styles["clip-path"] || !styles["mask-image"])
    issue ??= "facts-unavailable";
  else if (!transformScale || styles["clip-path"] !== "none" || styles["mask-image"] !== "none")
    issue ??= "geometry-unsupported";

  if (
    !["rotate", "scale", "perspective", "clip", "contain", "overflow-clip-margin"].every(
      (key) => styles[key],
    )
  )
    issue ??= "facts-unavailable";
  else if (
    !scaleSupported ||
    !["none", "0deg"].includes(styles.rotate) ||
    styles.perspective !== "none" ||
    styles.clip !== "auto" ||
    /(?:^|\s)(paint|strict|content)(?:$|\s)/.test(styles.contain)
  )
    issue ??= "geometry-unsupported";
  // Do not pretend every DOM ancestor clips out-of-flow descendants. Support
  // the ordinary positioned-container case; other containing-block cases stay explicit.
  if (
    (styles.position === "absolute" && parent.unpositionedClip) ||
    (styles.position === "fixed" && parent.localClip)
  )
    issue ??= "geometry-unsupported";
  const overflow = [styles["overflow-x"], styles["overflow-y"]];
  if (clipContents && overflow.includes("clip") && styles["overflow-clip-margin"] !== "0px")
    issue ??= "geometry-unsupported";
  if (
    overflow.some(
      (value) => !["visible", "hidden", "clip", "scroll", "auto", "overlay"].includes(value),
    )
  )
    issue ??= "facts-unavailable";
  const [x, y] = overflow.map((value) => value !== "visible");
  let clip = parent.clip;
  let clips = parent.clips;
  if (clipContents && (x || y)) {
    if (transformed) issue ??= "geometry-unsupported";
    const box = node.clientBox;
    if (
      !box ||
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.width < 0 ||
      box.height < 0
    )
      issue ??= "geometry-unavailable";
    else {
      clip = {
        left: x ? Math.max(clip.left, box.x) : clip.left,
        right: x ? Math.min(clip.right, box.x + box.width) : clip.right,
        top: y ? Math.max(clip.top, box.y) : clip.top,
        bottom: y ? Math.min(clip.bottom, box.y + box.height) : clip.bottom,
      };
      clips = {
        document: node.document,
        backendNodeId: node.backendNodeId,
        x,
        y,
        overflowX: styles["overflow-x"],
        overflowY: styles["overflow-y"],
        box,
        parent: clips,
      };
    }
  }
  const clipsHere = clipContents && (x || y);
  return {
    hidden,
    transformed,
    issue,
    clip,
    clips,
    localClip: parent.localClip || clipsHere,
    unpositionedClip:
      styles.position !== "static" ||
      styles.transform !== "none" ||
      /(?:^|\s)layout(?:$|\s)/.test(styles.contain ?? "")
        ? false
        : parent.unpositionedClip || clipsHere,
  };
}

export type VisualRegionResult =
  | { status: "available"; borderBox: ViewportRect; crop: ViewportRect; clips?: VisualClipSource }
  | { status: "empty" }
  | { status: "unavailable"; reason: VisualIssueReason };

/** Box and frameVisibleBox must come from the same box kind (Canvas border-box).
 * Frame/viewport clipping is supplied by the shared geometry adapter. */
export function resolveVisualRegion(input: {
  borderBox: ViewportRect | null;
  frameVisibleBox: ViewportRect | null;
  context: VisualContext;
  visibility: string;
}): VisualRegionResult {
  const { borderBox, frameVisibleBox, context, visibility } = input;
  if (context.hidden || visibility === "hidden" || visibility === "collapse")
    return { status: "empty" };
  if (context.issue) return { status: "unavailable", reason: context.issue };
  if (visibility !== "visible") return { status: "unavailable", reason: "facts-unavailable" };
  if (!borderBox) return { status: "unavailable", reason: "geometry-unavailable" };
  if (!frameVisibleBox) return { status: "empty" };
  if (
    ![
      borderBox.x,
      borderBox.y,
      borderBox.width,
      borderBox.height,
      frameVisibleBox.x,
      frameVisibleBox.y,
      frameVisibleBox.width,
      frameVisibleBox.height,
    ].every(Number.isFinite)
  )
    return { status: "unavailable", reason: "geometry-unavailable" };
  if (
    borderBox.width <= 0 ||
    borderBox.height <= 0 ||
    frameVisibleBox.width < 0 ||
    frameVisibleBox.height < 0 ||
    Object.values(context.clip).some(Number.isNaN)
  )
    return { status: "unavailable", reason: "geometry-unavailable" };
  const x = Math.max(frameVisibleBox.x, context.clip.left);
  const y = Math.max(frameVisibleBox.y, context.clip.top);
  const right = Math.min(frameVisibleBox.x + frameVisibleBox.width, context.clip.right);
  const bottom = Math.min(frameVisibleBox.y + frameVisibleBox.height, context.clip.bottom);
  return right > x && bottom > y
    ? {
        status: "available",
        borderBox,
        crop: { x, y, width: right - x, height: bottom - y },
        clips: context.clips,
      }
    : { status: "empty" };
}
