import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotInfo } from "@/lib/connection-controller";
import { EXTENSION_VERSION } from "@/transport/handshake";
import { App } from "./App";
import { useConnectionState } from "./use-connection-state";

vi.mock("./use-connection-state", () => ({
  useConnectionState: vi.fn(),
}));

const mockUseConnectionState = vi.mocked(useConnectionState);

/** Arbitrary peer fixture — only used to distinguish daemon vs extension in the UI. */
const mockDaemonVersion = "daemon-fixture";

const baseSnapshot: SnapshotInfo = {
  state: "disconnected",
  instanceId: "",
  label: "",
  extensionVersion: EXTENSION_VERSION,
  handshake: null,
  lastError: null,
  connectionEnabled: true,
};

describe("App", () => {
  const setLabel = vi.fn();
  const setConnectionEnabled = vi.fn();

  beforeEach(() => {
    mockUseConnectionState.mockReturnValue({
      snapshot: baseSnapshot,
      statusState: "disconnected",
      setLabel,
      setConnectionEnabled,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows status label without helper subtitle", () => {
    render(<App />);

    expect(screen.getByText("未连接")).toBeTruthy();
    expect(screen.queryByText("请先打开 BrowserSkill。")).toBeNull();
  });

  it("uses flex gap for label field spacing", () => {
    const { container } = render(<App />);

    const labelField = container.querySelector("[data-slot='popup-label-field']");
    expect(labelField?.className).toContain("flex");
    expect(labelField?.className).toContain("flex-col");
    expect(labelField?.className).toContain("gap-3");
  });

  it("shows single-line compact metadata and copies the instance id", async () => {
    mockUseConnectionState.mockReturnValue({
      snapshot: {
        ...baseSnapshot,
        state: "connected",
        instanceId: "03c3e47f",
        label: "个人 Chrome",
        handshake: {
          server: "bh",
          version: mockDaemonVersion,
          protocol_version: "1.0",
        },
      },
      statusState: "connected",
      setLabel,
      setConnectionEnabled,
    });

    render(<App />);

    expect(screen.queryByText(/^扩展 v/)).toBeNull();
    expect(screen.queryByText(/^daemon v/)).toBeNull();
    expect(screen.getByTitle("扩展版本").textContent).toBe(EXTENSION_VERSION);
    expect(screen.getByTitle("bsk 版本").textContent).toBe(mockDaemonVersion);
    expect(screen.getByText("03c3e47f")).toBeTruthy();

    const copyButton = screen.getByRole("button", { name: "复制实例 ID" });
    expect(copyButton.textContent).toBe("");

    fireEvent.click(copyButton);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("03c3e47f");
    await waitFor(() => expect(copyButton.getAttribute("title")).toBe("已复制"));
  });

  it("renders the connection toggle with switch semantics", () => {
    render(<App />);

    const toggle = screen.getByRole("switch", { name: "BrowserSkill 连接" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("calls setConnectionEnabled(false) when the toggle is turned off", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("switch", { name: "BrowserSkill 连接" }));
    expect(setConnectionEnabled).toHaveBeenCalledWith(false);
  });

  it("shows disabled status when connection is turned off", () => {
    mockUseConnectionState.mockReturnValue({
      snapshot: { ...baseSnapshot, connectionEnabled: false },
      statusState: "disabled",
      setLabel,
      setConnectionEnabled,
    });

    render(<App />);

    expect(screen.getByText("连接已关闭")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "BrowserSkill 连接" }).getAttribute("aria-checked"),
    ).toBe("false");
  });
});
