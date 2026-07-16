import { describe, expect, it } from "vitest";
import { appendRecordedPayload, observeRecordedNavigation } from "../recording-step-buffer";

describe("recording-step-buffer", () => {
  it("stores semantic click with summary", () => {
    const buffer = { steps: [], pendingNavigation: false };
    appendRecordedPayload(buffer, {
      op: "click",
      target: { tag: "button", role: "button", name: "发布" },
      summary: "点击「发布」按钮",
      expects_navigation: true,
    });
    expect(buffer.steps).toEqual([
      {
        op: "click",
        target: { tag: "button", role: "button", name: "发布" },
        summary: "点击「发布」按钮",
      },
    ]);
    expect(buffer.pendingNavigation).toBe(true);
  });

  it("annotates navigated_to on action-caused navigation instead of wait_for_navigation", () => {
    const buffer = {
      steps: [
        {
          op: "click" as const,
          target: { tag: "button", role: "button", name: "发布" },
          summary: "点击「发布」按钮",
        },
      ],
      currentUrl: "https://example.com/a",
      pendingNavigation: true,
      pendingNavigationDeadline: Date.now() + 5_000,
    };
    observeRecordedNavigation(buffer, "https://example.com/b", true);
    expect(buffer.steps).toEqual([
      {
        op: "click",
        target: { tag: "button", role: "button", name: "发布" },
        summary: "点击「发布」按钮",
        navigated_to: "https://example.com/b",
      },
    ]);
    expect(JSON.stringify(buffer.steps)).not.toContain("wait_for_navigation");
  });

  it("emits navigate for uncaused URL changes", () => {
    const buffer = {
      steps: [],
      currentUrl: "https://example.com/a",
      pendingNavigation: false,
    };
    observeRecordedNavigation(buffer, "https://example.com/b", false);
    expect(buffer.steps[0]).toMatchObject({
      op: "navigate",
      url: "https://example.com/b",
    });
  });
});
