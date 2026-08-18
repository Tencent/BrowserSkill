export interface Point {
  x: number;
  y: number;
}

export type Polygon = Point[];
export type Region = Polygon[];
export type Quad = [Point, Point, Point, Point];

export interface Size {
  width: number;
  height: number;
}

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProjectiveEdge {
  sourceViewport: Size;
  destinationQuad: Quad;
  destinationClips?: Polygon[];
}

export interface GeometryProjection {
  sourceClips: Polygon[];
  edges: ProjectiveEdge[];
  topViewport: Size;
}

export function parseCdpQuad(raw: number[] | undefined): Quad | null {
  if (!raw || raw.length !== 8 || !raw.every(Number.isFinite)) return null;
  return [
    { x: raw[0], y: raw[1] },
    { x: raw[2], y: raw[3] },
    { x: raw[4], y: raw[5] },
    { x: raw[6], y: raw[7] },
  ];
}

export function rectPolygon(rect: { x: number; y: number; w: number; h: number }): Quad {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ];
}

export function viewportPolygon(viewport: Size): Quad {
  return rectPolygon({ x: 0, y: 0, w: viewport.width, h: viewport.height });
}

/** Project a normalized unit-square point into an arbitrary content quad. */
export function projectUnitPoint(point: Point, quad: Quad): Point {
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  let a: number;
  let b: number;
  let c: number;
  let d: number;
  let e: number;
  let f: number;
  let g = 0;
  let h = 0;

  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = p1.x - p0.x;
    b = p3.x - p0.x;
    c = p0.x;
    d = p1.y - p0.y;
    e = p3.y - p0.y;
    f = p0.y;
  } else {
    const denominator = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(denominator) < 1e-9) {
      return {
        x: p0.x + (p1.x - p0.x) * point.x + (p3.x - p0.x) * point.y,
        y: p0.y + (p1.y - p0.y) * point.x + (p3.y - p0.y) * point.y,
      };
    }
    g = (dx3 * dy2 - dx2 * dy3) / denominator;
    h = (dx1 * dy3 - dx3 * dy1) / denominator;
    a = p1.x - p0.x + g * p1.x;
    b = p3.x - p0.x + h * p3.x;
    c = p0.x;
    d = p1.y - p0.y + g * p1.y;
    e = p3.y - p0.y + h * p3.y;
    f = p0.y;
  }

  const scale = g * point.x + h * point.y + 1;
  return {
    x: (a * point.x + b * point.y + c) / scale,
    y: (d * point.x + e * point.y + f) / scale,
  };
}

export function projectPolygon(polygon: Polygon, edge: ProjectiveEdge): Polygon {
  const { width, height } = edge.sourceViewport;
  if (width <= 0 || height <= 0) return [];
  return polygon.map((point) =>
    projectUnitPoint({ x: point.x / width, y: point.y / height }, edge.destinationQuad),
  );
}

function polygonSignedArea(points: Polygon): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function edgeIntersection(start: Point, end: Point, clipStart: Point, clipEnd: Point): Point {
  const subjectX = end.x - start.x;
  const subjectY = end.y - start.y;
  const clipX = clipEnd.x - clipStart.x;
  const clipY = clipEnd.y - clipStart.y;
  const denominator = subjectX * clipY - subjectY * clipX;
  if (Math.abs(denominator) < 1e-9) return end;
  const offsetX = clipStart.x - start.x;
  const offsetY = clipStart.y - start.y;
  const scale = (offsetX * clipY - offsetY * clipX) / denominator;
  return { x: start.x + scale * subjectX, y: start.y + scale * subjectY };
}

/** Clip a polygon to a convex polygon, preserving every resulting vertex. */
export function clipPolygon(subject: Polygon, clip: Polygon): Polygon {
  if (subject.length < 3 || clip.length < 3) return [];
  const orientation = polygonSignedArea(clip) >= 0 ? 1 : -1;
  let output = [...subject];
  for (let edge = 0; edge < clip.length && output.length > 0; edge += 1) {
    const clipStart = clip[edge];
    const clipEnd = clip[(edge + 1) % clip.length];
    const input = output;
    output = [];
    const inside = (point: Point) =>
      orientation *
        ((clipEnd.x - clipStart.x) * (point.y - clipStart.y) -
          (clipEnd.y - clipStart.y) * (point.x - clipStart.x)) >=
      -1e-9;
    let start = input[input.length - 1];
    for (const end of input) {
      const startInside = inside(start);
      const endInside = inside(end);
      if (endInside) {
        if (!startInside) output.push(edgeIntersection(start, end, clipStart, clipEnd));
        output.push(end);
      } else if (startInside) {
        output.push(edgeIntersection(start, end, clipStart, clipEnd));
      }
      start = end;
    }
  }
  return output;
}

export function polygonBounds(points: Polygon): ViewportRect | null {
  if (points.length < 3) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function regionBounds(region: Region): ViewportRect | null {
  return polygonBounds(region.flat());
}

export function polygonArea(points: Polygon): number {
  return Math.abs(polygonSignedArea(points));
}

export function polygonCentroid(points: Polygon): Point | null {
  if (points.length < 3) return null;
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;
    twiceArea += cross;
    x += (current.x + next.x) * cross;
    y += (current.y + next.y) * cross;
  }
  if (Math.abs(twiceArea) < 1e-9) return null;
  return { x: x / (3 * twiceArea), y: y / (3 * twiceArea) };
}

export function projectAndClipRegion(
  region: Region,
  edges: ProjectiveEdge[],
  topViewport: Size,
): Region {
  let projected = region;
  for (const edge of edges) {
    const sourceClip = viewportPolygon(edge.sourceViewport);
    projected = projected
      .map((polygon) => clipPolygon(polygon, sourceClip))
      .filter((polygon) => polygon.length >= 3)
      .map((polygon) =>
        [edge.destinationQuad, ...(edge.destinationClips ?? [])].reduce(
          (current, clip) => clipPolygon(current, clip),
          projectPolygon(polygon, edge),
        ),
      )
      .filter((polygon) => polygon.length >= 3);
  }
  const topClip = viewportPolygon(topViewport);
  return projected
    .map((polygon) => clipPolygon(polygon, topClip))
    .filter((polygon) => polygon.length >= 3);
}

export function projectRegionToViewport(region: Region, projection: GeometryProjection): Region {
  const clipped = region
    .map((polygon) =>
      projection.sourceClips.reduce((current, clip) => clipPolygon(current, clip), polygon),
    )
    .filter((polygon) => polygon.length >= 3);
  return projectAndClipRegion(clipped, projection.edges, projection.topViewport);
}

export function projectRectToViewport(
  rect: { x: number; y: number; w: number; h: number } | null,
  projection: GeometryProjection,
): ViewportRect | null {
  if (!rect) return null;
  return regionBounds(projectRegionToViewport([rectPolygon(rect)], projection));
}

export function childFrameProjection(
  parent: GeometryProjection,
  ownerRectInParent: { x: number; y: number; w: number; h: number },
): GeometryProjection {
  const destinationQuad = rectPolygon(ownerRectInParent);
  return {
    sourceClips: [],
    edges: [
      {
        sourceViewport: { width: ownerRectInParent.w, height: ownerRectInParent.h },
        destinationQuad,
        destinationClips: parent.sourceClips,
      },
      ...parent.edges,
    ],
    topViewport: parent.topViewport,
  };
}
