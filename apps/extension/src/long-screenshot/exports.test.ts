// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCREENSHOT_CHUNK_BYTES, ScreenshotExports } from "./exports";
import { removeTiledScreenshot } from "./tiles";

vi.mock("./tiles", () => ({ removeTiledScreenshot: vi.fn(async () => {}) }));

let store: ScreenshotExports;
let live: Set<string>;
let removed: string[];
beforeEach(() => {
  vi.useFakeTimers();
  live = new Set(["one", "two"]);
  removed = [];
  vi.stubGlobal("navigator", {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => ({
          async *keys() {
            yield "popup-123";
            yield "agent-orphan";
          },
          removeEntry: async (id: string) => {
            removed.push(id);
          },
        }),
      }),
    },
  });
  store = new ScreenshotExports((id) => live.has(id));
});
afterEach(async () => {
  await store.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Agent screenshot exports", () => {
  it("removes restart leftovers without touching popup previews", async () => {
    await store.prepare();
    await store.prepare();
    expect(removed).toEqual(["agent-orphan"]);
  });
  it("streams exact bounded chunks and permits retrying the same offset", async () => {
    await store.prepare();
    const bytes = Uint8Array.from({ length: SCREENSHOT_CHUNK_BYTES * 2 + 19 }, (_, i) => i % 251);
    store.put("one", "agent-test", new Blob([bytes]));
    const output: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const params = { session_id: "one", capture_id: "agent-test", offset };
      const chunk = await store.read(params);
      expect(chunk).toEqual(await store.read(params));
      if (!("data_base64" in chunk)) throw new Error(JSON.stringify(chunk));
      const data = Buffer.from(chunk.data_base64, "base64");
      expect(data.length).toBeLessThanOrEqual(SCREENSHOT_CHUNK_BYTES);
      output.push(data);
      offset = chunk.next_offset;
      if (chunk.eof) break;
    }
    expect(Buffer.concat(output)).toEqual(Buffer.from(bytes));
    expect(await store.release({ session_id: "one", capture_id: "agent-test" })).toEqual({
      released: true,
    });
    expect(removeTiledScreenshot).toHaveBeenCalledWith("agent-test");
    expect(
      await store.read({ session_id: "one", capture_id: "agent-test", offset: 0 }),
    ).toMatchObject({ code: "not_found" });
  });
  it("rejects another session, invalid offsets and released exports", async () => {
    await store.prepare();
    store.put("one", "agent-test", new Blob(["png"]));
    expect(
      await store.read({ session_id: "two", capture_id: "agent-test", offset: 0 }),
    ).toMatchObject({ code: "not_found" });
    expect(await store.release({ session_id: "two", capture_id: "agent-test" })).toEqual({
      released: false,
    });
    for (const offset of [-1, 0.5, 4, NaN, Infinity])
      expect(
        await store.read({ session_id: "one", capture_id: "agent-test", offset }),
      ).toMatchObject({ code: "invalid_params" });
    await store.releaseSession("one");
    expect(await store.release({ session_id: "one", capture_id: "agent-test" })).toEqual({
      released: false,
    });
  });
  it("reclaims idle exports and exports belonging to closed sessions", async () => {
    await store.prepare();
    store.put("one", "agent-closed", new Blob(["png"]));
    store.put("two", "agent-idle", new Blob(["png"]));
    live.delete("one");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(removeTiledScreenshot).toHaveBeenCalledWith("agent-closed");
    expect(removeTiledScreenshot).not.toHaveBeenCalledWith("agent-idle");
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(removeTiledScreenshot).toHaveBeenCalledWith("agent-idle");
    expect(() => store.put("one", "agent-late", new Blob())).toThrow("session ended");
  });
});
