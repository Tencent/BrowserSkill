import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPageCapture } from "./page";
import { LONG_SCREENSHOT_PAGE, type PageCommand } from "./types";

describe("page capture cleanup", () => {
  let capture: ReturnType<typeof createPageCapture>;
  let cancel: (id: string) => void;
  const send = (command: PageCommand) =>
    capture.handle({ type: LONG_SCREENSHOT_PAGE, id: "one", ...command });
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<header style="position:sticky;top:0;color:red">Heading</header><aside style="position:fixed;top:0">Navigation</aside>';
    Object.defineProperty(document, "images", {
      configurable: true,
      get: () => document.querySelectorAll("img"),
    });
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 2400,
    });
    Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 350 });
    Object.defineProperty(window, "scrollX", { configurable: true, writable: true, value: 12 });
    vi.spyOn(window, "scrollTo").mockImplementation(((value: unknown) => {
      const options = value as ScrollToOptions;
      if (typeof options === "object") {
        Object.defineProperty(window, "scrollY", {
          configurable: true,
          writable: true,
          value: Math.min(1800, options.top ?? 0),
        });
        Object.defineProperty(window, "scrollX", {
          configurable: true,
          writable: true,
          value: options.left ?? 0,
        });
      }
    }) as typeof window.scrollTo);
    cancel = vi.fn();
    capture = createPageCapture(cancel);
  });
  afterEach(() => {
    capture.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("rejects an initially hidden page before changing styles or scroll", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const before = document.documentElement.innerHTML;
    await expect(
      send({ action: "begin", label: "Capture", cancelLabel: "Cancel" }),
    ).rejects.toMatchObject({ code: "interrupted", reason: "page_hidden" });
    expect(document.documentElement.innerHTML).toBe(before);
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("measures fractional CSS viewport dimensions while retaining scrollbar gutters", async () => {
    vi.stubGlobal("innerWidth", 815);
    vi.stubGlobal("innerHeight", 615);
    vi.stubGlobal("visualViewport", { width: 800.4, height: 600.6, scale: 1 });
    expect(await send({ action: "probe" })).toMatchObject({
      viewportWidth: 800.4,
      viewportHeight: 600.6,
      innerWidth: 815.4,
      innerHeight: 615.6,
    });
  });

  it("does not substitute a pinched visual viewport for layout geometry", async () => {
    vi.stubGlobal("innerWidth", 815);
    vi.stubGlobal("innerHeight", 615);
    vi.stubGlobal("visualViewport", { width: 400, height: 300, scale: 2 });
    expect(await send({ action: "probe" })).toMatchObject({
      viewportWidth: 800,
      viewportHeight: 600,
      innerWidth: 815,
      innerHeight: 615,
    });
  });

  it.each([
    "finish",
    "cancel",
    "watchdog",
    "dispose",
    "hidden",
    "navigation",
  ])("restores root scrollbar styles after %s without changing nested scrollbars", async (end) => {
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 600);
    const root = document.documentElement;
    root.style.setProperty("scrollbar-width", "thin", "important");
    const nested = document.createElement("div");
    nested.style.cssText = "overflow:auto;scrollbar-width:thin";
    document.body.append(nested);
    const nestedStyle = nested.getAttribute("style");
    try {
      const before = await send({ action: "probe" });
      expect(await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" })).toEqual(
        before,
      );
      expect(root.style.getPropertyValue("scrollbar-width")).toBe("none");
      if (end === "finish") await send({ action: "finish" });
      else if (end === "cancel")
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      else if (end === "watchdog") await vi.advanceTimersByTimeAsync(15_001);
      else if (end === "hidden") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
      } else if (end === "navigation") window.dispatchEvent(new Event("pagehide"));
      else capture.dispose();
      expect(root.style.getPropertyValue("scrollbar-width")).toBe("thin");
      expect(root.style.getPropertyPriority("scrollbar-width")).toBe("important");
      expect(nested.getAttribute("style")).toBe(nestedStyle);
      expect(window.scrollY).toBe(350);
    } finally {
      capture.dispose();
      root.removeAttribute("style");
    }
  });

  it.each([
    [815, 600],
    [800, 615],
  ])("preserves reserved scrollbar space at %s/%s", async (width, height) => {
    vi.stubGlobal("innerWidth", width);
    vi.stubGlobal("innerHeight", height);
    await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
    expect(document.documentElement.style.getPropertyValue("scrollbar-width")).toBe("");
  });

  it.each([
    undefined,
    "color: red;",
  ])("restores the root style attribute across repeated captures (%s)", async (original) => {
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 600);
    vi.stubGlobal("visualViewport", { width: 800.4, height: 600.6, scale: 1 });
    const root = document.documentElement;
    if (original === undefined) root.removeAttribute("style");
    else root.setAttribute("style", original);
    const beforeStyle = root.getAttribute("style");
    const beforeMetrics = await send({ action: "probe" });
    try {
      for (const initialY of [100, 350]) {
        window.scrollTo({ top: initialY, left: 12 });
        await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
        expect(root.style.getPropertyValue("scrollbar-width")).toBe("none");
        expect(await send({ action: "probe" })).toMatchObject({
          viewportWidth: 800.4,
          viewportHeight: 600.6,
          innerWidth: 800.4,
          innerHeight: 600.6,
        });
        await send({ action: "finish" });
        expect(root.getAttribute("style")).toBe(beforeStyle);
        expect(window.scrollX).toBe(12);
        expect(window.scrollY).toBe(initialY);
        expect(await send({ action: "probe" })).toEqual({ ...beforeMetrics, y: initialY });
      }
    } finally {
      capture.dispose();
      root.removeAttribute("style");
    }
  });

  it("restores each changed CSS property and the original two-dimensional scroll", async () => {
    await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
    const moving = send({ action: "move", y: 800, capture: true });
    await vi.advanceTimersByTimeAsync(2000);
    await moving;
    expect(document.querySelector("header")!.style.position).toBe("relative");
    expect(document.querySelector("aside")!.style.visibility).toBe("hidden");
    // Unrelated changes made by the page must survive cleanup.
    document.querySelector("header")!.style.color = "blue";
    await send({ action: "finish" });
    expect(document.querySelector("header")!.style.position).toBe("sticky");
    expect(document.querySelector("header")!.style.top).toBe("0px");
    expect(document.querySelector("header")!.style.color).toBe("blue");
    expect(document.querySelector("aside")!.style.visibility).toBe("");
    expect(window.scrollTo).toHaveBeenLastCalledWith({ left: 12, top: 350, behavior: "instant" });
    expect(document.documentElement.querySelector(":scope > style")).toBeNull();
  });

  it("allows interaction while paused and restores on resumed user scrolling", async () => {
    await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
    await send({ action: "pause", paused: true });
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 200 }));
    expect(cancel).not.toHaveBeenCalled();
    await expect(send({ action: "inspect" })).resolves.toBeDefined();
    await send({ action: "pause", paused: false });
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 200 }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(window.scrollY).toBe(350);
  });

  it("Escape cancels pending waits and cleanup remains idempotent", async () => {
    await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
    const moving = send({ action: "move", y: 800, capture: true });
    const rejected = expect(moving).rejects.toThrow("interrupted");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await rejected;
    await send({ action: "finish" });
    expect(cancel).toHaveBeenCalledExactlyOnceWith("one", "user_cancelled");
    expect(document.querySelector("header")!.style.position).toBe("sticky");
    expect(window.scrollY).toBe(350);
  });

  it("restores automatically when the background disappears", async () => {
    await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("one", "watchdog_timeout");
    expect(window.scrollY).toBe(350);
    await expect(send({ action: "inspect" })).rejects.toBeDefined();
  });

  it("does not let a stale job finish or move a newer job", async () => {
    await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
    await send({ action: "finish" });
    await capture.handle({
      type: LONG_SCREENSHOT_PAGE,
      id: "two",
      action: "begin",
      label: "Capture",
      cancelLabel: "Cancel",
    });
    await expect(send({ action: "finish" })).rejects.toThrow("interrupted");
    await expect(send({ action: "move", y: 900, capture: true })).rejects.toThrow("interrupted");
  });
  it("waits for loading above a tall footer and a quiet bottom before finalizing", async () => {
    const footer = document.createElement("footer");
    const loader = document.createElement("span");
    loader.textContent = "加载中...";
    document.body.append(loader, footer);
    vi.spyOn(footer, "getBoundingClientRect").mockReturnValue({
      top: -200,
      bottom: 600,
      width: 800,
      height: 800,
    } as DOMRect);
    vi.spyOn(loader, "getBoundingClientRect").mockReturnValue({
      top: -230,
      bottom: -200,
      width: 200,
      height: 30,
    } as DOMRect);
    await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
    const moving = send({ action: "move", y: 1800, capture: true, final: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await moving).toMatchObject({ bottomReady: false, tailStart: 1570 });
    expect(await send({ action: "inspect" })).toMatchObject({ bottomReady: false });
    loader.textContent = "";
    expect(await send({ action: "inspect" })).toMatchObject({ bottomReady: false });
    await vi.advanceTimersByTimeAsync(700);
    expect(await send({ action: "inspect" })).toMatchObject({ bottomReady: true });
  });
  it("does not finalize when the quiet deadline crosses after painting hidden overlays", async () => {
    await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
    const first = send({ action: "move", y: 1800, capture: true });
    await vi.advanceTimersByTimeAsync(400);
    await first;
    await vi.advanceTimersByTimeAsync(1080);
    const pending = send({ action: "move", y: 1800, capture: true, final: true });
    await vi.advanceTimersByTimeAsync(400);
    expect(await pending).toMatchObject({ bottomReady: false });
    expect(await send({ action: "inspect" })).toMatchObject({ bottomReady: true });
    const final = send({ action: "move", y: 1800, capture: true, final: true });
    await vi.advanceTimersByTimeAsync(400);
    expect(await final).toMatchObject({ bottomReady: true });
  });
  it("does not wait indefinitely for a ticking footer with a stable document height", async () => {
    let notify!: (records: { target: Element; addedNodes: Node[] }[]) => void;
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(callback: typeof notify) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const clock = document.createElement("span");
    document.body.append(clock);
    vi.spyOn(clock, "getBoundingClientRect").mockReturnValue({
      top: 500,
      bottom: 520,
      width: 100,
      height: 20,
    } as DOMRect);
    await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
    const first = send({ action: "move", y: 1800, capture: true });
    await vi.advanceTimersByTimeAsync(400);
    await first;
    for (let tick = 0; tick < 18; tick++) {
      clock.textContent = String(tick);
      notify([{ target: clock, addedNodes: [] }]);
      await vi.advanceTimersByTimeAsync(300);
      const metrics = await send({ action: "inspect" });
      if (tick < 14) expect(metrics.bottomReady).toBe(false);
    }
    expect(await send({ action: "inspect" })).toMatchObject({ bottomReady: true });
  });
  it("does not treat article text, code examples or numeric progress widgets as loading", async () => {
    document.body.innerHTML +=
      '<p>Loading files in JavaScript</p><pre><code>Loading...</code></pre><div role="progressbar" aria-valuenow="100"></div>';
    for (const element of document.querySelectorAll("p, code, [role=progressbar]"))
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
        top: 500,
        bottom: 520,
        width: 100,
        height: 20,
      } as DOMRect);
    await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
    const first = send({ action: "move", y: 1800, capture: true });
    await vi.advanceTimersByTimeAsync(2000);
    await first;
    expect(await send({ action: "inspect" })).toMatchObject({ bottomReady: true });
  });
  it("caps begin metrics even when preparation changes the document height", async () => {
    let reads = 0;
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      get: () => (reads++ === 0 ? 2400 : 3400),
    });
    const begin = await send({
      action: "begin",
      scope: "current",
      label: "Capture",
      cancelLabel: "Cancel",
    });
    expect(document.documentElement.scrollHeight).toBe(3400);
    expect(begin.height).toBe(2400);
    expect((await send({ action: "inspect" })).height).toBe(begin.height);
  });
  it("captures the initial range despite appended height and a persistent loader", async () => {
    const loader = document.createElement("span");
    loader.textContent = "加载中...";
    document.body.append(loader);
    vi.spyOn(loader, "getBoundingClientRect").mockReturnValue({
      top: 500,
      bottom: 530,
      width: 100,
      height: 30,
    } as DOMRect);
    const initial = await send({
      action: "begin",
      label: "Capture",
      cancelLabel: "Cancel",
      scope: "current",
    });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: initial.height + 1000,
    });
    const move = send({ action: "move", y: initial.height - 600, capture: true, final: true });
    await vi.advanceTimersByTimeAsync(2500);
    await move;
    expect(await send({ action: "inspect" })).toMatchObject({
      height: initial.height,
      bottomReady: true,
      loading: true,
    });
    await send({ action: "finish" });
    expect(loader.textContent).toBe("加载中...");
  });
  it("distinguishes hiding the page from cancelling by user input", async () => {
    await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cancel).toHaveBeenCalledExactlyOnceWith("one", "page_hidden");
    hidden.mockRestore();
  });
});
