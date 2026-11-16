import { afterEach, describe, expect, it, vi } from "vitest";
import { UiTaskError } from "@/session-manager/ui-activity";
import { chromeAgentOverlayResetApi } from "@/tools/tabs";
import type { Transport } from "@/transport/transport";
import type { ProtocolFrame } from "@/transport/types";
import { auditRpc, isAuditPage } from "../audit-bridge";
import {
  CAPTURE_SUPPRESS,
  type CaptureSuppressMessage,
  withExtensionOverlayHidden,
} from "../capture-suppress-bridge";
import {
  HELP_ACK,
  HELP_CANCEL,
  HELP_FINISH,
  HELP_QUERY,
  HELP_REQUEST,
  HELP_RESPONSE,
  isHelpAckMessage,
  isHelpCancelMessage,
  isHelpFinishMessage,
  isHelpQueryMessage,
  isHelpRequestMessage,
  isHelpResponseMessage,
} from "../help-bridge";
import { trustedPopup } from "../local-pairing-bridge";
import {
  isOverlayAgentOverlayResetMessage,
  isOverlayAgentStateMessage,
  OVERLAY_AGENT_OVERLAY_RESET,
  OVERLAY_AGENT_STATE,
  OverlayVersionGate,
} from "../overlay-bridge";
import { sendInterrupt } from "../overlay-interrupt-client";
import { nextOverlayVersion } from "../overlay-version";
import {
  isAcceptedRecordStepAck,
  isRecordStepMessage,
  RECORD_STEP,
  type RecordStepMessage,
} from "../record-bridge";
import { attachUiChannel } from "../ui-channel";

describe("trustedPopup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts only this extension's popup, never a content script or tab", () => {
    vi.stubGlobal("chrome", {
      runtime: { id: "test", getURL: (path: string) => `chrome-extension://test/${path}` },
    });
    const sender = { id: "test", url: "chrome-extension://test/popup.html" };
    expect(trustedPopup(sender)).toBe(true);
    expect(trustedPopup({ ...sender, tab: { id: 1 } as chrome.tabs.Tab })).toBe(false);
    expect(trustedPopup({ ...sender, id: "other" })).toBe(false);
    expect(trustedPopup({ ...sender, url: "https://example.test/popup.html" })).toBe(false);
  });
});

describe("record step delivery protocol", () => {
  const message: RecordStepMessage = {
    type: RECORD_STEP,
    requestId: "rec-1",
    producerId: "document-1",
    sequence: 1,
    step: { op: "click", target: { tag: "button", name: "Submit" } },
  };

  it("requires a producer and a positive integer sequence", () => {
    expect(isRecordStepMessage(message)).toBe(true);
    expect(isRecordStepMessage({ ...message, producerId: "" })).toBe(false);
    expect(isRecordStepMessage({ ...message, sequence: 0 })).toBe(false);
    expect(isRecordStepMessage({ ...message, sequence: 1.5 })).toBe(false);
  });

  it("accepts only the acknowledgement for the sent sequence", () => {
    expect(isAcceptedRecordStepAck({ ok: true, sequence: 2 }, 2)).toBe(true);
    expect(isAcceptedRecordStepAck({ ok: true, sequence: 1 }, 2)).toBe(false);
    expect(isAcceptedRecordStepAck({ ok: false, expectedSequence: 2, error: "gap" }, 2)).toBe(
      false,
    );
  });
});

describe("overlay version gating", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands out increasing generations under one epoch", () => {
    const first = nextOverlayVersion();
    const second = nextOverlayVersion();
    expect(second.epoch).toBe(first.epoch);
    expect(second.generation).toBeGreaterThan(first.generation);
  });

  it("versions a reset like a state, so the page can order the two", async () => {
    const sendMessage = vi.fn(async () => {});
    vi.stubGlobal("chrome", { tabs: { sendMessage } });
    const before = nextOverlayVersion();
    await chromeAgentOverlayResetApi.resetAgentOverlays(3, "sess-1");
    expect(sendMessage).toHaveBeenCalledWith(3, {
      type: OVERLAY_AGENT_OVERLAY_RESET,
      sessionId: "sess-1",
      epoch: before.epoch,
      generation: before.generation + 1,
    });
  });

  it("is a best-effort no-op outside the extension runtime", async () => {
    vi.stubGlobal("chrome", undefined);
    await expect(
      chromeAgentOverlayResetApi.resetAgentOverlays(3, "sess-1"),
    ).resolves.toBeUndefined();
    vi.stubGlobal("chrome", { tabs: {} });
    await expect(
      chromeAgentOverlayResetApi.resetAgentOverlays(3, "sess-1"),
    ).resolves.toBeUndefined();
  });
});

describe("sendInterrupt", () => {
  afterEach(() => vi.useRealTimers());

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
    const sendMessage = vi.fn(() => new Promise(() => {}));
    const promise = sendInterrupt(sendMessage, "sess-t", { timeoutMs: 2000 });
    vi.advanceTimersByTime(2000);
    const result = await promise;
    expect(result).toEqual({ ok: false });
  });
});

