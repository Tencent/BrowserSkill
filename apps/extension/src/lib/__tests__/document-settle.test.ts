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

    const settled = waitForDocumentSettled(cdp, { tabId: 7 });
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
      { tabId: 7 },
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
      tabId: 7,
      handle: { tabId: 7, frameId: "child-frame", loaderId: "loader-1" },
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

  it("routes an OOPIF probe through its FrameDocumentHandle", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const sendToFrame = vi.fn(async (_handle, method: string) => {
      if (method === "Page.createIsolatedWorld") return { executionContextId: 27 };
      return { result: { value: { idleMs: 1_000, readyState: "complete" } } };
    });
    const cdp: CdpRunner = {
      send: send as unknown as CdpRunner["send"],
      sendToFrame: sendToFrame as unknown as NonNullable<CdpRunner["sendToFrame"]>,
      hasOwnFrameTarget: (_tabId, frameId) => frameId === "oopif-frame",
    };

    const handle = { tabId: 7, frameId: "oopif-frame", loaderId: "oopif-loader" };
    const settled = waitForDocumentSettled(cdp, { tabId: 7, handle });
    await vi.advanceTimersByTimeAsync(180);

    await expect(settled).resolves.toBe("quiet");
    expect(send).not.toHaveBeenCalled();
    expect(sendToFrame).toHaveBeenCalledWith(
      handle,
      "Runtime.evaluate",
      expect.objectContaining({ contextId: 27 }),
      undefined,
    );
  });
});
