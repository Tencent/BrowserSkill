import { describe, expect, it, vi } from "vitest";
import {
  OverlayController,
  shouldShowAgentControlOverlay,
  shouldShowInterruptingOverlay,
} from "../overlay-controller";

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

  it("hides control while paused and shows it again only after authoritative control mode", () => {
    const controller = new OverlayController();

    controller.applyAgentControlMode("sess-1", "paused");
    expect(controller.snapshot().activeSessionId).toBe("sess-1");
    expect(controller.snapshot().controlVisible).toBe(false);
    expect(shouldShowAgentControlOverlay(controller.snapshot())).toBe(false);

    controller.applyAgentControlMode("sess-1", "control");
    expect(controller.snapshot().activeSessionId).toBe("sess-1");
    expect(controller.snapshot().controlVisible).toBe(true);
    expect(shouldShowAgentControlOverlay(controller.snapshot())).toBe(true);
  });

  it("keeps the pill and its blocker up while the take-over request is in flight", () => {
    const controller = new OverlayController();
    controller.applyAgentControlMode("sess-1", "interrupting");

    // `interrupting` is not `control`, so the normal mask predicate is false…
    expect(shouldShowAgentControlOverlay(controller.snapshot())).toBe(false);
    // …but the pill must stay (disabled, 「接管中…」) until the daemon acks.
    expect(shouldShowInterruptingOverlay(controller.snapshot())).toBe(true);
    expect(controller.snapshot().interrupting).toBe(true);

    controller.applyAgentControlMode("sess-1", "paused");
    expect(shouldShowInterruptingOverlay(controller.snapshot())).toBe(false);
    expect(controller.isPausedVisible()).toBe(true);
  });

  it("hides the interrupting pill while another overlay owns the chrome", () => {
    const controller = new OverlayController();
    controller.applyAgentControlMode("sess-1", "interrupting");
    expect(shouldShowInterruptingOverlay(controller.snapshot())).toBe(true);

    controller.setAgentRecordRequest({ id: "rec-1", onFinish: vi.fn() });
    expect(shouldShowInterruptingOverlay(controller.snapshot())).toBe(false);

    controller.clearAgentRecordRequest("rec-1");
    expect(shouldShowInterruptingOverlay(controller.snapshot())).toBe(false);

    controller.setControlHintsHidden(true);
    expect(shouldShowInterruptingOverlay(controller.snapshot())).toBe(false);
  });

  it("exposes paused visibility only while a session holds control", () => {
    const controller = new OverlayController();
    expect(controller.isPausedVisible()).toBe(false);
    expect(controller.snapshot().pausedVisible).toBe(false);

    controller.activateAgentSession("sess-1");
    expect(controller.isPausedVisible()).toBe(false);

    controller.applyAgentControlMode("sess-1", "paused");
    expect(controller.isPausedVisible()).toBe(true);
    expect(controller.snapshot().pausedVisible).toBe(true);
    // The paused pill never blocks the page, but it is not the control mask
    // either — the two predicates are mutually exclusive.
    expect(controller.isControlVisible()).toBe(false);
    expect(shouldShowAgentControlOverlay(controller.snapshot())).toBe(false);

    controller.applyAgentControlMode("sess-1", "control");
    expect(controller.isPausedVisible()).toBe(false);
    expect(controller.isControlVisible()).toBe(true);

    controller.applyAgentControlMode("sess-1", "paused");
    controller.resetAgentOverlays("sess-1");
    expect(controller.isPausedVisible()).toBe(false);
    expect(controller.snapshot().pausedVisible).toBe(false);

    // No session ⇒ never paused, even if a stale mode lingered.
    controller.applyAgentControlMode(null, "hidden");
    expect(controller.isPausedVisible()).toBe(false);
  });

  it("hides the control overlay when the user hides control hints", () => {
    const controller = new OverlayController();
    controller.activateAgentSession("sess-1");
    expect(shouldShowAgentControlOverlay(controller.snapshot())).toBe(true);

    controller.setControlHintsHidden(true);
    expect(controller.snapshot().controlHintsHidden).toBe(true);
    // The session still owns the tab — only the chrome is hidden.
    expect(controller.snapshot().controlVisible).toBe(true);
    expect(shouldShowAgentControlOverlay(controller.snapshot())).toBe(false);

    controller.setControlHintsHidden(false);
    expect(shouldShowAgentControlOverlay(controller.snapshot())).toBe(true);
  });

  it("keeps the control-hints preference across session overlay resets", () => {
    const controller = new OverlayController();
    controller.activateAgentSession("sess-1");
    controller.setControlHintsHidden(true);

    controller.resetAgentOverlays("sess-1");
    expect(controller.snapshot().controlHintsHidden).toBe(true);

    controller.activateAgentSession("sess-2");
    expect(shouldShowAgentControlOverlay(controller.snapshot())).toBe(false);
  });
});
