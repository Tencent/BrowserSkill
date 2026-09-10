import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotInfo } from "@/lib/connection-controller";
import { STORAGE_KEYS } from "@/lib/instance-id";
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

function openRecordView() {
  fireEvent.click(screen.getByRole("button", { name: "快捷功能" }));
  fireEvent.click(screen.getByRole("button", { name: /操作录制/ }));
}

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

  it("does not render record UI on the main view", () => {
    render(<App />);

    expect(screen.queryByRole("button", { name: "复制录制指令" })).toBeNull();
    expect(screen.queryByRole("button", { name: "操作录制" })).toBeNull();
  });

  it("opens the feature list from the launcher and navigates to record", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "快捷功能" }));

    expect(screen.getByText("操作录制")).toBeTruthy();
    expect(screen.getByText("录制你的操作，供 Agent 参考")).toBeTruthy();
    expect(screen.queryByText("未连接")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /操作录制/ }));

    expect(screen.getByRole("button", { name: "复制录制指令" })).toBeTruthy();
  });

  it("returns from the feature list to the main view", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "快捷功能" }));
    fireEvent.click(screen.getByRole("button", { name: "返回" }));

    expect(screen.getByText("未连接")).toBeTruthy();
    expect(screen.queryByText("录制你的操作，供 Agent 参考")).toBeNull();
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
    expect(screen.getByTitle("扩展版本").textContent).toBe(`Ext ${EXTENSION_VERSION}`);
    expect(screen.getByTitle("bsk 版本").textContent).toBe(`CLI ${mockDaemonVersion}`);
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

  it("copies the record prompt with instance id and --browser when connected", async () => {
    mockUseConnectionState.mockReturnValue({
      snapshot: {
        ...baseSnapshot,
        state: "connected",
        instanceId: "03c3e47f",
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
    openRecordView();

    fireEvent.change(screen.getByPlaceholderText("例如：发布一篇文章"), {
      target: { value: "发布 wiki 文档" },
    });

    const copyButton = screen.getByRole("button", { name: "复制录制指令" });
    expect(copyButton.getAttribute("disabled")).toBeNull();

    fireEvent.click(copyButton);

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] ?? "";
    expect(copied).toContain("03c3e47f");
    expect(copied).toContain("--browser 03c3e47f");
    expect(copied).toContain('--purpose "发布 wiki 文档"');
    expect(copied).not.toMatch(/bsk record start[^\n]*--url/);
    expect(copied).toContain("./trace");
    expect(copied).toContain("trace.json");
    expect(copied).toContain("states/");
    // Button label stays static; a transient toast confirms the copy.
    expect(copyButton.textContent).toContain("复制录制指令");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已复制"));
  });

  it("includes --url in record prompt when a start URL is provided", async () => {
    mockUseConnectionState.mockReturnValue({
      snapshot: {
        ...baseSnapshot,
        state: "connected",
        instanceId: "03c3e47f",
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
    openRecordView();

    fireEvent.change(screen.getByPlaceholderText("https://…"), {
      target: { value: "https://example.com/" },
    });

    fireEvent.click(screen.getByRole("button", { name: "复制录制指令" }));

    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] ?? "";
    expect(copied).toContain("--url https://example.com/");
    expect(copied).not.toContain("--purpose");
  });

  it("disables record copy when disconnected", () => {
    render(<App />);
    openRecordView();

    const copyButton = screen.getByRole("button", { name: "复制录制指令" });
    expect(copyButton.getAttribute("disabled")).not.toBeNull();
    expect(screen.getByText("连接后可用")).toBeTruthy();
  });

  it("treats protocol drift as still connected and prompts an upgrade", async () => {
    mockUseConnectionState.mockReturnValue({
      snapshot: {
        ...baseSnapshot,
        state: "version_skew",
        instanceId: "03c3e47f",
        handshake: {
          server: "bh",
          version: mockDaemonVersion,
          protocol_version: "1.0",
        },
      },
      statusState: "version_skew",
      setLabel,
      setConnectionEnabled,
    });

    render(<App />);

    expect(screen.getByText("已连接")).toBeTruthy();
    expect(screen.getByText("可升级")).toBeTruthy();
    expect(screen.queryByText("协议不一致")).toBeNull();
    expect(screen.queryByText("Action needed")).toBeNull();
    expect(screen.queryByText("兼容")).toBeNull();
    const warning = screen.getByText(/协议版本不同，请及时升级/);
    expect(warning.textContent).toContain("CLI 协议");
    expect(warning.textContent).toContain("扩展协议");

    openRecordView();
    const copyButton = screen.getByRole("button", { name: "复制录制指令" });
    expect(copyButton.getAttribute("disabled")).toBeNull();
    fireEvent.click(copyButton);
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
  });
});

describe("control hints toggle", () => {
  function stubChromeStorage(initial: Record<string, unknown> = {}) {
    const store = { ...initial };
    vi.stubGlobal("chrome", {
      runtime: { lastError: undefined },
      storage: {
        local: {
          get: (keys: string | string[], cb: (items: Record<string, unknown>) => void) => {
            const items: Record<string, unknown> = {};
            for (const k of Array.isArray(keys) ? keys : [keys]) {
              if (k in store) items[k] = store[k];
            }
            cb(items);
          },
          set: (items: Record<string, unknown>, cb?: () => void) => {
            Object.assign(store, items);
            cb?.();
          },
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    });
    return store;
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the control hints toggle on when no preference is stored", async () => {
    stubChromeStorage();

    render(<App />);

    const toggle = await screen.findByRole("switch", { name: "控制提示" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("reflects the stored hidden preference", async () => {
    stubChromeStorage({ [STORAGE_KEYS.CONTROL_HINTS_HIDDEN]: true });

    render(<App />);

    const toggle = await screen.findByRole("switch", { name: "控制提示" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });

  it("persists the hidden preference when the toggle is turned off", async () => {
    const store = stubChromeStorage();

    render(<App />);

    const toggle = await screen.findByRole("switch", { name: "控制提示" });
    fireEvent.click(toggle);

    expect(store[STORAGE_KEYS.CONTROL_HINTS_HIDDEN]).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps the hint copy in an accessible info tooltip", async () => {
    stubChromeStorage();

    render(<App />);

    const info = await screen.findByRole("button", { name: "控制提示说明" });
    expect(info).toBeTruthy();
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe("Agent 控制页面时显示提示条和橙色闪光。");
    // Hidden until the info button is hovered or focused.
    expect(tooltip.className).toContain("opacity-0");
  });

  it("uses the same switch component and size for both settings rows", async () => {
    stubChromeStorage();

    render(<App />);

    const hintsToggle = await screen.findByRole("switch", { name: "控制提示" });
    const connectionToggle = screen.getByRole("switch", { name: "BrowserSkill 连接" });
    // One shared Switch component, one size — hierarchy comes from copy and
    // the info icon, not control size. Both rows default to checked, so the
    // class strings must be identical.
    expect(hintsToggle.className).toContain("h-5 w-9");
    expect(hintsToggle.className).toBe(connectionToggle.className);
  });
});
