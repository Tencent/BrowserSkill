import { describe, expect, it, vi } from "vitest";

// `background.ts` is a WXT entrypoint that calls the global `defineBackground`
// at module load. WXT injects that helper at build time via auto-imports;
// vitest runs the file directly so we have to stub it before the import is
// resolved. `vi.hoisted` runs before ESM imports, which is exactly what we need.
vi.hoisted(() => {
  (globalThis as unknown as { defineBackground: (cb: unknown) => unknown }).defineBackground = (
    cb: unknown,
  ) => cb;
});

import {
  controlModeAfterTakeOver,
  handleOverlayInterrupt,
  handleOverlayReturnControl,
  handleOverlayReturnControlRequest,
  shouldControlResumeOnBrowserActivity,
} from "@/entrypoints/background";

type InterruptTransport = Parameters<typeof handleOverlayInterrupt>[0];

describe("handleOverlayInterrupt", () => {
  it("sends session.user_interrupt + session.control_taken and acks ok", async () => {
    const send = vi.fn().mockReturnValue(undefined);
    const transport = { send } as unknown as InterruptTransport;
    const result = await handleOverlayInterrupt(transport, "sess-1");
    expect(send).toHaveBeenCalledWith({
      event: "session.user_interrupt",
      payload: { session_id: "sess-1" },
    });
    expect(send).toHaveBeenCalledWith({
      event: "session.control_taken",
      payload: { session_id: "sess-1" },
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns ok=false when the transport send throws", async () => {
    const send = vi.fn(() => {
      throw new Error("ws closed");
    });
    const transport = { send } as unknown as InterruptTransport;
    const result = await handleOverlayInterrupt(transport, "sess-1");
    expect(result).toEqual({ ok: false });
  });
});

describe("handleOverlayReturnControl", () => {
  it("sends session.control_returned with the note", () => {
    const send = vi.fn().mockReturnValue(undefined);
    const transport = { send } as unknown as InterruptTransport;
    expect(handleOverlayReturnControl(transport, "sess-1", "我登录好了")).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith({
      event: "session.control_returned",
      payload: { session_id: "sess-1", note: "我登录好了" },
    });
  });

  it("sends an empty note verbatim", () => {
    const send = vi.fn().mockReturnValue(undefined);
    const transport = { send } as unknown as InterruptTransport;
    handleOverlayReturnControl(transport, "sess-1", "");
    expect(send).toHaveBeenCalledWith({
      event: "session.control_returned",
      payload: { session_id: "sess-1", note: "" },
    });
  });

  it("reports ok=false when the transport is down", () => {
    const send = vi.fn(() => {
      throw new Error("ws closed");
    });
    const transport = { send } as unknown as InterruptTransport;
    expect(handleOverlayReturnControl(transport, "sess-1", "note")).toEqual({ ok: false });
  });
});

describe("handleOverlayReturnControlRequest", () => {
  it("sends session.control_returned with the note and flips the mode back to control", () => {
    const send = vi.fn();
    const setControlMode = vi.fn();
    const reply = handleOverlayReturnControlRequest(
      { hasSession: () => true, transport: { send }, setControlMode },
      { kind: "overlay.return_control", sessionId: "sess-1", note: "all set" },
    );

    expect(send).toHaveBeenCalledWith({
      event: "session.control_returned",
      payload: { session_id: "sess-1", note: "all set" },
    });
    expect(setControlMode).toHaveBeenCalledWith("sess-1", "control");
    expect(reply).toEqual({ ok: true });
  });

  it("replies ok=false and leaves the mode alone when the session is gone", () => {
    const send = vi.fn();
    const setControlMode = vi.fn();
    const reply = handleOverlayReturnControlRequest(
      { hasSession: () => false, transport: { send }, setControlMode },
      { kind: "overlay.return_control", sessionId: "sess-gone", note: "" },
    );

    expect(send).not.toHaveBeenCalled();
    expect(setControlMode).not.toHaveBeenCalled();
    expect(reply).toEqual({ ok: false });
  });

  it("keeps the user in control when the daemon frame cannot be sent", () => {
    const send = vi.fn(() => {
      throw new Error("ws closed");
    });
    const setControlMode = vi.fn();
    const reply = handleOverlayReturnControlRequest(
      { hasSession: () => true, transport: { send }, setControlMode },
      { kind: "overlay.return_control", sessionId: "sess-1", note: "note" },
    );

    expect(setControlMode).not.toHaveBeenCalled();
    expect(reply).toEqual({ ok: false });
  });

  it("treats a non-string note as empty", () => {
    const send = vi.fn();
    const reply = handleOverlayReturnControlRequest(
      { hasSession: () => true, transport: { send }, setControlMode: vi.fn() },
      {
        kind: "overlay.return_control",
        sessionId: "sess-1",
        note: undefined as unknown as string,
      },
    );

    expect(send).toHaveBeenCalledWith({
      event: "session.control_returned",
      payload: { session_id: "sess-1", note: "" },
    });
    expect(reply).toEqual({ ok: true });
  });
});

describe("shouldControlResumeOnBrowserActivity", () => {
  it("never auto-resumes a session the user took over", () => {
    // The daemon blocks agent input while control is held, but a passive read
    // (snapshot / get_html) still reaches the extension — it must not un-pause
    // the UI behind the user's back.
    expect(shouldControlResumeOnBrowserActivity("paused")).toBe(false);
    expect(shouldControlResumeOnBrowserActivity("interrupting")).toBe(false);
  });

  it("keeps resuming from every other state", () => {
    expect(shouldControlResumeOnBrowserActivity("control")).toBe(true);
    expect(shouldControlResumeOnBrowserActivity("hidden")).toBe(true);
    expect(shouldControlResumeOnBrowserActivity(undefined)).toBe(true);
  });
});

describe("controlModeAfterTakeOver", () => {
  it("parks the session in paused once the daemon has the frame", () => {
    expect(controlModeAfterTakeOver(true)).toBe("paused");
  });

  it("rolls back to control when the take-over frame could not be sent", () => {
    // `interrupting` is sticky, so a failed send must not be left in place:
    // the pill would keep its disabled button and its input blocker with no
    // return button, locking the user out of the page for good.
    expect(controlModeAfterTakeOver(false)).toBe("control");
    expect(shouldControlResumeOnBrowserActivity(controlModeAfterTakeOver(false))).toBe(true);
  });
});
