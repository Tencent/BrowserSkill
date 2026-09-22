import {
  type CaptureCancelReason,
  type CaptureError,
  type CaptureScope,
  type PageMetrics,
  type PageRequest,
  ScreenshotError,
} from "./types";

export function createPageCapture(onCancel: (id: string, reason: CaptureCancelReason) => void) {
  let task: ReturnType<typeof prepare> | undefined;

  function prepare(id: string, label: string, cancelLabel: string, scope: CaptureScope = "follow") {
    // The stitcher captures visible viewports; hidden tabs cannot reliably repaint or restore them.
    if (document.hidden) throw new ScreenshotError("interrupted", "page_hidden");
    const limit = scope === "current" ? measure().height : Infinity;
    const controller = new AbortController();
    const original = { x: window.scrollX, y: window.scrollY };
    const changes: (() => void)[] = [];
    const originallyUnstyled = new Set<HTMLElement | SVGElement>();
    const seen = new WeakSet<Element>();
    const fixed: {
      element: HTMLElement | SVGElement;
      atTop: boolean;
      visibility: string;
      priority: string;
    }[] = [];
    const root = document.documentElement;
    // Overlay scrollbars paint over content and survive the tiler's gutter crop.
    // Only suppress them when neither axis reserves space: removing a classic
    // scrollbar would change wrapping and responsive layout during capture.
    if (root.clientWidth === window.innerWidth && root.clientHeight === window.innerHeight)
      setStyle(root, "scrollbar-width", "none");
    const style = document.createElement("style");
    style.textContent = `
      html, body, * { scroll-behavior: auto !important; scroll-snap-type: none !important;
        overflow-anchor: none !important; }
      *, *::before, *::after { animation-play-state: paused !important;
        transition: none !important; caret-color: transparent !important; }
      [data-bsk-overlay] { visibility: hidden !important; }
    `;
    document.documentElement.append(style);
    const host = document.createElement("div");
    host.style.cssText =
      "all:initial!important;position:fixed!important;bottom:20px!important;left:20px!important;z-index:2147483647!important;";
    const shadow = host.attachShadow({ mode: "closed" });
    const panel = document.createElement("div");
    panel.style.cssText =
      "display:flex;align-items:center;gap:16px;padding:12px 16px;background:#18181b;color:#fff;border:1px solid #52525b;border-radius:12px;box-shadow:0 6px 24px #0003;font:13px/1.5 system-ui,sans-serif;";
    const text = document.createElement("span");
    text.textContent = label;
    text.setAttribute("role", "status");
    const button = document.createElement("button");
    button.textContent = `${cancelLabel} · Esc`;
    button.style.cssText =
      "border:1px solid #71717a;border-radius:7px;padding:5px 10px;background:transparent;color:#fff;font:inherit;cursor:pointer;";
    panel.append(text, button);
    shadow.append(panel);
    document.documentElement.append(host);
    let watchdog: ReturnType<typeof setTimeout>;
    let finished = false;
    let paused = false;
    let bottomOverlayHeight = 0;
    let bottomSince = performance.now();
    let lastMutation = bottomSince;
    let lastHeight = 0;
    let wasBusy = false;
    const loading = new Set<Element>();
    const footers = new Set<Element>();
    const loadingText =
      /^(?:加载中|正在加载|载入中|loading(?:\s+(?:more|content|items|results))?)[\s.。…!！]*$/i;
    const trackLoading = (element: Element) => {
      if (
        element.matches('[aria-busy="true"], [role="progressbar"], [role="status"]') ||
        (element.childElementCount === 0 &&
          !element.closest("pre, code") &&
          loadingText.test(element.textContent?.trim() ?? ""))
      )
        loading.add(element);
    };
    const pendingRoots = new Set<Element>([document.documentElement]);
    const observer = new MutationObserver((records) => {
      const targets = new Set<Element>();
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) pendingRoots.add(node);
        const element =
          record.target instanceof Element ? record.target : record.target.parentElement;
        if (element) targets.add(element);
      }
      for (const element of targets) {
        if (element === host || element.matches("script, style") || !element.isConnected) continue;
        trackLoading(element);
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          style.position !== "fixed" &&
          style.visibility !== "hidden"
        )
          lastMutation = performance.now();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-busy", "hidden", "class", "src"],
    });

    function setStyle(element: HTMLElement | SVGElement, property: string, value: string) {
      if (!element.hasAttribute("style")) originallyUnstyled.add(element);
      const old = element.style.getPropertyValue(property);
      const priority = element.style.getPropertyPriority(property);
      element.style.setProperty(property, value, "important");
      changes.push(() => {
        if (element.style.getPropertyValue(property) !== value) return;
        if (old) element.style.setProperty(property, old, priority);
        else element.style.removeProperty(property);
      });
    }

    function normalize() {
      const roots = [...pendingRoots];
      pendingRoots.clear();
      for (const root of roots) {
        if (!root.isConnected) continue;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let element: Element | null = root;
        do {
          normalizeElement(element);
          element = walker.nextNode() as Element | null;
        } while (element);
      }
    }
    function normalizeElement(element: Element) {
      if (
        element === host ||
        seen.has(element) ||
        !(element instanceof HTMLElement || element instanceof SVGElement)
      )
        return;
      seen.add(element);
      trackLoading(element);
      if (
        element.getAttribute("role") === "contentinfo" ||
        (element.tagName === "FOOTER" && !element.closest("article, aside, section"))
      )
        footers.add(element);
      const computed = getComputedStyle(element);
      if (computed.position === "sticky") {
        // Relative positioning retains the element's place and size in flow.
        setStyle(element, "position", "relative");
        for (const edge of ["top", "right", "bottom", "left"]) setStyle(element, edge, "auto");
      } else if (computed.position === "fixed" && !element.hasAttribute("data-bsk-overlay")) {
        if (!element.hasAttribute("style")) originallyUnstyled.add(element);
        const visibility = element.style.getPropertyValue("visibility");
        const priority = element.style.getPropertyPriority("visibility");
        fixed.push({
          element,
          atTop: element.getBoundingClientRect().top < window.innerHeight / 2,
          visibility,
          priority,
        });
        changes.push(() => {
          if (element.style.getPropertyValue("visibility") !== "hidden") return;
          if (visibility) element.style.setProperty("visibility", visibility, priority);
          else element.style.removeProperty("visibility");
        });
      }
    }

    function finish() {
      if (finished) return;
      finished = true;
      observer.disconnect();
      pendingRoots.clear();
      loading.clear();
      footers.clear();
      controller.abort();
      clearTimeout(watchdog);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("wheel", interaction, true);
      window.removeEventListener("touchstart", interaction, true);
      window.removeEventListener("pagehide", navigated);
      document.removeEventListener("visibilitychange", visibilityChanged);
      host.remove();
      for (const restore of changes.reverse()) restore();
      for (const element of originallyUnstyled) {
        if (element.getAttribute("style") === "") element.removeAttribute("style");
      }
      window.scrollTo({ left: original.x, top: original.y, behavior: "instant" });
      style.remove();
    }

    function cancel(reason: CaptureCancelReason = "user_cancelled") {
      controller.abort(new ScreenshotError("interrupted", reason));
      finish();
      onCancel(id, reason);
    }
    function interaction() {
      if (!paused) cancel();
    }
    function keydown(event: KeyboardEvent) {
      if (paused && event.key !== "Escape") return;
      if (
        ["Escape", "PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp", " "].includes(
          event.key,
        )
      ) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        cancel();
      }
    }
    function visibilityChanged() {
      if (document.hidden) cancel("page_hidden");
    }
    const navigated = () => cancel("navigation");
    button.addEventListener("click", () => cancel());
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("wheel", interaction, { capture: true, passive: true });
    window.addEventListener("touchstart", interaction, { capture: true, passive: true });
    window.addEventListener("pagehide", navigated);
    document.addEventListener("visibilitychange", visibilityChanged);

    function touch() {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => cancel("watchdog_timeout"), 15_000);
    }
    touch();

    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        controller.signal.throwIfAborted();
        const abort = () => {
          clearTimeout(timer);
          reject(controller.signal.reason ?? new ScreenshotError("interrupted"));
        };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", abort);
          resolve();
        }, ms);
        controller.signal.addEventListener("abort", abort, { once: true });
      });

    function measureRange(): PageMetrics {
      const metrics = measure();
      return { ...metrics, height: Math.min(metrics.height, limit) };
    }

    function inspect(): PageMetrics {
      const metrics = measureRange();
      const atBottom = metrics.y + metrics.viewportHeight >= metrics.height - 0.5;
      const now = performance.now();
      if (!atBottom || metrics.height !== lastHeight) bottomSince = now;
      lastHeight = metrics.height;
      let tailStart = Math.max(0, metrics.height - metrics.viewportHeight);
      for (const element of footers) {
        if (!element.isConnected) {
          footers.delete(element);
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (rect.height && getComputedStyle(element).position !== "fixed")
          tailStart = Math.min(tailStart, Math.max(0, metrics.y + rect.top));
      }
      let busy = false;
      const loadingStart = tailStart - metrics.viewportHeight;
      for (const element of loading) {
        if (!element.isConnected) {
          loading.delete(element);
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || metrics.y + rect.bottom <= loadingStart) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (
          element.getAttribute("aria-busy") === "true" ||
          (element.getAttribute("role") === "progressbar" &&
            !element.hasAttribute("aria-valuenow")) ||
          (!element.closest("pre, code") && loadingText.test(element.textContent?.trim() ?? ""))
        ) {
          busy = true;
          // A loading row can sit above a tall footer, outside the viewport.
          // Its provisional pixels must also be repainted on growth.
          if (rect.height <= metrics.viewportHeight)
            tailStart = Math.min(tailStart, Math.max(0, metrics.y + rect.top));
        }
      }
      if (busy !== wasBusy) lastMutation = now;
      wasBusy = busy;
      return {
        ...metrics,
        tailStart,
        // A clock or live widget can mutate forever without moving any rows.
        // Bound that quiet wait; an actual loading indicator still keeps waiting.
        loading: busy,
        bottomReady:
          atBottom &&
          (scope === "current" || !busy) &&
          now - bottomSince >= 1500 &&
          (now - lastMutation >= 600 || now - bottomSince >= 5000),
      };
    }

    async function move(y: number, capture: boolean, final = false) {
      controller.signal.throwIfAborted();
      touch();
      host.style.setProperty("visibility", "visible", "important");
      normalize();
      window.scrollTo({ left: 0, top: y, behavior: "instant" });
      await wait(capture ? 160 : 300);
      // Give images in this viewport a bounded opportunity to finish loading.
      for (let attempt = 0; attempt < 10; attempt++) {
        const pending = Array.from(document.images).some((img) => {
          const rect = img.getBoundingClientRect();
          return !img.complete && rect.bottom >= 0 && rect.top <= window.innerHeight;
        });
        if (!pending) break;
        await wait(100);
      }
      let before = measure();
      let stable = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        await wait(80);
        const after = measure();
        stable = before.height === after.height && before.y === after.y ? stable + 1 : 0;
        before = after;
        if (stable >= 2) break;
      }
      controller.signal.throwIfAborted();
      let paintedReady = false;
      if (capture) {
        normalize();
        const metrics = inspect();
        paintedReady = metrics.bottomReady === true;
        bottomOverlayHeight = 0;
        for (const item of fixed) {
          const show = item.atTop ? metrics.y < 0.5 : final && metrics.bottomReady;
          if (!show) item.element.style.setProperty("visibility", "hidden", "important");
          else if (item.visibility)
            item.element.style.setProperty("visibility", item.visibility, item.priority);
          else item.element.style.removeProperty("visibility");
          if (show && !item.atTop && getComputedStyle(item.element).visibility !== "hidden") {
            bottomOverlayHeight = Math.max(
              bottomOverlayHeight,
              metrics.viewportHeight - item.element.getBoundingClientRect().top,
            );
          }
        }
        host.style.setProperty("visibility", "hidden", "important");
        // Paint the final visibility changes before the background reads pixels.
        await wait(80);
      }
      const metrics = inspect();
      // Crossing the quiet deadline during the paint wait must not advertise a
      // final frame whose bottom overlays were still hidden before that paint.
      return { ...metrics, bottomReady: metrics.bottomReady && (!capture || paintedReady) };
    }

    return {
      id,
      finish,
      move,
      measure: measureRange,
      inspect,
      touch,
      signal: controller.signal,
      pause(value: boolean) {
        paused = value;
        touch();
        host.style.setProperty("visibility", "visible", "important");
      },
      get bottomOverlayHeight() {
        return bottomOverlayHeight;
      },
    };
  }

  function measure(): PageMetrics {
    const root = document.documentElement;
    const scrolling = document.scrollingElement ?? root;
    // client/inner dimensions are integers. At fractional browser zoom that can
    // lose more than one image pixel; the unpinched visual viewport retains the
    // CSS precision needed to match CDP and native screenshot surfaces.
    const visual = window.visualViewport;
    const viewportWidth = visual?.scale === 1 ? visual.width : root.clientWidth;
    const viewportHeight = visual?.scale === 1 ? visual.height : root.clientHeight;
    return {
      x: window.scrollX,
      y: window.scrollY,
      width: scrolling.scrollWidth,
      height: Math.max(scrolling.scrollHeight, viewportHeight),
      viewportWidth,
      viewportHeight,
      innerWidth: viewportWidth + (window.innerWidth - root.clientWidth),
      innerHeight: viewportHeight + (window.innerHeight - root.clientHeight),
      dpr: window.devicePixelRatio,
      bottomOverlayHeight: task?.bottomOverlayHeight ?? 0,
    };
  }

  return {
    async handle(request: PageRequest): Promise<PageMetrics> {
      if (request.action === "probe") return measure();
      if (request.action === "begin") {
        if (task && !task.signal.aborted) throw new ScreenshotError("busy");
        task = prepare(request.id, request.label, request.cancelLabel, request.scope);
        return task.measure();
      }
      if (!task || task.id !== request.id) throw new ScreenshotError("interrupted");
      if (request.action === "finish") {
        task.finish();
        task = undefined;
        return measure();
      }
      task.signal.throwIfAborted();
      task.touch();
      if (request.action === "pause") task.pause(request.paused);
      if (request.action === "move") return task.move(request.y, request.capture, request.final);
      return task.inspect();
    },
    dispose() {
      task?.finish();
      task = undefined;
    },
  };
}

export function pageError(error: unknown): CaptureError {
  return error instanceof ScreenshotError ? error.code : "interrupted";
}
