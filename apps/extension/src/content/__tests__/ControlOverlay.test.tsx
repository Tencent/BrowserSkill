import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlOverlay, NOTE_MAX_CHARS } from "../ControlOverlay";

function baseProps() {
  return {
    visible: true,
    mode: "control" as const,
    interrupting: false,
    automationBypass: false,
    onInterrupt: vi.fn(),
    onReturnControl: vi.fn(),
  };
}

describe("ControlOverlay", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps page blocker none under automationBypass but Take over stays clickable", () => {
    const { container } = render(<ControlOverlay {...baseProps()} automationBypass={true} />);

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
    const { container } = render(<ControlOverlay {...baseProps()} />);

    const blocker = container.querySelector("[data-slot='control-overlay-blocker']");
    expect(blocker).toBeTruthy();
    expect((blocker as HTMLElement).style.pointerEvents).toBe("auto");
  });

  it("calls onInterrupt from the take-over button", () => {
    const props = baseProps();
    const { container } = render(<ControlOverlay {...props} />);

    const stopBtn = container.querySelector("[data-slot='control-overlay-stop-all']");
    fireEvent.click(stopBtn as HTMLButtonElement);

    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("shows the idle action line when the agent has nothing in flight", () => {
    const { container } = render(<ControlOverlay {...baseProps()} currentAction={null} />);

    const action = container.querySelector("[data-slot='control-overlay-action']");
    expect(action?.textContent).toBe("等待下一步指令");
  });

  it.each([
    ["tool.click", "@e3", "点击 @e3"],
    ["tool.hover", "#js-link-box-pt", "悬停 #js-link-box-pt"],
    ["tool.fill", "input#searchInput", "输入 input#searchInput"],
    ["tool.navigate", "https://example.test/x", "导航 https://example.test/x"],
    ["tool.press", "Enter", "按键 Enter"],
    ["tool.wheel", undefined, "滚动"],
    ["tool.unknown_thing", undefined, "正在执行…"],
  ])("renders the action line for %s", (tool, target, expected) => {
    const { container } = render(
      <ControlOverlay {...baseProps()} currentAction={{ tool, ...(target ? { target } : {}) }} />,
    );

    const action = container.querySelector("[data-slot='control-overlay-action']");
    expect(action?.textContent).toBe(expected);
    expect((action as HTMLElement).style.fontSize).toBe("13px");
    expect((action as HTMLElement).style.color).toBe("#6b7280");
  });

  it("renders the paused pill with a note field and a return button, and no blocker", () => {
    const { container } = render(<ControlOverlay {...baseProps()} mode="paused" />);

    expect(container.querySelector("[data-slot='control-overlay-blocker']")).toBeNull();
    expect(container.querySelector("[data-slot='control-overlay']")).toBeNull();
    expect(
      (container.querySelector("[data-slot='control-overlay-pill']") as HTMLElement).dataset.mode,
    ).toBe("paused");

    const note = container.querySelector("[data-slot='control-overlay-note']");
    expect(note).toBeTruthy();
    expect((note as HTMLInputElement).placeholder).toBe("给 Agent 的备注（可选）");

    expect(container.querySelector("[data-slot='control-overlay-return']")).toBeTruthy();
    expect(container.querySelector("[data-slot='control-overlay-stop-all']")).toBeNull();
  });

  it("calls onReturnControl with the note when the return button is clicked", () => {
    const props = baseProps();
    const { container } = render(<ControlOverlay {...props} mode="paused" />);

    const note = container.querySelector("[data-slot='control-overlay-note']") as HTMLInputElement;
    fireEvent.change(note, { target: { value: "我登录好了" } });

    fireEvent.click(container.querySelector("[data-slot='control-overlay-return']") as HTMLElement);

    expect(props.onReturnControl).toHaveBeenCalledWith("我登录好了");
  });

  it("caps the note field so an unbounded string never reaches the daemon", () => {
    // The daemon cuts the note at 4096 bytes and keeps it in its interrupt
    // registry until a waiter consumes it; the field must stay inside that.
    const { container } = render(<ControlOverlay {...baseProps()} mode="paused" />);

    const note = container.querySelector("[data-slot='control-overlay-note']") as HTMLInputElement;
    expect(note.maxLength).toBe(NOTE_MAX_CHARS);
    expect(NOTE_MAX_CHARS).toBeLessThanOrEqual(4096);
  });

  it("calls onReturnControl when Enter is pressed in the note field", () => {
    const props = baseProps();
    const { container } = render(<ControlOverlay {...props} mode="paused" />);

    const note = container.querySelector("[data-slot='control-overlay-note']") as HTMLInputElement;
    fireEvent.keyDown(note, { key: "Enter" });

    expect(props.onReturnControl).toHaveBeenCalledWith("");
  });

  it("renders nothing while hidden", () => {
    const { container } = render(<ControlOverlay {...baseProps()} visible={false} />);
    expect(container.querySelector("[data-slot='control-overlay-pill']")).toBeNull();
  });
});
