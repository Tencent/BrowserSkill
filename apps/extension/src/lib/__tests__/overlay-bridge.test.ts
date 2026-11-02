import { describe, expect, it } from "vitest";
import {
  isOverlayAgentOverlayResetMessage,
  isOverlayAgentStateMessage,
  OVERLAY_AGENT_OVERLAY_RESET,
  OVERLAY_AGENT_STATE,
  OVERLAY_MSG_INTERRUPT,
  type OverlayInterruptRequest,
  type OverlayInterruptResponse,
  OverlayVersionGate,
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
  it("accepts reset messages with a session id and a version", () => {
    expect(
      isOverlayAgentOverlayResetMessage({
        type: OVERLAY_AGENT_OVERLAY_RESET,
        sessionId: "sess-1",
        epoch: "worker",
        generation: 1,
      }),
    ).toBe(true);
  });

  it("rejects reset messages without a version", () => {
    expect(
      isOverlayAgentOverlayResetMessage({
        type: OVERLAY_AGENT_OVERLAY_RESET,
        sessionId: "sess-1",
      }),
    ).toBe(false);
  });

  it("rejects reset messages without a session id", () => {
    expect(
      isOverlayAgentOverlayResetMessage({
        type: OVERLAY_AGENT_OVERLAY_RESET,
      }),
    ).toBe(false);
  });
});

describe("isOverlayAgentStateMessage", () => {
  it("requires a version", () => {
    const message = { type: OVERLAY_AGENT_STATE, sessionId: "sess-1", mode: "control" };
    expect(isOverlayAgentStateMessage({ ...message, epoch: "worker", generation: 1 })).toBe(true);
    expect(isOverlayAgentStateMessage({ ...message, generation: 1 })).toBe(false);
  });
});

describe("OverlayVersionGate", () => {
  it("admits the first message and the same message again", () => {
    const gate = new OverlayVersionGate();
    expect(gate.admit({ epoch: "worker", generation: 4 })).toBe(true);
    expect(gate.admit({ epoch: "worker", generation: 4 })).toBe(true);
  });

  it("orders messages from one worker by generation", () => {
    const gate = new OverlayVersionGate();
    expect(gate.admit({ epoch: "worker", generation: 6 })).toBe(true);
    expect(gate.admit({ epoch: "worker", generation: 5 })).toBe(false);
    expect(gate.admit({ epoch: "worker", generation: 7 })).toBe(true);
  });

  it("follows a restarted worker and drops the one it replaced", () => {
    const gate = new OverlayVersionGate();
    expect(gate.admit({ epoch: "worker", generation: 20 })).toBe(true);
    expect(gate.admit({ epoch: "restarted", generation: 1 })).toBe(true);
    expect(gate.admit({ epoch: "worker", generation: 21 })).toBe(false);
    expect(gate.admit({ epoch: "restarted", generation: 2 })).toBe(true);
  });
});
