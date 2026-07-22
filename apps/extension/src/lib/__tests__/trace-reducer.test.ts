import { describe, expect, it } from "vitest";
import type { DraftTraceStep } from "@/transport/types";
import { reduceTraceSteps, resolveTraceStartUrl, shouldRecordPress } from "../trace-reducer";

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
  it("builds steps with pages dictionary and page id references", () => {
    const drafts: DraftTraceStep[] = [
      {
        op: "navigate",
        url: "https://example.com/search?q=hello&utm_source=x",
        page_url: "https://example.com/search?q=hello&utm_source=x",
      },
      {
        op: "fill",
        target: { tag: "input", role: "textbox", name: "搜索", name_attr: "q" },
        value: "browser skill",
        page_url: "https://example.com/search?q=hello&utm_source=x",
      },
      {
        op: "press",
        key: "Enter",
        target: { tag: "input", role: "textbox", name: "搜索", name_attr: "q" },
        navigated_to: "https://example.com/results/42",
        page_url: "https://example.com/search?q=hello&utm_source=x",
      },
      {
        op: "click",
        target: { tag: "button", role: "button", name: "发布" },
        navigated_to: "https://example.com/p/99",
        page_url: "https://example.com/results/42",
      },
      {
        op: "press",
        key: "a",
        page_url: "https://example.com/p/99",
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

  it("maps select navigated_to onto effect.navigated_to (page id)", () => {
    const { pages, steps } = reduceTraceSteps(
      [
        {
          op: "select",
          target: { tag: "select", role: "combobox", name: "分类" },
          values: ["tech"],
          labels: ["技术"],
          navigated_to: "https://example.com/list?cat=tech",
          page_url: "https://example.com/list",
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

  it("resolveTraceStartUrl prefers explicit start URL", () => {
    expect(
      resolveTraceStartUrl(
        [{ op: "navigate", url: "https://example.com/other" }],
        "https://example.com/start",
      ),
    ).toBe("https://example.com/start");
  });
});
