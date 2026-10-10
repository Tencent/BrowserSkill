import { expect, it, vi } from "vitest";
import { VideoOverlayGate } from "./overlay";

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

it("keeps overlays hidden after failed discovery and accepts a later background handshake", async () => {
  const gate = new VideoOverlayGate(
    async () => {
      throw new Error("Background unavailable");
    },
    vi.fn(),
    async () => {},
  );
  await expect(gate.initialize()).rejects.toThrow("Background unavailable");
  expect(gate.canRenderControl()).toBe(false);
  expect(gate.canRenderInteractive(true)).toBe(false);
  await gate.set(null);
  expect(gate.canRenderControl()).toBe(true);
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
