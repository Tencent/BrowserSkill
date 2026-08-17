import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpRunner } from "@/tools/shared";
import { waitForPageSettled } from "../page-settled";

function quietCdp(): { cdp: CdpRunner; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => ({
    result: { value: { idleMs: 1_000, readyState: "complete" } },
  }));
  return {
    cdp: { send: send as unknown as CdpRunner["send"] },
    send,
  };
}

describe("waitForPageSettled", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits through the minimum observation floor before accepting a quiet page", async () => {
    vi.useFakeTimers();
    const { cdp, send } = quietCdp();

    const settled = waitForPageSettled(cdp, 7);
    await vi.advanceTimersByTimeAsync(180);

    await expect(settled).resolves.toBe("quiet");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("cancels before probing a superseded observation", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const { cdp, send } = quietCdp();

    const settled = waitForPageSettled(cdp, 7, { cancelled: () => cancelled });
    cancelled = true;
    await vi.advanceTimersByTimeAsync(60);

    await expect(settled).resolves.toBe("cancelled");
    expect(send).not.toHaveBeenCalled();
  });
});
