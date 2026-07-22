import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureBrowserObservationListeners,
  isBrowserObservationAttachedForTests,
  RECORD_DEFAULT_START_URL,
  releaseBrowserObservationListenersIfIdle,
  resetBrowserObservationForTests,
  setBrowserObservationAttachForTests,
} from "../record";

describe("record defaults", () => {
  it("uses Baidu as the default injectable start URL", () => {
    expect(RECORD_DEFAULT_START_URL).toBe("https://www.baidu.com/");
  });
});

describe("browser observation lifecycle", () => {
  afterEach(() => {
    resetBrowserObservationForTests();
  });

  it("does not attach listeners until ensure is called", () => {
    const tab = vi.fn(() => () => undefined);
    const nav = vi.fn(() => () => undefined);
    setBrowserObservationAttachForTests(tab, nav);

    expect(isBrowserObservationAttachedForTests()).toBe(false);
    expect(tab).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
  });

  it("attaches once on ensure and detaches when idle", () => {
    const detachTab = vi.fn();
    const detachNav = vi.fn();
    const tab = vi.fn(() => detachTab);
    const nav = vi.fn(() => detachNav);
    setBrowserObservationAttachForTests(tab, nav);

    ensureBrowserObservationListeners({
      tabsApi: { get: vi.fn(), query: vi.fn(), create: vi.fn() } as never,
      sendToTab: vi.fn(),
    });
    expect(isBrowserObservationAttachedForTests()).toBe(true);
    expect(tab).toHaveBeenCalledTimes(1);
    expect(nav).toHaveBeenCalledTimes(1);

    // Idempotent.
    ensureBrowserObservationListeners({
      tabsApi: { get: vi.fn(), query: vi.fn(), create: vi.fn() } as never,
      sendToTab: vi.fn(),
    });
    expect(tab).toHaveBeenCalledTimes(1);

    releaseBrowserObservationListenersIfIdle();
    expect(isBrowserObservationAttachedForTests()).toBe(false);
    expect(detachTab).toHaveBeenCalledTimes(1);
    expect(detachNav).toHaveBeenCalledTimes(1);
  });
});
