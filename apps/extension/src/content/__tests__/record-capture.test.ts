import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECORD_STOP, type RecordStepPayload } from "@/lib/record-bridge";
import { handleRecordContentMessage, startRecordCapture } from "../record-capture";

vi.stubGlobal("chrome", {
  runtime: {
    sendMessage: vi.fn(() => Promise.resolve()),
  },
});

describe("handleRecordContentMessage stop/cancel", () => {
  it("ignores STOP when no recording is active", () => {
    const dispose = vi.fn();
    const onStop = vi.fn();
    const setActiveRequestId = vi.fn();
    const setCapture = vi.fn();
    const sendResponse = vi.fn();

    const needsAsync = handleRecordContentMessage(
      { type: RECORD_STOP, requestId: "rec-stale" },
      {
        activeRequestId: null,
        capture: { dispose },
        setActiveRequestId,
        setCapture,
        onStart: vi.fn(),
        onStop,
      },
      sendResponse,
    );

    expect(needsAsync).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    expect(setActiveRequestId).not.toHaveBeenCalled();
    expect(setCapture).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("ignores STOP for a mismatched requestId", () => {
    const dispose = vi.fn();
    const onStop = vi.fn();

    const needsAsync = handleRecordContentMessage(
      { type: RECORD_STOP, requestId: "rec-other" },
      {
        activeRequestId: "rec-1",
        capture: { dispose },
        setActiveRequestId: vi.fn(),
        setCapture: vi.fn(),
        onStart: vi.fn(),
        onStop,
      },
      vi.fn(),
    );

    expect(needsAsync).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe("record-capture semantic", () => {
  let steps: RecordStepPayload[];

  beforeEach(() => {
    steps = [];
    document.body.innerHTML = `
      <label for="q">查询</label>
      <input id="q" name="q" />
      <button type="button" aria-label="搜索">搜索</button>
      <div role="listbox" id="sug">
        <div role="option">建议项</div>
      </div>
    `;
  });

  it("commits final fill value and records semantic click", () => {
    const capture = startRecordCapture("rec-1", (step) => steps.push(step));
    const input = document.querySelector("input")!;
    const button = document.querySelector("button")!;

    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));

    capture.dispose();

    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: "fill",
          value: "hello",
          target: expect.objectContaining({ name: "查询", tag: "input" }),
        }),
        expect.objectContaining({
          op: "click",
          target: expect.objectContaining({ name: "搜索", role: "button" }),
        }),
      ]),
    );
    expect(JSON.stringify(steps)).not.toMatch(/@e\d+/);
    expect(steps.some((s) => "selector" in s)).toBe(false);
  });

  it("ignores autocomplete suggestion clicks while a fill session is open", () => {
    const capture = startRecordCapture("rec-2", (step) => steps.push(step));
    const input = document.querySelector("input")!;
    const option = document.querySelector('[role="option"]')!;

    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.value = "hel";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    option.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    capture.dispose();

    expect(steps.filter((s) => s.op === "click")).toHaveLength(0);
    expect(steps.some((s) => s.op === "fill" && s.value === "hello")).toBe(true);
  });

  it("records Enter press but not bare typing keys", () => {
    const capture = startRecordCapture("rec-press", (step) => steps.push(step));
    const input = document.querySelector("input")!;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    capture.dispose();
    expect(steps.filter((s) => s.op === "press")).toEqual([
      expect.objectContaining({ op: "press", key: "Enter" }),
    ]);
  });

  it("does not record clicks on anonymous layout divs", () => {
    document.body.innerHTML = `
      <div id="chrome">page chrome</div>
      <button type="button" aria-label="下一步">下一步</button>
    `;
    const capture = startRecordCapture("rec-3", (step) => steps.push(step));
    document
      .querySelector("#chrome")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    document
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      op: "click",
      target: { name: "下一步", role: "button" },
    });
  });
});
