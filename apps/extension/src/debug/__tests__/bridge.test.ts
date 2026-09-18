import { afterEach, describe, expect, it, vi } from "vitest";
import { isDebugPage } from "../bridge";

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
});
