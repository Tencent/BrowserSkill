import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordOverlay } from "../RecordOverlay";

describe("RecordOverlay", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the bottom pill with orange finish CTA and no logo", () => {
    const onFinish = vi.fn();
    const { container } = render(<RecordOverlay request={{ id: "rec-1", onFinish }} />);

    const pill = container.querySelector("[data-slot='record-overlay-pill']");
    expect(pill).toBeTruthy();
    expect(pill?.querySelector("img")).toBeNull();
    expect((pill as HTMLElement).style.borderRadius).toBe("9999px");
    expect((pill as HTMLElement).style.backgroundColor).toBe("#fff");

    const finish = container.querySelector("[data-slot='record-overlay-finish']");
    expect(finish).toBeTruthy();
    expect((finish as HTMLElement).style.backgroundColor).toBe("#f97316");
    expect((finish as HTMLElement).style.borderRadius).toBe("9999px");

    fireEvent.click(finish!);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("moves the pill by its drag handle", () => {
    const { container } = render(<RecordOverlay request={{ id: "rec-1", onFinish: vi.fn() }} />);
    const pill = container.querySelector("[data-slot='record-overlay-pill']") as HTMLElement;
    const handle = container.querySelector(
      "[data-slot='record-overlay-drag-handle']",
    ) as HTMLElement;
    pill.getBoundingClientRect = () =>
      ({
        top: 500,
        left: 300,
        width: 360,
        height: 54,
        right: 660,
        bottom: 554,
      }) as DOMRect;
    Object.defineProperty(pill, "offsetWidth", { value: 360, configurable: true });
    Object.defineProperty(pill, "offsetHeight", { value: 54, configurable: true });

    fireEvent.pointerDown(handle, { button: 0, clientX: 320, clientY: 520, pointerId: 1 });
    fireEvent(window, new PointerEvent("pointermove", { clientX: 420, clientY: 470 }));
    fireEvent(window, new PointerEvent("pointerup", { pointerId: 1 }));

    expect(pill.style.top).toBe("450px");
    expect(pill.style.left).toBe("400px");
    expect(pill.style.bottom).toBe("auto");
    expect(pill.getAttribute("data-dragging")).toBe("false");
  });

  it("clamps dragging to the viewport", () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    const { container } = render(<RecordOverlay request={{ id: "rec-1", onFinish: vi.fn() }} />);
    const pill = container.querySelector("[data-slot='record-overlay-pill']") as HTMLElement;
    const handle = container.querySelector(
      "[data-slot='record-overlay-drag-handle']",
    ) as HTMLElement;
    pill.getBoundingClientRect = () =>
      ({
        top: 100,
        left: 100,
        width: 300,
        height: 60,
        right: 400,
        bottom: 160,
      }) as DOMRect;
    Object.defineProperty(pill, "offsetWidth", { value: 300, configurable: true });
    Object.defineProperty(pill, "offsetHeight", { value: 60, configurable: true });

    fireEvent.pointerDown(handle, { button: 0, clientX: 110, clientY: 110, pointerId: 1 });
    fireEvent(window, new PointerEvent("pointermove", { clientX: 2000, clientY: 2000 }));
    fireEvent(window, new PointerEvent("pointerup", { pointerId: 1 }));

    expect(pill.style.top).toBe("524px");
    expect(pill.style.left).toBe("484px");
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: originalInnerHeight,
      configurable: true,
    });
  });

  it("keeps the finish button independent from dragging", () => {
    const onFinish = vi.fn();
    const { container } = render(<RecordOverlay request={{ id: "rec-1", onFinish }} />);
    const pill = container.querySelector("[data-slot='record-overlay-pill']") as HTMLElement;
    const finish = container.querySelector("[data-slot='record-overlay-finish']") as HTMLElement;

    fireEvent.pointerDown(finish, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.click(finish);

    expect(pill.getAttribute("data-dragging")).toBe("false");
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("shows a pulsing recording indicator and no full-screen glow layer", () => {
    const { container } = render(<RecordOverlay request={{ id: "rec-1", onFinish: vi.fn() }} />);
    expect(container.querySelector("[data-slot='record-overlay']")).toBeNull();

    const indicator = container.querySelector("[data-slot='record-overlay-indicator']");
    expect(indicator).toBeTruthy();
    expect((indicator as HTMLElement).style.animation).toContain("bsk-rec-pulse");
  });
});
