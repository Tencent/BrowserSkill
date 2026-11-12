import { afterEach, expect, it, vi } from "vitest";
import type { SessionManager } from "@/session-manager/manager";
import { attachCooperation, collectCooperationFrames } from "./browser-bridge";
import { FrameCollectionError, FrameUnresponsiveError } from "./frame-error";
import type { FrameOwner } from "./hidden-frames";
import {
  COOPERATION_ARM,
  COOPERATION_DISABLE,
  COOPERATION_OWNERS,
  COOPERATION_READ,
  COOPERATION_RESUME,
  type FrameRepairs,
  type FrameState,
  type HiddenFrames,
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

it("invalidates control for a root navigation but not for a subframe navigation", () => {
  type NavigateListener = (
    details: chrome.webNavigation.WebNavigationParentedCallbackDetails,
  ) => void;
  let navigate!: NavigateListener;
  vi.stubGlobal("chrome", {
    runtime: { id: "test", onMessage: { addListener: vi.fn() } },
    webNavigation: {
      onBeforeNavigate: {
        addListener: vi.fn((listener: NavigateListener) => {
          navigate = listener;
        }),
      },
    },
    tabs: { onRemoved: { addListener: vi.fn() }, onDetached: { addListener: vi.fn() } },
  });
  const controller = attachCooperation({} as SessionManager, () => {});
  const invalidate = vi.spyOn(controller, "invalidate");
  const details = {
    tabId: 7,
    documentLifecycle: "active" as const,
    frameType: "sub_frame" as const,
    processId: 1,
    timeStamp: Date.now(),
  };
  // A child frame navigation start must not discard the observed root page.
  navigate({
    ...details,
    frameId: 8,
    parentFrameId: 0,
    url: "https://page.test/frame",
  });
  expect(invalidate).not.toHaveBeenCalled();
  navigate({
    ...details,
    frameId: 0,
    parentFrameId: -1,
    frameType: "outermost_frame",
    url: "https://page.test/",
  });
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(7);
});

it("recollects a proven child document replacement once and retains new human input", async () => {
  const child = { ...main, frameId: 2, documentId: "old-child" };
  const send = vi.fn(async (_tab, _message, target) => {
    if (target.documentId === "old-child")
      throw new FrameCollectionError("frame_unobservable", [{ frame_id: 2, url: main.url }]);
    return frame(target.documentId === "new-child" ? 1 : 0);
  });
  bridge(send, [main, child]);
  vi.mocked(chrome.webNavigation).getAllFrames = vi
    .fn()
    .mockResolvedValueOnce([main, child])
    .mockResolvedValue([main, { ...child, documentId: "new-child" }]);
  const result = await collectCooperationFrames(7, COOPERATION_READ, "lease");
  expect(result.frames.get(2)?.human).toBe(1);
  expect(send.mock.calls.filter((call) => call[2].documentId === "old-child")).toHaveLength(1);
  expect(send.mock.calls.filter((call) => call[2].documentId === "new-child")).toHaveLength(1);
});

it("bounds replacement collection and does not conceal an active unobservable frame", async () => {
  const child = { ...main, frameId: 2, documentId: "child" };
  const send = vi.fn(async (_tab, _message, target) => {
    if (target.documentId !== main.documentId)
      throw new FrameCollectionError("frame_unobservable", [{ frame_id: 2, url: main.url }]);
    return frame();
  });
  bridge(send, [main, child]);
  await expect(collectCooperationFrames(7, COOPERATION_READ, "lease")).rejects.toMatchObject({
    reason: "frame_unobservable",
  });
  expect(send).toHaveBeenCalledTimes(2);
  send.mockClear();
  vi.mocked(chrome.webNavigation).getAllFrames = vi
    .fn()
    .mockResolvedValueOnce([main, child])
    .mockResolvedValueOnce([main, { ...child, documentId: "new" }])
    .mockResolvedValue([main, { ...child, documentId: "newer" }]);
  await expect(collectCooperationFrames(7, COOPERATION_READ, "lease")).rejects.toMatchObject({
    reason: "frame_unobservable",
  });
  expect(send).toHaveBeenCalledTimes(4);
});

// Frames that do not answer (#614): name them, and let only provably hidden
// child documents stay uncollected.
const child = (frameId: number, documentId: string, url: string, parentFrameId = 0) => ({
  ...main,
  frameId,
  parentFrameId,
  documentId,
  url,
});
type Target = { documentId: string };
function page(owners: Record<string, unknown>, silent: (documentId: string) => boolean) {
  return vi.fn(async (_tab: number, message: { kind: string }, target: Target) => {
    if (message.kind === COOPERATION_OWNERS) return owners[target.documentId];
    if (silent(target.documentId)) return new Promise(() => {});
    return frame();
  });
}
const ownerQueries = (send: ReturnType<typeof page>) =>
  send.mock.calls
    .filter(([, message]) => message.kind === COOPERATION_OWNERS)
    .map(([, , target]) => target.documentId);
const settle = async <T>(work: Promise<T>) => {
  const outcome = work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(1200);
  return outcome as Promise<{ value?: T; error?: unknown }>;
};

it("names a displayed child frame that does not answer and keeps it retryable", async () => {
  const silent = child(2, "silent", "https://page.test/widget?token=secret#private");
  const send = page({ [main.documentId]: [{ hidden: false, url: null }] }, (id) => id === "silent");
  bridge(send, [main, silent]);
  const { error } = await settle(collectCooperationFrames(7, COOPERATION_READ, "lease"));
  expect(error).toBeInstanceOf(FrameUnresponsiveError);
  expect(error).not.toBeInstanceOf(FrameCollectionError);
  expect(error).toMatchObject({
    message: "A page frame is not responding: 2 (https://page.test/widget)",
    frames: [{ frame_id: 2, url: "https://page.test/widget" }],
  });
  expect(ownerQueries(send)).toEqual([main.documentId]);
});

it("records a hidden child that does not answer as a gap and does not wait for it again", async () => {
  const silent = child(2, "silent", "https://page.test/sandbox");
  const send = page({ [main.documentId]: [{ hidden: true, url: null }] }, (id) => id === "silent");
  bridge(send, [main, silent]);
  const hidden: HiddenFrames = new Set();
  const gap = { frame_id: 2, url: silent.url, reason: "hidden_frame" };
  const { value: first } = await settle(
    collectCooperationFrames(7, COOPERATION_READ, "lease", undefined, new Map(), hidden),
  );
  expect([...first!.frames.keys()]).toEqual([0]);
  expect(first!.gaps).toEqual([gap]);
  expect([...hidden]).toEqual(["silent"]);
  // Fake timers stay still: a collection that awaited the silent frame would never settle.
  const input = { type: "pointerdown" as const, x: 4, y: 5 };
  const second = await collectCooperationFrames(
    7,
    COOPERATION_ARM,
    "lease",
    input,
    new Map(),
    hidden,
  );
  expect(second.gaps).toEqual([gap]);
  expect(send.mock.calls.filter(([, , target]) => target.documentId === "silent")).toHaveLength(1);
  expect(ownerQueries(send)).toEqual([main.documentId, main.documentId]);
});

it("collects a remembered hidden frame again once its element is displayed", async () => {
  const silent = child(2, "silent", "https://page.test/sandbox");
  const owners: Record<string, FrameOwner[]> = { [main.documentId]: [{ hidden: true, url: null }] };
  let answering = false;
  const send = page(owners, (id) => id === "silent" && !answering);
  bridge(send, [main, silent]);
  const hidden: HiddenFrames = new Set();
  await settle(
    collectCooperationFrames(7, COOPERATION_READ, "lease", undefined, new Map(), hidden),
  );
  owners[main.documentId] = [{ hidden: false, url: null }];
  const { error } = await settle(
    collectCooperationFrames(7, COOPERATION_READ, "lease", undefined, new Map(), hidden),
  );
  expect(error).toBeInstanceOf(FrameUnresponsiveError);
  expect(hidden.size).toBe(0);
  answering = true;
  const shown = await collectCooperationFrames(
    7,
    COOPERATION_READ,
    "lease",
    undefined,
    new Map(),
    hidden,
  );
  expect([...shown.frames.keys()]).toEqual([0, 2]);
  expect(shown.gaps).toEqual([]);
});

it.each([
  [
    "an identified displayed same-origin sibling",
    ["https://page.test/a", "https://page.test/b"],
    [
      { hidden: true, url: "https://page.test/a" },
      { hidden: false, url: "https://page.test/b" },
    ],
    true,
  ],
  [
    "a displayed cross-origin sibling",
    ["https://page.test/a", "https://ads.test/b"],
    [
      { hidden: true, url: null },
      { hidden: false, url: null },
    ],
    false,
  ],
  [
    "a displayed sibling with the same URL",
    ["https://page.test/a", "https://page.test/a"],
    [
      { hidden: true, url: "https://page.test/a" },
      { hidden: false, url: "https://page.test/a" },
    ],
    false,
  ],
  [
    "a displayed element for no known document",
    ["https://page.test/a", "https://page.test/b"],
    [
      { hidden: true, url: "https://page.test/a" },
      { hidden: false, url: "https://page.test/c" },
    ],
    false,
  ],
  [
    "an element count that differs from the frame inventory",
    ["https://page.test/a", "https://page.test/b"],
    [{ hidden: true, url: null }],
    false,
  ],
  [
    "an unreadable parent reply",
    ["https://page.test/a", "https://page.test/b"],
    { hidden: true },
    false,
  ],
])("decides a silent child with %s", async (_case, [silentUrl, otherUrl], facts, concealed) => {
  const silent = child(2, "silent", silentUrl);
  const send = page({ [main.documentId]: facts }, (id) => id === "silent");
  bridge(send, [main, silent, child(3, "other", otherUrl)]);
  const { value, error } = await settle(collectCooperationFrames(7, COOPERATION_READ, "lease"));
  if (concealed) {
    expect([...value!.frames.keys()]).toEqual([0, 3]);
    expect(value!.gaps).toEqual([{ frame_id: 2, url: silentUrl, reason: "hidden_frame" }]);
  } else expect(error).toBeInstanceOf(FrameUnresponsiveError);
});

it("does not conceal a frame when the inventory changes while its parent is read", async () => {
  const silent = child(2, "silent", "https://page.test/sandbox");
  const send = page({ [main.documentId]: [{ hidden: true, url: null }] }, (id) => id === "silent");
  bridge(send, [main, silent]);
  vi.mocked(chrome.webNavigation).getAllFrames = vi
    .fn()
    .mockResolvedValueOnce([main, silent])
    .mockResolvedValueOnce([main, silent])
    .mockResolvedValue([main, { ...silent, url: "https://page.test/moved" }]);
  const { error } = await settle(collectCooperationFrames(7, COOPERATION_READ, "lease"));
  expect(error).toBeInstanceOf(FrameUnresponsiveError);
  expect(ownerQueries(send)).toEqual([main.documentId]);
});

it("treats silent frames nested in a hidden frame as hidden without asking the silent parent", async () => {
  const outer = child(2, "outer", "https://page.test/outer");
  const inner = child(3, "inner", "https://page.test/inner", 2);
  const send = page(
    { [main.documentId]: [{ hidden: true, url: null }] },
    (id) => id !== main.documentId,
  );
  bridge(send, [main, outer, inner]);
  const { value } = await settle(collectCooperationFrames(7, COOPERATION_READ, "lease"));
  expect(value!.gaps.map((gap) => [gap.frame_id, gap.reason])).toEqual([
    [2, "hidden_frame"],
    [3, "hidden_frame"],
  ]);
  expect(ownerQueries(send)).toEqual([main.documentId]);
});

it("records a hidden child that cannot host a collector as a gap", async () => {
  const blocked = child(2, "blocked", "https://page.test/blocked");
  const send = vi.fn(async (_tab: number, message: { kind: string }, target: Target) => {
    if (message.kind === COOPERATION_OWNERS) return [{ hidden: true, url: null }];
    if (target.documentId === "blocked") throw missingReceiver();
    return frame();
  });
  bridge(send, [main, blocked]).mockRejectedValue(new Error("Cannot access contents of the page"));
  expect((await collectCooperationFrames(7, COOPERATION_READ, "lease")).gaps).toEqual([
    { frame_id: 2, url: blocked.url, reason: "hidden_frame" },
  ]);
});

it("never conceals a silent main page and does not ask during release", async () => {
  const silent = child(2, "silent", "https://page.test/sandbox");
  const send = page({ [main.documentId]: [{ hidden: true, url: null }] }, () => true);
  bridge(send, [main, silent]);
  const { error } = await settle(collectCooperationFrames(7, COOPERATION_READ, "lease"));
  expect(error).toMatchObject({
    frames: [
      { frame_id: 0, url: main.url },
      { frame_id: 2, url: silent.url },
    ],
  });
  send.mockClear();
  const released = await settle(
    collectCooperationFrames(
      7,
      COOPERATION_DISABLE,
      "lease",
      undefined,
      new Map(),
      new Set(["silent"]),
    ),
  );
  expect(released.error).toBeInstanceOf(FrameUnresponsiveError);
  expect(ownerQueries(send)).toEqual([]);
});
