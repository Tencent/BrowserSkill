import { describe, expect, it } from "vitest";
import { type SurfaceCaptureInput, SurfaceCaptureStore } from "../surface-capture-store";

function input(): SurfaceCaptureInput {
  return {
    sessionId: "aa11",
    tabId: 7,
    navigationIdentity: "navigation",
    surface: {
      ref: "e3",
      frameId: "main",
      backendNodeId: 99,
      observationGeneration: 2,
    },
    topViewportRect: { x: 10, y: 20, w: 100, h: 50 },
    imageWidth: 200,
    imageHeight: 100,
    viewportSignature: "viewport",
    frameProjectionSignature: "frame",
  };
}

describe("SurfaceCaptureStore", () => {
  it("creates metadata-only, short-lived captures and consumes them once", () => {
    let now = 1_000;
    const store = new SurfaceCaptureStore({
      now: () => now,
      ttlMs: 500,
      createId: () => "sc_test",
    });
    const capture = store.create(input());

    expect(capture).toMatchObject({
      id: "sc_test",
      createdAt: 1_000,
      expiresAt: 1_500,
      consumed: false,
    });
    expect(capture).not.toHaveProperty("imageBase64");
    expect(store.consume("sc_test")).toMatchObject({ ok: true });
    expect(store.consume("sc_test")).toEqual({ ok: false, reason: "consumed" });

    now = 1_600;
    expect(store.size()).toBe(0);
  });

  it("rejects expired and unknown captures", () => {
    let now = 1_000;
    const store = new SurfaceCaptureStore({
      now: () => now,
      ttlMs: 10,
      createId: () => "sc_expired",
    });
    store.create(input());
    now = 1_010;

    expect(store.consume("sc_expired")).toEqual({ ok: false, reason: "expired" });
    expect(store.consume("sc_missing")).toEqual({ ok: false, reason: "not_found" });
  });

  it("clears every capture on session cleanup", () => {
    const store = new SurfaceCaptureStore({ createId: () => "sc_clear" });
    store.create(input());
    store.clear();
    expect(store.size()).toBe(0);
  });
});
