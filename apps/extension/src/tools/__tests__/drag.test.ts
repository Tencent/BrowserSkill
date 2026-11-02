import { expect, it, vi } from "vitest";
import { guardedRunner } from "@/cooperation/action-guard";
import { INPUT_PASSTHROUGH } from "@/lib/input-passthrough-bridge";
import type { DragParams } from "@/transport/types";
import { withClickOverlay } from "../click-overlay";
import { validateDrag } from "../drag";
import { pointerTransactionDeps } from "../pointer-transaction";
import type { CdpRunner } from "../shared";

it.each([
  { source: { selector: "" } },
  { source: { ref: "e1", selector: "#one" } },
  { delta: { x: NaN, y: 1 } },
  { target: { selector: "#two" } },
  { mode: "auto" },
  { mode: "click-move-click" },
  { mode: "click-move-click", target: { ref: "e2" }, delta: undefined, hold_ms: 1 },
  { duration_ms: 0 },
  { duration_ms: Infinity },
  { hold_ms: -1 },
  { source: { selector: "#one", offset: { x: 1, y: Infinity } } },
  { modifiers: ["unknown"] },
])("rejects malformed drag parameters: %j", (invalid) => {
  expect(
    validateDrag({
      session_id: "s",
      source: { ref: "e1" },
      delta: { x: 2, y: 0 },
      ...invalid,
    } as DragParams),
  ).toMatchObject({ code: "invalid_params" });
});
it("cancels native drag and releases the last position after control is revoked", async () => {
  let revoked = false;
  const sent: { method: string; params?: object }[] = [];
  const raw: CdpRunner = {
    send: vi.fn(async (_tab, method, params) => {
      sent.push({ method, params });
      return {};
    }) as CdpRunner["send"],
  };
  const cdp = guardedRunner(raw, {
    prepare: async () => {
      if (revoked) throw new Error("revoked");
    },
    dispatch: () => {
      if (revoked) throw new Error("revoked");
    },
  });
  const scope = pointerTransactionDeps(
    { cdp, tabsApi: { get: vi.fn(), query: vi.fn() } },
    undefined,
    true,
  );
  await scope.deps.cdp.send(4, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    x: 10,
    y: 20,
  });
  await scope.deps.cdp.send(4, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "left",
    buttons: 1,
    x: 80,
    y: 90,
  });
  revoked = true;
  await scope.cleanup(Date.now() + 1000);
  expect(sent.map((s) => s.method)).toEqual([
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Input.cancelDragging",
    "Input.dispatchMouseEvent",
  ]);
  expect(sent.at(-1)?.params).toMatchObject({ type: "mouseReleased", x: 80, y: 90 });
  await expect(
    scope.deps.cdp.send(4, "Input.dispatchMouseEvent", { type: "mouseMoved" }),
  ).rejects.toThrow();
});
it("does not allow an unrelated request to cancel dragging after revocation", async () => {
  const raw: CdpRunner = { send: vi.fn() as CdpRunner["send"] };
  const cdp = guardedRunner(raw, {
    prepare: async () => {
      throw new Error("revoked");
    },
  });
  await expect(cdp.send(4, "Input.cancelDragging", {})).rejects.toThrow("revoked");
  expect(raw.send).not.toHaveBeenCalled();
});

it("does not release a replacement attachment after native cancellation settles", async () => {
  let attachment = "original";
  const cdp: CdpRunner = {
    getAttachmentId: () => attachment,
    send: vi.fn(async (_tab, method) => {
      if (method === "Input.cancelDragging") attachment = "replacement";
      return {};
    }) as CdpRunner["send"],
  };
  const scope = pointerTransactionDeps(
    { cdp, tabsApi: { get: vi.fn(), query: vi.fn() } },
    undefined,
    true,
  );
  await scope.deps.cdp.send(4, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    x: 10,
    y: 20,
  });
  await scope.deps.cdp.send(4, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "left",
    x: 20,
    y: 20,
  });
  await scope.cleanup(Date.now() + 1000);
  expect(vi.mocked(cdp.send).mock.calls.map(([, method]) => method)).toEqual([
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Input.cancelDragging",
  ]);
});

it("does not complete a drop when native cancellation cannot be confirmed", async () => {
  const cdp: CdpRunner = {
    send: vi.fn(async (_tab, method) => {
      if (method === "Input.cancelDragging") throw new Error("disconnected");
      return {};
    }) as CdpRunner["send"],
    detach: vi.fn(async () => {}),
  };
  const scope = pointerTransactionDeps(
    { cdp, tabsApi: { get: vi.fn(), query: vi.fn() } },
    undefined,
    true,
  );
  await scope.deps.cdp.send(4, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    x: 10,
    y: 20,
  });
  await scope.deps.cdp.send(4, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "left",
    x: 20,
    y: 20,
  });
  await expect(scope.cleanup(Date.now() + 1000)).rejects.toThrow("disconnected");
  expect(cdp.detach).toHaveBeenCalledOnce();
  expect(
    vi
      .mocked(cdp.send)
      .mock.calls.some(([, , p]) => (p as { type?: string })?.type === "mouseReleased"),
  ).toBe(false);
});

it("refuses a long gesture before input when overlay passthrough cannot cover it", async () => {
  let passthrough = false;
  const cdp: CdpRunner = {
    send: vi.fn(async () => ({
      result: { value: passthrough ? "clear" : "covered" },
    })) as CdpRunner["send"],
  };
  const action = vi.fn(async () => ({ done: true }));
  const result = await withClickOverlay(
    4,
    { x: 10, y: 20 },
    {
      cdp,
      sendInputPassthrough: async (_tab, message) => {
        passthrough = message.phase === "begin";
        return { type: INPUT_PASSTHROUGH, ok: true };
      },
    },
    action,
    true,
    6000,
  );
  expect(result).toMatchObject({ code: "cdp_failed", data: { effect_state: "none" } });
  expect(action).not.toHaveBeenCalled();
  expect(passthrough).toBe(false);
});
