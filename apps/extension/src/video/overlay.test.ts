import { expect, it, vi } from "vitest";
import { VideoOverlayGate } from "./overlay";

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
