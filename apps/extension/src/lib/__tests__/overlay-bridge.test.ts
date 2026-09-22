import { describe, expect, it } from "vitest";
import {
  isOverlayAgentOverlayResetMessage,
  OVERLAY_AGENT_OVERLAY_RESET,
  OVERLAY_AGENT_STATE,
  OVERLAY_MSG_INTERRUPT,
  type OverlayAgentStateMessage,
  type OverlayInterruptRequest,
  type OverlayInterruptResponse,
  shouldApplyOverlayAgentState,
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

function state(
  generation: number,
  mode: OverlayAgentStateMessage["mode"] = "control",
): OverlayAgentStateMessage {
  return { type: OVERLAY_AGENT_STATE, sessionId: "sess-1", mode, generation };
}

describe("shouldApplyOverlayAgentState", () => {
  it("applies the first overlay state", () => {
    expect(shouldApplyOverlayAgentState(null, state(1))).toBe(true);
  });

  it("applies an equal or newer generation", () => {
    expect(shouldApplyOverlayAgentState(state(4, "control"), state(4, "paused"))).toBe(true);
    expect(shouldApplyOverlayAgentState(state(4, "control"), state(5, "hidden"))).toBe(true);
  });

  it("drops a stale control state after a newer hide", () => {
    expect(shouldApplyOverlayAgentState(state(6, "hidden"), state(5, "control"))).toBe(false);
  });
});
