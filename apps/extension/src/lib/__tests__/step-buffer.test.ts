import { describe, expect, it } from "vitest";
import { appendRecordedPayload, observeRecordedNavigation } from "../recording/step-buffer";

describe("recording-step-buffer", () => {
  it("stores semantic click without summary", () => {
    const buffer = { steps: [], navigation: { pendingNavigation: false } };
    appendRecordedPayload(buffer, {
      op: "click",
      target: { tag: "button", role: "button", name: "发布" },
      expects_navigation: true,
    });
    expect(buffer.steps).toEqual([
      {
        op: "click",
        captureTarget: { tag: "button", role: "button", name: "发布" },
      },
    ]);
    expect(buffer.navigation.pendingNavigation).toBe(true);
  });

  it("keeps the hovered element description as a capture fallback", () => {
    const buffer = { steps: [], navigation: { pendingNavigation: false } };
    appendRecordedPayload(
      buffer,
      {
        op: "hover",
        target: { tag: "button", role: "button", name: "新建" },
        geometry: {
          rect: { x: 900, y: 8, w: 60, h: 32 },
          tag: "button",
        },
      },
      {
        geometry: {
          rect: { x: 900, y: 8, w: 60, h: 32 },
          tag: "button",
        },
      },
    );
    expect(buffer.steps).toEqual([
      {
        op: "hover",
        captureTarget: { tag: "button", role: "button", name: "新建" },
        targetHint: {
          geometry: {
            rect: { x: 900, y: 8, w: 60, h: 32 },
            tag: "button",
          },
        },
      },
    ]);
  });

  it("annotates navigated_to on action-caused navigation instead of wait_for_navigation", () => {
    const buffer = {
      steps: [
        {
          op: "click" as const,
          captureTarget: { tag: "button", role: "button", name: "发布" },
        },
      ],
      navigation: {
        currentUrl: "https://example.com/a",
        pendingNavigation: true,
        pendingNavigationDeadline: Date.now() + 5_000,
      },
    };
    observeRecordedNavigation(buffer, "https://example.com/b", true);
    expect(buffer.steps).toEqual([
      {
        op: "click",
        captureTarget: { tag: "button", role: "button", name: "发布" },
        navigatedTo: "https://example.com/b",
      },
    ]);
    expect(JSON.stringify(buffer.steps)).not.toContain("wait_for_navigation");
  });

  it("annotates navigated_to onto a select that auto-submits a navigation", () => {
    const buffer = {
      steps: [
        {
          op: "select" as const,
          captureTarget: { tag: "select", role: "combobox", name: "分类" },
          values: ["tech"],
        },
      ],
      navigation: {
        currentUrl: "https://example.com/list",
        pendingNavigation: true,
        pendingNavigationDeadline: Date.now() + 5_000,
      },
    };
    observeRecordedNavigation(buffer, "https://example.com/list?cat=tech", true);
    expect(buffer.steps).toEqual([
      {
        op: "select",
        captureTarget: { tag: "select", role: "combobox", name: "分类" },
        values: ["tech"],
        navigatedTo: "https://example.com/list?cat=tech",
      },
    ]);
  });

  it("emits navigate for uncaused URL changes", () => {
    const buffer = {
      steps: [],
      navigation: { currentUrl: "https://example.com/a", pendingNavigation: false },
    };
    const result = observeRecordedNavigation(buffer, "https://example.com/b", false);
    expect(result).toEqual({ kind: "appended", index: 0 });
    expect(buffer.steps[0]).toMatchObject({
      op: "navigate",
      url: "https://example.com/b",
    });
  });

  it("records a reload of the current page instead of dropping it as a same-URL navigation", () => {
    const buffer = {
      steps: [],
      navigation: { currentUrl: "https://example.com/a", pendingNavigation: false },
    };
    const result = observeRecordedNavigation(
      buffer,
      "https://example.com/a",
      undefined,
      "reload",
      [],
    );
    expect(result).toEqual({ kind: "appended", index: 0 });
    expect(buffer.steps[0]).toMatchObject({
      op: "navigate",
      url: "https://example.com/a",
      transitionType: "reload",
    });
  });

  it("still collapses the completion that follows a reload onto the recorded step", () => {
    const buffer = {
      steps: [],
      navigation: { currentUrl: "https://example.com/a", pendingNavigation: false },
    };
    observeRecordedNavigation(buffer, "https://example.com/a", undefined, "reload", []);
    // webNavigation.onCompleted reports the same URL and carries no transition type.
    expect(observeRecordedNavigation(buffer, "https://example.com/a")).toEqual({ kind: "noop" });
    expect(buffer.steps).toHaveLength(1);
  });

  it("asks the recorder to coalesce redirect hops instead of emitting each one", () => {
    const buffer = {
      steps: [],
      navigation: {
        currentUrl: "https://passport.example/login",
        pendingNavigation: false,
      },
    };
    const hop1 = observeRecordedNavigation(
      buffer,
      "https://passport.example/callback",
      false,
      "link",
      ["server_redirect"],
    );
    expect(hop1).toEqual({
      kind: "coalesce_redirect",
      url: "https://passport.example/callback",
    });
    expect(buffer.steps).toEqual([]);

    const hop2 = observeRecordedNavigation(buffer, "https://app.example/dashboard", false, "link", [
      "client_redirect",
    ]);
    expect(hop2).toEqual({
      kind: "coalesce_redirect",
      url: "https://app.example/dashboard",
    });
    expect(buffer.steps).toEqual([]);
    expect(buffer.navigation.currentUrl).toBe("https://app.example/dashboard");
  });

  it("does not reuse redirect metadata for a later content-observed URL change", () => {
    const buffer = {
      steps: [],
      navigation: {
        currentUrl: "https://example.com/redirect",
        pendingNavigation: false,
      },
    };

    const result = observeRecordedNavigation(buffer, "https://example.com/spa");

    expect(result).toEqual({ kind: "appended", index: 0 });
    expect(buffer.steps[0]).toMatchObject({ op: "navigate", url: "https://example.com/spa" });
  });
});
