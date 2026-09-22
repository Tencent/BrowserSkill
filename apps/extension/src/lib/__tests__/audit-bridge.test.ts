import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "@/transport/transport";
import type { ProtocolFrame } from "@/transport/types";
import { auditRpc, isAuditPage } from "../audit-bridge";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("audit bridge", () => {
  it("only accepts messages from the popup and history page, not content scripts", () => {
    vi.stubGlobal("chrome", {
      runtime: { id: "own", getURL: (path: string) => `chrome-extension://own${path}` },
    });
    expect(isAuditPage({ id: "own", url: "https://example.com" })).toBe(false);
    expect(isAuditPage({ id: "other", url: "chrome-extension://own/audit.html" })).toBe(false);
    expect(isAuditPage({ id: "own", url: "chrome-extension://own/popup.html" })).toBe(true);
    expect(isAuditPage({ id: "own", url: "chrome-extension://own/audit.html?id=a" })).toBe(true);
  });
  it("correlates replies without consuming tool responses", async () => {
    let listener: (frame: ProtocolFrame) => void = () => {};
    const dispose = vi.fn();
    const send = vi.fn();
    const transport = {
      send,
      onMessage: (callback: typeof listener) => {
        listener = callback;
        return { dispose };
      },
      onConnectionStateChange: () => ({ dispose }),
    } as unknown as Transport;
    const result = auditRpc(transport, { action: "list" });
    listener({ id: "other-tool", result: { unrelated: true } });
    listener({ id: send.mock.calls[0][0].id, result: { total: 1 } });
    await expect(result).resolves.toEqual({ total: 1 });
    expect(dispose).toHaveBeenCalledTimes(2);
  });
  it("times out old daemons and releases subscriptions", async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const transport = {
      send: vi.fn(),
      onMessage: () => ({ dispose }),
      onConnectionStateChange: () => ({ dispose }),
    } as unknown as Transport;
    const rejected = expect(auditRpc(transport, { action: "list" })).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(dispose).toHaveBeenCalledTimes(2);
  });
  it("handles a transport that reports disconnection during subscription", async () => {
    const dispose = vi.fn();
    const send = vi.fn();
    const transport = {
      send,
      onMessage: () => ({ dispose }),
      onConnectionStateChange: (listener: (state: string) => void) => {
        listener("disconnected");
        return { dispose };
      },
    } as unknown as Transport;
    await expect(auditRpc(transport, { action: "list" })).rejects.toThrow("disconnected");
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });
});
