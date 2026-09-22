import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interruptPerformance, performanceSnapshot } from "../performance";
import { installPerformance } from "../performance-observer";
import type { DebugPerformance } from "../types";

const callbacks = new Map<string, (entries: object[]) => void>();
const disconnect = vi.fn();
let current = 100;
let visibility: DocumentVisibilityState = "visible";
let capture: ReturnType<typeof installPerformance> | undefined;
class Observer {
  static supportedEntryTypes = [
    "navigation",
    "paint",
    "largest-contentful-paint",
    "layout-shift",
    "longtask",
  ];
  constructor(private callback: (list: { getEntries(): object[] }) => void) {}
  observe({ type }: { type: string }) {
    callbacks.set(type, (entries) => this.callback({ getEntries: () => entries }));
  }
  takeRecords() {
    return [];
  }
  disconnect = disconnect;
}
const entry = (type: string, values: object[]) => callbacks.get(type)?.(values);
beforeEach(() => {
  vi.useFakeTimers();
  current = 100;
  visibility = "visible";
  callbacks.clear();
  disconnect.mockClear();
  vi.stubGlobal("PerformanceObserver", Observer);
  vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(1000);
  vi.spyOn(performance, "now").mockImplementation(() => current);
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([
    { type: "navigate", responseStart: 20, domContentLoadedEventEnd: 30, loadEventEnd: 40 },
  ] as unknown as PerformanceEntry[]);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => {
  capture?.dispose();
  capture = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("native performance observer", () => {
  it("computes CLS session windows, excludes recent input, and retains bounded worst long tasks", () => {
    capture = installPerformance(() => {}, true);
    entry("layout-shift", [
      { startTime: 10, value: 0.1 },
      { startTime: 500, value: 0.2 },
      { startTime: 550, value: 2, hadRecentInput: true },
      { startTime: 1600, value: 0.25 },
    ]);
    entry(
      "longtask",
      Array.from({ length: 60 }, (_, i) => ({ startTime: i * 100, duration: 50 + i })),
    );
    const value = capture.snapshot();
    expect(value.metrics.cls.value).toBeCloseTo(0.3);
    expect(value.metrics.cls.state).toBe("provisional");
    expect(value.metrics.ttfb_ms).toMatchObject({ value: 20, state: "available" });
    expect(value.metrics.long_task_count.value).toBe(60);
    expect(value.metrics.long_task_total_ms.value).toBe(4770);
    expect(value.long_tasks).toHaveLength(50);
    expect(value.long_tasks[0].duration_ms).toBe(109);
    expect(value.long_tasks_truncated).toBe(true);
    expect(capture.finish().metrics.cls).toMatchObject({
      state: "partial",
      reasons: ["capture_stopped_before_final"],
    });
  });
  it("exposes hidden-page validity and visibility history without inventing paint values", () => {
    visibility = "hidden";
    capture = installPerformance(() => {}, true);
    entry("paint", [{ name: "first-contentful-paint", startTime: 25 }]);
    entry("largest-contentful-paint", [{ startTime: 60 }]);
    expect(capture.snapshot().metrics.fcp_ms).toEqual({
      state: "unavailable",
      reasons: ["initially_hidden"],
    });
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(capture.snapshot().visibility.map((v) => v.state)).toEqual(["hidden", "visible"]);
    expect(capture.snapshot().metrics.lcp_ms.value).toBeUndefined();
  });
  it("marks late buffered observations partial and unsupported APIs explicitly", () => {
    vi.stubGlobal(
      "PerformanceObserver",
      class extends Observer {
        static supportedEntryTypes = ["navigation", "paint"];
      },
    );
    capture = installPerformance(() => {}, false);
    entry("paint", [{ name: "first-contentful-paint", startTime: 25 }]);
    const value = capture.snapshot();
    expect(value.metrics.fcp_ms).toMatchObject({
      value: 25,
      state: "partial",
      reasons: ["started_late"],
    });
    expect(value.metrics.cls).toEqual({ state: "unsupported", reasons: ["api_unsupported"] });
    expect(value.coverage).toContain("visibility_before_capture_unknown");
  });
  it("resets restored visits without reusing navigation or paint metrics", () => {
    capture = installPerformance(() => {}, true);
    entry("longtask", [{ startTime: 10, duration: 80 }]);
    window.dispatchEvent(new Event("pagehide"));
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: true });
    current = 2000;
    window.dispatchEvent(event);
    entry("longtask", [
      { startTime: 10, duration: 80 },
      { startTime: 2100, duration: 70 },
    ]);
    const value = capture.snapshot();
    expect(value.document_key).toBe("1000:1");
    expect(value.metrics.ttfb_ms).toEqual({
      state: "unsupported",
      reasons: ["back_forward_cache"],
    });
    expect(value.metrics.long_task_count.value).toBe(1);
  });
  it("coalesces writes and disconnects observers and listeners on cleanup", () => {
    const emit = vi.fn();
    capture = installPerformance(emit, true);
    entry("longtask", [{ startTime: 10, duration: 80 }]);
    entry("longtask", [{ startTime: 100, duration: 80 }]);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(emit).toHaveBeenCalledTimes(2);
    capture.dispose();
    capture = undefined;
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(4);
  });
  it("validates and redacts persistent snapshots and marks interrupted metrics", () => {
    capture = installPerformance(() => {}, true);
    const raw = { ...capture.snapshot(), url: "https://site.test/?token=secret" };
    const value = performanceSnapshot(raw)!;
    expect(value.url).not.toContain("secret");
    expect(performanceSnapshot({ ...raw, document_key: "untrusted" })).toBeUndefined();
    expect(performanceSnapshot({ ...raw, time_origin: NaN })).toBeUndefined();
    const saved = { ...value, id: "p1", sequence: 1 } as DebugPerformance;
    interruptPerformance(saved, "worker_restarted");
    expect(saved.state).toBe("interrupted");
    expect(saved.metrics.cls).toMatchObject({ state: "partial", reasons: ["worker_restarted"] });
  });
});
