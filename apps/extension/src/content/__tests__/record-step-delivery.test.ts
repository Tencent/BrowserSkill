import { describe, expect, it, vi } from "vitest";
import type { RecordStepMessage } from "@/lib/record-bridge";
import { RecordStepDelivery } from "../record-step-delivery";

describe("RecordStepDelivery", () => {
  it("retries from the first unacknowledged sequence before sending later steps", async () => {
    const sent: RecordStepMessage[] = [];
    const send = vi.fn(async (message: RecordStepMessage) => {
      sent.push(message);
      if (sent.length === 1) throw new Error("service worker unavailable");
      return { ok: true, sequence: message.sequence };
    });
    const delivery = new RecordStepDelivery("rec-ordered", send, "document-1");

    delivery.enqueue({ op: "click", target: { tag: "button", name: "First" } });
    delivery.enqueue({ op: "click", target: { tag: "button", name: "Second" } });

    await expect(delivery.flush()).resolves.toBe(true);
    expect(sent.map((message) => message.sequence)).toEqual([1, 1, 2]);
    expect(sent.map((message) => message.step.target?.name)).toEqual(["First", "First", "Second"]);
  });

  it("keeps unacknowledged steps pending for a later flush", async () => {
    const send = vi
      .fn<(message: RecordStepMessage) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockImplementation(async (message) => ({ ok: true, sequence: message.sequence }));
    const delivery = new RecordStepDelivery("rec-retry", send, "document-1");
    delivery.enqueue({ op: "click", target: { tag: "button", name: "Save" } });

    await expect(delivery.flush()).resolves.toBe(false);
    await expect(delivery.flush()).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
