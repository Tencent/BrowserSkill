import { describe, expect, it, vi } from "vitest";
import { createHelpRequestData } from "../help-request";

describe("createHelpRequestData", () => {
  it("gives live delivery and recovery the same rectangle refresh mechanism", async () => {
    const finish = vi.fn();
    const query = vi.fn(async () => ({
      active: true,
      request: {
        requestId: "help-1",
        prompt: "complete the challenge",
        selectors: [],
        rects: [{ top: 80, left: 90, width: 140, height: 60 }],
        timeoutMs: 1_000,
      },
    }));
    const request = createHelpRequestData(
      {
        requestId: "help-1",
        prompt: "complete the challenge",
        selectors: [],
        rects: [{ top: 10, left: 20, width: 30, height: 40 }],
        timeoutMs: 1_000,
      },
      { finish, query },
    );

    await expect(request.refreshRects?.()).resolves.toEqual([
      { top: 80, left: 90, width: 140, height: 60 },
    ]);
    request.onContinue(" done ");
    request.onCancel();

    expect(query).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenNthCalledWith(1, "help-1", "continued", " done ");
    expect(finish).toHaveBeenNthCalledWith(2, "help-1", "cancelled");
  });

  it("ignores rectangle replies for a replaced request", async () => {
    const request = createHelpRequestData(
      {
        requestId: "help-1",
        prompt: "complete the challenge",
        selectors: [],
        rects: [{ top: 10, left: 20, width: 30, height: 40 }],
        timeoutMs: 1_000,
      },
      {
        finish: vi.fn(),
        query: vi.fn(async () => ({
          active: true,
          request: {
            requestId: "help-2",
            prompt: "new challenge",
            selectors: [],
            rects: [{ top: 1, left: 2, width: 3, height: 4 }],
            timeoutMs: 1_000,
          },
        })),
      },
    );

    await expect(request.refreshRects?.()).resolves.toBeUndefined();
  });

  it("omits refreshRects when there are no cross-frame highlight rectangles", () => {
    const request = createHelpRequestData(
      {
        requestId: "help-no-rects",
        prompt: "sign in",
        selectors: ["#login"],
        rects: [],
        timeoutMs: 1_000,
      },
      {
        finish: vi.fn(),
        query: vi.fn(),
      },
    );

    expect(request.refreshRects).toBeUndefined();
  });

  it("retains refreshRects when hasDynamicRects is true even if rects is currently empty", async () => {
    const query = vi.fn(async () => ({
      active: true,
      request: {
        requestId: "help-offscreen-ref",
        prompt: "complete captcha",
        selectors: [],
        rects: [{ top: 45, left: 60, width: 180, height: 70 }],
        hasDynamicRects: true,
        timeoutMs: 1_000,
      },
    }));
    const request = createHelpRequestData(
      {
        requestId: "help-offscreen-ref",
        prompt: "complete captcha",
        selectors: [],
        rects: [],
        hasDynamicRects: true,
        timeoutMs: 1_000,
      },
      { finish: vi.fn(), query },
    );

    expect(request.hasDynamicRects).toBe(true);
    await expect(request.refreshRects?.()).resolves.toEqual([
      { top: 45, left: 60, width: 180, height: 70 },
    ]);
  });
});
