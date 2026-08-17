import { describe, expect, it } from "vitest";
import { resetStateIdCounterForTests } from "@/lib/record-constants";
import {
  reduceTraceSteps,
  registerObservation,
  resolveTraceStartUrl,
  shouldRecordPress,
} from "../trace-reducer";

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

describe("reduceTraceSteps v3", () => {
  it("builds steps with state/result references and deduped states", () => {
    resetStateIdCounterForTests();
    const registry = new Map();
    const body = "@vom 1\nL1 page";
    const s1 = registerObservation(registry, {
      url: "https://example.com/search",
      rawVomText: body,
    });
    const s2 = registerObservation(registry, {
      url: "https://example.com/results/42",
      rawVomText: "@vom 1\nL1 results",
    });

    const { states, steps } = reduceTraceSteps(
      [
        {
          op: "navigate",
          url: "https://example.com/search",
          preStateId: s1,
          postStateId: s1,
        },
        {
          op: "fill",
          target: { ref: "e1", role: "textbox", name: "搜索" },
          value: "browser skill",
          commit: "enter",
          preStateId: s1,
          postStateId: s1,
        },
        {
          op: "press",
          key: "Enter",
          target: { ref: "e1", role: "textbox", name: "搜索" },
          preStateId: s1,
          postStateId: s2,
          navigated_to: "https://example.com/results/42",
        },
        {
          op: "click",
          target: { ref: "e2", role: "button", name: "发布" },
          preStateId: s2,
          postStateId: s2,
        },
      ],
      registry,
    );

    expect(states).toHaveLength(2);
    expect(steps.map((s) => s.op)).toEqual(["navigate", "fill", "press", "click"]);
    expect(steps[1]).toMatchObject({
      op: "fill",
      state: s1,
      result: { state: s1 },
      commit: "enter",
    });
    expect(steps[2]).toMatchObject({
      op: "press",
      state: s1,
      result: { state: s2 },
    });
    expect(JSON.stringify(steps)).not.toContain("page");
    expect(JSON.stringify(steps)).not.toContain("effect");
  });

  it("collapses consecutive navigations", () => {
    resetStateIdCounterForTests();
    const registry = new Map();
    const s1 = registerObservation(registry, {
      url: "https://a.example/redirect1",
      rawVomText: "a",
    });
    const { steps } = reduceTraceSteps(
      [
        { op: "navigate", url: "https://a.example/redirect1", preStateId: s1, postStateId: s1 },
        { op: "navigate", url: "https://a.example/final", preStateId: s1, postStateId: s1 },
      ],
      registry,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      op: "navigate",
      to: "https://a.example/final",
    });
  });

  it("keeps the origin state and cause of the hop that started a redirect chain", () => {
    resetStateIdCounterForTests();
    const registry = new Map();
    const start = registerObservation(registry, {
      url: "https://example.com/",
      rawVomText: "start",
    });
    const hop = registerObservation(registry, {
      url: "https://iwiki.woa.com/",
      rawVomText: "hop",
    });
    const landing = registerObservation(registry, {
      url: "https://iwiki.woa.com/dashboard",
      rawVomText: "landing",
    });

    const { steps, stepIdByDraftId } = reduceTraceSteps(
      [
        {
          op: "navigate",
          url: "https://iwiki.woa.com/",
          preStateId: start,
          postStateId: hop,
          transitionType: "typed",
        },
        {
          op: "navigate",
          url: "https://iwiki.woa.com/dashboard",
          preStateId: hop,
          postStateId: landing,
          transitionType: "link",
        },
      ],
      registry,
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      op: "navigate",
      id: 1,
      state: start,
      result: { state: landing },
      to: "https://iwiki.woa.com/dashboard",
      cause: "user_typed",
    });
    // Both drafts fold into step 1, so anything tagged with either draft id
    // must resolve to it.
    expect(stepIdByDraftId.get(1)).toBe(1);
    expect(stepIdByDraftId.get(2)).toBe(1);
  });

  it("maps draft ids to published step ids across dropped drafts", () => {
    resetStateIdCounterForTests();
    const registry = new Map();
    const s1 = registerObservation(registry, { url: "https://a.example/", rawVomText: "a" });

    const { steps, stepIdByDraftId } = reduceTraceSteps(
      [
        // Dropped: bare typing press.
        { op: "press", key: "a", preStateId: s1, postStateId: s1 },
        { op: "click", target: { ref: "e2" }, preStateId: s1, postStateId: s1 },
      ],
      registry,
    );

    expect(steps.map((step) => step.op)).toEqual(["click"]);
    expect(stepIdByDraftId.get(1)).toBeUndefined();
    expect(stepIdByDraftId.get(2)).toBe(1);
  });

  it("keeps committed empty fills", () => {
    resetStateIdCounterForTests();
    const registry = new Map();
    const s1 = registerObservation(registry, { url: "https://a.example/", rawVomText: "a" });

    const { steps } = reduceTraceSteps(
      [
        { op: "fill", target: { ref: "e1", role: "textbox", name: "Search" }, value: "", preStateId: s1, postStateId: s1 },
        { op: "click", target: { ref: "e2", role: "button", name: "Apply" }, preStateId: s1, postStateId: s1 },
      ],
      registry,
    );

    expect(steps.map((step) => step.op)).toEqual(["fill", "click"]);
    expect(steps[0]).toMatchObject({ op: "fill", value: "" });
  });

  it("keeps hover steps before menu clicks", () => {
    resetStateIdCounterForTests();
    const registry = new Map();
    const state = registerObservation(registry, {
      url: "https://example.com/app",
      rawVomText: '@e1 button "Account"\n@e2 link "Profile"',
    });
    const { steps } = reduceTraceSteps(
      [
        {
          op: "hover",
          target: { ref: "e1", role: "button", name: "Account" },
          page_url: "https://example.com/app",
          preStateId: state,
          postStateId: state,
        },
        {
          op: "click",
          target: { ref: "e2", role: "link", name: "Profile" },
          page_url: "https://example.com/app",
          preStateId: state,
          postStateId: state,
        },
      ],
      registry,
    );
    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      state,
      result: { state },
      target: { name: "Account" },
    });
  });

  it("resolveTraceStartUrl prefers explicit start URL", () => {
    expect(
      resolveTraceStartUrl(
        [{ op: "navigate", url: "https://example.com/other", preStateId: "s1", postStateId: "s1" }],
        "https://example.com/start",
      ),
    ).toBe("https://example.com/start");
  });
});
