import { describe, expect, it, vi } from "vitest";
import type { CdpRunner } from "../shared";
import { dispatchTextInput } from "../text-input";

function makeCdp(onSend?: (method: string, params?: object) => void) {
  const sent: Array<{ method: string; params?: object }> = [];
  const send = vi.fn(async <T>(_tabId: number, method: string, params?: object): Promise<T> => {
    sent.push({ method, params });
    onSend?.(method, params);
    return {} as T;
  });
  return { cdp: { send } as CdpRunner, sent };
}

describe("dispatchTextInput", () => {
  it("types ASCII through complete keydown, char, and keyup sequences", async () => {
    const fake = makeCdp();

    const result = await dispatchTextInput(fake.cdp, 4, "Ab");

    expect(result).toBeNull();
    expect(
      fake.sent.map((call) => `${call.method}:${(call.params as { type?: string }).type}`),
    ).toEqual([
      "Input.dispatchKeyEvent:rawKeyDown",
      "Input.dispatchKeyEvent:char",
      "Input.dispatchKeyEvent:keyUp",
      "Input.dispatchKeyEvent:rawKeyDown",
      "Input.dispatchKeyEvent:char",
      "Input.dispatchKeyEvent:keyUp",
    ]);
    expect(fake.sent[0].params).toMatchObject({ key: "A", code: "KeyA", modifiers: 8 });
    expect(fake.sent[1].params).toMatchObject({ text: "A" });
  });

  it("types non-ASCII through the committed IME insertion path", async () => {
    const fake = makeCdp();

    const result = await dispatchTextInput(fake.cdp, 4, "测试");

    expect(result).toBeNull();
    expect(fake.sent).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        params: {
          type: "rawKeyDown",
          key: "Process",
          code: "",
          windowsVirtualKeyCode: 229,
          nativeVirtualKeyCode: 229,
          modifiers: 0,
        },
      },
      { method: "Input.insertText", params: { text: "测试" } },
      {
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyUp",
          key: "Process",
          code: "",
          windowsVirtualKeyCode: 229,
          nativeVirtualKeyCode: 229,
          modifiers: 0,
        },
      },
    ]);
  });

  it("preserves text order across keyboard and IME segments", async () => {
    const fake = makeCdp();

    const result = await dispatchTextInput(fake.cdp, 4, "A测试1");

    expect(result).toBeNull();
    const meaningful = fake.sent.flatMap((call) => {
      if (call.method === "Input.insertText") {
        return [`ime:${(call.params as { text: string }).text}`];
      }
      if (
        call.method === "Input.dispatchKeyEvent" &&
        (call.params as { type?: string }).type === "char"
      ) {
        return [`key:${(call.params as { text: string }).text}`];
      }
      return [];
    });
    expect(meaningful).toEqual(["key:A", "ime:测试", "key:1"]);
  });

  it("reports cancellation observed after an accepted IME insertion", async () => {
    const abort = new AbortController();
    const fake = makeCdp((method) => {
      if (method === "Input.insertText") abort.abort();
    });

    const result = await dispatchTextInput(fake.cdp, 4, "测试", abort.signal);

    expect(result).toMatchObject({ code: "cancelled" });
    expect(fake.sent.map((call) => call.method)).toEqual([
      "Input.dispatchKeyEvent",
      "Input.insertText",
      "Input.dispatchKeyEvent",
    ]);
    expect(fake.sent.at(-1)?.params).toMatchObject({ type: "keyUp", key: "Process" });
  });

  it("releases the IME process key without committing when cancellation follows keydown", async () => {
    const abort = new AbortController();
    const fake = makeCdp((method, params) => {
      if (
        method === "Input.dispatchKeyEvent" &&
        (params as { type?: string }).type === "rawKeyDown"
      ) {
        abort.abort();
      }
    });

    const result = await dispatchTextInput(fake.cdp, 4, "测试", abort.signal);

    expect(result).toMatchObject({ code: "cancelled" });
    expect(fake.sent.map((call) => call.method)).toEqual([
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]);
    expect(fake.sent[0].params).toMatchObject({ type: "rawKeyDown", key: "Process" });
    expect(fake.sent[1].params).toMatchObject({ type: "keyUp", key: "Process" });
  });
});
