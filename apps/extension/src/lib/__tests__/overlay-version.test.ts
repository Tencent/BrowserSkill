import { afterEach, expect, it, vi } from "vitest";
import { OVERLAY_AGENT_OVERLAY_RESET } from "@/lib/overlay-bridge";
import { nextOverlayVersion } from "@/lib/overlay-version";
import { chromeAgentOverlayResetApi } from "@/tools/tabs";

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
