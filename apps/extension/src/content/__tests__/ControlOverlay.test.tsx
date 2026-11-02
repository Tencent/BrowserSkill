import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlOverlay } from "../ControlOverlay";

describe("ControlOverlay fallback", () => {
  const sendMessage = vi.fn();
  beforeEach(() => {
    sendMessage.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps page blocker none under automationBypass but Interrupt stays clickable", () => {
    const { container, getByRole, queryByRole } = render(
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

    expect(container.querySelector("[data-slot='control-overlay-card']")).not.toBeNull();
    expect(getByRole("status").textContent).toBe("Agent 正在控制");
    expect((getByRole("button", { name: "停止任务" }) as HTMLButtonElement).disabled).toBe(false);
    expect(queryByRole("button", { name: "暂停 Agent" })).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
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

  it("keeps stop disabled while interrupting without sending cooperation messages", () => {
    const onInterrupt = vi.fn();
    const { getByRole } = render(
      <ControlOverlay visible interrupting automationBypass={false} onInterrupt={onInterrupt} />,
    );
    const stop = getByRole("button", { name: "中断中…" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    fireEvent.click(stop);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reuses the card and glow while removing fallback input blocking when cooperation arrives", () => {
    const props = {
      visible: true,
      interrupting: false,
      automationBypass: false,
      onInterrupt: vi.fn(),
    };
    const { container, getByRole, rerender } = render(<ControlOverlay {...props} />);
    const card = getByRole("toolbar");
    const glow = container.querySelector('[data-slot="control-overlay"]');
    const scroll = (type: string) => window.dispatchEvent(new Event(type, { cancelable: true }));
    expect(scroll("wheel")).toBe(false);
    expect(scroll("touchmove")).toBe(false);

    rerender(<ControlOverlay {...props} state={{ mode: "ready", editing: false, revision: 23 }} />);
    expect(getByRole("toolbar")).toBe(card);
    expect(container.querySelector('[data-slot="control-overlay"]')).toBe(glow);
    expect(container.querySelector('[data-slot="control-overlay-blocker"]')).toBeNull();
    expect(scroll("wheel")).toBe(true);
    expect(scroll("touchmove")).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("restores fallback scroll blocking after bypass and removes it when hidden or unmounted", () => {
    const props = {
      visible: true,
      interrupting: false,
      automationBypass: false,
      onInterrupt: vi.fn(),
    };
    const { container, rerender, unmount } = render(<ControlOverlay {...props} />);
    const scroll = () => window.dispatchEvent(new Event("wheel", { cancelable: true }));
    expect(scroll()).toBe(false);
    rerender(<ControlOverlay {...props} automationBypass />);
    expect(scroll()).toBe(true);
    rerender(<ControlOverlay {...props} />);
    expect(scroll()).toBe(false);
    rerender(<ControlOverlay {...props} visible={false} />);
    expect(container.childElementCount).toBe(0);
    expect(scroll()).toBe(true);
    rerender(<ControlOverlay {...props} />);
    expect(scroll()).toBe(false);
    unmount();
    expect(scroll()).toBe(true);
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
