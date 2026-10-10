import { afterEach, expect, it, vi } from "vitest";
import { VIDEO_OVERLAY_QUERY_TIMEOUT_MS, VideoOverlayGate } from "./overlay";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("hides controls and interactive overlays until recording state is known", async () => {
  let resolve!: (value: { recording_id: string | null }) => void;
  const gate = new VideoOverlayGate(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    vi.fn(),
    async () => {},
  );
  expect(gate.canRenderControl()).toBe(false);
  expect(gate.canRenderInteractive(true)).toBe(false);
  const initializing = gate.initialize();
  expect(gate.canRenderControl()).toBe(false);
  resolve({ recording_id: null });
  await initializing;
  expect(gate.canRenderControl()).toBe(true);
  expect(gate.canRenderInteractive(true)).toBe(true);
  // A restored page must also hide stale controls until the new query returns.
  const restoring = gate.initialize();
  expect(gate.canRenderControl()).toBe(false);
  resolve({ recording_id: "video" });
  await restoring;
  expect(gate.canRenderControl()).toBe(false);
});

it("retries a failed query and restores ordinary overlays without a background push", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("Background unavailable"))
    .mockResolvedValue({ recording_id: null });
  const gate = new VideoOverlayGate(send, vi.fn(), async () => {});
  const pending = gate.initialize();
  expect(gate.initialize()).toBe(pending);
  expect(gate.canRenderInteractive(true)).toBe(false);
  await vi.advanceTimersByTimeAsync(250);
  await pending;
  expect(send).toHaveBeenCalledTimes(2);
  expect(gate.canRenderControl()).toBe(true);
  expect(gate.canRenderInteractive(true)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds failed discovery and allows a later request to restart it", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockRejectedValue(new Error("Background unavailable"));
  const gate = new VideoOverlayGate(send, vi.fn(), async () => {});
  const pending = expect(gate.initialize()).rejects.toThrow("Background unavailable");
  await vi.advanceTimersByTimeAsync(1250);
  await pending;
  expect(send).toHaveBeenCalledTimes(3);
  expect(gate.canRenderControl()).toBe(false);
  expect(gate.canRenderInteractive(true)).toBe(false);
  expect(gate.needsDiscovery()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  send.mockResolvedValue({ recording_id: null });
  await gate.initialize();
  expect(gate.canRenderControl()).toBe(true);
  expect(gate.canRenderInteractive(true)).toBe(true);
});

it("times out a lost reply and ignores it after a successful retry", async () => {
  vi.useFakeTimers();
  let resolve!: (value: { recording_id: string | null }) => void;
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue({ recording_id: "video" });
  const gate = new VideoOverlayGate(send, vi.fn(), async () => {});
  const pending = gate.initialize();
  await vi.advanceTimersByTimeAsync(VIDEO_OVERLAY_QUERY_TIMEOUT_MS + 250);
  await pending;
  resolve({ recording_id: null });
  await Promise.resolve();
  expect(gate.id).toBe("video");
  expect(gate.canRenderControl()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["push", "dispose"])("cancels discovery and retry timers on %s", async (event) => {
  vi.useFakeTimers();
  const send = vi.fn().mockRejectedValue(new Error("Background unavailable"));
  const render = vi.fn();
  const gate = new VideoOverlayGate(send, render, async () => {});
  const pending = gate.initialize();
  await vi.advanceTimersByTimeAsync(0);
  if (event === "push") await gate.set("video");
  else gate.dispose();
  render.mockClear();
  await pending;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(send).toHaveBeenCalledOnce();
  expect(render).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for background suspension before rendering help, then confirms a clean paint", async () => {
  let acknowledge!: () => void;
  const pending = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const send = vi.fn(async (action: string) => {
    if (action === "interactive") await pending;
    return { recording_id: "video" };
  });
  const render = vi.fn();
  const painted = vi.fn(async () => {});
  const gate = new VideoOverlayGate(send, render, painted);
  await gate.initialize();
  render.mockClear();
  expect(gate.canRenderInteractive(true)).toBe(false);
  expect(gate.canRenderInteractive(true)).toBe(false);
  expect(send.mock.calls.filter(([action]) => action === "interactive")).toHaveLength(1);
  acknowledge();
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  expect(gate.canRenderInteractive(true)).toBe(true);
  gate.canRenderInteractive(false);
  await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith("clean"));
  expect(painted).toHaveBeenCalled();
});

it("ignores old acknowledgements after an overlay or recording is removed", async () => {
  let acknowledge!: () => void;
  const send = vi.fn(
    () =>
      new Promise<{ recording_id: string }>((resolve) => {
        acknowledge = () => resolve({ recording_id: "old" });
      }),
  );
  const render = vi.fn();
  const gate = new VideoOverlayGate(send, render, async () => {});
  await gate.set("old");
  expect(gate.canRenderInteractive(true)).toBe(false);
  await gate.set(null);
  render.mockClear();
  acknowledge();
  await Promise.resolve();
  expect(render).not.toHaveBeenCalled();
  expect(gate.id).toBeNull();
  expect(gate.canRenderInteractive(true)).toBe(true);
});

it("ignores a stale initialization query after a newer recording handshake", async () => {
  let resolve!: (value: { recording_id: string | null }) => void;
  const gate = new VideoOverlayGate(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    vi.fn(),
    async () => {},
  );
  const initializing = gate.initialize();
  expect(gate.id).toBeNull();
  await gate.set("new-recording");
  resolve({ recording_id: null });
  await initializing;
  expect(gate.id).toBe("new-recording");
  expect(gate.canRenderControl()).toBe(false);
});
