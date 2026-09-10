import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordFramePortMessage } from "@/lib/recording/frame-bridge";
import { RECORD_FRAME_START } from "@/lib/recording/frame-bridge";
import { RECORD_DOCUMENT_ATTRIBUTE } from "@/shared/recording-document-identity";
import { RecordFrameAgent } from "../recording/frame-agent";

class PortListeners<T extends (...args: never[]) => unknown> {
  readonly values = new Set<T>();
  addListener = (listener: T) => this.values.add(listener);
  removeListener = (listener: T) => this.values.delete(listener);
}

function portHarness() {
  const onMessage = new PortListeners<(message: unknown) => void>();
  const onDisconnect = new PortListeners<() => void>();
  const outbound: RecordFramePortMessage[] = [];
  const port = {
    name: "bsk-record-frame",
    onMessage,
    onDisconnect,
    postMessage(message: RecordFramePortMessage) {
      outbound.push(message);
      if (message.type === "ready") {
        queueMicrotask(() => {
          for (const listener of onMessage.values) {
            listener({
              type: "ready_ack",
              requestId: message.requestId,
              producerId: message.producerId,
            });
          }
        });
      }
    },
    disconnect: vi.fn(),
  } as unknown as chrome.runtime.Port;
  return {
    port,
    outbound,
    receive(message: RecordFramePortMessage) {
      for (const listener of onMessage.values) listener(message);
    },
  };
}

describe("RecordFrameAgent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute(RECORD_DOCUMENT_ATTRIBUTE);
    document.body.replaceChildren();
  });

  it("starts when crypto.randomUUID is unavailable", async () => {
    const harness = portHarness();
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0x11);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    vi.stubGlobal("chrome", {
      runtime: {
        connect: vi.fn(() => harness.port),
        sendMessage: vi.fn(),
      },
    });
    const agent = new RecordFrameAgent();

    await expect(
      agent.start({ type: RECORD_FRAME_START, requestId: "rec-http", startedAtMs: 10 }),
    ).resolves.toEqual({ ok: true });
    expect(getRandomValues).toHaveBeenCalled();
  });

  it("keeps a failed stop retryable and flushes the final dirty fill", async () => {
    const harness = portHarness();
    const sendMessage = vi
      .fn<(message: { sequence: number }) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockImplementation(async (message) => ({ ok: true, sequence: message.sequence }));
    vi.stubGlobal("chrome", {
      runtime: {
        connect: vi.fn(() => harness.port),
        sendMessage,
      },
    });
    document.body.innerHTML = `<label for="draft">Draft</label><input id="draft" />`;
    const agent = new RecordFrameAgent();

    await expect(
      agent.start({ type: RECORD_FRAME_START, requestId: "rec-1", startedAtMs: 10 }),
    ).resolves.toEqual({ ok: true });
    expect(document.documentElement.hasAttribute(RECORD_DOCUMENT_ATTRIBUTE)).toBe(true);

    const input = document.querySelector("input")!;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.value = "final value";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    harness.receive({ type: "stop", requestId: "rec-1", commandId: "stop-1" });
    await vi.waitFor(() =>
      expect(harness.outbound).toContainEqual({
        type: "stopped",
        requestId: "rec-1",
        commandId: "stop-1",
        ok: false,
        error: "failed to deliver one or more recorded steps",
      }),
    );
    expect(document.documentElement.hasAttribute(RECORD_DOCUMENT_ATTRIBUTE)).toBe(true);

    harness.receive({ type: "stop", requestId: "rec-1", commandId: "stop-2" });
    await vi.waitFor(() =>
      expect(harness.outbound).toContainEqual({
        type: "stopped",
        requestId: "rec-1",
        commandId: "stop-2",
        ok: true,
      }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(document.documentElement.hasAttribute(RECORD_DOCUMENT_ATTRIBUTE)).toBe(false);
  });
});
