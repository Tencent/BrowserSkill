import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { pruneScreenshots, SCREENSHOT_HISTORY_AGE_MS, SCREENSHOT_HISTORY_LIMIT } from "./retention";

const now = 2 * SCREENSHOT_HISTORY_AGE_MS;
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
type Entry = { manifest?: string; kind?: string; readError?: Error; deleteError?: Error };
let files: Map<string, Entry>;
let removed: string[];
let remove: Mock<(key: string, options: { recursive: boolean }) => Promise<void>>;
let getRoot: Mock<() => Promise<ReturnType<typeof directory>>>;

function directory() {
  return {
    async *entries() {
      for (const [key, entry] of files) yield [key, { kind: entry.kind ?? "directory" }];
    },
    removeEntry: remove,
    getDirectoryHandle: async (key: string) => ({
      getFileHandle: async () => ({
        getFile: async () => {
          const entry = files.get(key);
          if (entry?.readError) throw entry.readError;
          if (entry?.manifest === undefined) throw new DOMException("Missing", "NotFoundError");
          return new Blob([entry.manifest]);
        },
      }),
    }),
  };
}

beforeEach(() => {
  files = new Map();
  removed = [];
  remove = vi.fn(async (key: string, options: { recursive: boolean }) => {
    expect(options.recursive).toBe(true);
    const error = files.get(key)?.deleteError;
    if (error) throw error;
    files.delete(key);
    removed.push(key);
  });
  getRoot = vi.fn(async () => directory());
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => ({ getDirectoryHandle: getRoot }) },
  });
});
afterEach(() => vi.unstubAllGlobals());

function capture(index: number, createdAt = now - index) {
  files.set(id(index), { manifest: JSON.stringify({ id: id(index), createdAt }) });
  return id(index);
}

describe("popup screenshot retention", () => {
  it("keeps only the newest five captures and removes entire old artifact directories", async () => {
    for (const index of [8, 2, 5, 1, 6, 3, 7, 4]) capture(index);
    await pruneScreenshots(() => false, now);
    expect(files.size).toBe(SCREENSHOT_HISTORY_LIMIT);
    expect([...files.keys()].sort()).toEqual([1, 2, 3, 4, 5].map(id));
    expect(removed).toEqual([6, 7, 8].map(id));
  });

  it("expires captures at the age limit even below the count limit", async () => {
    capture(1, now - SCREENSHOT_HISTORY_AGE_MS + 1);
    capture(2, now - SCREENSHOT_HISTORY_AGE_MS);
    await pruneScreenshots(() => false, now);
    expect([...files.keys()]).toEqual([id(1)]);
  });

  it("protects open previews and active captures, then reclaims them after release", async () => {
    const protectedIds = new Set([capture(1, 1), capture(2, 2)]);
    files.set(id(3), {}); // Active capture has not committed its first manifest yet.
    protectedIds.add(id(3));
    for (let index = 4; index <= 9; index++) capture(index);
    await pruneScreenshots((key) => protectedIds.has(key), now);
    expect([...files.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(id));
    protectedIds.clear();
    await pruneScreenshots(() => false, now);
    expect([...files.keys()]).toEqual([4, 5, 6, 7, 8].map(id));
  });

  it("never evicts protected previews even when they exceed the history limit", async () => {
    const protectedIds = new Set(Array.from({ length: 8 }, (_, index) => capture(index, 1)));
    await pruneScreenshots((key) => protectedIds.has(key), now);
    expect(files.size).toBe(8);
    expect(remove).not.toHaveBeenCalled();
  });

  it("rechecks ownership when a capture starts during storage reads", async () => {
    capture(1, 1);
    let active = false;
    const getDirectoryHandle = (await getRoot()).getDirectoryHandle;
    getRoot.mockResolvedValueOnce({
      async *entries() {
        yield [id(1), { kind: "directory" }];
        active = true;
      },
      getDirectoryHandle,
      removeEntry: remove,
    });
    await pruneScreenshots(() => active, now);
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes unprotected crash leftovers and invalid manifests", async () => {
    files.set(id(1), {});
    files.set(id(2), { manifest: "{broken" });
    files.set(id(3), { manifest: '{"createdAt":"yesterday"}' });
    await pruneScreenshots(() => false, now);
    expect(files.size).toBe(0);
  });

  it("awaits current preview ownership before deleting an expired artifact", async () => {
    capture(1, 1);
    let protect!: (value: boolean) => void;
    const keep = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          protect = resolve;
        }),
    );
    const sweep = pruneScreenshots(keep, now);
    await vi.waitFor(() => expect(keep).toHaveBeenCalledWith(id(1)));
    expect(remove).not.toHaveBeenCalled();
    protect(true);
    await sweep;
    expect(files.has(id(1))).toBe(true);
  });

  it("does not touch Agent exports, unrelated directories or files", async () => {
    files.set("agent-orphan", {});
    files.set("unrelated", {});
    files.set(id(1), { kind: "file" });
    await pruneScreenshots(() => false, now);
    expect(files.size).toBe(3);
    expect(remove).not.toHaveBeenCalled();
  });

  it("leaves unreadable captures intact instead of treating storage errors as corruption", async () => {
    files.set(id(1), { readError: new DOMException("Storage unavailable", "UnknownError") });
    capture(2, 1);
    await pruneScreenshots(() => false, now);
    expect([...files.keys()]).toEqual([id(1)]);
  });

  it("continues past a failed deletion and can retry it on the next sweep", async () => {
    capture(1, 1);
    capture(2, 2);
    files.get(id(2))!.deleteError = new DOMException("Busy", "NoModificationAllowedError");
    await expect(pruneScreenshots(() => false, now)).rejects.toThrow("Busy");
    expect([...files.keys()]).toEqual([id(2)]);
    files.get(id(2))!.deleteError = undefined;
    await pruneScreenshots(() => false, now);
    expect(files.size).toBe(0);
  });

  it("accepts a missing root but surfaces other storage failures", async () => {
    getRoot.mockRejectedValueOnce(new DOMException("Missing", "NotFoundError"));
    await expect(pruneScreenshots(() => false, now)).resolves.toBeUndefined();
    getRoot.mockRejectedValueOnce(new DOMException("Storage unavailable", "UnknownError"));
    await expect(pruneScreenshots(() => false, now)).rejects.toThrow("Storage unavailable");
  });
});
