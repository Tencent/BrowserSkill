import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePage, checkSize, sameLayout, sliceForFrame } from "./capture";
import { type PageCommand, type PageMetrics, ScreenshotError } from "./types";

const metrics: PageMetrics = {
  x: 0,
  y: 0,
  width: 800,
  height: 2501,
  viewportWidth: 800,
  viewportHeight: 600,
  innerWidth: 815,
  innerHeight: 600,
  dpr: 1,
};

afterEach(() => vi.unstubAllGlobals());

describe("long screenshot stitching", () => {
  it("preserves a complete fixed footer even when the final scroll adds only a few rows", () => {
    const slice = sliceForFrame({ ...metrics, y: 1901, bottomOverlayHeight: 100 }, 2490, 2);
    expect(slice).toEqual({ sourceY: 1000, targetY: 4802, height: 200, end: 2501 });
  });
  it.each([
    1, 1.25, 1.5, 2,
  ])("covers every output row once at scale %s, including a clamped final scroll", (scale) => {
    let covered = 0;
    const spans: { top: number; height: number }[] = [];
    for (const y of [0, 510, 1020, 1530, 1901]) {
      const slice = sliceForFrame({ ...metrics, y }, covered, scale);
      expect(slice.sourceY).toBeGreaterThanOrEqual(0);
      expect(slice.sourceY + slice.height).toBeLessThanOrEqual(Math.ceil(600 * scale));
      spans.push({ top: slice.targetY, height: slice.height });
      covered = slice.end;
    }
    expect(covered).toBe(2501);
    for (let i = 1; i < spans.length; i++)
      expect(spans[i].top).toBe(spans[i - 1].top + spans[i - 1].height);
    expect(spans.reduce((sum, span) => sum + span.height, 0)).toBe(Math.round(2501 * scale));
  });

  it("rejects gaps, oversized canvases and layout changes", () => {
    expect(() => sliceForFrame({ ...metrics, y: 701 }, 600, 1)).toThrow("changed");
    expect(() => checkSize(1600, 40000)).toThrow("tooLarge");
    expect(() => checkSize(10000, 10000)).toThrow("tooLarge");
    expect(() => checkSize(0, 100)).toThrow("tooLarge");
    expect(sameLayout(metrics, { ...metrics, dpr: 2 })).toBe(false);
    expect(sameLayout(metrics, { ...metrics, y: 600 })).toBe(false);
  });
});

function harness() {
  const controller = new AbortController();
  const draw = vi.fn();
  const canvases: { width: number; height: number }[] = [];
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {
        canvases.push(this);
      }
      getContext() {
        return { drawImage: draw };
      }
      async convertToBlob() {
        return new Blob(["png"], { type: "image/png" });
      }
    },
  );
  let current = { ...metrics, y: 401 };
  const commands: PageCommand[] = [];
  const page = vi.fn(async (command: PageCommand) => {
    commands.push(command);
    if (command.action === "move")
      current = {
        ...current,
        y: Math.max(0, Math.min(command.y, current.height - current.viewportHeight)),
      };
    return { ...current };
  });
  const bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
  const screenshot = vi.fn(async () => {
    const bitmap = { width: 1630, height: 1200, close: vi.fn() };
    bitmaps.push(bitmap);
    return bitmap as unknown as ImageBitmap;
  });
  const deps = {
    page,
    screenshot,
    signal: controller.signal,
    progress: vi.fn(),
    label: "Capture",
    cancelLabel: "Cancel",
  };
  return { deps, controller, commands, bitmaps, draw, canvases };
}

describe("capture lifecycle", () => {
  it("warms lazy content, crops scrollbars, stitches and releases every bitmap", async () => {
    const h = harness();
    const result = await capturePage(h.deps);
    expect(result).toMatchObject({ width: 1600, height: 5002 });
    expect(h.commands.filter((c) => c.action === "move" && !c.capture).length).toBeGreaterThan(4);
    expect(h.draw.mock.calls[0].slice(1)).toEqual([0, 0, 1600, 1200, 0, 0, 1600, 1200]);
    const last = h.draw.mock.calls.at(-1)!;
    expect(last[6] + last[8]).toBe(5002);
    expect(h.commands.at(-1)).toEqual({ action: "finish" });
    expect(h.bitmaps.every((bitmap) => bitmap.close.mock.calls.length === 1)).toBe(true);
    expect(h.canvases[0]).toMatchObject({ width: 1, height: 1 });
  });

  it("restores the page if begin mutates it but its response is lost", async () => {
    const h = harness();
    h.deps.page.mockRejectedValueOnce(new ScreenshotError("unavailable"));
    await expect(capturePage(h.deps)).rejects.toThrow("unavailable");
    expect(h.commands.at(-1)).toEqual({ action: "finish" });
  });

  it("restores on cancellation after a bitmap arrives without drawing or leaking it", async () => {
    const h = harness();
    const screenshot = h.deps.screenshot.getMockImplementation()!;
    h.deps.screenshot.mockImplementation(async () => {
      const result = await screenshot();
      h.controller.abort();
      return result;
    });
    await expect(capturePage(h.deps)).rejects.toBeDefined();
    expect(h.bitmaps[0].close).toHaveBeenCalledOnce();
    expect(h.draw).not.toHaveBeenCalled();
    expect(h.commands.at(-1)).toEqual({ action: "finish" });
  });

  it("rejects page reflow during capture rather than saving a torn image", async () => {
    const h = harness();
    const page = h.deps.page.getMockImplementation()!;
    h.deps.page.mockImplementation(async (command) => {
      const result = await page(command);
      return command.action === "inspect" ? { ...result, height: result.height + 50 } : result;
    });
    await expect(capturePage(h.deps)).rejects.toThrow("changed");
    expect(h.commands.at(-1)).toEqual({ action: "finish" });
    expect(h.bitmaps[0].close).toHaveBeenCalledOnce();
  });

  it("stops a continuously growing page with no partial result", async () => {
    const h = harness();
    const page = h.deps.page.getMockImplementation()!;
    h.deps.page.mockImplementation(async (command) => ({
      ...(await page(command)),
      height: 40_000,
    }));
    await expect(capturePage(h.deps)).rejects.toThrow("tooLarge");
    expect(h.deps.screenshot).not.toHaveBeenCalled();
    expect(h.commands.at(-1)).toEqual({ action: "finish" });
  });
});