describe("overlay bridge type guards and gate", () => {
  it("validates reset messages with session id and version", () => {
    expect(
      isOverlayAgentOverlayResetMessage({
        type: OVERLAY_AGENT_OVERLAY_RESET,
        sessionId: "sess-1",
        epoch: "worker",
        generation: 1,
      }),
    ).toBe(true);
    expect(
      isOverlayAgentOverlayResetMessage({
        type: OVERLAY_AGENT_OVERLAY_RESET,
        sessionId: "sess-1",
      }),
    ).toBe(false);
    expect(
      isOverlayAgentOverlayResetMessage({
        type: OVERLAY_AGENT_OVERLAY_RESET,
      }),
    ).toBe(false);
  });

  it("validates controller metadata and version on state messages", () => {
    const message = {
      type: OVERLAY_AGENT_STATE,
      sessionId: "sess-1",
      mode: "control",
      epoch: "worker",
      generation: 1,
    };
    expect(isOverlayAgentStateMessage(message)).toBe(true);
    expect(
      isOverlayAgentStateMessage({
        ...message,
        controller: { name: "Codex", project: "Search", color: "#2563eb" },
      }),
    ).toBe(true);
    expect(isOverlayAgentStateMessage({ ...message, controller: { name: 42 } })).toBe(false);
    expect(
      isOverlayAgentStateMessage({ ...message, controller: { name: "Codex", color: "url(x)" } }),
    ).toBe(false);
    expect(
      isOverlayAgentStateMessage({
        type: OVERLAY_AGENT_STATE,
        sessionId: "sess-1",
        mode: "control",
        generation: 1,
      }),
    ).toBe(false);
  });

  it("orders worker epochs and generations in OverlayVersionGate", () => {
    const gate = new OverlayVersionGate();
    expect(gate.admit({ epoch: "worker", generation: 4 })).toBe(true);
    expect(gate.admit({ epoch: "worker", generation: 4 })).toBe(true);
    expect(gate.admit({ epoch: "worker", generation: 6 })).toBe(true);
    expect(gate.admit({ epoch: "worker", generation: 5 })).toBe(false);
    expect(gate.admit({ epoch: "worker", generation: 7 })).toBe(true);
    expect(gate.admit({ epoch: "restarted", generation: 1 })).toBe(true);
    expect(gate.admit({ epoch: "worker", generation: 21 })).toBe(false);
    expect(gate.admit({ epoch: "restarted", generation: 2 })).toBe(true);
  });
});

describe("help-bridge", () => {
  it("type-guards a help-request message", () => {
    expect(
      isHelpRequestMessage({
        type: HELP_REQUEST,
        requestId: "r1",
        prompt: "log in",
        displayMode: "compact",
        selectors: ["#login"],
        rects: [{ top: 10, left: 20, width: 100, height: 40 }],
        timeoutMs: 1000,
      }),
    ).toBe(true);
    expect(isHelpRequestMessage({ type: "borrow-request" })).toBe(false);
    expect(isHelpRequestMessage(null)).toBe(false);
  });

  it("rejects a help-request message with missing/wrong fields", () => {
    expect(isHelpRequestMessage({ type: HELP_REQUEST })).toBe(false);
    expect(
      isHelpRequestMessage({
        type: HELP_REQUEST,
        requestId: "r1",
        prompt: "p",
        selectors: "nope",
        timeoutMs: 1,
      }),
    ).toBe(false);
    expect(
      isHelpRequestMessage({
        type: HELP_REQUEST,
        requestId: "r1",
        prompt: "p",
        selectors: [123],
        timeoutMs: 1,
      }),
    ).toBe(false);
  });

  it("type-guards help-cancel and lifecycle messages", () => {
    expect(isHelpCancelMessage({ type: HELP_CANCEL, requestId: "r1" })).toBe(true);
    expect(isHelpCancelMessage({ type: HELP_REQUEST, requestId: "r1" })).toBe(false);
    expect(isHelpCancelMessage(null)).toBe(false);
    expect(isHelpAckMessage({ type: HELP_ACK, ok: true })).toBe(true);
    expect(isHelpQueryMessage({ type: HELP_QUERY })).toBe(true);
    expect(isHelpFinishMessage({ type: HELP_FINISH, requestId: "r1", outcome: "continued" })).toBe(
      true,
    );
    expect(isHelpResponseMessage({ type: HELP_RESPONSE, outcome: "cancelled", note: "no" })).toBe(
      true,
    );
    expect(isHelpFinishMessage({ type: HELP_FINISH, requestId: "r1", outcome: "weird" })).toBe(
      false,
    );
  });
});

