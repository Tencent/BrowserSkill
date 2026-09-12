import { describe, expect, it } from "vitest";
import {
  EMPTY_VISUAL_CONTEXT,
  extendVisualContext,
  projectVisualBox,
  resolveVisualRegion,
  type VisualAncestor,
} from "../visual-region";

const styles = {
  position: "static",
  visibility: "visible",
  opacity: "1",
  display: "block",
  transform: "none",
  zoom: "1",
  "overflow-x": "visible",
  "overflow-y": "visible",
  "clip-path": "none",
  "mask-image": "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  clip: "auto",
  contain: "none",
  "overflow-clip-margin": "0px",
};
const ancestor: VisualAncestor = {
  document: {
    attachmentId: "a",
    target: { tabId: 1 },
    frameId: "main",
    documentElementBackendNodeId: 1,
  },
  backendNodeId: 2,
  styles,
  clientBox: { x: 5, y: 5, width: 60, height: 30 },
};
const box = { x: 0, y: 0, width: 120, height: 40 };

describe("shared visual region rules", () => {
  it.each([
    "visible",
    "hidden",
    "auto",
    "scroll",
    "clip",
  ])("keeps %s screenshot bounds independent of rounded styling", (overflow) => {
    for (const clipContents of [true, false]) {
      const node = {
        ...ancestor,
        styles: { ...styles, "overflow-x": overflow, "overflow-y": overflow },
      };
      const baseline = extendVisualContext(EMPTY_VISUAL_CONTEXT, node, clipContents);
      for (const radius of ["0px", "8px", "50%", "4px 8px"]) {
        const rounded = extendVisualContext(
          EMPTY_VISUAL_CONTEXT,
          {
            ...node,
            styles: {
              ...node.styles,
              "border-top-left-radius": radius,
              "border-top-right-radius": radius,
              "border-bottom-left-radius": radius,
              "border-bottom-right-radius": radius,
            },
          },
          clipContents,
        );
        expect(rounded).toEqual(baseline);
        expect(
          resolveVisualRegion({
            borderBox: box,
            frameVisibleBox: box,
            visibility: "visible",
            context: rounded,
          }),
        ).toMatchObject({ status: "available" });
        expect(
          resolveVisualRegion({
            borderBox: box,
            frameVisibleBox: box,
            visibility: "hidden",
            context: rounded,
          }),
        ).toEqual({ status: "empty" });
        if (clipContents && overflow !== "visible")
          expect(
            resolveVisualRegion({
              borderBox: box,
              frameVisibleBox: { x: 80, y: 0, width: 20, height: 20 },
              visibility: "visible",
              context: rounded,
            }),
          ).toEqual({ status: "empty" });
      }
    }
  });

  it("accepts independently supplied normalized facts and preserves clipping policy", () => {
    const context = extendVisualContext(EMPTY_VISUAL_CONTEXT, {
      ...ancestor,
      styles: { ...styles, "overflow-x": "hidden" },
    });
    expect(
      resolveVisualRegion({ borderBox: box, frameVisibleBox: box, visibility: "visible", context }),
    ).toMatchObject({
      status: "available",
      crop: { x: 5, y: 0, width: 60, height: 40 },
      clips: { overflowX: "hidden", overflowY: "visible" },
    });
    const differentPolicy = extendVisualContext(EMPTY_VISUAL_CONTEXT, {
      ...ancestor,
      styles: { ...styles, "overflow-x": "scroll" },
    });
    expect(differentPolicy.clip).toEqual(context.clip);
    expect(differentPolicy.clips).not.toEqual(context.clips);
  });

  it("distinguishes fully clipped, missing client geometry and invalid rectangles", () => {
    const clipping = { ...ancestor, styles: { ...styles, "overflow-x": "hidden" } };
    const context = extendVisualContext(EMPTY_VISUAL_CONTEXT, {
      ...clipping,
      clientBox: { x: 0, y: 0, width: 0, height: 20 },
    });
    expect(
      resolveVisualRegion({ borderBox: box, frameVisibleBox: box, visibility: "visible", context })
        .status,
    ).toBe("empty");
    const unavailable = extendVisualContext(EMPTY_VISUAL_CONTEXT, { ...clipping, clientBox: null });
    expect(
      resolveVisualRegion({
        borderBox: box,
        frameVisibleBox: box,
        visibility: "visible",
        context: unavailable,
      }),
    ).toEqual({ status: "unavailable", reason: "geometry-unavailable" });
    expect(
      resolveVisualRegion({
        borderBox: { ...box, x: NaN },
        frameVisibleBox: box,
        visibility: "visible",
        context: EMPTY_VISUAL_CONTEXT,
      }).status,
    ).toBe("unavailable");
    expect(projectVisualBox({ x: 5, y: 5, width: 0, height: 20 }, [])).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 20,
    });
  });

  it.each<Record<string, string>>([
    { rotate: "45deg" },
    { scale: "-1 1" },
    { perspective: "100px" },
    { clip: "rect(0px, 20px, 20px, 0px)" },
    { contain: "paint" },
    { "overflow-x": "clip", "overflow-clip-margin": "10px" },
    { transform: "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0.01,0,0,0,1)" },
  ])("refuses unsupported CSS evidence without changing DOM geometry: %o", (change) => {
    const context = extendVisualContext(EMPTY_VISUAL_CONTEXT, {
      ...ancestor,
      styles: { ...styles, ...change },
    });
    expect(context.issue).toBe("geometry-unsupported");
  });

  it("accepts axis-preserving matrix3d translation and independent positive scale", () => {
    for (const change of [
      { transform: "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,10,20,0,1)" },
      { scale: "1.25" },
    ])
      expect(
        extendVisualContext(EMPTY_VISUAL_CONTEXT, { ...ancestor, styles: { ...styles, ...change } })
          .issue,
      ).toBeUndefined();
  });

  it.each([
    "matrix(1,0,0,1,0,0)",
    "matrix(1,0,0,1,10,20)",
  ])("accepts unscaled overflow transform %s", (transform) => {
    const context = extendVisualContext(EMPTY_VISUAL_CONTEXT, {
      ...ancestor,
      styles: {
        ...styles,
        transform,
        position: "relative",
        "overflow-x": "hidden",
        "overflow-y": "hidden",
      },
    });
    expect(context.issue).toBeUndefined();
    const child = extendVisualContext(
      context,
      {
        ...ancestor,
        styles: {
          ...styles,
          position: "absolute",
          "overflow-x": "clip",
          "overflow-y": "clip",
          "overflow-clip-margin": "content-box",
        },
      },
      false,
    );
    expect(
      resolveVisualRegion({
        borderBox: box,
        frameVisibleBox: box,
        visibility: "visible",
        context: child,
      }),
    ).toMatchObject({ status: "available", crop: { x: 5, y: 5, width: 60, height: 30 } });
  });

  it("supports positioned overflow containers but refuses uncertain out-of-flow clipping", () => {
    const overflow = { ...ancestor, styles: { ...styles, "overflow-x": "hidden" } };
    const staticParent = extendVisualContext(EMPTY_VISUAL_CONTEXT, overflow);
    expect(
      extendVisualContext(
        staticParent,
        { ...ancestor, styles: { ...styles, position: "absolute" } },
        false,
      ).issue,
    ).toBe("geometry-unsupported");
    const positionedParent = extendVisualContext(EMPTY_VISUAL_CONTEXT, {
      ...overflow,
      styles: { ...overflow.styles, position: "relative" },
    });
    const child = extendVisualContext(
      positionedParent,
      { ...ancestor, styles: { ...styles, position: "absolute" } },
      false,
    );
    expect(child.issue).toBeUndefined();
    expect(child.clip).toEqual(positionedParent.clip);
    expect(
      extendVisualContext(
        positionedParent,
        { ...ancestor, styles: { ...styles, position: "fixed" } },
        false,
      ).issue,
    ).toBe("geometry-unsupported");
  });
});
