import { i18n } from "@browser-skill/i18n";
import { I18nextProvider } from "@browser-skill/i18n/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordOverlay } from "../RecordOverlay";

function renderOverlay(request: { id: string; startedAtMs?: number; onFinish: () => void } | null) {
  return render(
    createElement(I18nextProvider, { i18n }, createElement(RecordOverlay, { request })),
  );
}

function advanceRecording(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("RecordOverlay", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the bottom pill with the icon-only finish button", () => {
    const onFinish = vi.fn();
    const { container } = renderOverlay({ id: "rec-1", onFinish });

    const pill = container.querySelector("[data-slot='record-overlay-pill']");
    expect(pill).toBeTruthy();
    expect((pill as HTMLElement).style.borderRadius).toBe("9999px");
    expect((pill as HTMLElement).style.backgroundColor).toBe("#fff");
    expect((pill as HTMLElement).style.gap).toBe("5px");
    expect((pill as HTMLElement).style.padding).toBe("6px 8px 6px 16px");
    expect((pill as HTMLElement).style.height).toBe("50px");
    expect((pill as HTMLElement).style.boxSizing).toBe("border-box");
    expect(container.querySelector("[data-slot='record-overlay-collapse']")).toBeNull();

    const status = container.querySelector("[data-slot='record-overlay-status']") as HTMLElement;
    expect(status.style.minHeight).toBe("32px");
    const finish = screen.getByRole("button", {
      name: i18n.t("recordOverlay.finish", { ns: "extension" }),
    });
    expect(finish).toBeTruthy();
    expect(finish.textContent).toBe("");
    const icon = finish.querySelector("img");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("src")).toContain("record-icon.png");
    expect((finish as HTMLElement).style.width).toBe("32px");
    expect((finish as HTMLElement).style.height).toBe("32px");
    expect(icon?.getAttribute("width")).toBe("24");
    expect(icon?.getAttribute("height")).toBe("24");
    expect((finish as HTMLElement).style.borderRadius).toBe("9999px");

    fireEvent.click(finish);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("shows a pulsing recording indicator and no full-screen glow layer", () => {
    const { container } = renderOverlay({ id: "rec-1", onFinish: vi.fn() });
    expect(container.querySelector("[data-slot='record-overlay']")).toBeNull();

    const indicator = container.querySelector("[data-slot='record-overlay-indicator']");
    expect(indicator).toBeTruthy();
    expect((indicator as HTMLElement).style.animation).toContain("bsk-rec-pulse");
  });

  it("shows the recording message for ten seconds, then displays elapsed time", () => {
    vi.useFakeTimers();
    const { container } = renderOverlay({ id: "rec-1", onFinish: vi.fn() });
    const pill = container.querySelector("[data-slot='record-overlay-pill']") as HTMLElement;
    const label = container.querySelector("[data-slot='record-overlay-label']") as HTMLElement;

    expect(pill.dataset.phase).toBe("intro");
    expect(label.textContent).toBe(i18n.t("recordOverlay.recording", { ns: "extension" }));

    advanceRecording(9999);
    expect(pill.dataset.phase).toBe("intro");

    advanceRecording(1);
    expect(pill.dataset.phase).toBe("timer");
    expect(label.textContent).toBe("00:10");
  });

  it("formats elapsed time as zero-padded minutes and seconds", () => {
    vi.useFakeTimers();
    const { container } = renderOverlay({ id: "rec-1", onFinish: vi.fn() });
    const label = container.querySelector("[data-slot='record-overlay-label']") as HTMLElement;

    advanceRecording(125_000);
    expect(label.textContent).toBe("02:05");
  });

  it("keeps a fixed timer label width with tabular numerals", () => {
    vi.useFakeTimers();
    const { container } = renderOverlay({ id: "rec-1", onFinish: vi.fn() });
    const label = container.querySelector("[data-slot='record-overlay-label']") as HTMLElement;

    advanceRecording(10_000);
    expect(label.style.width).toBe("48px");
    expect(label.style.maxWidth).toBe("48px");
    expect(label.style.fontVariantNumeric).toBe("tabular-nums");
    expect(label.style.textAlign).toBe("center");

    advanceRecording(1_000);
    expect(label.textContent).toBe("00:11");
    expect(label.style.width).toBe("48px");
  });

  it("resets the intro and elapsed time for a new request", () => {
    vi.useFakeTimers();
    const first = { id: "rec-1", onFinish: vi.fn() };
    const second = { id: "rec-2", onFinish: vi.fn() };
    const { container, rerender } = renderOverlay(first);

    advanceRecording(65_000);
    rerender(
      createElement(I18nextProvider, { i18n }, createElement(RecordOverlay, { request: second })),
    );

    const pill = container.querySelector("[data-slot='record-overlay-pill']") as HTMLElement;
    const label = container.querySelector("[data-slot='record-overlay-label']") as HTMLElement;
    expect(pill.dataset.phase).toBe("intro");
    expect(label.textContent).toBe(i18n.t("recordOverlay.recording", { ns: "extension" }));

    advanceRecording(10_000);
    expect(pill.dataset.phase).toBe("timer");
    expect(label.textContent).toBe("00:10");
  });

  it("continues the session timer when the overlay remounts on a new page", () => {
    vi.useFakeTimers();
    const startedAtMs = Date.now() - 65_000;
    const { container } = renderOverlay({ id: "rec-1", startedAtMs, onFinish: vi.fn() });

    const pill = container.querySelector("[data-slot='record-overlay-pill']") as HTMLElement;
    const label = container.querySelector("[data-slot='record-overlay-label']") as HTMLElement;
    expect(pill.dataset.phase).toBe("timer");
    expect(label.textContent).toBe("01:05");

    advanceRecording(5_000);
    expect(label.textContent).toBe("01:10");
  });

  it("does not start drag when pointer down on finish", () => {
    const { container } = renderOverlay({ id: "rec-1", onFinish: vi.fn() });
    const pill = container.querySelector("[data-slot='record-overlay-pill']") as HTMLElement;
    const finish = container.querySelector("[data-slot='record-overlay-finish']") as HTMLElement;

    fireEvent.pointerDown(finish, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    expect(pill.getAttribute("data-dragging")).toBe("false");
  });

  it("moves the pill when dragging the non-button area without toggling collapse", () => {
    const { container } = renderOverlay({ id: "rec-1", onFinish: vi.fn() });
    const pill = container.querySelector("[data-slot='record-overlay-pill']") as HTMLElement;

    pill.getBoundingClientRect = () =>
      ({
        top: 600,
        left: 200,
        width: 320,
        height: 48,
        right: 520,
        bottom: 648,
      }) as DOMRect;
    Object.defineProperty(pill, "offsetWidth", { value: 320, configurable: true });
    Object.defineProperty(pill, "offsetHeight", { value: 48, configurable: true });

    fireEvent.pointerDown(pill, { button: 0, clientX: 300, clientY: 620, pointerId: 1 });
    fireEvent(window, new PointerEvent("pointermove", { clientX: 360, clientY: 580 }));
    fireEvent(window, new PointerEvent("pointerup", { pointerId: 1 }));

    expect(pill.getAttribute("data-phase")).toBe("intro");
    expect(pill.style.left).toBe("260px");
    expect(pill.style.top).toBe("560px");
    expect(pill.style.bottom).toBe("auto");
    expect(pill.style.transform).toBe("none");
  });
});
