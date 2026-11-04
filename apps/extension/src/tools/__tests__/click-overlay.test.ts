import { expect, it, vi } from "vitest";
import { withClickOverlay } from "../click-overlay";

const coveredCdp = { send: vi.fn(async () => ({ result: { value: "covered" } })) } as never;

it("reports the point and each failed overlay-clearing step in input_not_ready (#556)", async () => {
  const click = vi.fn();
  const result = await withClickOverlay(
    7,
    { x: 10, y: 20 },
    {
      cdp: coveredCdp,
      bypassOverlay: async () => false,
      sendInputPassthrough: async (_tabId, message) => {
        if (message.phase === "begin") throw new Error("no receiver");
      },
    },
    click,
  );
  expect(click).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    code: "cdp_failed",
    message:
      "Could not clear the extension overlay from the click point (10, 20): " +
      "hit-test covered, bypass undelivered, passthrough failed",
    data: {
      reason: "input_not_ready",
      effect_state: "none",
      point: { x: 10, y: 20 },
      overlay: {
        hit: "covered",
        bypass: "undelivered",
        passthrough: "failed",
        deadline_reached: false,
      },
    },
  });
});

it("distinguishes a missing bypass from a delivered passthrough that did not clear the point", async () => {
  const result = await withClickOverlay(
    7,
    { x: 1, y: 2 },
    { cdp: coveredCdp, sendInputPassthrough: async () => {} },
    vi.fn(),
  );
  expect(result).toMatchObject({
    data: { overlay: { hit: "covered", bypass: "unavailable", passthrough: "sent" } },
  });
});
