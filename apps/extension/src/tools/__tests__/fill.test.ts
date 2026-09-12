import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import { handleFill } from "../interaction";

interface ScriptParams {
  functionDeclaration: string;
  arguments?: Array<{ value: unknown }>;
}

async function setup(markup = '<input value="old">') {
  document.body.innerHTML = markup;
  const element = document.body.firstElementChild as HTMLInputElement;
  const manager = new SessionManager({
    agentWindow: {
      create: async () => 100,
      remove: async () => {},
      ensureActiveTab: async () => 4,
    },
  });
  const ctx = await manager.start("aa11");
  ctx.refStore.set("e1", 12, { tabId: 4 });
  const script = vi.fn(async (params: ScriptParams): Promise<unknown> => {
    try {
      const fn = new Function(`return (${params.functionDeclaration})`)();
      return {
        result: {
          value: await fn.apply(
            element,
            (params.arguments ?? []).map((arg) => arg.value),
          ),
        },
      };
    } catch {
      return { exceptionDetails: { text: "test page script failed" } };
    }
  });
  // Number/email controls have a browser caret even though their selection
  // getters return null. Model that caret instead of assuming it is at the end.
  const hiddenCaret = { start: 0, end: 0 };
  const moveToEnd = vi.fn(async () => {
    if (typeof element.selectionStart === "number") {
      element.setSelectionRange(element.value.length, element.value.length);
    } else {
      hiddenCaret.start = hiddenCaret.end = element.value.length;
    }
  });
  const insert = vi.fn(async (text: string) => {
    const focused = document.activeElement as HTMLInputElement;
    if (focused.readOnly || focused.disabled) return;
    const start = focused.selectionStart ?? hiddenCaret.start;
    const end = focused.selectionEnd ?? hiddenCaret.end;
    const value = focused.value.slice(0, start) + text + focused.value.slice(end);
    focused.value = focused.maxLength >= 0 ? value.slice(0, focused.maxLength) : value;
    hiddenCaret.start = hiddenCaret.end = Math.min(start + text.length, focused.value.length);
    focused.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const release = vi.fn(async () => ({}));
  const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
    switch (method) {
      case "DOM.describeNode":
        return {
          node: {
            nodeName: element.tagName,
            attributes: Array.from(element.attributes).flatMap((attr) => [attr.name, attr.value]),
          },
        };
      case "DOM.scrollIntoViewIfNeeded":
        return {};
      case "DOM.focus":
        element.focus();
        return {};
      case "DOM.resolveNode":
        return { object: { objectId: "fill-target" } };
      case "Runtime.callFunctionOn":
        return script(params as ScriptParams);
      case "Input.insertText":
        await insert((params as { text: string }).text);
        return {};
      case "Input.dispatchKeyEvent":
        if ((params as { commands?: string[] }).commands?.includes("moveToEndOfDocument")) {
          await moveToEnd();
        }
        return {};
      case "Runtime.releaseObject":
        return release();
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  return {
    element,
    hiddenCaret,
    moveToEnd,
    script,
    insert,
    release,
    send,
    fill: (value = "hello", clearBefore = true, signal?: AbortSignal) =>
      handleFill(
        manager,
        { session_id: "aa11", ref: "e1", value, clear_before: clearBefore },
        {
          cdp: { send: send as CdpRunner["send"] },
          tabsApi: {
            get: async (id) => ({ id, windowId: 100, active: true }) as chrome.tabs.Tab,
            query: async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab],
          },
          signal,
        },
      ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("fill result verification", () => {
  it.each([
    "readonly",
    "disabled",
  ])("preserves a %s field before rejecting it", async (attribute) => {
    const h = await setup(`<input ${attribute} value="old">`);
    expect(await h.fill()).toMatchObject({
      code: "invalid_params",
      data: { reason: "target_not_fillable" },
    });
    expect(h.element.value).toBe("old");
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each([
    "checkbox",
    "radio",
    "range",
    "date",
    "file",
  ])("rejects an unsupported %s input before clearing", async (type) => {
    const h = await setup(`<input type="${type}">`);
    const before = h.element.value;
    expect(await h.fill()).toMatchObject({
      code: "invalid_params",
      data: { reason: "target_not_fillable" },
    });
    expect(h.element.value).toBe(before);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("rejects an overlong value before clearing", async () => {
    const h = await setup('<input maxlength="3" value="old">');
    expect(await h.fill()).toMatchObject({
      code: "invalid_params",
      message: /maxlength/,
      data: { reason: "fill_value_invalid" },
    });
    expect(h.element.value).toBe("old");
    expect(h.insert).not.toHaveBeenCalled();
  });

  it.each([
    true,
    false,
  ])("classifies a DOM.focus rejection on a disabled=%s target", async (disabled) => {
    const h = await setup(`<input ${disabled ? "disabled" : ""} value="old">`);
    const send = h.send.getMockImplementation()!;
    h.send.mockImplementation(async (tabId, method, params) => {
      if (method === "DOM.focus") throw new Error("Element is not focusable");
      return send(tabId, method, params);
    });
    expect(await h.fill()).toMatchObject({
      code: disabled ? "invalid_params" : "cdp_failed",
      data: { reason: disabled ? "target_not_fillable" : "fill_failed" },
    });
    expect(h.element.value).toBe("old");
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("fills a background document without requiring foreground browser focus", async () => {
    const h = await setup();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(await h.fill()).toMatchObject({ value_length: 5 });
    expect(h.element.value).toBe("hello");
  });

  it("restores focus once after clearing without typing into another field", async () => {
    const h = await setup();
    const other = document.createElement("input");
    document.body.append(other);
    h.element.addEventListener("input", () => other.focus());
    expect(await h.fill()).toMatchObject({ value_length: 5 });
    expect(h.element.value).toBe("hello");
    expect(other.value).toBe("");
    expect(h.send.mock.calls.filter(([, method]) => method === "DOM.focus")).toHaveLength(2);
  });

  it.each([
    "focus",
    "value",
  ])("rechecks %s after restoring focus, without retrying again", async (action) => {
    const h = await setup();
    const other = document.createElement("input");
    document.body.append(other);
    h.element.addEventListener(
      "input",
      () => {
        other.focus();
        h.element.addEventListener("focus", () => {
          if (action === "focus") queueMicrotask(() => other.focus());
          else h.element.value = "changed";
        });
      },
      { once: true },
    );
    expect(await h.fill()).toMatchObject({
      code: "cdp_failed",
      data: { reason: action === "focus" ? "fill_focus_lost" : "fill_target_changed" },
    });
    expect(other.value).toBe("");
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.send.mock.calls.filter(([, method]) => method === "DOM.focus")).toHaveLength(2);
  });

  it.each([
    "remove",
    "readonly",
    "restore",
    "microtask-restore",
  ])("stops when clearing causes the page to %s the target", async (action) => {
    const h = await setup();
    h.element.addEventListener("input", () => {
      if (action === "remove") h.element.remove();
      if (action === "readonly") h.element.readOnly = true;
      if (action === "restore") h.element.value = "restored";
      if (action === "microtask-restore")
        queueMicrotask(() => {
          h.element.value = "restored";
        });
    });
    expect(await h.fill()).toMatchObject({
      code: "cdp_failed",
      data: { reason: "fill_target_changed" },
    });
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("fails when insertText is acknowledged without changing the value", async () => {
    const h = await setup();
    h.insert.mockImplementation(async () => {});
    expect(await h.fill()).toMatchObject({
      code: "cdp_failed",
      data: { reason: "fill_value_mismatch" },
    });
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("detects truncation when maxlength changes after preparation", async () => {
    const h = await setup();
    h.element.addEventListener(
      "input",
      () => {
        h.element.maxLength = 3;
      },
      { once: true },
    );
    expect(await h.fill()).toMatchObject({
      code: "cdp_failed",
      data: { reason: "fill_value_mismatch" },
    });
    expect(h.element.value).toBe("hel");
  });

  it.each([
    "input",
    "change",
    "microtask-change",
  ])("detects a value reverted by the %s handler", async (event) => {
    const h = await setup();
    h.element.addEventListener(event === "microtask-change" ? "change" : event, () => {
      if (event === "microtask-change")
        queueMicrotask(() => {
          h.element.value = "";
        });
      else h.element.value = "";
    });
    expect(await h.fill()).toMatchObject({ code: "cdp_failed", message: /expected value/ });
  });

  it("compares content rather than length without including field values in the error", async () => {
    const h = await setup('<input type="password">');
    h.element.addEventListener("change", () => {
      h.element.value = "other-secret";
    });
    const result = await h.fill("given-secret");
    expect(result).toMatchObject({ code: "cdp_failed", message: /expected value/ });
    expect(JSON.stringify(result)).not.toMatch(/given-secret|other-secret/);
  });

  it("does not report success for a target replaced by a change handler", async () => {
    const h = await setup();
    h.element.addEventListener("change", () => h.element.replaceWith(h.element.cloneNode()));
    expect(await h.fill()).toMatchObject({
      code: "cdp_failed",
      data: { reason: "fill_target_changed" },
    });
  });

  it.each([
    1, 2, 3, 4, 5,
  ])("rejects script exceptions at phase %s and releases the target", async (phase) => {
    const h = await setup();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const run = h.script.getMockImplementation()!;
    let count = 0;
    h.script.mockImplementation(async (params) =>
      ++count === phase ? { exceptionDetails: { text: "page secret" } } : run(params),
    );
    const result = await h.fill();
    expect(result).toMatchObject({ code: "cdp_failed", data: { reason: "fill_failed" } });
    expect(JSON.stringify(result)).not.toContain("page secret");
    if (phase <= 3) expect(h.insert).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 3, 5])("rejects missing results at phase %s", async (phase) => {
    const h = await setup();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const run = h.script.getMockImplementation()!;
    let count = 0;
    h.script.mockImplementation(async (params) =>
      ++count === phase ? { result: { type: "undefined" } } : run(params),
    );
    expect(await h.fill()).toMatchObject({ code: "cdp_failed" });
    if (phase <= 3) expect(h.insert).not.toHaveBeenCalled();
  });

  it.each(["input", "change"])("checks state after nested microtasks from %s", async (event) => {
    const h = await setup();
    h.element.addEventListener(event, () => {
      queueMicrotask(() =>
        queueMicrotask(() => {
          h.element.value = "reverted";
        }),
      );
    });
    expect(await h.fill()).toMatchObject({ code: "cdp_failed" });
    if (event === "input") expect(h.insert).not.toHaveBeenCalled();
  });

  it.each([
    "<input>",
    '<input type="password">',
    "<textarea></textarea>",
  ])("verifies successful text in %s", async (markup) => {
    const h = await setup(markup);
    expect(await h.fill("你好🙂")).toMatchObject({ value_length: 4 });
    expect(h.element.value).toBe("你好🙂");
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("verifies append against the old value plus the requested text", async () => {
    const h = await setup();
    h.element.focus();
    h.element.setSelectionRange(3, 3);
    expect(await h.fill("!", false)).toMatchObject({ value_length: 4 });
    expect(h.element.value).toBe("old!");
  });

  it.each([
    ["<textarea></textarea>", "a\r\nb", "a\nb"],
    ["<input>", "a\nb", "a b"],
    ["<input>", "a\r\nb", "a b"],
    [
      '<input type="email" multiple>',
      " a@example.com , b@example.com ",
      "a@example.com,b@example.com",
    ],
  ])("accepts native normalization for %s", async (markup, requested, normalized) => {
    if (markup.startsWith("<textarea")) {
      // Happy DOM does not implement Chrome's textarea line-ending normalization.
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      vi.spyOn(HTMLTextAreaElement.prototype, "value", "set").mockImplementation(function (
        this: HTMLTextAreaElement,
        value,
      ) {
        setter.call(this, value.replace(/\r\n?/g, "\n"));
      });
    }
    const h = await setup(markup);
    h.insert.mockImplementation(async () => {
      h.element.value = normalized;
    });
    expect(await h.fill(requested)).toMatchObject({ value_length: normalized.length });
  });

  it("does not count an editable padding break as an extra typed character", async () => {
    const h = await setup('<div contenteditable="true" tabindex="0"></div>');
    // These two layout/editability properties are missing in Happy DOM.
    let innerText = "";
    Object.defineProperty(h.element, "isContentEditable", { get: () => true });
    Object.defineProperty(h.element, "innerText", { get: () => innerText });
    h.insert.mockImplementation(async () => {
      h.element.innerHTML = "one<div><br></div>";
      innerText = "one\n\n";
    });
    expect(await h.fill("one\n")).toMatchObject({ value_length: 4 });
  });

  it.each([
    [0, 0],
    [1, 1],
    [0, 3],
  ])("appends after moving selection %s:%s to the end", async (start, end) => {
    const h = await setup();
    h.element.focus();
    h.element.setSelectionRange(start, end);
    expect(await h.fill("🙂", false)).toMatchObject({ value_length: 5 });
    expect(h.element.value).toBe("old🙂");
  });

  it.each(
    ["number", "email"].flatMap((type) =>
      [
        [0, 0],
        [1, 1],
        [0, 2],
      ].map(([start, end]) => ({ type, start, end })),
    ),
  )("appends to $type from selection $start:$end without using its unsupported API", async ({
    type,
    start,
    end,
  }) => {
    const h = await setup(`<input type="${type}" value="12">`);
    Object.assign(h.hiddenCaret, { start, end });
    vi.spyOn(h.element, "selectionStart", "get").mockReturnValue(null);
    vi.spyOn(h.element, "selectionEnd", "get").mockReturnValue(null);
    const selection = vi.spyOn(h.element, "setSelectionRange").mockImplementation(() => {
      throw new DOMException("unsupported", "InvalidStateError");
    });
    expect(await h.fill("3", false)).toMatchObject({ value_length: 3 });
    expect(h.element.value).toBe("123");
    expect(selection).not.toHaveBeenCalled();
  });

  it.each([
    "number",
    "email",
  ])("does not report successful %s append when the caret command is ignored", async (type) => {
    const h = await setup(`<input type="${type}" value="12">`);
    vi.spyOn(h.element, "selectionStart", "get").mockReturnValue(null);
    vi.spyOn(h.element, "selectionEnd", "get").mockReturnValue(null);
    h.moveToEnd.mockResolvedValueOnce(undefined);
    expect(await h.fill("3", false)).toMatchObject({
      code: "cdp_failed",
      data: { reason: "fill_value_mismatch" },
    });
    expect(h.element.value).toBe("312");
    expect(h.insert).toHaveBeenCalledOnce();
  });

  it("rejects invalid number text before clearing", async () => {
    const h = await setup('<input type="number" value="12">');
    expect(await h.fill("abc")).toMatchObject({
      code: "invalid_params",
      data: { reason: "fill_value_invalid" },
    });
    expect(h.element.value).toBe("12");
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("reports page formatting as unconfirmed without retrying the write", async () => {
    const h = await setup();
    h.element.addEventListener("change", () => {
      h.element.value = h.element.value.toUpperCase();
    });
    expect(await h.fill()).toMatchObject({
      code: "cdp_failed",
      data: { reason: "fill_value_mismatch" },
    });
    expect(h.element.value).toBe("HELLO");
    expect(h.insert).toHaveBeenCalledOnce();
  });

  it.each([
    ["focus", false],
    ["focus", true],
    ["value", false],
    ["value", true],
    ["cancel", false],
    ["cancel", true],
    ["throw", false],
    ["throw", true],
  ] as const)("stops when positioning triggers %s (clear=%s) and releases the key", async (action, clearBefore) => {
    const h = await setup();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const controller = new AbortController();
    const other = document.createElement("input");
    document.body.append(other);
    const send = h.send.getMockImplementation()!;
    h.send.mockImplementation(async (tabId, method, params) => {
      const reply = await send(tabId, method, params);
      if (
        method === "Input.dispatchKeyEvent" &&
        (params as { type: string }).type === "rawKeyDown"
      ) {
        if (action === "focus") other.focus();
        if (action === "value") h.element.value = "changed";
        if (action === "cancel") controller.abort();
        if (action === "throw") throw new Error("dispatch failed");
      }
      return reply;
    });
    const result = await h.fill("!", clearBefore, controller.signal);
    expect(result).toMatchObject({ code: action === "cancel" ? "cancelled" : "cdp_failed" });
    expect(h.insert).not.toHaveBeenCalled();
    expect(other.value).toBe("");
    expect(h.send).toHaveBeenCalledWith(
      4,
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyUp" }),
    );
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each([true, false])("verifies an empty request with clear_before=%s", async (clearBefore) => {
    const h = await setup();
    expect(await h.fill("", clearBefore)).toMatchObject({ value_length: clearBefore ? 0 : 3 });
    expect(h.element.value).toBe(clearBefore ? "" : "old");
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("cancels after insertion without sending change events", async () => {
    const h = await setup();
    const controller = new AbortController();
    h.insert.mockImplementation(async () => controller.abort());
    expect(await h.fill("hello", true, controller.signal)).toMatchObject({ code: "cancelled" });
    expect(h.script).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("cancels after resolving the remote object without clearing the field", async () => {
    const h = await setup();
    const controller = new AbortController();
    const send = h.send.getMockImplementation()!;
    h.send.mockImplementation(async (tabId, method, params) => {
      const result = await send(tabId, method, params);
      if (method === "DOM.resolveNode") controller.abort();
      return result;
    });
    expect(await h.fill("hello", true, controller.signal)).toMatchObject({ code: "cancelled" });
    expect(h.element.value).toBe("old");
    expect(h.script).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("honors cancellation during verification", async () => {
    const h = await setup();
    const controller = new AbortController();
    h.element.addEventListener("change", () => controller.abort());
    expect(await h.fill("hello", true, controller.signal)).toMatchObject({ code: "cancelled" });
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("keeps the verified outcome when releasing the remote object fails", async () => {
    const h = await setup();
    h.release.mockRejectedValueOnce(new Error("target closed"));
    expect(await h.fill()).toMatchObject({ value_length: 5 });
  });
});
