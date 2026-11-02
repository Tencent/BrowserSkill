import { i18n } from "@browser-skill/i18n";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOPERATION_CONTROL, type CooperationView } from "@/cooperation/types";
import { ControlOverlay } from "../ControlOverlay";

const view = (mode: CooperationView["mode"], extra = {}): CooperationView => ({
  mode,
  revision: 17,
  editing: false,
  ...extra,
});
const modes = ["ready", "acting", "human", "held", "yielding", "syncing", "unavailable"] as const;

describe("ControlOverlay cooperation", () => {
  const sendMessage = vi.fn();
  beforeEach(() => {
    sendMessage.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not render hidden controls even with an active cooperation state", () => {
    const { container } = render(
      <ControlOverlay
        visible={false}
        state={view("ready")}
        interrupting={false}
        automationBypass={false}
        onInterrupt={vi.fn()}
      />,
    );
    expect(container.childElementCount).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(modes)("preserves control messages and stop behavior in %s mode", async (mode) => {
    const onStop = vi.fn();
    const { container, getByRole } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        state={view(mode)}
        onInterrupt={onStop}
      />,
    );
    const glow = container.querySelector<HTMLElement>('[data-slot="control-overlay"]');
    expect(glow).not.toBeNull();
    expect(glow?.style.pointerEvents).toBe("none");
    expect(glow?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[data-slot="control-overlay-blocker"]')).toBeNull();
    expect(container.querySelector('[data-slot="control-overlay-card"]')).toBeNull();
    const resume = mode === "human" || mode === "held";
    const action = getByRole("button", {
      name: i18n.t(resume ? "cooperation.resume" : "cooperation.hold", { ns: "extension" }),
    }) as HTMLButtonElement;
    expect(getByRole("status").textContent).toContain(
      i18n.t(`cooperation.${mode}`, { ns: "extension" }),
    );
    expect(getByRole("status").textContent).toContain(
      i18n.t(`cooperation.hints.${mode}`, { ns: "extension" }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(action.disabled).toBe(mode === "yielding");
    await act(async () => fireEvent.click(action));
    if (mode === "yielding") expect(sendMessage).not.toHaveBeenCalled();
    else {
      expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
        kind: COOPERATION_CONTROL,
        revision: 17,
        action: resume ? "resume" : "hold",
      });
    }
    fireEvent.click(getByRole("button", { name: "停止任务" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("keeps editing and explicit pause distinct and uses the latest revision", async () => {
    const onStop = vi.fn();
    const { getByRole, rerender } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        state={view("human", { editing: true })}
        onInterrupt={onStop}
      />,
    );
    expect(getByRole("status").textContent).toBe("你正在编辑完成编辑后交给 Agent");
    rerender(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        state={view("held", { revision: 23, editing: true })}
        onInterrupt={onStop}
      />,
    );
    expect(getByRole("status").textContent).toBe("Agent 已暂停准备好后交给 Agent");
    await act(async () => fireEvent.click(getByRole("button", { name: "交给 Agent" })));
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      kind: COOPERATION_CONTROL,
      revision: 23,
      action: "resume",
    });
  });

  it("blocks duplicate hand-back while pending and keeps stop available", async () => {
    let finish: () => void = () => {};
    sendMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const onStop = vi.fn();
    const { getByRole } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        state={view("human")}
        onInterrupt={onStop}
      />,
    );
    const action = getByRole("button", { name: "交给 Agent" }) as HTMLButtonElement;
    fireEvent.click(action);
    expect(action.disabled).toBe(true);
    fireEvent.click(action);
    fireEvent.click(getByRole("button", { name: "停止任务" }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(action.disabled).toBe(false);
  });

  it("does not steal an editing field's focus when handing back with the mouse", async () => {
    const user = userEvent.setup();
    const { getByRole } = render(
      <>
        <input aria-label="Page field" />
        <ControlOverlay
          visible={true}
          interrupting={false}
          automationBypass={false}
          state={view("human", { editing: true })}
          onInterrupt={vi.fn()}
        />
      </>,
    );
    const field = getByRole("textbox");
    await user.click(field);
    await user.click(getByRole("button", { name: "交给 Agent" }));
    expect(document.activeElement).toBe(field);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("supports handing back with the keyboard", async () => {
    const user = userEvent.setup();
    const { getByRole } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        state={view("held")}
        onInterrupt={vi.fn()}
      />,
    );
    await user.tab();
    expect(document.activeElement).toBe(getByRole("button", { name: "交给 Agent" }));
    await user.keyboard("{Enter}");
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      kind: COOPERATION_CONTROL,
      revision: 17,
      action: "resume",
    });
  });

  it("keeps target coordinates and expiration independent of card rendering", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        state={view("acting", { target: { x: 75, y: 120, expires: Date.now() + 500 } })}
        onInterrupt={vi.fn()}
      />,
    );
    const target = container.querySelector<HTMLElement>(".bsk-cooperation-target");
    expect(target?.style.left).toBe("75px");
    expect(target?.style.top).toBe("120px");
    expect(target?.getAttribute("aria-hidden")).toBe("true");
    act(() => vi.advanceTimersByTime(500));
    expect(container.querySelector(".bsk-cooperation-target")).toBeNull();
    rerender(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        state={view("acting", { target: { x: 90, y: 150, expires: Date.now() + 500 } })}
        onInterrupt={vi.fn()}
      />,
    );
    expect(container.querySelector<HTMLElement>(".bsk-cooperation-target")?.style.left).toBe(
      "90px",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
