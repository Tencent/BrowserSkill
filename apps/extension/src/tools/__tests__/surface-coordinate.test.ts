import { describe, expect, it } from "vitest";
import {
  mapImagePointToViewport,
  pointInRegion,
  sameRect,
  surfaceVisibleRect,
} from "../surface-coordinate";

describe("surface coordinate mapping", () => {
  it("maps capture image pixels through the actual screenshot dimensions", () => {
    expect(mapImagePointToViewport({ x: 100, y: 50, w: 400, h: 200 }, 800, 400, 200, 100)).toEqual({
      x: 200,
      y: 100,
    });
  });

  it("rejects invalid image coordinates and dimensions", () => {
    const rect = { x: 0, y: 0, w: 100, h: 50 };
    expect(mapImagePointToViewport(rect, 100, 50, -1, 0)).toBeNull();
    expect(mapImagePointToViewport(rect, 100, 50, 100, 0)).toBeNull();
    expect(mapImagePointToViewport(rect, 100, 50, 0, 50)).toBeNull();
    expect(mapImagePointToViewport(rect, 100, 50, Number.NaN, 0)).toBeNull();
    expect(mapImagePointToViewport(rect, 100, 50, Number.POSITIVE_INFINITY, 0)).toBeNull();
    expect(mapImagePointToViewport(rect, 0, 50, 0, 0)).toBeNull();
  });

  it("intersects live and observed visible regions and compares them strictly", () => {
    const clipped = surfaceVisibleRect(
      { x: 0, y: 0, width: 200, height: 100 },
      { x: 25, y: 30, w: 50, h: 40 },
    );
    expect(clipped).toEqual({ x: 25, y: 30, w: 50, h: 40 });
    expect(sameRect(clipped as NonNullable<typeof clipped>, { x: 25, y: 30, w: 50, h: 40 })).toBe(
      true,
    );
    expect(sameRect(clipped as NonNullable<typeof clipped>, { x: 26, y: 30, w: 50, h: 40 })).toBe(
      false,
    );
  });

  it("checks the projected visible region rather than only its bounding box", () => {
    const triangle = [
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 0, y: 100 },
      ],
    ];
    expect(pointInRegion({ x: 20, y: 20 }, triangle)).toBe(true);
    expect(pointInRegion({ x: 90, y: 90 }, triangle)).toBe(false);
  });
});
