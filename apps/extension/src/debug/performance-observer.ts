/** Runs in the existing isolated main-frame debug world. No page objects leave it. */
export function installPerformance(emit: (value: unknown) => void, early: boolean) {
  const origin = performance.timeOrigin;
  const abort = new AbortController();
  const observers: {
    observer: PerformanceObserver;
    consume: (entries: PerformanceEntry[]) => void;
  }[] = [];
  const supported = new Set(
    typeof PerformanceObserver === "function"
      ? (PerformanceObserver.supportedEntryTypes ?? [])
      : [],
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let visit = 0;
  let since = early ? 0 : performance.now();
  let restored = false;
  let ended = false;
  let stopped = false;
  let lcpClosed = false;
  let initiallyHidden = document.visibilityState !== "visible";
  let firstHidden = initiallyHidden ? 0 : Infinity;
  let visibility = [{ at: origin + since, state: document.visibilityState }];
  let fcp: number | undefined, lcp: number | undefined;
  let cls = 0,
    burst = 0,
    burstStart = 0,
    lastShift = -Infinity;
  let taskCount = 0,
    taskTotal = 0,
    taskMax = 0;
  let tasks: { at: number; duration_ms: number }[] = [];
  const gaps = new Set<string>();
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const schedule = () => {
    if (!disposed && !timer)
      timer = setTimeout(() => {
        timer = undefined;
        emit(snapshot());
      }, 500);
  };
  function observe(type: string, consume: (entries: PerformanceEntry[]) => void) {
    if (!supported.has(type)) return;
    try {
      const observer = new PerformanceObserver(
        (list, _observer, options?: { droppedEntriesCount?: number }) => {
          if (disposed || ended) return;
          if (options?.droppedEntriesCount) gaps.add("browser_entry_buffer_full");
          const entries = list.getEntries();
          if (entries.length > 1000) gaps.add("performance_entry_limit");
          consume(entries.slice(0, 1000));
          schedule();
        },
      );
      observer.observe({ type, buffered: true });
      observers.push({ observer, consume });
    } catch {
      supported.delete(type);
    }
  }
  const inVisit = (entry: PerformanceEntry) =>
    valid(entry.startTime) && (!restored || entry.startTime >= since);
  observe("paint", (entries) => {
    for (const e of entries)
      if (inVisit(e) && e.name === "first-contentful-paint" && e.startTime < firstHidden)
        fcp = e.startTime;
  });
  observe("largest-contentful-paint", (entries) => {
    for (const e of entries) if (inVisit(e) && e.startTime < firstHidden) lcp = e.startTime;
  });
  observe("layout-shift", (entries) => {
    for (const e of entries) {
      const shift = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
      if (!inVisit(e) || shift.hadRecentInput || !valid(shift.value)) continue;
      if (e.startTime - lastShift < 1000 && e.startTime - burstStart < 5000) burst += shift.value;
      else {
        burst = shift.value;
        burstStart = e.startTime;
      }
      lastShift = e.startTime;
      cls = Math.max(cls, burst);
    }
  });
  observe("longtask", (entries) => {
    for (const e of entries) {
      if (!inVisit(e) || !valid(e.duration)) continue;
      taskCount++;
      taskTotal += e.duration;
      taskMax = Math.max(taskMax, e.duration);
      tasks.push({ at: origin + e.startTime, duration_ms: e.duration });
    }
    // Keep the most expensive tasks, while counters cover all observed entries.
    tasks.sort((a, b) => b.duration_ms - a.duration_ms || a.at - b.at);
    tasks = tasks.slice(0, 50);
  });
  function drain() {
    for (const item of observers) {
      const entries = item.observer.takeRecords();
      if (entries.length > 1000) gaps.add("performance_entry_limit");
      item.consume(entries.slice(0, 1000));
    }
  }
  function snapshot(final = false) {
    drain();
    const nav = performance.getEntriesByType("navigation")[0] as
      | (PerformanceNavigationTiming & { activationStart?: number })
      | undefined;
    const prerendered =
      (nav?.activationStart ?? 0) > 0 ||
      !!(document as Document & { prerendering?: boolean }).prerendering;
    const metric = (value: number | undefined, type: string, dynamic = false, paint = false) => {
      const reasons: string[] = [];
      let state = dynamic && !ended && !final ? "provisional" : "available";
      if (!supported.has(type)) {
        state = "unsupported";
        value = undefined;
        reasons.push("api_unsupported");
      } else if (restored && type !== "longtask" && type !== "layout-shift") {
        state = "unsupported";
        reasons.push("back_forward_cache");
        value = undefined;
      } else if (prerendered && type !== "longtask") {
        state = "unsupported";
        reasons.push("prerendered_page");
        value = undefined;
      } else if (paint && initiallyHidden) {
        state = "unavailable";
        reasons.push("initially_hidden");
        value = undefined;
      } else if (value === undefined) {
        state = "unavailable";
        reasons.push(ended || final ? "not_observed" : "not_observed_yet");
      } else if ((!early && type !== "navigation") || gaps.size) {
        state = "partial";
        if (!early) reasons.push("started_late");
        reasons.push(...gaps);
      }
      if (stopped && dynamic && state === "available") {
        state = "partial";
        reasons.push("capture_stopped_before_final");
      }
      return { ...(valid(value) ? { value } : {}), state, reasons };
    };
    const navigation = (value?: number) =>
      metric(value && value > 0 ? value : undefined, "navigation");
    return {
      document_key: `${origin}:${visit}`,
      time_origin: origin,
      started_at: origin + since,
      observed_at: Date.now(),
      url: location.href,
      navigation: restored ? "back_forward_cache" : (nav?.type ?? "unknown"),
      state: ended || final ? "completed" : "capturing",
      early,
      scope: "main_frame",
      visibility,
      visibility_truncated: gaps.has("visibility_history_limit"),
      metrics: {
        ttfb_ms: navigation(nav?.responseStart),
        dom_content_loaded_ms: navigation(nav?.domContentLoadedEventEnd),
        load_ms: navigation(nav?.loadEventEnd),
        fcp_ms: metric(fcp, "paint", false, true),
        lcp_ms: metric(lcp, "largest-contentful-paint", !lcpClosed, true),
        cls: metric(cls, "layout-shift", true),
        long_task_count: metric(taskCount, "longtask"),
        long_task_total_ms: metric(taskTotal, "longtask"),
        long_task_max_ms: metric(taskMax, "longtask"),
      },
      long_tasks: tasks,
      long_tasks_truncated: taskCount > tasks.length,
      coverage: [
        ...new Set([
          "main_frame_only",
          ...(!early ? ["started_late", "visibility_before_capture_unknown"] : []),
          ...gaps,
        ]),
      ],
    };
  }
  function send(final = false) {
    if (disposed) return;
    clearTimeout(timer);
    timer = undefined;
    emit(snapshot(final));
  }
  document.addEventListener(
    "visibilitychange",
    () => {
      if (visibility.length < 64)
        visibility.push({ at: Date.now(), state: document.visibilityState });
      else gaps.add("visibility_history_limit");
      if (document.visibilityState === "hidden") {
        firstHidden = Math.min(firstHidden, performance.now());
        lcpClosed = true;
      }
      send();
    },
    { signal: abort.signal },
  );
  for (const type of ["pointerdown", "keydown", "scroll"])
    document.addEventListener(
      type,
      () => {
        if (!lcpClosed) {
          lcpClosed = true;
          send();
        }
      },
      { capture: true, passive: true, signal: abort.signal },
    );
  window.addEventListener("load", schedule, { signal: abort.signal });
  document.addEventListener("DOMContentLoaded", schedule, { signal: abort.signal });
  window.addEventListener(
    "pagehide",
    () => {
      send(true);
      ended = true;
    },
    { signal: abort.signal },
  );
  window.addEventListener(
    "pageshow",
    (event) => {
      if (!event.persisted) return;
      visit++;
      since = performance.now();
      restored = true;
      early = true;
      ended = false;
      stopped = false;
      fcp = lcp = undefined;
      cls = burst = burstStart = taskCount = taskTotal = taskMax = 0;
      lastShift = -Infinity;
      tasks = [];
      gaps.clear();
      lcpClosed = false;
      initiallyHidden = document.visibilityState !== "visible";
      firstHidden = initiallyHidden ? 0 : Infinity;
      visibility = [{ at: origin + since, state: document.visibilityState }];
      send();
    },
    { signal: abort.signal },
  );
  send();
  return {
    snapshot,
    finish: () => {
      clearTimeout(timer);
      timer = undefined;
      stopped = true;
      const value = snapshot();
      value.state = "completed";
      ended = true;
      for (const item of Object.values(value.metrics))
        if (item.state === "provisional") {
          item.state = "partial";
          item.reasons.push("capture_stopped_before_final");
        }
      return value;
    },
    dispose: () => {
      disposed = true;
      abort.abort();
      clearTimeout(timer);
      for (const item of observers) item.observer.disconnect();
    },
  };
}
