import { describe, expect, it, vi } from "vitest";
import { fillEditable } from "../editable-input";
import type { CdpRunner } from "../shared";

interface FakeOptions {
  initialValue?: string;
  finalValue: string;
  remount?: boolean;
}

function editableState(value: string, connected = true, focused = true) {
  return {
    result: {
      value: { supported: true, connected, focused, value, kind: "input" },
    },
  };
}

function makeEditableCdp(options: FakeOptions) {
  const sent: Array<{ method: string; params?: object }> = [];
  let inserted = false;
  const send = vi.fn(async <T>(_tabId: number, method: string, params?: object): Promise<T> => {
    sent.push({ method, params });
    if (method === "Input.insertText") {
      inserted = true;
      return {} as T;
    }
    if (method === "Input.dispatchKeyEvent") {
      if ((params as { type?: string }).type === "rawKeyDown") inserted = true;
      return {} as T;
    }
    if (method !== "Runtime.callFunctionOn") throw new Error(`unexpected ${method}`);

    const call = params as { objectId?: string; functionDeclaration?: string };
    const fn = call.functionDeclaration ?? "";
    if (fn.includes("bsk-editable-selection")) {
      return { result: { value: { selected: true } } } as T;
    }
    if (fn.includes("bsk-editable-sync")) return { result: { value: undefined } } as T;
    if (fn.includes("bsk-editable-live")) {
      return {
        result: options.remount && inserted ? { objectId: "replacement" } : { objectId: "anchor" },
      } as T;
    }
    if (fn.includes("bsk-editable-state")) {
      if (call.objectId === "replacement") return editableState(options.finalValue) as T;
      if (options.remount && inserted) {
        return editableState(options.finalValue, false, false) as T;
      }
      return editableState(inserted ? options.finalValue : (options.initialValue ?? "")) as T;
    }
    throw new Error("unexpected Runtime.callFunctionOn function");
  });
  return { cdp: { send } as CdpRunner, sent };
}

describe("fillEditable", () => {
  it("replaces text through the browser input path without synthetic events or value setters", async () => {
    const fake = makeEditableCdp({ initialValue: "old", finalValue: "新值" });

    const result = await fillEditable(fake.cdp, 4, "anchor", "新值", true);

    expect(result).toMatchObject({ value: "新值", replacedNode: false });
    expect(fake.sent).toContainEqual({ method: "Input.insertText", params: { text: "新值" } });
    const declarations = fake.sent
      .map((call) => (call.params as { functionDeclaration?: string })?.functionDeclaration ?? "")
      .join("\n");
    expect(declarations).not.toMatch(/dispatchEvent|\.value\s*=/);
  });

  it("reacquires the focused editable after a framework remount", async () => {
    const fake = makeEditableCdp({ finalValue: "persisted", remount: true });

    const result = await fillEditable(fake.cdp, 4, "anchor", "persisted", true);

    expect(result).toMatchObject({ value: "persisted", replacedNode: true });
  });

  it("reports a page rollback after the bounded settlement", async () => {
    const fake = makeEditableCdp({ finalValue: "" });

    const result = await fillEditable(fake.cdp, 4, "anchor", "rejected", true);

    expect(result).toMatchObject({
      code: "cdp_failed",
      data: {
        reason: "input_not_applied",
        expected_value_length: 8,
        actual_value_length: 0,
        phase: "readback",
      },
    });
  });

  it("clears to an empty value with a browser Backspace edit", async () => {
    const fake = makeEditableCdp({ initialValue: "old", finalValue: "" });

    const result = await fillEditable(fake.cdp, 4, "anchor", "", true);

    expect(result).toMatchObject({ value: "" });
    expect(fake.sent.some((call) => call.method === "Input.insertText")).toBe(false);
    expect(fake.sent.filter((call) => call.method === "Input.dispatchKeyEvent")).toHaveLength(2);
  });
});
