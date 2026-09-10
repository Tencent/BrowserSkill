import { type CaptureError, type PageMetrics, type PageRequest, ScreenshotError } from "./types";

export function createPageCapture(onCancel: (id: string) => void) {
  let task: ReturnType<typeof prepare> | undefined;

  function prepare(id: string, label: string, cancelLabel: string) {
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
    let bottomOverlayHeight = 0;

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
      for (const element of document.querySelectorAll("*")) {
        if (
          element === host ||
          seen.has(element) ||
          !(element instanceof HTMLElement || element instanceof SVGElement)
        )
          continue;
        seen.add(element);
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
    }

    function finish() {
      if (finished) return;
      finished = true;
      controller.abort();
      clearTimeout(watchdog);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("wheel", cancel, true);
      window.removeEventListener("touchstart", cancel, true);
      window.removeEventListener("pagehide", cancel);
      document.removeEventListener("visibilitychange", visibilityChanged);
      host.remove();
      for (const restore of changes.reverse()) restore();
      for (const element of originallyUnstyled) {
        if (element.getAttribute("style") === "") element.removeAttribute("style");
      }
      window.scrollTo({ left: original.x, top: original.y, behavior: "instant" });
      style.remove();
    }

    function cancel() {
      finish();
      onCancel(id);
    }
    function keydown(event: KeyboardEvent) {
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
      if (document.hidden) cancel();
    }
    button.addEventListener("click", cancel);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("wheel", cancel, { capture: true, passive: true });
    window.addEventListener("touchstart", cancel, { capture: true, passive: true });
    window.addEventListener("pagehide", cancel);
    document.addEventListener("visibilitychange", visibilityChanged);

    function touch() {
      clearTimeout(watchdog);
      watchdog = setTimeout(cancel, 15_000);
    }
    touch();

    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        controller.signal.throwIfAborted();
        const abort = () => {
          clearTimeout(timer);
          reject(new ScreenshotError("interrupted"));
        };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", abort);
          resolve();
        }, ms);
        controller.signal.addEventListener("abort", abort, { once: true });
      });

    async function move(y: number, capture: boolean) {
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
      if (capture) {
        normalize();
        const metrics = measure();
        bottomOverlayHeight = 0;
        for (const item of fixed) {
          const show = item.atTop
            ? metrics.y < 0.5
            : metrics.y + metrics.viewportHeight >= metrics.height - 0.5;
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
      return measure();
    }

    return {
      id,
      finish,
      move,
      touch,
      signal: controller.signal,
      get bottomOverlayHeight() {
        return bottomOverlayHeight;
      },
    };
  }

  function measure(): PageMetrics {
    const root = document.documentElement;
    const scrolling = document.scrollingElement ?? root;
    return {
      x: window.scrollX,
      y: window.scrollY,
      width: scrolling.scrollWidth,
      height: Math.max(scrolling.scrollHeight, root.clientHeight),
      viewportWidth: root.clientWidth,
      viewportHeight: root.clientHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      bottomOverlayHeight: task?.bottomOverlayHeight ?? 0,
    };
  }

  return {
    async handle(request: PageRequest): Promise<PageMetrics> {
      if (request.action === "begin") {
        if (task && !task.signal.aborted) throw new ScreenshotError("busy");
        task = prepare(request.id, request.label, request.cancelLabel);
        return measure();
      }
      if (!task || task.id !== request.id) throw new ScreenshotError("interrupted");
      if (request.action === "finish") {
        task.finish();
        task = undefined;
        return measure();
      }
      task.signal.throwIfAborted();
      task.touch();
      if (request.action === "move") return task.move(request.y, request.capture);
      return measure();
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
