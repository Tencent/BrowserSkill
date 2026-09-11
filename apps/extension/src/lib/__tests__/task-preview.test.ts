import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import { captureTaskPreview } from "../task-preview";

vi.mock("@/lib/capture-suppress-bridge", () => ({
  withExtensionOverlayHidden: (_tab: number, run: () => unknown) => run(),
}));
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const task = { activeTabId: 5, agentCreatedTabs: new Set([5]), borrowedTabs: new Map() };
  const manager = { get: () => task } as unknown as SessionManager;
  const cdp = {
    trackSessionTab: vi.fn(),
    ensureAttached: vi.fn(async () => {}),
    send: vi.fn(async (_tab, method) =>
      method === "Page.getLayoutMetrics"
        ? { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 } }
        : { data: btoa("jpeg") },
    ),
  } as unknown as ChromiumCdp;
  const draw = vi.fn();
  const close = vi.fn();
  const sizes: number[] = [];
  vi.stubGlobal("chrome", {
    tabs: { get: vi.fn(async () => ({ id: 5, windowId: 10, title: "task" })) },
  });
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1280, height: 720, close })),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
        sizes.push(w, h);
      }
      getContext() {
        return { drawImage: draw };
      }
      async convertToBlob() {
        return new Blob(["thumbnail"]);
      }
    },
  );
  return { task, manager, cdp, sizes, close };
}
describe("independent task preview", () => {
  it("coalesces captures and bounds the physical bitmap on HiDPI screens", async () => {
    const f = fixture();
    const first = captureTaskPreview(f.manager, f.cdp, "one");
    expect(captureTaskPreview(f.manager, f.cdp, "one")).toBe(first);
    const frame = await first;
    expect(frame).toMatchObject({ tab_id: 5, format: "jpeg", image_base64: btoa("thumbnail") });
    expect(f.sizes).toEqual([640, 360]);
    expect(f.close).toHaveBeenCalled();
    expect(f.cdp.send).toHaveBeenCalledWith(5, "Page.captureScreenshot", expect.anything());
  });
  it("does not capture an unowned active user tab", async () => {
    const f = fixture();
    f.task.agentCreatedTabs.clear();
    await expect(captureTaskPreview(f.manager, f.cdp, "empty")).rejects.toThrow(
      "Task tab unavailable",
    );
    expect(f.cdp.send).not.toHaveBeenCalled();
  });
  it("discards the result if authorization ends during capture", async () => {
    const f = fixture();
    vi.mocked(f.cdp.ensureAttached).mockImplementation(async () => {
      f.task.agentCreatedTabs.clear();
    });
    await expect(captureTaskPreview(f.manager, f.cdp, "ended")).rejects.toThrow(
      "Task ended during capture",
    );
  });
});
