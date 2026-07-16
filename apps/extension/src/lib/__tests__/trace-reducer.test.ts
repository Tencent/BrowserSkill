import { describe, expect, it } from "vitest";
import { buildTraceEntry, reduceTraceSteps, shouldRecordPress } from "../trace-reducer";
import type { DraftTraceStep } from "@/transport/types";

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
  it("builds textbook steps with page, intent, effect; no parameters", () => {
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
        page_url: "https://example.com/search",
      },
      {
        op: "press",
        key: "Enter",
        target: { tag: "input", role: "textbox", name: "搜索", name_attr: "q" },
        navigated_to: "https://example.com/results/42",
        page_url: "https://example.com/search",
      },
      {
        op: "click",
        target: { tag: "button", role: "button", name: "发布" },
        summary: "点击「发布」按钮",
        navigated_to: "https://example.com/p/99",
        page_url: "https://example.com/results/42",
      },
      {
        op: "press",
        key: "a",
        page_url: "https://example.com/p/99",
      },
    ];

    const steps = reduceTraceSteps(drafts);
    expect(JSON.stringify(steps)).not.toContain("parameters");
    expect(steps.map((s) => s.op)).toEqual(["navigate", "fill", "press", "click"]);

    expect(steps[0]).toMatchObject({
      id: 1,
      op: "navigate",
      intent: "open_entry",
      destination: {
        url: "https://example.com/search?q=hello&utm_source=x",
        url_pattern: "https://example.com/search?q=hello",
      },
    });

    expect(steps[1]).toMatchObject({
      op: "fill",
      intent: "provide_input",
      value: "browser skill",
      summary: "在「搜索」填入 browser skill",
    });

    expect(steps[2]).toMatchObject({
      op: "press",
      intent: "search",
      key: "Enter",
      effect: {
        navigated_to: "https://example.com/results/42",
        url_pattern_after: "https://example.com/results/*",
      },
    });

    expect(steps[3]).toMatchObject({
      op: "click",
      intent: "confirm",
      effect: {
        navigated_to: "https://example.com/p/99",
        url_pattern_after: "https://example.com/p/*",
      },
    });
  });

  it("collapses consecutive navigations", () => {
    const steps = reduceTraceSteps([
      { op: "navigate", url: "https://a.example/redirect1" },
      { op: "navigate", url: "https://a.example/final" },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.destination?.url).toBe("https://a.example/final");
  });

  it("buildTraceEntry adds site and pattern", () => {
    expect(buildTraceEntry("https://iwiki.woa.com/p/1")).toEqual({
      start_url: "https://iwiki.woa.com/p/1",
      start_url_pattern: "https://iwiki.woa.com/p/*",
      site: "iwiki.woa.com",
    });
  });
});
