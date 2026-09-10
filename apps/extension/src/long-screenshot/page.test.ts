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
});
