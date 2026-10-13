import { afterEach, expect, it, vi } from "vitest";
import { trustedPopup } from "./local-pairing-bridge";

afterEach(() => vi.unstubAllGlobals());
it("accepts only this extension's popup, never a content script or tab", () => {
  vi.stubGlobal("chrome", {
    runtime: { id: "test", getURL: (path: string) => `chrome-extension://test/${path}` },
  });
  const sender = { id: "test", url: "chrome-extension://test/popup.html" };
  expect(trustedPopup(sender)).toBe(true);
  expect(trustedPopup({ ...sender, tab: { id: 1 } as chrome.tabs.Tab })).toBe(false);
  expect(trustedPopup({ ...sender, id: "other" })).toBe(false);
  expect(trustedPopup({ ...sender, url: "https://example.test/popup.html" })).toBe(false);
});
