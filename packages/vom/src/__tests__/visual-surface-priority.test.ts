import { describe, expect, it } from "vitest";
import {
  compareVisualSurfacePriority,
  selectHighestPriorityVisualSurfaces,
} from "../visual-surface-priority";

function surface(backendNodeId: number, area: number, label?: string) {
  return {
    backendNodeId,
    frameId: "main",
    visibleRect: { x: backendNodeId, y: 0, w: area, h: 1 },
    ...(label ? { label } : {}),
  };
}

describe("visual surface priority selection", () => {
  it("matches a full priority sort when selecting a bounded prefix", () => {
    const surfaces = Array.from({ length: 600 }, (_, index) => surface(index, index + 1));
    surfaces[599] = surface(599, 1, "Important status");

    const selected = selectHighestPriorityVisualSurfaces(surfaces, 512);
    const expected = [...surfaces].sort(compareVisualSurfacePriority).slice(0, 512);

    expect(selected).toEqual(expected);
    expect(selected[0]?.backendNodeId).toBe(599);
  });

  it("normalizes empty, fractional, and unbounded limits", () => {
    const surfaces = [surface(1, 1), surface(2, 2), surface(3, 3)];

    expect(selectHighestPriorityVisualSurfaces(surfaces, 0)).toEqual([]);
    expect(selectHighestPriorityVisualSurfaces(surfaces, 1.9)).toEqual([surface(3, 3)]);
    expect(selectHighestPriorityVisualSurfaces(surfaces, Number.POSITIVE_INFINITY)).toHaveLength(3);
  });
});
