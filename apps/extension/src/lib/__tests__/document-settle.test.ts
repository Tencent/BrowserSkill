import { afterEach, describe, expect, it, vi } from "vitest";
import { type CdpRunner, createStubCdpRunner } from "@/tools/shared";
import { waitForDocumentSettled } from "../recording/document-settle";

function quietCdp(): { cdp: CdpRunner; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async (_tabId: number, method: string, params?: { expression?: string }) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root-frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 11 };
    if (method === "Runtime.evaluate" && params?.expression?.includes("tokens.delete")) {
      return { result: { value: true } };
    }
    return {
      result: { value: { idleMs: 1_000, readyState: "complete" } },
    };
  });
  return {
    cdp: createStubCdpRunner({ send: send as unknown as CdpRunner["send"] }),
    send,
  };
}

describe("waitForDocumentSettled", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("bsk.record.quiet")];
  });

  it("waits through the minimum observation floor in an isolated world and cleans up its observer", async () => {
    vi.useFakeTimers();
    const { cdp, send } = quietCdp();

    const settled = waitForDocumentSettled(cdp, { tabId: 7 });
    await vi.advanceTimersByTimeAsync(180);

    await expect(settled).resolves.toBe("quiet");
    expect(send).toHaveBeenCalledWith(7, "Page.getFrameTree", {});
    expect(send).toHaveBeenCalledWith(
      7,
      "Page.createIsolatedWorld",
      expect.objectContaining({ frameId: "root-frame" }),
    );
    const evalCalls = send.mock.calls.filter(([, method]) => method === "Runtime.evaluate");
    expect(evalCalls).toHaveLength(4); // 3 polls + 1 cleanup
    for (const [, , params] of evalCalls) {
      expect((params as { contextId?: number }).contextId).toBe(11);
      expect((params as { expression?: string }).expression).not.toContain("__bskRecordQuiet");
    }
    expect((evalCalls[3]?.[2] as { expression?: string }).expression).toContain(
      "observer.disconnect()",
    );
  });

  it("executes probe and cleanup without polluting window.__bskRecordQuiet or leaking MutationObserver", async () => {
    vi.useFakeTimers();
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");
    const send = vi.fn(async (_tabId: number, method: string, params?: { expression?: string }) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root-frame" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 17 };
      if (method === "Runtime.evaluate" && params?.expression) {
        // Execute the exact generated probe/cleanup code against the DOM.
        const value = (0, eval)(params.expression);
        return { result: { value } };
      }
      return {};
    });
    const cdp = createStubCdpRunner({ send: send as unknown as CdpRunner["send"] });

    const settled = waitForDocumentSettled(cdp, { tabId: 7 });
    // Advance past SETTLE_MIN_MS + SETTLE_QUIET_MS with no mutations.
    await vi.advanceTimersByTimeAsync(360);

    await expect(settled).resolves.toBe("quiet");
    expect("__bskRecordQuiet" in window).toBe(false);
    expect(Symbol.for("bsk.record.quiet") in globalThis).toBe(false);
    expect(disconnectSpy).toHaveBeenCalledOnce();
  });

  it("cleans up the observer even when aborted mid-wait after probing began", async () => {
    vi.useFakeTimers();
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");
    const send = vi.fn(async (_tabId: number, method: string, params?: { expression?: string }) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root-frame" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 19 };
      if (method === "Runtime.evaluate" && params?.expression) {
        const value = (0, eval)(params.expression);
        return { result: { value } };
      }
      return {};
    });
    const cdp = createStubCdpRunner({ send: send as unknown as CdpRunner["send"] });
    const controller = new AbortController();

    const settled = waitForDocumentSettled(cdp, { tabId: 7 }, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(60);
    expect(Symbol.for("bsk.record.quiet") in globalThis).toBe(true);

    controller.abort();
    await expect(settled).resolves.toBe("cancelled");
    expect(Symbol.for("bsk.record.quiet") in globalThis).toBe(false);
    expect(disconnectSpy).toHaveBeenCalledOnce();
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
    const cdp: CdpRunner = createStubCdpRunner({ send: send as unknown as CdpRunner["send"] });

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
    const cdp: CdpRunner = createStubCdpRunner({
      send: send as unknown as CdpRunner["send"],
      sendToFrame: sendToFrame as unknown as CdpRunner["sendToFrame"],
      hasOwnFrameTarget: (_tabId, frameId) => frameId === "oopif-frame",
    });

    const handle = { tabId: 7, frameId: "oopif-frame", loaderId: "oopif-loader" };
    const settled = waitForDocumentSettled(cdp, { tabId: 7, handle });
    await vi.advanceTimersByTimeAsync(180);

    await expect(settled).resolves.toBe("quiet");
    expect(send).not.toHaveBeenCalled();
    expect(sendToFrame).toHaveBeenCalledWith(
      handle,
      "Runtime.evaluate",
      expect.objectContaining({ contextId: 27 }),
    );
  });
});
