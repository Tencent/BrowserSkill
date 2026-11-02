import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CaptureState, LONG_SCREENSHOT, LONG_SCREENSHOT_STATE } from "@/long-screenshot/types";
import { LongScreenshot } from "./long-screenshot";

const state: CaptureState = {
  id: "shot",
  tabId: 4,
  title: "Example",
  phase: "capturing",
  progress: 35,
  frames: 2,
};
let listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
const sendMessage = vi.fn();

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue({ ok: true, state: null });
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    storage: {
      onChanged: {
        addListener: vi.fn((fn) => {
          listener = fn;
        }),
        removeListener: vi.fn(),
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("long screenshot quick action", () => {
  it("starts directly without a daemon or Agent session", async () => {
    render(<LongScreenshot />);
    const button = screen.getByRole("button", { name: "开始截图" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    sendMessage.mockResolvedValueOnce({ ok: true, state });
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("35"),
    );
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: LONG_SCREENSHOT,
      action: "start",
      mode: "auto",
    });
  });

  it("reconnects to an ongoing capture and offers cancellation", async () => {
    sendMessage.mockResolvedValue({ ok: true, state });
    render(<LongScreenshot />);
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenLastCalledWith({
        type: LONG_SCREENSHOT,
        action: "cancel",
        id: "shot",
      }),
    );
    listener(
      { [LONG_SCREENSHOT_STATE]: { newValue: { ...state, phase: "cancelled" } } },
      "session",
    );
    expect(await screen.findByText("截图已取消，页面位置已恢复。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始截图" })).toBeTruthy();
  });

  it("keeps the result preview accessible after a popup is reopened", async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      state: { ...state, phase: "complete", width: 1600, height: 5200 },
    });
    render(<LongScreenshot />);
    fireEvent.click(await screen.findByRole("button", { name: "打开预览" }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenLastCalledWith({
        type: LONG_SCREENSHOT,
        action: "preview",
        id: "shot",
      }),
    );
    expect(screen.getByText("1600 × 5200 px")).toBeTruthy();
  });

  it("shows an actionable error and re-enables start", async () => {
    render(<LongScreenshot />);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "开始截图" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    sendMessage.mockResolvedValueOnce({ ok: false, error: "unsupported" });
    fireEvent.click(screen.getByRole("button", { name: "开始截图" }));
    expect((await screen.findByRole("alert")).textContent).toContain("我来滚动");
    expect((screen.getByRole("button", { name: "开始截图" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("explains automatic scrolling failure and starts manual mode only on request", async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      state: { ...state, mode: "auto", phase: "error", error: "autoUnavailable" },
    });
    render(<LongScreenshot />);
    expect((await screen.findByRole("alert")).textContent).toContain("未能启动自动滚动");
    expect(screen.queryByText(/手动滚动模式：/)).toBeNull();
    expect(sendMessage).toHaveBeenCalledOnce();
    sendMessage.mockResolvedValueOnce({ ok: true, state: { ...state, mode: "manual" } });
    fireEvent.click(screen.getByRole("button", { name: "改用手动滚动" }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenLastCalledWith({
        type: LONG_SCREENSHOT,
        action: "start",
        mode: "manual",
      }),
    );
    expect(await screen.findByText(/手动滚动模式：/)).toBeTruthy();
  });
});
