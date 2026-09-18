import { afterEach, describe, expect, it, vi } from "vitest";
import { attachDebugBridge, DEBUG_MESSAGE, isDebugPage } from "../bridge";
import type { DebugManager } from "../manager";

afterEach(() => vi.unstubAllGlobals());
describe("debug evidence access", () => {
  it("accepts only this extension's popup and evidence page, never a content script", () => {
    vi.stubGlobal("chrome", {
      runtime: { id: "own", getURL: (path: string) => `chrome-extension://own${path}` },
    });
    expect(isDebugPage({ id: "own", url: "https://site.test" })).toBe(false);
    expect(isDebugPage({ id: "other", url: "chrome-extension://own/debug.html" })).toBe(false);
    expect(isDebugPage({ id: "own", url: "chrome-extension://own/other.html" })).toBe(false);
    expect(isDebugPage({ id: "own", url: "chrome-extension://own/popup.html" })).toBe(true);
    expect(isDebugPage({ id: "own", url: "chrome-extension://own/debug.html?session=s1" })).toBe(
      true,
    );
  });

  it("serves archived records without a task and rejects website access before reading history", async () => {
    const addListener = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        id: "own",
        getURL: (path: string) => `chrome-extension://own${path}`,
        onMessage: { addListener },
      },
    });
    const debug = {
      history: vi.fn(async () => ({ runs: [{ id: "d1" }] })),
      readHistory: vi.fn(async () => ({ recording: { version: 1 } })),
      deleteHistory: vi.fn(async () => {}),
    };
    // No SessionManager is needed for these extension-only, offline reads.
    attachDebugBridge(undefined as never, debug as unknown as DebugManager);
    const listener = addListener.mock.calls[0][0];
    const sender = { id: "own", url: "chrome-extension://own/debug.html" };
    const send = (message: object, source = sender) =>
      new Promise((resolve) => listener({ kind: DEBUG_MESSAGE, ...message }, source, resolve));
    expect(await send({ action: "history" }, { ...sender, url: "https://site.test" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(debug.history).not.toHaveBeenCalled();
    expect(await send({ action: "history" })).toEqual({
      ok: true,
      data: { runs: [{ id: "d1" }] },
    });
    const params = { action: "export", session_id: "", run_id: "d1" };
    expect(await send({ action: "record", params })).toEqual({
      ok: true,
      data: { recording: { version: 1 } },
    });
    expect(debug.readHistory).toHaveBeenCalledWith(params);
    expect(await send({ action: "delete", run_id: "d1" })).toEqual({ ok: true, data: {} });
    expect(debug.deleteHistory).toHaveBeenCalledWith("d1");
  });
});
