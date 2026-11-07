import { afterEach, expect, it, vi } from "vitest";
import { VideoArtifactStore } from "./store";
import type { StoredVideo } from "./types";

afterEach(() => vi.unstubAllGlobals());

// Minimal IDB event fixture: reads and writes belong to the same transaction,
// and its completion (not the get request) determines success.
function database(value: StoredVideo | undefined, abort = false) {
  let current = value;
  const put = vi.fn((next: StoredVideo) => {
    current = structuredClone(next);
    return {};
  });
  const modes: IDBTransactionMode[] = [];
  const close = vi.fn();
  vi.stubGlobal("indexedDB", {
    open: () => {
      const opening = {
        result: {
          close,
          transaction: (_name: string, mode: IDBTransactionMode) => {
            modes.push(mode);
            const tx = {
              error: new Error("storage aborted"),
              oncomplete: () => {},
              onabort: () => {},
              objectStore: () => ({
                get: () => {
                  const request = { result: structuredClone(current), onsuccess: () => {} };
                  queueMicrotask(() => {
                    request.onsuccess();
                    queueMicrotask(() => (abort ? tx.onabort() : tx.oncomplete()));
                  });
                  return request;
                },
                put,
              }),
            };
            return tx;
          },
        },
        onsuccess: () => {},
      };
      queueMicrotask(() => opening.onsuccess());
      return opening;
    },
  });
  return { put, modes, close, current: () => current };
}

const id = `vid_${"a".repeat(32)}`;
const ready = {
  recording_id: id,
  state: "ready",
  expires_at: Date.now() + 60_000,
  title: "Latest title",
  byte_size: 42,
  exported: false,
} as StoredVideo;

it("marks the current metadata exported in one readwrite transaction", async () => {
  const db = database(ready);
  await new VideoArtifactStore().markExported(id);
  expect(db.current()).toEqual({ ...ready, exported: true });
  expect(db.put).toHaveBeenCalledTimes(1);
  expect(db.modes).toEqual(["readwrite"]);
  expect(db.close).toHaveBeenCalledTimes(1);
});

it.each([
  undefined,
  { ...ready, state: "failed" },
  { ...ready, expires_at: 0 },
])("does not recreate or mark an unavailable recording: %j", async (value) => {
  const db = database(value as StoredVideo | undefined);
  await new VideoArtifactStore().markExported(id);
  expect(db.put).not.toHaveBeenCalled();
  expect(db.current()).toEqual(value);
});

it("does not report a committed export after a transaction abort", async () => {
  const db = database(ready, true);
  await expect(new VideoArtifactStore().markExported(id)).rejects.toThrow("storage aborted");
  expect(db.close).toHaveBeenCalledTimes(1);
});
