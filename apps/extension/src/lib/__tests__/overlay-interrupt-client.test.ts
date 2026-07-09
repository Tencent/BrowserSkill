import { describe, expect, it, vi } from "vitest";
import { sendInterrupt } from "@/lib/overlay-interrupt-client";

describe("sendInterrupt", () => {
  it("sends OVERLAY_MSG_INTERRUPT with the session id and resolves to the reply", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const result = await sendInterrupt(sendMessage, "sess-9");
    expect(sendMessage).toHaveBeenCalledWith({
      kind: "overlay.interrupt",
      sessionId: "sess-9",
    });
    expect(result).toEqual({ ok: true });
  });

  it("treats an absent reply as failure", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const result = await sendInterrupt(sendMessage, "sess-1");
    expect(result).toEqual({ ok: false });
  });

  it("treats a thrown sendMessage as failure", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await sendInterrupt(sendMessage, "sess-1");
    expect(result).toEqual({ ok: false });
  });

  it("resolves to ok=false if the round trip exceeds the timeout", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => new Promise(() => {})); // never resolves
    const promise = sendInterrupt(sendMessage, "sess-t", { timeoutMs: 2000 });
    vi.advanceTimersByTime(2000);
    const result = await promise;
    expect(result).toEqual({ ok: false });
    vi.useRealTimers();
  });
});
