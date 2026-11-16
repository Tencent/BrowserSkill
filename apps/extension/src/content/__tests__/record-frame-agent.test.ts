import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordFramePortMessage } from "@/lib/recording/frame-bridge";
import { RECORD_FRAME_START } from "@/lib/recording/frame-bridge";
import { RECORD_DOCUMENT_ATTRIBUTE } from "@/shared/recording-document-identity";
import { attachRecordFrameAgent, RecordFrameAgent } from "../recording/frame-agent";

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

  it("loads with zero startup wakeup IPC and reports dynamically added subframes (including closed ShadowRoots) while recording", async () => {
    const closedRoots = new WeakMap<HTMLElement, ShadowRoot>();
    const preHost = document.createElement("div");
    const preClosed = preHost.attachShadow({ mode: "closed" });
    closedRoots.set(preHost, preClosed);
    document.body.appendChild(preHost);

    const harness = portHarness();
    const onMessage = new PortListeners<
      (
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean
    >();
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", {
      dom: {
        openOrClosedShadowRoot: (el: HTMLElement) => closedRoots.get(el) ?? null,
      },
      runtime: {
        onMessage,
        connect: vi.fn(() => harness.port),
        sendMessage,
      },
    });
    const dispose = attachRecordFrameAgent();
    try {
      expect(sendMessage).not.toHaveBeenCalled();
      expect(onMessage.values.size).toBe(1);

      // Appending an iframe before recording starts emits nothing.
      document.body.appendChild(document.createElement("iframe"));
      await Promise.resolve();
      expect(harness.outbound).toEqual([]);

      // Arm recording via RECORD_FRAME_START, then dynamically append two iframes.
      let startReply: unknown;
      for (const listener of onMessage.values) {
        listener(
          { type: RECORD_FRAME_START, requestId: "rec-subframe", startedAtMs: 20 },
          {} as chrome.runtime.MessageSender,
          (reply) => {
            startReply = reply;
          },
        );
      }
      await vi.waitFor(() => expect(startReply).toEqual({ ok: true }));
      harness.outbound.length = 0;

      document.body.append(document.createElement("iframe"), document.createElement("iframe"));
      await vi.waitFor(
        () => {
          expect(harness.outbound).toEqual([
            {
              type: "subframe_added",
              requestId: "rec-subframe",
              producerId: expect.any(String),
            },
          ]);
        },
        { interval: 5 },
      );

      // Pre-existing closed ShadowRoot and newly inserted closed ShadowRoot hosts also emit `subframe_added`.
      harness.outbound.length = 0;
      preClosed.appendChild(document.createElement("iframe"));
      await vi.waitFor(() => expect(harness.outbound).toHaveLength(1), { interval: 5 });

      harness.outbound.length = 0;
      const dynamicHost = document.createElement("div");
      const dynamicClosed = dynamicHost.attachShadow({ mode: "closed" });
      closedRoots.set(dynamicHost, dynamicClosed);
      dynamicClosed.appendChild(document.createElement("iframe"));
      document.body.appendChild(dynamicHost);
      await vi.waitFor(() => expect(harness.outbound).toHaveLength(1), { interval: 5 });

      harness.outbound.length = 0;
      dynamicClosed.appendChild(document.createElement("iframe"));
      await vi.waitFor(() => expect(harness.outbound).toHaveLength(1), { interval: 5 });
    } finally {
      dispose();
    }
  });
});
