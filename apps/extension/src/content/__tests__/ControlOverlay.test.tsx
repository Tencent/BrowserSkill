import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlOverlay } from "../ControlOverlay";

describe("ControlOverlay", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps page blocker none under automationBypass but Interrupt stays clickable", () => {
    const { container } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={true}
        onInterrupt={() => {}}
      />,
    );

    const blocker = container.querySelector("[data-slot='control-overlay-blocker']");
    expect(blocker).toBeTruthy();
    expect((blocker as HTMLElement).style.pointerEvents).toBe("none");

    const pill = container.querySelector("[data-slot='control-overlay-pill']");
    expect(pill).toBeTruthy();
    expect((pill as HTMLElement).style.pointerEvents).toBe("auto");

    const stopBtn = container.querySelector("[data-slot='control-overlay-stop-all']");
    expect(stopBtn).toBeTruthy();
    expect((stopBtn as HTMLElement).style.pointerEvents).toBe("auto");
  });

  it("uses pointer-events auto on blocker when automationBypass is false", () => {
    const { container } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        onInterrupt={() => {}}
      />,
    );

    const blocker = container.querySelector("[data-slot='control-overlay-blocker']");
    expect(blocker).toBeTruthy();
    expect((blocker as HTMLElement).style.pointerEvents).toBe("auto");
  });

  it("calls onInterrupt from the stop button", () => {
    const onInterrupt = vi.fn();
    const { container } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        onInterrupt={onInterrupt}
      />,
    );

    const stopBtn = container.querySelector("[data-slot='control-overlay-stop-all']");
    (stopBtn as HTMLButtonElement).click();

    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  describe("control glow", () => {
    function renderGlow() {
      const { container } = render(
        <ControlOverlay
          visible={true}
          interrupting={false}
          automationBypass={false}
          onInterrupt={() => {}}
        />,
      );
      const rules = Array.from(container.querySelectorAll("style")).flatMap((style) =>
        Array.from(style.sheet?.cssRules ?? []),
      );
      return {
        container,
        rules,
        glow: container.querySelector<HTMLElement>("[data-slot='control-overlay']")!,
        pulse: container.querySelector<HTMLElement>("[data-slot='control-overlay-pulse']")!,
      };
    }

    const animationsFor = (element: Element, rules: CSSRule[]) =>
      rules
        .filter(
          (rule): rule is CSSStyleRule =>
            rule instanceof CSSStyleRule && element.matches(rule.selectorText),
        )
        .map((rule) => rule.style.animation);

    it("paints the glow once and pulses only a pre-painted layer's opacity, twice", () => {
      const { container, rules, glow, pulse } = renderGlow();

      // The viewport-sized shadows are static paint, never animated themselves.
      expect(glow.style.boxShadow).toContain("inset");
      expect(glow.style.animation).toBe("");
      expect(pulse.style.boxShadow).toContain("inset");
      expect(pulse.style.opacity).toBe("0");

      const keyframes = rules.filter(
        (rule): rule is CSSKeyframesRule => rule instanceof CSSKeyframesRule,
      );
      expect(keyframes).not.toHaveLength(0);
      for (const frame of keyframes.flatMap((rule) => Array.from(rule.cssRules))) {
        const { style } = frame as CSSKeyframeRule;
        expect(Array.from({ length: style.length }, (_, i) => style.item(i))).toEqual(["opacity"]);
      }

      expect(animationsFor(pulse, rules)).toEqual(["bsk-breathe 3s ease-in-out 2"]);
      for (const element of container.querySelectorAll("*"))
        expect(getComputedStyle(element).animation).not.toContain("infinite");
    });

    it("keeps only the static glow under prefers-reduced-motion", () => {
      const { rules, glow, pulse } = renderGlow();
      const reduced = rules
        .filter(
          (rule): rule is CSSMediaRule =>
            rule instanceof CSSMediaRule &&
            rule.media.mediaText.includes("prefers-reduced-motion: reduce"),
        )
        .flatMap((rule) => Array.from(rule.cssRules));

      expect(animationsFor(pulse, reduced)).toEqual(["none"]);
      expect(glow.style.boxShadow).toContain("inset");
    });
  });
});
