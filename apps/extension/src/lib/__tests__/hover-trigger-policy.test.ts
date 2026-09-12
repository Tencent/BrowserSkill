import { describe, expect, it } from "vitest";
import { evaluateHoverTrigger } from "../hover-trigger-policy";

describe("evaluateHoverTrigger", () => {
  it("accepts explicit popup triggers", () => {
    const decision = evaluateHoverTrigger({
      tag: "button",
      role: "button",
      label: "Open user navigation menu",
      attrs: { "aria-haspopup": "menu", "aria-expanded": "false" },
      rect: { x: 900, y: 8, w: 32, h: 32 },
      cursor: "pointer",
      pointerEvents: "auto",
    });

    expect(decision.eligible).toBe(true);
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["aria-haspopup", "collapsed", "popup-signal"]),
    );
  });

  it("accepts compact topbar image buttons without popup attributes", () => {
    const decision = evaluateHoverTrigger({
      tag: "button",
      role: "button",
      label: "image",
      attrs: {},
      rect: { x: 900, y: 8, w: 32, h: 32 },
      pointerEvents: "auto",
      hasGraphicDescendant: true,
    });

    expect(decision.eligible).toBe(true);
    expect(decision.reasons).toEqual(expect.arrayContaining(["icon-only", "topbar", "compact"]));
  });

  it("accepts compact topbar image links without popup attributes", () => {
    const decision = evaluateHoverTrigger({
      tag: "a",
      role: "link",
      label: "image",
      attrs: {},
      rect: { x: 900, y: 8, w: 32, h: 32 },
      pointerEvents: "auto",
      hasGraphicDescendant: true,
    });

    expect(decision.eligible).toBe(true);
    expect(decision.reasons).toEqual(expect.arrayContaining(["icon-only", "topbar", "compact"]));
  });

  it("rejects topbar menu links without surface trigger evidence", () => {
    const decision = evaluateHoverTrigger({
      tag: "a",
      role: "link",
      label: "My profile",
      attrs: {},
      rect: { x: 820, y: 72, w: 96, h: 32 },
      cursor: "pointer",
      pointerEvents: "auto",
    });

    expect(decision.eligible).toBe(false);
  });

  it("rejects text navigation items even when their attributes contain popup words", () => {
    const decision = evaluateHoverTrigger({
      tag: "a",
      role: "link",
      label: "My profile",
      attrs: { class: "dropdown-item profile-link" },
      rect: { x: 820, y: 72, w: 96, h: 32 },
      cursor: "pointer",
      pointerEvents: "auto",
    });

    expect(decision.eligible).toBe(false);
  });

  it("rejects labelled dropdown list items as hover triggers", () => {
    const decision = evaluateHoverTrigger({
      tag: "li",
      label: "文档C+D",
      attrs: { class: "dropdown-item", tabindex: "0" },
      rect: { x: 820, y: 48, w: 160, h: 32 },
      cursor: "pointer",
      pointerEvents: "auto",
    });

    expect(decision.eligible).toBe(false);
  });

  it("rejects ordinary controls without hover popup signals", () => {
    const decision = evaluateHoverTrigger({
      tag: "button",
      role: "button",
      label: "Search",
      attrs: {},
      rect: { x: 100, y: 240, w: 120, h: 36 },
      pointerEvents: "auto",
    });

    expect(decision.eligible).toBe(false);
  });

  it("rejects unsafe or non-visible triggers", () => {
    expect(
      evaluateHoverTrigger({
        tag: "input",
        attrs: {},
        rect: { x: 10, y: 10, w: 80, h: 24 },
        pointerEvents: "auto",
      }).eligible,
    ).toBe(false);
    expect(
      evaluateHoverTrigger({
        tag: "button",
        role: "button",
        attrs: { hidden: "" },
        rect: { x: 10, y: 10, w: 80, h: 24 },
        pointerEvents: "auto",
      }).eligible,
    ).toBe(false);
  });
});
