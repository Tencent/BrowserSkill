import { describe, expect, it } from "vitest";
import {
  isOverlayAgentOverlayResetMessage,
  isOverlayScreenshotHideMessage,
  OVERLAY_AGENT_OVERLAY_RESET,
  OVERLAY_MSG_INTERRUPT,
  OVERLAY_SCREENSHOT_HIDE,
  type OverlayInterruptRequest,
  type OverlayInterruptResponse,
} from "@/lib/overlay-bridge";

describe("OVERLAY_MSG_INTERRUPT", () => {
  it("constant matches the wire string content scripts will send", () => {
    expect(OVERLAY_MSG_INTERRUPT).toBe("overlay.interrupt");
  });

  it("OverlayInterruptRequest type carries kind + sessionId", () => {
    const req: OverlayInterruptRequest = {
      kind: OVERLAY_MSG_INTERRUPT,
      sessionId: "sess-1",
    };
    expect(req.kind).toBe("overlay.interrupt");
    expect(req.sessionId).toBe("sess-1");
  });

  it("OverlayInterruptResponse carries ok flag", () => {
    const res: OverlayInterruptResponse = { ok: true };
    expect(res.ok).toBe(true);
  });
});

describe("isOverlayAgentOverlayResetMessage", () => {
  it("accepts reset messages with a session id", () => {
    expect(
      isOverlayAgentOverlayResetMessage({
        type: OVERLAY_AGENT_OVERLAY_RESET,
        sessionId: "sess-1",
      }),
    ).toBe(true);
  });

  it("rejects reset messages without a session id", () => {
    expect(
      isOverlayAgentOverlayResetMessage({
        type: OVERLAY_AGENT_OVERLAY_RESET,
      }),
    ).toBe(false);
  });
});

describe("isOverlayScreenshotHideMessage", () => {
  it("accepts hide/restore messages with a boolean flag", () => {
    expect(isOverlayScreenshotHideMessage({ type: OVERLAY_SCREENSHOT_HIDE, hidden: true })).toBe(
      true,
    );
    expect(isOverlayScreenshotHideMessage({ type: OVERLAY_SCREENSHOT_HIDE, hidden: false })).toBe(
      true,
    );
  });

  it("rejects messages with a missing or non-boolean flag", () => {
    expect(isOverlayScreenshotHideMessage({ type: OVERLAY_SCREENSHOT_HIDE })).toBe(false);
    expect(
      isOverlayScreenshotHideMessage({ type: OVERLAY_SCREENSHOT_HIDE, hidden: "yes" }),
    ).toBe(false);
  });

  it("rejects unrelated message types and non-objects", () => {
    expect(isOverlayScreenshotHideMessage({ type: "something-else", hidden: true })).toBe(false);
    expect(isOverlayScreenshotHideMessage(null)).toBe(false);
    expect(isOverlayScreenshotHideMessage("nope")).toBe(false);
  });
});
