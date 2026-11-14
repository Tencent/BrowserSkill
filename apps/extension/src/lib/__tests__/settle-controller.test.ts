import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import { ObservationNodeIndex, type RegisteredObservation } from "../recording/observation-capture";
import { RecordingObservationSession } from "../recording/observation-session";
import { SettleController } from "../recording/settle-controller";
import type { RecordingDraftStep } from "../recording/types";

const OBSERVATION: RegisteredObservation = {
  stateId: "s-next",
  rootFrameId: "root",
  index: new ObservationNodeIndex({ rootFrameId: "root", matchNodes: [], refs: [] }),
  url: "https://example.com/next",
};

describe("SettleController", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts superseded capture work and lands the prior action on the next origin", async () => {
    vi.useFakeTimers();
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({
        result: { value: { idleMs: 1_000, readyState: "complete" } },
      })) as unknown as CdpRunner["send"],
    };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    let firstSignal: AbortSignal | undefined;
    vi.spyOn(session, "capture")
      .mockImplementationOnce(async (_cdp, _tabs, _tabId, signal) => {
        firstSignal = signal;
        return new Promise<RegisteredObservation>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("observation aborted", "AbortError")),
            { once: true },
          );
        });
      })
      .mockResolvedValueOnce(OBSERVATION);

    const drafts: RecordingDraftStep[] = [
      { op: "click", captureTarget: { tag: "button", name: "First" }, preStateId: "s1" },
    ];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    controller.schedule(drafts, 0);
    await vi.advanceTimersByTimeAsync(180);

    drafts.push({
      op: "click",
      captureTarget: { tag: "button", name: "Second" },
      preStateId: "s-next",
    });
    controller.schedule(drafts, 1);
    expect(firstSignal?.aborted).toBe(true);
    expect(drafts[0]?.postStateId).toBe("s-next");

    await vi.advanceTimersByTimeAsync(500);
    await controller.flush();
    expect(drafts[1]?.postStateId).toBe("s-next");
  });

  it("does not consume a newer redirect while reading the prior landing URL", async () => {
    vi.useFakeTimers();
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({
        result: { value: { idleMs: 1_000, readyState: "complete" } },
      })) as unknown as CdpRunner["send"],
    };
    let resolveFirstTab!: (tab: chrome.tabs.Tab) => void;
    const firstTab = new Promise<chrome.tabs.Tab>((resolve) => {
      resolveFirstTab = resolve;
    });
    const tabsApi: ChromeTabsApi = {
      get: vi
        .fn()
        .mockImplementationOnce(() => firstTab)
        .mockResolvedValue({ id: 7, url: OBSERVATION.url }),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    session.cursor.lastSettled = OBSERVATION;
    const drafts: RecordingDraftStep[] = [];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });

    controller.scheduleRedirect(drafts, "https://example.com/intermediate");
    await vi.advanceTimersByTimeAsync(180);
    expect(tabsApi.get).toHaveBeenCalledTimes(1);

    controller.scheduleRedirect(drafts, OBSERVATION.url);
    resolveFirstTab({ id: 7, url: "https://example.com/intermediate" } as chrome.tabs.Tab);
    await vi.advanceTimersByTimeAsync(500);
    await controller.flushRedirects();

    expect(drafts).toEqual([]);
    expect(controller.hasPending).toBe(false);
  });

  it("settles an action in its own OOPIF document scope", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const sendToFrame = vi.fn(async (_handle, method: string) => {
      if (method === "Page.createIsolatedWorld") return { executionContextId: 39 };
      return { result: { value: { idleMs: 1_000, readyState: "complete" } } };
    });
    const cdp: CdpRunner = {
      send: send as unknown as CdpRunner["send"],
      sendToFrame: sendToFrame as unknown as NonNullable<CdpRunner["sendToFrame"]>,
      hasOwnFrameTarget: (_tabId, frameId) => frameId === "oopif-frame",
    };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    vi.spyOn(session, "capture").mockResolvedValue(OBSERVATION);
    const drafts: RecordingDraftStep[] = [
      { op: "click", captureTarget: { tag: "button", name: "Inside frame" } },
    ];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    const handle = { tabId: 7, frameId: "oopif-frame", loaderId: "oopif-loader" };

    controller.schedule(drafts, 0, { tabId: 7, handle });
    await vi.advanceTimersByTimeAsync(180);
    await controller.flush();

    expect(send).not.toHaveBeenCalled();
    expect(sendToFrame).toHaveBeenCalledWith(
      handle,
      "Runtime.evaluate",
      expect.objectContaining({ contextId: 39 }),
      undefined,
    );
    expect(drafts[0]?.postStateId).toBe("s-next");
  });
});
