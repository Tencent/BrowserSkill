import { describe, expect, it } from "vitest";
import type { RecordingDraftStep } from "@/lib/recording/types";
import { shouldRecordPress } from "../recording/draft-policy";
import { buildTraceV2 } from "../recording/trace-reducer-v2";

function reduceTraceSteps(steps: RecordingDraftStep[], startUrl?: string) {
  return buildTraceV2({
    steps,
    startedAt: "2026-01-01T00:00:00.000Z",
    ...(startUrl ? { startUrl } : {}),
  });
}

describe("shouldRecordPress", () => {
  it("keeps Enter and Escape", () => {
    expect(shouldRecordPress("Enter")).toBe(true);
    expect(shouldRecordPress("Escape")).toBe(true);
  });

  it("drops modifiers, clipboard shortcuts, and bare typing", () => {
    expect(shouldRecordPress("Meta")).toBe(false);
    expect(shouldRecordPress("c", ["meta"])).toBe(false);
    expect(shouldRecordPress("a", ["ctrl"])).toBe(false);
    expect(shouldRecordPress("x")).toBe(false);
    expect(shouldRecordPress("中")).toBe(false);
  });
});

describe("reduceTraceSteps", () => {
  it("does not expose internal tab transitions in trace v2", () => {
    const trace = reduceTraceSteps([
      {
        op: "switch_tab",
        preStateId: "s1",
        postStateId: "s2",
      },
    ]);
    expect(trace.steps).toEqual([]);
  });

  it("builds steps with pages dictionary and page id references", () => {
    const drafts: RecordingDraftStep[] = [
      {
        op: "navigate",
        url: "https://example.com/search?q=hello&utm_source=x",
        pageUrl: "https://example.com/search?q=hello&utm_source=x",
      },
      {
        op: "fill",
        captureTarget: { tag: "input", role: "textbox", name: "搜索", name_attr: "q" },
        value: "browser skill",
        pageUrl: "https://example.com/search?q=hello&utm_source=x",
      },
      {
        op: "press",
        key: "Enter",
        captureTarget: { tag: "input", role: "textbox", name: "搜索", name_attr: "q" },
        navigatedTo: "https://example.com/results/42",
        pageUrl: "https://example.com/search?q=hello&utm_source=x",
      },
      {
        op: "click",
        captureTarget: { tag: "button", role: "button", name: "发布" },
        navigatedTo: "https://example.com/p/99",
        pageUrl: "https://example.com/results/42",
      },
      {
        op: "press",
        key: "a",
        pageUrl: "https://example.com/p/99",
      },
    ];

    const { pages, steps } = reduceTraceSteps(
      drafts,
      "https://example.com/search?q=hello&utm_source=x",
    );
    expect(JSON.stringify(steps)).not.toContain("parameters");
    expect(JSON.stringify(steps)).not.toContain("intent");
    expect(JSON.stringify(steps)).not.toContain("summary");
    expect(steps.map((s) => s.op)).toEqual(["navigate", "fill", "press", "click"]);
    expect(pages.map((p) => p.url)).toEqual([
      "https://example.com/search?q=hello&utm_source=x",
      "https://example.com/results/42",
      "https://example.com/p/99",
    ]);

    expect(steps[0]).toMatchObject({
      id: 1,
      op: "navigate",
      page: "p1",
      to: "https://example.com/search?q=hello&utm_source=x",
    });

    expect(steps[1]).toMatchObject({
      op: "fill",
      page: "p1",
      value: "browser skill",
    });

    expect(steps[2]).toMatchObject({
      op: "press",
      key: "Enter",
      page: "p1",
      effect: { navigated_to: "p2" },
    });

    expect(steps[3]).toMatchObject({
      op: "click",
      page: "p2",
      effect: { navigated_to: "p3" },
    });
  });

  it("collapses consecutive navigations", () => {
    const { steps } = reduceTraceSteps([
      { op: "navigate", url: "https://a.example/redirect1" },
      { op: "navigate", url: "https://a.example/final" },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      op: "navigate",
      to: "https://a.example/final",
    });
  });

  it("keeps committed empty fill steps", () => {
    const { steps } = reduceTraceSteps(
      [
        {
          op: "fill",
          captureTarget: { tag: "input", role: "textbox", name: "Search query" },
          value: "",
          pageUrl: "https://example.com/search",
        },
      ],
      "https://example.com/search",
    );

    expect(steps).toEqual([
      expect.objectContaining({
        op: "fill",
        value: "",
      }),
    ]);
  });

  it("maps select navigatedTo onto effect.navigatedTo (page id)", () => {
    const { pages, steps } = reduceTraceSteps(
      [
        {
          op: "select",
          captureTarget: { tag: "select", role: "combobox", name: "分类" },
          values: ["tech"],
          labels: ["技术"],
          navigatedTo: "https://example.com/list?cat=tech",
          pageUrl: "https://example.com/list",
        },
      ],
      "https://example.com/list",
    );
    expect(pages.map((p) => p.url)).toEqual([
      "https://example.com/list",
      "https://example.com/list?cat=tech",
    ]);
    expect(steps[0]).toMatchObject({
      op: "select",
      page: "p1",
      selection: [{ value: "tech", label: "技术" }],
      effect: { navigated_to: "p2" },
    });
  });

  it("drops hover steps, which only exist in trace v3", () => {
    const { steps } = reduceTraceSteps(
      [
        {
          op: "hover",
          captureTarget: { tag: "span", role: "button", name: "Account" },
          pageUrl: "https://example.com/app",
        },
        {
          op: "click",
          captureTarget: { tag: "a", role: "link", name: "Profile" },
          pageUrl: "https://example.com/app",
        },
      ],
      "https://example.com/app",
    );
    expect(steps.map((s) => s.op)).toEqual(["click"]);
  });

  it("resolveTraceStartUrl prefers explicit start URL", () => {
    expect(
      buildTraceV2({
        steps: [{ op: "navigate", url: "https://example.com/other" }],
        startedAt: "2026-01-01T00:00:00.000Z",
        startUrl: "https://example.com/start",
      }).entry.start_url,
    ).toBe("https://example.com/start");
  });
});
