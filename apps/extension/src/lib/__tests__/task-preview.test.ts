import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import { captureTaskPreview, withTaskPreviewStop } from "../task-preview";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const task = {
    remote: true,
    agentWindowId: 10,
    refStore: { documentRevision: () => 1 },
    agentCreatedTabs: new Set([5]),
    borrowedTabs: new Map(),
  };
  const manager = { get: () => task } as unknown as SessionManager;
  const cdp = {
    getAttachmentId: vi.fn(() => "attachment"),
    acquireBackgroundExecution: vi.fn(async () => {}),
    send: vi.fn(async () => ({ data: btoa("jpeg") })),
  } as unknown as ChromiumCdp;
  const draw = vi.fn();
  const close = vi.fn();
  const sizes: number[] = [];
  vi.stubGlobal("chrome", {
    tabs: {
      query: vi.fn(async () => [{ id: 5, windowId: 10, active: true }]),
      get: vi.fn(async () => ({ id: 5, windowId: 10, title: "task" })),
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
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

describe("task preview", () => {
  it("keeps the control and help overlays visible across repeated captures", async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      await expect(captureTaskPreview(f.manager, f.cdp, "visible")).resolves.toMatchObject({
        tab_id: 5,
        image_base64: btoa("thumbnail"),
      });
    }
    expect(f.cdp.acquireBackgroundExecution).toHaveBeenCalledWith("visible", 5);
    expect(f.cdp.send).toHaveBeenCalledTimes(3);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("coalesces concurrent polls and bounds the encoded frame on HiDPI screens", async () => {
    const f = fixture();
    const first = captureTaskPreview(f.manager, f.cdp, "one");
    expect(captureTaskPreview(f.manager, f.cdp, "one")).toBe(first);
    expect(await first).toMatchObject({
      tab_id: 5,
      format: "jpeg",
      image_base64: btoa("thumbnail"),
    });
    expect(f.sizes).toEqual([640, 360]);
    expect(f.close).toHaveBeenCalled();
    expect(f.cdp.send).toHaveBeenCalledExactlyOnceWith(5, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 50,
      fromSurface: true,
      captureBeyondViewport: false,
    });
  });

  it("refuses a further poll while Chrome still holds a capture, and recovers after it", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (frame: { data: string }) => void;
    vi.mocked(f.cdp.send).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
    );
    const stuck = expect(captureTaskPreview(f.manager, f.cdp, "stuck")).rejects.toThrow(
      "timed out after 3000ms",
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await stuck;
    await expect(captureTaskPreview(f.manager, f.cdp, "stuck")).rejects.toThrow(
      "still running in Chrome",
    );
    expect(f.cdp.send).toHaveBeenCalledTimes(1);
    finish({ data: btoa("late") });
    await vi.advanceTimersByTimeAsync(0);
    await expect(captureTaskPreview(f.manager, f.cdp, "stuck")).resolves.toMatchObject({
      tab_id: 5,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets session.stop proceed once a stuck capture has timed out", async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.cdp.send).mockReturnValueOnce(new Promise(() => {}) as never);
    const stuck = expect(captureTaskPreview(f.manager, f.cdp, "stop")).rejects.toThrow("timed out");
    const stop = vi.fn(async () => "stopped");
    const released = withTaskPreviewStop(f.manager, "stop", stop);
    await expect(captureTaskPreview(f.manager, f.cdp, "stop")).rejects.toThrow("stopping");
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    await stuck;
    await expect(released).resolves.toBe("stopped");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("blocks previews throughout cleanup and restores them after a failed stop", async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_, fail) => {
      reject = fail;
    });
    const stopping = withTaskPreviewStop(f.manager, "retry", () => pending);
    const checked = expect(stopping).rejects.toThrow("return failed");
    await expect(captureTaskPreview(f.manager, f.cdp, "retry")).rejects.toThrow("stopping");
    expect(f.cdp.acquireBackgroundExecution).not.toHaveBeenCalled();
    reject(new Error("return failed"));
    await checked;
    await expect(captureTaskPreview(f.manager, f.cdp, "retry")).resolves.toMatchObject({
      tab_id: 5,
    });
  });

  it("does not capture an unowned active user tab", async () => {
    const f = fixture();
    f.task.agentCreatedTabs.clear();
    await expect(captureTaskPreview(f.manager, f.cdp, "empty")).rejects.toThrow(
      "Task tab unavailable",
    );
    expect(f.cdp.send).not.toHaveBeenCalled();
  });

  it("uses an owned tab when an unauthorized user tab is active", async () => {
    const f = fixture();
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 9, windowId: 10, active: true },
      { id: 5, windowId: 10, active: false },
    ] as chrome.tabs.Tab[]);
    await expect(captureTaskPreview(f.manager, f.cdp, "user-active")).resolves.toMatchObject({
      tab_id: 5,
    });
    expect(f.cdp.send).toHaveBeenCalledWith(5, "Page.captureScreenshot", expect.anything());
  });

  it("discards the frame when authorization ends during the capture", async () => {
    const f = fixture();
    vi.mocked(f.cdp.acquireBackgroundExecution).mockImplementation(async () => {
      f.task.agentCreatedTabs.clear();
    });
    await expect(captureTaskPreview(f.manager, f.cdp, "ended")).rejects.toThrow(
      "Task ended during capture",
    );
  });

  it("discards the frame when the debugger attachment changes", async () => {
    const f = fixture();
    vi.mocked(f.cdp.send).mockImplementation(async () => {
      vi.mocked(f.cdp.getAttachmentId).mockReturnValue("replacement");
      return { data: btoa("jpeg") } as never;
    });
    await expect(captureTaskPreview(f.manager, f.cdp, "replaced")).rejects.toThrow(
      "Task ended during capture",
    );
  });
});
