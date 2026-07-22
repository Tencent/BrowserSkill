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

  it("shows a pulsing recording indicator and no full-screen glow layer", () => {
    const { container } = render(<RecordOverlay request={{ id: "rec-1", onFinish: vi.fn() }} />);
    expect(container.querySelector("[data-slot='record-overlay']")).toBeNull();

    const indicator = container.querySelector("[data-slot='record-overlay-indicator']");
    expect(indicator).toBeTruthy();
    expect((indicator as HTMLElement).style.animation).toContain("bsk-rec-pulse");
  });
});
