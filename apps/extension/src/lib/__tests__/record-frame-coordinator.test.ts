import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECORD_FRAME_PORT, RECORD_FRAME_QUERY } from "../recording/frame-bridge";
import { RecordFrameCoordinator } from "../recording/frame-coordinator";

class ListenerSet<T extends (...args: never[]) => unknown> {
  readonly listeners = new Set<T>();
  addListener = (listener: T) => this.listeners.add(listener);
  removeListener = (listener: T) => this.listeners.delete(listener);
}

function fakePort(sender: chrome.runtime.MessageSender) {
  const messages: unknown[] = [];
  const onMessage = new ListenerSet<(message: unknown) => void>();
  const onDisconnect = new ListenerSet<() => void>();
  return {
    port: {
      name: RECORD_FRAME_PORT,
      sender,
      onMessage,
      onDisconnect,
      postMessage: vi.fn((message: unknown) => messages.push(message)),
      disconnect: vi.fn(),
    } as unknown as chrome.runtime.Port,
    messages,
    receive(message: unknown) {
      for (const listener of onMessage.listeners) listener(message);
    },
  };
}

describe("RecordFrameCoordinator", () => {
  const onConnect = new ListenerSet<(port: chrome.runtime.Port) => void>();
  const onMessage = new ListenerSet<
    (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => boolean
  >();

  beforeEach(() => {
    onConnect.listeners.clear();
    onMessage.listeners.clear();
    vi.stubGlobal("chrome", {
      runtime: { onConnect, onMessage },
    });
  });

  it("answers child-document queries for the initial tab before it is armed", () => {
    const coordinator = new RecordFrameCoordinator({
      getAllFrames: async () => [],
      sendToDocument: async () => ({ ok: true }),
    });
    coordinator.attach();
    coordinator.begin("rec-1", 10, 3);

    const query = (tabId: number) => {
      let response: unknown;
      for (const listener of onMessage.listeners) {
        listener(
          { type: RECORD_FRAME_QUERY },
          {
            tab: { id: tabId },
            frameId: 7,
            documentId: "child-document",
          } as chrome.runtime.MessageSender,
          (value) => {
            response = value;
          },
        );
      }
      return response;
    };

    expect(query(3)).toEqual({ active: true, requestId: "rec-1", startedAtMs: 10 });
    expect(query(4)).toEqual({ active: false });
  });

  it("starts a child Document that appears after the initial frame snapshot", async () => {
    let notifyFrameNavigation:
      | ((frame: {
          tabId: number;
          frameId: number;
          documentId?: string;
          lifecycle: "committed" | "completed";
        }) => void)
      | undefined;
    const sendToDocument = vi.fn(async () => ({ ok: true }));
    const coordinator = new RecordFrameCoordinator({
      getAllFrames: async () => [{ frameId: 0, documentId: "top-document" }],
      sendToDocument,
      subscribeFrameNavigation(listener) {
        notifyFrameNavigation = listener;
        return () => {};
      },
    });
    coordinator.attach();
    const onDocumentReady = vi.fn();
    coordinator.begin("rec-1", 10, 3, onDocumentReady);
    await coordinator.armTab("rec-1", 3);
    sendToDocument.mockClear();

    notifyFrameNavigation?.({
      tabId: 3,
      frameId: 7,
      documentId: "late-child",
      lifecycle: "completed",
    });
    await vi.waitFor(() => {
      expect(sendToDocument).toHaveBeenCalledWith(
        3,
        { type: "bsk-record-frame-start", requestId: "rec-1", startedAtMs: 10 },
        { documentId: "late-child" },
      );
    });
    expect(onDocumentReady).not.toHaveBeenCalled();

    const child = fakePort({
      tab: { id: 3 },
      frameId: 7,
      documentId: "late-child",
    } as chrome.runtime.MessageSender);
    for (const listener of onConnect.listeners) listener(child.port);
    child.receive({ type: "ready", requestId: "rec-1", producerId: "producer-1" });
    notifyFrameNavigation?.({
      tabId: 3,
      frameId: 7,
      documentId: "late-child",
      lifecycle: "completed",
    });
    await vi.waitFor(() => {
      expect(onDocumentReady).toHaveBeenCalledWith({
        tabId: 3,
        documentId: "late-child",
        browserFrameId: 7,
        producerId: "producer-1",
      });
    });
  });

  it("binds a producer to its sender Document and keeps final steps valid while stopping", async () => {
    const sendToDocument = vi.fn(async () => ({ ok: true }));
    const coordinator = new RecordFrameCoordinator({
      getAllFrames: async () => [
        { frameId: 0, documentId: "top-document" },
        { frameId: 7, documentId: "child-document" },
      ],
      sendToDocument,
    });
    coordinator.attach();
    coordinator.begin("rec-1", 10, 3);
    await expect(coordinator.armTab("rec-1", 3)).resolves.toBe(true);

    const sender = {
      tab: { id: 3 },
      frameId: 7,
      documentId: "child-document",
    } as chrome.runtime.MessageSender;
    const frame = fakePort(sender);
    for (const listener of onConnect.listeners) listener(frame.port);
    frame.receive({ type: "ready", requestId: "rec-1", producerId: "producer-1" });

    expect(coordinator.sourceFor("rec-1", "producer-1", sender)).toEqual({
      tabId: 3,
      documentId: "child-document",
      browserFrameId: 7,
      producerId: "producer-1",
    });

    const stopping = coordinator.stop("rec-1");
    expect(coordinator.sourceFor("rec-1", "producer-1", sender)).not.toBeNull();
    const stop = frame.messages.find(
      (message): message is { type: "stop"; commandId: string } =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: string }).type === "stop",
    );
    expect(stop).toBeDefined();
    frame.receive({
      type: "stopped",
      requestId: "rec-1",
      commandId: stop!.commandId,
      ok: true,
    });
    await expect(stopping).resolves.toBe(true);
    expect(coordinator.sourceFor("rec-1", "producer-1", sender)).toBeNull();
  });

  it("rejects a producer used from another Document", async () => {
    const coordinator = new RecordFrameCoordinator({
      getAllFrames: async () => [{ frameId: 0, documentId: "top-document" }],
      sendToDocument: async () => ({ ok: true }),
    });
    coordinator.attach();
    coordinator.begin("rec-1", 10, 3);
    await coordinator.armTab("rec-1", 3);
    const sender = {
      tab: { id: 3 },
      frameId: 0,
      documentId: "top-document",
    } as chrome.runtime.MessageSender;
    const frame = fakePort(sender);
    for (const listener of onConnect.listeners) listener(frame.port);
    frame.receive({ type: "ready", requestId: "rec-1", producerId: "producer-1" });

    expect(
      coordinator.sourceFor("rec-1", "producer-1", {
        ...sender,
        documentId: "other-document",
      }),
    ).toBeNull();
  });
});
