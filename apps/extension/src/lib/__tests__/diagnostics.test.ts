import { describe, expect, it, vi } from "vitest";
import { DiagnosticLogger } from "../diagnostics";

class MemoryStorage {
  value: Record<string, unknown> = {};

  async get(key: string): Promise<Record<string, unknown>> {
    return { [key]: this.value[key] };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.value = { ...this.value, ...items };
  }
}

describe("DiagnosticLogger", () => {
  it("persists evidence before transport readiness and flushes it after reconnect", async () => {
    const storage = new MemoryStorage();
    const send = vi.fn();
    const logger = new DiagnosticLogger(storage);
    logger.bindTransport(send);

    logger.record("transport.socket.closed", { code: 1006 });
    await logger.flush();
    expect(send).not.toHaveBeenCalled();

    logger.setTransportReady(true);
    await logger.flush();

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      event: "browser.diagnostic",
      payload: {
        schema_version: 1,
        entries: [
          {
            event: "transport.socket.closed",
            fields: { code: 1006 },
          },
        ],
      },
    });
    expect(storage.value.bsk_diagnostic_events_v1).toEqual([]);
  });

  it("keeps persisted evidence when the transport rejects the flush", async () => {
    const storage = new MemoryStorage();
    const logger = new DiagnosticLogger(storage);
    logger.bindTransport(() => {
      throw new Error("socket closed");
    });
    logger.record("session.stop.requested", { session_id: "abcd" });

    logger.setTransportReady(true);
    await logger.flush();

    expect(storage.value.bsk_diagnostic_events_v1).toMatchObject([
      { event: "session.stop.requested", fields: { session_id: "abcd" } },
    ]);
  });
});
