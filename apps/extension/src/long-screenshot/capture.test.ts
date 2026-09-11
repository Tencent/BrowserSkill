import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePage, sameLayout, sliceForFrame } from "./capture";
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

  it("rejects gaps and viewport layout changes", () => {
    expect(() => sliceForFrame({ ...metrics, y: 701 }, 600, 1)).toThrow("changed");
    expect(sameLayout(metrics, { ...metrics, dpr: 2 })).toBe(false);
    expect(sameLayout(metrics, { ...metrics, y: 600 })).toBe(false);
  });
});

function harness() {
  const controller = new AbortController();
  const draw = vi.fn();
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
    write: draw,
    signal: controller.signal,
    progress: vi.fn(),
    label: "Capture",
    cancelLabel: "Cancel",
  };
  return { deps, controller, commands, bitmaps, draw };
}

describe("capture lifecycle", () => {
  it("captures incrementally, crops scrollbars and releases every bitmap", async () => {
    const h = harness();
    const result = await capturePage(h.deps);
    expect(result).toMatchObject({ width: 1600, height: 5002 });
    expect(h.commands.filter((c) => c.action === "move" && !c.capture).length).toBe(0);
    expect(h.draw.mock.calls[0].slice(1)).toEqual([1600, 0, 0, 1200]);
    const last = h.draw.mock.calls.at(-1)!;
    expect(last[3] + last[4]).toBe(5002);
    expect(h.commands.at(-1)).toEqual({ action: "finish" });
    expect(h.bitmaps.every((bitmap) => bitmap.close.mock.calls.length === 1)).toBe(true);
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

  it("captures beyond the old pixel and 120-frame limits without allocating a full canvas", async () => {
    const h = harness();
    const page = h.deps.page.getMockImplementation()!;
    h.deps.page.mockImplementation(async (command) => {
      // Feed the full dimensions into the clamped scroll simulation.
      const result = await page(command);
      const y = command.action === "move" ? Math.min(command.y, 99_400) : lastY;
      lastY = y;
      return { ...result, height: 100_000, y };
    });
    let lastY = 0;
    const result = await capturePage(h.deps);
    expect(result).toEqual({ width: 1600, height: 200_000 });
    expect(h.deps.screenshot.mock.calls.length).toBeGreaterThan(120);
    expect(h.bitmaps.every((bitmap) => bitmap.close.mock.calls.length === 1)).toBe(true);
  });
  it("finishes early with all completed rows when the user chooses Finish", async () => {
    const h = harness();
    const result = await capturePage({ ...h.deps, finished: () => h.draw.mock.calls.length >= 2 });
    expect(result.height).toBe(2220);
    expect(h.commands.at(-1)).toEqual({ action: "finish" });
  });
  it("waits through loading bottoms and redraws a moved flow footer after each append", async () => {
    const h = harness();
    let height = 1200,
      y = 0,
      waiting = 0,
      batches = 0,
      frameHeight = 0;
    h.deps.page.mockImplementation(async (command) => {
      if (command.action === "move") {
        if (command.final && ++waiting === 4 && batches < 2) {
          height += 900;
          batches++;
          waiting = 0;
        }
        y = Math.min(command.y, height - 600);
      }
      frameHeight = height;
      return { ...metrics, height, y, tailStart: height - 700, bottomReady: batches === 2 };
    });
    // Each source row identifies its document position; a provisional 700px
    // flow footer uses a sentinel, so even a one-row stale footer is detected.
    const pixels: number[] = [];
    h.deps.screenshot.mockImplementation(
      async () =>
        ({
          width: 815,
          height: 600,
          close: vi.fn(),
          y,
          pageHeight: frameHeight,
        }) as unknown as ImageBitmap,
    );
    h.deps.write.mockImplementation(async (bitmap, _width, sourceY, targetY, count) => {
      for (let row = 0; row < count; row++) {
        const documentY = bitmap.y + sourceY + row;
        pixels[targetY + row] = documentY >= bitmap.pageHeight - 700 ? -1 : documentY;
      }
    });
    expect(await capturePage(h.deps)).toEqual({ width: 800, height: 3000 });
    expect(batches).toBe(2);
    expect(pixels.slice(0, 2300)).toEqual(Array.from({ length: 2300 }, (_, i) => i));
    expect(pixels.slice(2300)).toEqual(Array(700).fill(-1));
  });
});
