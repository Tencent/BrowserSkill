import { expect, it, vi } from "vitest";
import { withClickOverlay } from "../click-overlay";
import type { CdpRunner } from "../shared";

const point = { x: 40, y: 60 };

/** Answers the overlay hit test in order; `"exception"` stands for an unreadable probe. */
function probeCdp(values: unknown[]) {
  const send = vi.fn(async () => {
    const value = values.shift();
    if (value instanceof Error) throw value;
    return value === "exception"
      ? { exceptionDetails: { text: "hit test blocked" } }
      : { result: { value } };
  });
  return { send } as unknown as CdpRunner;
}

function deps(cdp: CdpRunner) {
  const bypassOverlay = vi.fn(async () => {});
  const sendInputPassthrough = vi.fn(async () => ({}));
  return {
    bypassOverlay,
    sendInputPassthrough,
    deps: { cdp, bypassOverlay, sendInputPassthrough } as never,
  };
}

it("names the click point and the still-covering overlay", async () => {
  const cdp = probeCdp(["covered", "covered", "covered"]);
  const d = deps(cdp);
  const click = vi.fn(async () => "clicked");
  const result = await withClickOverlay(7, point, d.deps, click);

  expect(result).toMatchObject({
    code: "cdp_failed",
    data: {
      reason: "input_not_ready",
      click_point: point,
      overlay_probe: "covered",
      overlay_bypass: "enabled",
      overlay_passthrough: "attempted",
      effect_state: "none",
    },
  });
  expect(result).toHaveProperty(
    "message",
    `The BrowserSkill overlay still covers the click point (40, 60) after bypass and input passthrough`,
  );
  expect(click).not.toHaveBeenCalled();
});

it("distinguishes an unreadable hit test from a still-covering overlay", async () => {
  const cdp = probeCdp(["covered", "exception"]);
  const d = deps(cdp);
  const result = await withClickOverlay(7, point, d.deps, async () => "clicked");

  expect(result).toMatchObject({
    code: "cdp_failed",
    data: { reason: "input_not_ready", overlay_probe: "unknown", overlay_bypass: "enabled" },
  });
  expect(result).toHaveProperty(
    "message",
    `Could not confirm the click point (40, 60) is clear: the overlay hit test did not answer after bypass`,
  );
  expect(d.bypassOverlay).toHaveBeenCalledWith(7, true);
});

it("distinguishes an expired passthrough lease from an obstruction", async () => {
  const cdp = probeCdp(["covered", "covered", "covered"]);
  const d = deps(cdp);
  const result = await withClickOverlay(7, point, d.deps, async () => "clicked", false, 60_000);

  expect(result).toMatchObject({
    code: "cdp_failed",
    data: { reason: "input_not_ready", overlay_passthrough: "attempted" },
  });
  expect(result).toHaveProperty(
    "message",
    `Input passthrough expired before the click point (40, 60) could be verified`,
  );
});

it("keeps an ordinary unobstructed click unchanged", async () => {
  const cdp = probeCdp(["absent", "absent"]);
  const d = deps(cdp);
  const result = await withClickOverlay(7, point, d.deps, async (beforePress) => {
    expect(await beforePress()).toBeNull();
    return "clicked";
  });

  expect(result).toBe("clicked");
  expect(d.bypassOverlay).not.toHaveBeenCalled();
  expect(d.sendInputPassthrough).not.toHaveBeenCalled();
});
