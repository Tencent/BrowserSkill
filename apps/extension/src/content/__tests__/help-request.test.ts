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
});
