import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpRunner } from "@/tools/shared";
import { waitForDocumentSettled } from "../recording/document-settle";

function quietCdp(): { cdp: CdpRunner; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => ({
    result: { value: { idleMs: 1_000, readyState: "complete" } },
  }));
  return {
    cdp: { send: send as unknown as CdpRunner["send"] },
    send,
  };
}

describe("waitForDocumentSettled", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits through the minimum observation floor before accepting a quiet page", async () => {
    vi.useFakeTimers();
    const { cdp, send } = quietCdp();

    const settled = waitForDocumentSettled(cdp, { target: { tabId: 7 } });
    await vi.advanceTimersByTimeAsync(180);

    await expect(settled).resolves.toBe("quiet");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("cancels before probing a superseded observation", async () => {
    vi.useFakeTimers();
    const { cdp, send } = quietCdp();

    const controller = new AbortController();
    const settled = waitForDocumentSettled(
      cdp,
      { target: { tabId: 7 } },
      {
        signal: controller.signal,
      },
    );
    controller.abort();
    await vi.advanceTimersByTimeAsync(60);

    await expect(settled).resolves.toBe("cancelled");
    expect(send).not.toHaveBeenCalled();
  });

  it("probes a same-process iframe through its isolated execution context", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_tabId: number, method: string) => {
      if (method === "Page.createIsolatedWorld") return { executionContextId: 91 };
      return { result: { value: { idleMs: 1_000, readyState: "complete" } } };
    });
    const cdp: CdpRunner = { send: send as unknown as CdpRunner["send"] };

    const settled = waitForDocumentSettled(cdp, {
      target: { tabId: 7 },
      frameId: "child-frame",
    });
    await vi.advanceTimersByTimeAsync(180);

    await expect(settled).resolves.toBe("quiet");
    expect(send).toHaveBeenCalledWith(
      7,
      "Page.createIsolatedWorld",
      expect.objectContaining({ frameId: "child-frame" }),
    );
    expect(send).toHaveBeenCalledWith(
      7,
      "Runtime.evaluate",
      expect.objectContaining({ contextId: 91 }),
    );
  });

  it("routes an OOPIF probe through its CDP target session", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const sendToTarget = vi.fn(async (_target, method: string) => {
      if (method === "Page.createIsolatedWorld") return { executionContextId: 27 };
      return { result: { value: { idleMs: 1_000, readyState: "complete" } } };
    });
    const cdp: CdpRunner = {
      send: send as unknown as CdpRunner["send"],
      sendToTarget: sendToTarget as unknown as NonNullable<CdpRunner["sendToTarget"]>,
    };

    const target = { tabId: 7, sessionId: "oopif-session" };
    const settled = waitForDocumentSettled(cdp, { target, frameId: "oopif-frame" });
    await vi.advanceTimersByTimeAsync(180);

    await expect(settled).resolves.toBe("quiet");
    expect(send).not.toHaveBeenCalled();
    expect(sendToTarget).toHaveBeenCalledWith(
      target,
      "Runtime.evaluate",
      expect.objectContaining({ contextId: 27 }),
    );
  });
});
