import { describe, expect, it, vi } from "vitest";
import {
  ACTION_STATUS_MAX_TARGET_CHARS,
  ACTION_STATUS_MSG,
  createActionStatusNotifier,
  isActionStatusMessage,
  truncateActionTarget,
} from "@/lib/action-status-bridge";

describe("isActionStatusMessage", () => {
  it("accepts start and end frames", () => {
    expect(
      isActionStatusMessage({ type: ACTION_STATUS_MSG, phase: "start", tool: "tool.click" }),
    ).toBe(true);
    expect(
      isActionStatusMessage({
        type: ACTION_STATUS_MSG,
        phase: "start",
        tool: "tool.click",
        target: "@e3",
      }),
    ).toBe(true);
    expect(
      isActionStatusMessage({ type: ACTION_STATUS_MSG, phase: "end", tool: "tool.click" }),
    ).toBe(true);
  });

  it("rejects malformed frames", () => {
    expect(isActionStatusMessage(null)).toBe(false);
    expect(isActionStatusMessage({ type: ACTION_STATUS_MSG, phase: "start" })).toBe(false);
    expect(isActionStatusMessage({ type: ACTION_STATUS_MSG, phase: "nope", tool: "t" })).toBe(
      false,
    );
    expect(
      isActionStatusMessage({ type: ACTION_STATUS_MSG, phase: "start", tool: "t", target: 3 }),
    ).toBe(false);
  });
});

describe("truncateActionTarget", () => {
  it("leaves short values alone and cuts long ones", () => {
    expect(truncateActionTarget("short")).toBe("short");
    const long = "x".repeat(ACTION_STATUS_MAX_TARGET_CHARS + 10);
    expect(truncateActionTarget(long)).toHaveLength(ACTION_STATUS_MAX_TARGET_CHARS);
  });
});

describe("createActionStatusNotifier", () => {
  it("sends start then end for the same tab", async () => {
    const send = vi.fn(async () => undefined);
    const notifier = createActionStatusNotifier(send);

    await notifier.start(7, "tool.click", "@e3");
    await notifier.end(7);

    expect(send.mock.calls).toEqual([
      [7, { type: ACTION_STATUS_MSG, phase: "start", tool: "tool.click", target: "@e3" }],
      [7, { type: ACTION_STATUS_MSG, phase: "end", tool: "tool.click" }],
    ]);
  });

  it("omits the target when none was derived", async () => {
    const send = vi.fn(async () => undefined);
    const notifier = createActionStatusNotifier(send);

    await notifier.start(7, "tool.scroll_to");

    expect(send).toHaveBeenCalledWith(7, {
      type: ACTION_STATUS_MSG,
      phase: "start",
      tool: "tool.scroll_to",
    });
  });

  it("swallows delivery failures so a tab without a content script never breaks an action", async () => {
    const send = vi.fn(async () => {
      throw new Error("Receiving end does not exist");
    });
    const notifier = createActionStatusNotifier(send);

    await expect(notifier.start(7, "tool.click", "@e1")).resolves.toBeUndefined();
    await expect(notifier.end(7)).resolves.toBeUndefined();
  });

  it("remembers the in-flight tool per tab so end still names it", async () => {
    const send = vi.fn(async () => undefined);
    const notifier = createActionStatusNotifier(send);

    await notifier.start(1, "tool.fill", "input#q");
    await notifier.start(2, "tool.hover", "@e9");
    await notifier.end(1);

    expect(send).toHaveBeenLastCalledWith(1, {
      type: ACTION_STATUS_MSG,
      phase: "end",
      tool: "tool.fill",
    });
  });
});
