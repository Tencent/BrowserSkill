import { describe, expect, it } from "vitest";
import { RecordingTabCoordinator } from "../recording/tab-coordinator";

describe("RecordingTabCoordinator", () => {
  it("keeps navigation state isolated per tab", () => {
    const tabs = new RecordingTabCoordinator(4, "https://example.com/first");
    const first = tabs.navigation(4);
    first.pendingNavigation = true;
    const second = tabs.navigation(5, "https://example.com/second");

    expect(second).toEqual({
      currentUrl: "https://example.com/second",
      pendingNavigation: false,
    });
    expect(tabs.navigation(4)).toBe(first);
    expect(tabs.navigation(4).pendingNavigation).toBe(true);
  });

  it("invalidates an earlier activation when a newer tab becomes active", () => {
    const tabs = new RecordingTabCoordinator(4);
    const second = tabs.noteActivation(5);
    const third = tabs.noteActivation(6);

    expect(tabs.isLatest(second)).toBe(false);
    expect(tabs.isLatest(third)).toBe(true);
    expect(tabs.commit(6)).toBe(4);
    expect(tabs.currentTabId).toBe(6);
  });
});
