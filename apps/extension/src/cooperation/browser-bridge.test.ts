import { afterEach, expect, it, vi } from "vitest";
import { collectCooperationFrames } from "./browser-bridge";
import { FrameCollectionError } from "./frame-error";
import {
  COOPERATION_ARM,
  COOPERATION_DISABLE,
  COOPERATION_READ,
  COOPERATION_RESUME,
  type FrameRepairs,
  type FrameState,
} from "./types";

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
const main = {
  frameId: 0,
  documentId: "chrome-document-a",
  url: "https://page.test/",
  documentLifecycle: "active",
  errorOccurred: false,
};
function bridge(sendMessage: ReturnType<typeof vi.fn>, frames = [main]) {
  vi.useFakeTimers();
  const executeScript = vi.fn().mockResolvedValue([]);
  vi.stubGlobal("chrome", {
    webNavigation: { getAllFrames: async () => frames },
    tabs: { sendMessage },
    scripting: { executeScript },
  });
  return executeScript;
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
  expect((await result).frames.get(0)?.human).toBe(1);
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
  expect((await collectCooperationFrames(7, COOPERATION_READ, "lease")).frames.size).toBe(1);
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

it.each([
  COOPERATION_READ,
  COOPERATION_RESUME,
  COOPERATION_DISABLE,
])("skips only failed child frames and inactive documents for %s", async (kind) => {
  const send = vi.fn().mockResolvedValue(frame());
  const execute = bridge(send, [
    main,
    { ...main, frameId: 2, documentId: "failed", errorOccurred: true },
    ...["prerender", "cached", "pending_deletion"].map((documentLifecycle, i) => ({
      ...main,
      frameId: i + 3,
      documentId: documentLifecycle,
      documentLifecycle,
    })),
  ]);
  const result = await collectCooperationFrames(7, kind, "lease");
  expect([...result.frames.keys()]).toEqual([0]);
  expect(result.gaps).toEqual([
    { frame_id: 2, url: main.url, reason: "load_error" },
    ...[3, 4, 5].map((frame_id) => ({ frame_id, url: main.url, reason: "inactive_document" })),
  ]);
  expect(send).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});

it("rejects a failed main page before messaging any frames", async () => {
  const send = vi.fn();
  const execute = bridge(send, [{ ...main, errorOccurred: true }]);
  await expect(collectCooperationFrames(7, COOPERATION_READ, "lease")).rejects.toMatchObject({
    reason: "page_load_failed",
    frames: [{ frame_id: 0, url: main.url }],
  });
  expect(send).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

const missingReceiver = () =>
  new Error("Could not establish connection. Receiving end does not exist.");

it("repairs a missing listener on the same document and lease", async () => {
  const send = vi.fn().mockRejectedValueOnce(missingReceiver()).mockResolvedValue(frame(1));
  const execute = bridge(send);
  const result = await collectCooperationFrames(7, COOPERATION_READ, "lease");
  expect(result.frames.get(0)?.human).toBe(1);
  expect(execute).toHaveBeenCalledExactlyOnceWith({
    target: { tabId: 7, documentIds: [main.documentId] },
    files: ["content-scripts/cooperation.js"],
    injectImmediately: true,
  });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
});

it("reports every unreachable active frame and never repeats a failed document repair", async () => {
  const send = vi.fn().mockRejectedValue(missingReceiver());
  const execute = bridge(send, [main, { ...main, frameId: 3, documentId: "child" }]);
  const repairs: FrameRepairs = new Map();
  for (let i = 0; i < 2; i++) {
    const error = await collectCooperationFrames(
      7,
      COOPERATION_READ,
      "lease",
      undefined,
      repairs,
    ).catch((error) => error as FrameCollectionError);
    expect(error).toBeInstanceOf(FrameCollectionError);
    expect((error as FrameCollectionError).toRpcError()).toMatchObject({
      code: "permission_denied",
      data: {
        reason: "frame_unobservable",
        effect_state: "none",
        frames: [
          { frame_id: 0, url: main.url },
          { frame_id: 3, url: main.url },
        ],
      },
    });
  }
  expect(execute).toHaveBeenCalledTimes(2);
});

it("prunes repair attempts for documents that left the tab", async () => {
  const send = vi.fn().mockRejectedValue(missingReceiver());
  const frames = [main, { ...main, frameId: 3, documentId: "child" }];
  const execute = bridge(send, frames);
  const repairs: FrameRepairs = new Map();
  const collect = () => collectCooperationFrames(7, COOPERATION_READ, "lease", undefined, repairs);
  await expect(collect()).rejects.toMatchObject({ reason: "frame_unobservable" });
  expect([...repairs.keys()]).toEqual([main.documentId, "child"]);
  frames.pop();
  await expect(collect()).rejects.toMatchObject({ reason: "frame_unobservable" });
  expect([...repairs.keys()]).toEqual([main.documentId]);
  expect(execute).toHaveBeenCalledTimes(2);
  frames.length = 0;
  await expect(collect()).rejects.toThrow("No observable document");
  expect(repairs.size).toBe(0);
});

it.each([
  "gap",
  "unobservable",
  "main",
])("omits URL credentials, query and fragment from %s diagnostics", async (kind) => {
  const url = "https://user:password@pay.test/checkout?token=secret#callback-token";
  const target = {
    ...main,
    frameId: kind === "main" ? 0 : 3,
    documentId: "sensitive",
    url,
    errorOccurred: kind !== "unobservable",
  };
  const send = vi.fn().mockImplementation(async (_tab, _message, { documentId }) => {
    if (documentId === "sensitive") throw missingReceiver();
    return frame();
  });
  bridge(send, kind === "main" ? [target] : [main, target]);
  const result = await collectCooperationFrames(7, COOPERATION_READ, "lease").then(
    (collection) => collection.gaps,
    (error: FrameCollectionError) => error.toRpcError(),
  );
  const diagnostic = JSON.stringify(result);
  expect(diagnostic).toContain("https://pay.test/checkout");
  expect(diagnostic).not.toMatch(/user|password|token|secret|callback|\?|#/);
});

it("shares an in-flight repair across concurrent reads", async () => {
  let repaired = false;
  let finish!: () => void;
  const send = vi.fn(async () => {
    if (!repaired) throw missingReceiver();
    return frame();
  });
  const execute = bridge(send);
  execute.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          repaired = true;
          resolve();
        };
      }),
  );
  const repairs: FrameRepairs = new Map();
  const pending = [1, 2].map(() =>
    collectCooperationFrames(7, COOPERATION_READ, "lease", undefined, repairs),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(execute).toHaveBeenCalledOnce();
  finish();
  expect((await Promise.all(pending)).every((result) => result.frames.has(0))).toBe(true);
});

it.each([
  ["data:text/html,<input value=secret>", "data:"],
  ["blob:https://page.test/private-content", "blob:"],
  ["https://bad host/private-content", "[unavailable]"],
])("limits opaque or malformed URL diagnostics without failing collection: %s", async (url, expected) => {
  const send = vi.fn().mockResolvedValue(frame());
  bridge(send, [main, { ...main, frameId: 3, documentId: "child", errorOccurred: true, url }]);
  const result = await collectCooperationFrames(7, COOPERATION_READ, "lease");
  expect(result.frames.has(0)).toBe(true);
  expect(result.gaps).toEqual([{ frame_id: 3, url: expected, reason: "load_error" }]);
});

it("does not retry a denied injection or install collectors during release", async () => {
  const send = vi.fn().mockRejectedValue(missingReceiver());
  const execute = bridge(send);
  execute.mockRejectedValue(new Error("Cannot access contents of the page"));
  const repairs: FrameRepairs = new Map();
  for (const kind of [COOPERATION_READ, COOPERATION_READ, COOPERATION_DISABLE])
    await expect(
      collectCooperationFrames(7, kind, "lease", undefined, repairs),
    ).rejects.toMatchObject({
      reason: "frame_unobservable",
    });
  expect(execute).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledTimes(3);
});

it.each([
  "Frame was removed",
  "The message port closed before a response was received.",
])("does not inject for unrelated messaging errors: %s", async (message) => {
  const send = vi.fn().mockRejectedValue(new Error(message));
  const execute = bridge(send);
  await expect(collectCooperationFrames(7, COOPERATION_READ, "lease")).rejects.toThrow(message);
  expect(execute).not.toHaveBeenCalled();
});

it("cannot arm a repaired collector after the deadline", async () => {
  let finish!: () => void;
  const send = vi.fn().mockRejectedValue(missingReceiver());
  const execute = bridge(send);
  execute.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const result = expect(collectCooperationFrames(7, COOPERATION_ARM, "lease")).rejects.toThrow(
    "not responding",
  );
  await vi.advanceTimersByTimeAsync(1200);
  await result;
  finish();
  await vi.advanceTimersByTimeAsync(25);
  expect(send).toHaveBeenCalledOnce();
});