describe("withExtensionOverlayHidden", () => {
  function recordingSendToTab(events: string[]) {
    return vi.fn(async (_tabId: number, message: CaptureSuppressMessage) => {
      events.push(message.phase);
      return { type: CAPTURE_SUPPRESS, ok: true };
    });
  }

  it("sends begin -> fn -> end and returns fn's result", async () => {
    const events: string[] = [];
    const sendToTab = recordingSendToTab(events);

    const result = await withExtensionOverlayHidden(
      7,
      async () => {
        events.push("capture");
        return "shot";
      },
      sendToTab,
    );

    expect(result).toBe("shot");
    expect(events).toEqual(["begin", "capture", "end"]);
    expect(sendToTab).toHaveBeenCalledWith(7, { type: CAPTURE_SUPPRESS, phase: "begin" });
    expect(sendToTab).toHaveBeenCalledWith(7, { type: CAPTURE_SUPPRESS, phase: "end" });
  });

  it("still sends end when fn throws, then rethrows", async () => {
    const events: string[] = [];
    const sendToTab = recordingSendToTab(events);

    await expect(
      withExtensionOverlayHidden(
        7,
        async () => {
          events.push("capture");
          throw new Error("capture exploded");
        },
        sendToTab,
      ),
    ).rejects.toThrow("capture exploded");
    expect(events).toEqual(["begin", "capture", "end"]);
  });

  it("captures directly when the tab has no content script", async () => {
    const sendToTab = vi.fn(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    const fn = vi.fn(async () => "shot");

    const result = await withExtensionOverlayHidden(7, fn, sendToTab);

    expect(result).toBe("shot");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sendToTab).toHaveBeenCalledTimes(1);
  });

  it("swallows end failures so the capture result stands", async () => {
    const sendToTab = vi.fn(async (_tabId: number, message: CaptureSuppressMessage) => {
      if (message.phase === "end") throw new Error("tab navigated away");
      return { type: CAPTURE_SUPPRESS, ok: true };
    });

    const result = await withExtensionOverlayHidden(7, async () => "shot", sendToTab);

    expect(result).toBe("shot");
    expect(sendToTab).toHaveBeenCalledTimes(2);
  });
});

describe("audit bridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

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

describe("remote UI channel", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fixture() {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const socket = Object.assign(new EventTarget(), { readyState: 1, send: vi.fn() });
    const handlers = {
      focus: vi.fn(async () => ({ focused: true })),
      preview: vi.fn(async () => ({ image_base64: "jpeg" })),
    };
    attachUiChannel(socket as unknown as WebSocket, handlers);
    const native = vi.fn();
    socket.addEventListener("message", native);
    const request = async (body: unknown) => {
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(body) }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { socket, handlers, native, request };
  }

  it("answers UI requests without reaching the native transport", async () => {
    const f = fixture();
    for (const name of ["preview", "focus"] as const) {
      await f.request({ id: name, method: `ui.task_${name}`, params: { session_id: "task" } });
      expect(f.handlers[name]).toHaveBeenCalledWith("task");
    }
    expect(f.native).not.toHaveBeenCalled();
    await f.request({ id: "native", method: "tool.snapshot", params: {} });
    expect(f.native).toHaveBeenCalledOnce();
  });

  it("rejects an invalid session id before any browser work", async () => {
    const f = fixture();
    await f.request({ id: "bad", method: "ui.task_focus", params: { session_id: 42 } });
    expect(f.handlers.focus).not.toHaveBeenCalled();
    expect(JSON.parse(f.socket.send.mock.calls[0]![0])).toMatchObject({
      error: { code: "invalid_params" },
    });
  });

  it("reports a failed request and drops a late reply on a closed socket", async () => {
    const f = fixture();
    f.handlers.focus.mockRejectedValueOnce(new Error("unavailable"));
    await f.request({ id: "focus", method: "ui.task_focus", params: { session_id: "task" } });
    expect(JSON.parse(f.socket.send.mock.calls[0]![0])).toMatchObject({
      error: { code: "cdp_failed", message: "unavailable" },
    });
    f.socket.readyState = 3;
    await f.request({ id: "late", method: "ui.task_preview", params: { session_id: "task" } });
    expect(f.socket.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not_found", "task_unavailable"],
    ["timeout", "ui_deadline"],
    ["timeout", "preview_busy"],
    ["cancelled", "task_stopping"],
    ["cdp_failed", "ui_lookup_failed"],
  ] as const)("preserves %s / %s in the socket response", async (code, reason) => {
    const f = fixture();
    f.handlers.preview.mockRejectedValueOnce(new UiTaskError(code, "Specific failure", reason));
    await f.request({ id: "typed", method: "ui.task_preview", params: { session_id: "task" } });
    expect(JSON.parse(f.socket.send.mock.calls[0]![0])).toEqual({
      id: "typed",
      error: { code, message: "Specific failure", data: { reason } },
    });
    expect(f.native).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", 42])("drops an uncorrelatable request ID %s", async (id) => {
    const f = fixture();
    await f.request({ id, method: "ui.task_preview", params: { session_id: "task" } });
    expect(f.handlers.preview).not.toHaveBeenCalled();
    expect(f.socket.send).not.toHaveBeenCalled();
    expect(f.native).not.toHaveBeenCalled();
  });

  it("passes unsupported UI methods to native unknown_method handling", async () => {
    const f = fixture();
    await f.request({ id: "probe", method: "ui.unsupported", params: {} });
    expect(f.native).toHaveBeenCalledOnce();
    expect(f.socket.send).not.toHaveBeenCalled();
  });
});
