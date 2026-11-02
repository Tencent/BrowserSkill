import { afterEach, expect, it, vi } from "vitest";
import { collectCooperationFrames } from "./browser-bridge";
import { COOPERATION_ARM, COOPERATION_READ, COOPERATION_RESUME, type FrameState } from "./types";

const frame = (human = 0): FrameState => ({
  document: "document-a",
  revision: human,
  structure: 0,
  human,
  busy: false,
  editing: false,
  lastInput: 0,
  fields: [],
  events: [],
});
function bridge(sendMessage: ReturnType<typeof vi.fn>) {
  vi.useFakeTimers();
  vi.stubGlobal("chrome", {
    webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: "chrome-document-a" }] },
    tabs: { sendMessage },
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retries an empty collection reply on the same document and retains intervening human input", async () => {
  const send = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(frame(1));
  bridge(send);
  const input = { type: "pointerdown" as const, timestamp: 123, x: 4, y: 5 };
  const result = collectCooperationFrames(7, COOPERATION_ARM, "lease", input);
  await vi.advanceTimersByTimeAsync(25);
  expect((await result).get(0)?.human).toBe(1);
  expect(send).toHaveBeenCalledTimes(2);
  for (const call of send.mock.calls)
    expect(call).toEqual([
      7,
      { kind: COOPERATION_ARM, input, lease: "lease" },
      { documentId: "chrome-document-a" },
    ]);
});

it("does not retry a successful state read", async () => {
  const send = vi.fn().mockResolvedValue(frame());
  bridge(send);
  expect((await collectCooperationFrames(7, COOPERATION_READ, "lease")).size).toBe(1);
  expect(send).toHaveBeenCalledOnce();
});

it.each([
  undefined,
  {},
])("never treats a missing or malformed frame as covered: %j", async (value) => {
  const send = vi.fn().mockResolvedValue(value);
  bridge(send);
  const result = expect(collectCooperationFrames(7, COOPERATION_READ, "lease")).rejects.toThrow(
    "Interaction collection is unavailable",
  );
  await vi.advanceTimersByTimeAsync(25);
  await result;
  expect(send).toHaveBeenCalledTimes(value === undefined ? 2 : 1);
});

it("keeps the collection deadline when a retry never responds", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementation(() => new Promise(() => {}));
  bridge(send);
  const result = expect(collectCooperationFrames(7, COOPERATION_READ, "lease")).rejects.toThrow(
    "A page frame is not responding",
  );
  await vi.advanceTimersByTimeAsync(1200);
  await result;
  expect(send).toHaveBeenCalledTimes(2);
});

it("does not repeat an explicit hand-back", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  bridge(send);
  await expect(collectCooperationFrames(7, COOPERATION_RESUME, "lease")).rejects.toThrow(
    "no reply",
  );
  expect(send).toHaveBeenCalledOnce();
});

it("cannot arm a late retry after the collection deadline", async () => {
  let reply!: (value: undefined) => void;
  const send = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  bridge(send);
  const result = expect(collectCooperationFrames(7, COOPERATION_ARM, "lease")).rejects.toThrow(
    "A page frame is not responding",
  );
  await vi.advanceTimersByTimeAsync(1200);
  await result;
  reply(undefined);
  await vi.advanceTimersByTimeAsync(25);
  expect(send).toHaveBeenCalledOnce();
});
