import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BorrowConfirmationOverlay } from "../BorrowConfirmationOverlay";

describe("BorrowConfirmationOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("auto-allows after countdown reaches zero and progress transition ends", async () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();

    const { container } = render(
      <BorrowConfirmationOverlay
        requests={[
          {
            id: "req-1",
            isActiveTab: true,
            tabTitle: "Example",
            timeoutMs: 5000,
            onAllow,
            onDeny,
          },
        ]}
      />,
    );

    expect(screen.getByText("允许借用标签页？")).toBeTruthy();
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(screen.getByText("0 秒后自动允许")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const progressCircle = container.querySelectorAll("svg circle")[1];
    expect(progressCircle).toBeTruthy();
    await act(() => {
      const event = new TransitionEvent("transitionend", { bubbles: true });
      Object.defineProperty(event, "propertyName", {
        value: "stroke-dashoffset",
        configurable: true,
      });
      progressCircle!.dispatchEvent(event);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("only invokes onDeny once when deny is clicked repeatedly", async () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();

    render(
      <BorrowConfirmationOverlay
        requests={[
          {
            id: "req-2",
            isActiveTab: true,
            tabTitle: "Active Tab",
            timeoutMs: 60_000,
            onAllow,
            onDeny,
          },
        ]}
      />,
    );

    const denyButton = screen.getByRole("button", { name: "拒绝" });
    denyButton.click();
    denyButton.click();
    await vi.advanceTimersByTimeAsync(150);
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onAllow).not.toHaveBeenCalled();
  });
});
