import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import type { CapturedNode } from "@/tools/vom/capture";
import type { DraftTraceStep } from "@/transport/types";
import { resetStateIdCounterForTests } from "../record-constants";
import {
  applyTargetMatching,
  buildTraceV3,
  createObservationState,
  flushPendingRedirectLanding,
  rememberStepOnPage,
  scheduleRedirectLandingFlush,
} from "../record-observation";
import { registerObservation } from "../trace-reducer";

const URL = "https://example.com/login";

function capturedInput(): CapturedNode {
  return {
    backendNodeId: 42,
    parentBackendNodeId: null,
    tag: "input",
    attrs: {},
    rect: { x: 20, y: 40, w: 200, h: 30 },
    localRect: { x: 20, y: 40, w: 200, h: 30 },
    paintOrder: 1,
    position: "static",
    pointerEvents: "auto",
  };
}

function finalizedFillBody(value: string, redactValues: boolean): string {
  const obs = createObservationState({ redactValues });
  const rawVomText = '@vom 1\ntextbox "Password" value="••••••" [ref=e1]';
  const stateId = registerObservation(obs.stateRegistry, { url: URL, rawVomText });
  obs.lastSettled = {
    stateId,
    captured: [capturedInput()],
    refs: [{ ref: "e1", backendNodeId: 42, role: "textbox", name: "Password", line: 1 }],
    url: URL,
    vomText: rawVomText,
  };

  const draft: DraftTraceStep = {
    op: "fill",
    target: { unmatched: true },
    value,
    geometry: {
      rect: { x: 20, y: 40, w: 200, h: 30 },
      scrollX: 0,
      scrollY: 0,
      position: "static",
      tag: "input",
    },
  };
  applyTargetMatching(obs, draft, 1);
  draft.postStateId = stateId;
  rememberStepOnPage(obs, draft, 1);

  return (
    buildTraceV3({
      obs,
      steps: [draft],
      startedAt: "2026-08-12T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    }).states[0]?.body ?? ""
  );
}

describe("record observation annotations", () => {
  beforeEach(() => {
    resetStateIdCounterForTests();
  });

  it("omits a fill literal from finalized state bodies when values are redacted", () => {
    const secret = "hunter2-private";
    const body = finalizedFillBody(secret, true);

    expect(body).toContain("step 1: fill");
    expect(body).not.toContain(secret);
  });

  it("keeps fill details in ordinary recording annotations", () => {
    const value = "ordinary text";
    const body = finalizedFillBody(value, false);

    expect(body).toContain(`step 1: fill: ${JSON.stringify(value)}`);
  });
});

describe("applyTargetMatching without a settled observation", () => {
  it("keeps the capture role/name instead of a bare unmatched target", () => {
    const obs = createObservationState();
    const draft: DraftTraceStep = {
      op: "hover",
      target: { unmatched: true },
      captureTarget: { tag: "button", role: "button", name: "新建" },
      geometry: {
        rect: { x: 900, y: 8, w: 60, h: 32 },
        scrollX: 0,
        scrollY: 0,
        position: "static",
        tag: "button",
      },
    };

    applyTargetMatching(obs, draft, 1);

    expect(draft.preStateId).toBeUndefined();
    expect(draft.target).toEqual({
      role: "button",
      name: "新建",
      unmatched: true,
    });
  });
});

describe("applyTargetMatching while the previous action is still settling", () => {
  it("does not bind a new unmatched control to the stale observation", () => {
    const obs = createObservationState();
    const stateId = registerObservation(obs.stateRegistry, {
      url: URL,
      rawVomText: '@vom 1\n@e1 textbox "Search"',
    });
    obs.lastSettled = {
      stateId,
      captured: [capturedInput()],
      refs: [{ ref: "e1", backendNodeId: 42, role: "textbox", name: "Search", line: 1 }],
      url: URL,
      vomText: '@vom 1\n@e1 textbox "Search"',
    };
    obs.settles.set(0, { draftIndex: 0, cancelled: false });
    const draft: DraftTraceStep = {
      op: "click",
      target: { unmatched: true },
      captureTarget: { tag: "button", role: "button", name: "Confirm" },
      geometry: {
        rect: { x: 400, y: 300, w: 80, h: 30 },
        scrollX: 0,
        scrollY: 0,
        position: "fixed",
        tag: "button",
      },
    };

    applyTargetMatching(obs, draft, 2);

    expect(draft.preStateId).toBeUndefined();
    expect(draft.target).toEqual({ role: "button", name: "Confirm", unmatched: true });
  });
});

describe("redirect landing coalescing", () => {
  it("does not consume a newer redirect hop while reading tab metadata", async () => {
    vi.useFakeTimers();
    try {
      const finalUrl = "https://example.com/final";
      const intermediateUrl = "https://example.com/intermediate";
      const obs = createObservationState();
      obs.lastSettled = {
        stateId: "s-final",
        captured: [],
        refs: [],
        url: finalUrl,
        vomText: "@vom 1\nFinal",
      };
      const steps: DraftTraceStep[] = [];

      let resolveFirstTab!: (tab: chrome.tabs.Tab) => void;
      const firstTab = new Promise<chrome.tabs.Tab>((resolve) => {
        resolveFirstTab = resolve;
      });
      const get = vi
        .fn()
        .mockImplementationOnce(() => firstTab)
        .mockResolvedValue({ id: 7, url: finalUrl });
      const tabsApi: ChromeTabsApi = {
        get,
        query: vi.fn(async () => []),
      };
      const send = vi.fn(async (_tabId: number, method: string) => {
        if (method === "Runtime.evaluate") {
          return { result: { value: { idleMs: 1_000, readyState: "complete" } } };
        }
        throw new Error(`unexpected CDP method ${method}`);
      });
      const cdp: CdpRunner = { send: send as unknown as CdpRunner["send"] };

      scheduleRedirectLandingFlush(obs, steps, cdp, 7, tabsApi, intermediateUrl);
      await vi.advanceTimersByTimeAsync(180);
      expect(get).toHaveBeenCalledTimes(1);

      scheduleRedirectLandingFlush(obs, steps, cdp, 7, tabsApi, finalUrl);
      resolveFirstTab({ id: 7, url: intermediateUrl } as chrome.tabs.Tab);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushPendingRedirectLanding(obs, steps, cdp, 7, tabsApi);

      expect(steps).toEqual([]);
      expect(obs.pendingRedirect).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
