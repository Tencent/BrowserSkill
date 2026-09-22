import { afterEach, describe, expect, it, vi } from "vitest";
import { UiTaskError } from "@/session-manager/ui-activity";
import { attachUiChannel } from "../ui-channel";

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

describe("remote UI channel", () => {
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
});

it.each([
  ["not_found", "task_unavailable"],
  ["timeout", "ui_deadline"],
  ["timeout", "preview_busy"],
  ["cancelled", "task_stopping"],
  ["cancelled", "ui_busy"],
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
