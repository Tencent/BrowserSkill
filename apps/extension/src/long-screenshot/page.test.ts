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
    expect(cancel).toHaveBeenCalledExactlyOnceWith("one");
    expect(document.querySelector("header")!.style.position).toBe("sticky");
    expect(window.scrollY).toBe(350);
  });

  it("restores automatically when the background disappears", async () => {
    await send({ action: "begin", label: "Capture", cancelLabel: "Cancel" });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("one");
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
});
