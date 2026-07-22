import { describe, expect, it, vi } from "vitest";
import { OverlayController, shouldShowAgentControlOverlay } from "../overlay-controller";

describe("OverlayController", () => {
  it("resets agent overlays without clearing user-tab borrow requests", () => {
    const controller = new OverlayController();

    controller.addBorrowRequest({
      id: "borrow-1",
      isActiveTab: true,
      tabTitle: "User page",
      timeoutMs: 5000,
      onAllow: vi.fn(),
      onDeny: vi.fn(),
    });
    controller.activateAgentSession("sess-1");
    controller.setAgentHelpRequest({
      id: "help-1",
      prompt: "Finish login",
      selectors: ["#login"],
      onContinue: vi.fn(),
      onCancel: vi.fn(),
    });
    controller.setAutomationBypass(true);

    controller.resetAgentOverlays("sess-1");

    const state = controller.snapshot();
    expect(state.borrowRequests).toHaveLength(1);
    expect(state.borrowRequests[0]?.id).toBe("borrow-1");
    expect(state.controlVisible).toBe(false);
    expect(state.activeSessionId).toBeNull();
    expect(state.activeHelp).toBeNull();
    expect(state.activeRecord).toBeNull();
    expect(state.automationBypassCount).toBe(0);
  });

  it("ignores a reset for a different session", () => {
    const controller = new OverlayController();

    controller.activateAgentSession("sess-1");
    controller.setAutomationBypass(true);

    controller.resetAgentOverlays("sess-2");

    const state = controller.snapshot();
    expect(state.activeSessionId).toBe("sess-1");
    expect(state.controlVisible).toBe(true);
    expect(state.automationBypassCount).toBe(1);
  });

  it("returns the previous help request when replacing agent help", () => {
    const controller = new OverlayController();

    controller.setAgentHelpRequest({
      id: "help-1",
      prompt: "First request",
      selectors: [],
      onContinue: vi.fn(),
      onCancel: vi.fn(),
    });
    const previous = controller.setAgentHelpRequest({
      id: "help-2",
      prompt: "Second request",
      selectors: [],
      onContinue: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(previous?.id).toBe("help-1");
    expect(controller.snapshot().activeHelp?.id).toBe("help-2");
  });

  it("tracks active record request state", () => {
    const controller = new OverlayController();

    controller.activateAgentSession("sess-1");
    controller.setAgentRecordRequest({
      id: "rec-1",
      onFinish: vi.fn(),
    });

    expect(controller.snapshot().activeRecord?.id).toBe("rec-1");
  });

  it("hides agent control overlay while recording is active", () => {
    const controller = new OverlayController();
    controller.activateAgentSession("sess-1");
    expect(shouldShowAgentControlOverlay(controller.snapshot())).toBe(true);

    controller.setAgentRecordRequest({
      id: "rec-1",
      onFinish: vi.fn(),
    });
    expect(shouldShowAgentControlOverlay(controller.snapshot())).toBe(false);
    expect(controller.snapshot().controlVisible).toBe(true);
  });

  it("keeps control hidden after record ends until session overlays reset", () => {
    const controller = new OverlayController();
    controller.activateAgentSession("sess-1");
    controller.setAgentRecordRequest({
      id: "rec-1",
      onFinish: vi.fn(),
    });
    controller.setAutomationBypass(true);
    controller.setAutomationBypass(true);

    controller.clearAgentRecordRequest("rec-1");
    expect(controller.snapshot().activeRecord).toBeNull();
    expect(controller.snapshot().suppressControlAfterRecord).toBe(true);
    expect(controller.snapshot().automationBypassCount).toBe(0);
    expect(shouldShowAgentControlOverlay(controller.snapshot())).toBe(false);

    controller.resetAgentOverlays("sess-1");
    expect(controller.snapshot().suppressControlAfterRecord).toBe(false);
    expect(controller.snapshot().controlVisible).toBe(false);
  });
});
