import { afterEach, describe, expect, it, vi } from "vitest";
import { RECORD_PASSWORD_ATTRIBUTE } from "@/lib/sensitive-autocomplete";
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
      create: async () => ({ windowId: 100, initialTabIds: [] }),
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
  // Background tabs apply focus() but run focus listeners only when the next
  // Input command delivers renderer focus; `background()` models that by running
  // `onFlush` on each such command.
  let flushFocus: (() => void) | undefined;
  const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
    if (
      flushFocus &&
      ((method === "Input.dispatchMouseEvent" &&
        (params as { type?: string }).type === "mouseMoved") ||
        (method === "Input.dispatchKeyEvent" &&
          (params as { type?: string }).type === "rawKeyDown"))
    ) {
      flushFocus();
    }
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
      case "Input.dispatchMouseEvent":
        return {};
      case "Runtime.releaseObject":
        return release();
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  const sent = (method: string, type?: string) =>
    send.mock.calls.filter(
      ([, m, p]) => m === method && (type === undefined || (p as { type?: string }).type === type),
    ).length;
  return {
    element,
    hiddenCaret,
    moveToEnd,
    script,
    insert,
    release,
    send,
    sent,
    /**
     * Unfocused document. Each Input command delivers focus (unless `delivers`
     * names the only methods that do) and runs `onFlush`.
     */
    background: (onFlush: () => void = () => {}, delivers?: "key") => {
      let focused = false;
      vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
      flushFocus = () => {
        const last = send.mock.calls.at(-1)?.[1];
        if (!delivers || last === "Input.dispatchKeyEvent") focused = true;
        onFlush();
      };
    },
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

  it.each([
    ["date", "2026-10-14"],
    ["time", "14:30"],
    ["datetime-local", "2026-10-14T14:30"],
    ["month", "2026-10"],
    ["week", "2026-W42"],
  ] as const)("fills a %s input via the value setter", async (type, value) => {
    const h = await setup(`<input type="${type}" value="">`);
    expect(await h.fill(value)).toMatchObject({ value_length: value.length });
    expect(h.element.value).toBe(value);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each([
    "date",
    "time",
    "datetime-local",
    "month",
    "week",
  ])("rejects an invalid %s value before clearing", async (type) => {
    const h = await setup(`<input type="${type}" value="">`);
    expect(await h.fill("not-a-date")).toMatchObject({
      code: "invalid_params",
      data: { reason: "fill_value_invalid" },
    });
    expect(h.element.value).toBe("");
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("clears a date input without insertText", async () => {
    const h = await setup('<input type="date" value="2026-01-01">');
    expect(await h.fill("")).toMatchObject({ value_length: 0 });
    expect(h.element.value).toBe("");
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("does not repeat the empty input notification when clearing a date", async () => {
    const h = await setup('<input type="date" value="2026-01-01">');
    const inputs: string[] = [];
    h.element.addEventListener("input", () => inputs.push(h.element.value));
    expect(await h.fill("")).toMatchObject({ value_length: 0 });
    expect(inputs).toEqual([""]);
  });

  it.each([
    ["clear then type", '<input value="old">', "hello", true, ["", "hello"]],
    ["append without clearing", '<input value="old">', "hello", false, ["oldhello"]],
    ["clear to empty", '<input value="old">', "", true, [""]],
    ["append empty to empty", "<input>", "", false, [""]],
  ] as const)("dispatches one input per value change when it %s", async (_name, markup, value, clearBefore, expected) => {
    const h = await setup(markup);
    const inputs: string[] = [];
    let changes = 0;
    h.element.addEventListener("input", () => inputs.push(h.element.value));
    h.element.addEventListener("change", () => changes++);
    expect(await h.fill(value, clearBefore)).toMatchObject({
      value_length: expected.at(-1)!.length,
    });
    expect(inputs).toEqual(expected);
    expect(changes).toBe(1);
  });

  it("flushes deferred background focus before a date value write", async () => {
    const h = await setup('<input type="date" value="">');
    // Happy DOM fires focus synchronously on focus(); inject the deferred
    // background focus handler on the flush instead.
    h.background(() => {
      h.element.value = "2026-01-01";
    });
    expect(await h.fill("2026-10-14")).toMatchObject({ value_length: 10 });
    expect(h.element.value).toBe("2026-10-14");
    expect(h.insert).not.toHaveBeenCalled();
    // The flush moves the pointer off the page; the page sees no key event.
    expect(h.send).toHaveBeenCalledWith(4, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: -1,
      y: -1,
    });
    expect(h.sent("Input.dispatchKeyEvent")).toBe(0);
  });

  it("clears a background date after deferred focus restores a value", async () => {
    const h = await setup('<input type="date" value="2026-01-01">');
    const inputs: string[] = [];
    h.background(() => {
      h.element.value = "2026-01-01";
      inputs.push(`focus:${h.element.value}`);
    });
    h.element.addEventListener("input", () => inputs.push(h.element.value));

    expect(await h.fill("")).toMatchObject({ value_length: 0 });
    expect(h.element.value).toBe("");
    expect(inputs).toEqual(["focus:2026-01-01", ""]);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it.each([
    ["date", "2026-10-14", ""],
    ["time", "12:34", ":56"],
    ["week", "2026-W42", ""],
  ] as const)("rejects --no-clear on a %s input before focus", async (type, initial, value) => {
    const h = await setup(`<input type="${type}" value="${initial}">`);
    expect(await h.fill(value, false)).toMatchObject({
      code: "invalid_params",
      data: { reason: "fill_value_invalid" },
      message: expect.stringContaining("--no-clear"),
    });
    expect(h.element.value).toBe(initial);
    expect(h.send).not.toHaveBeenCalledWith(4, "DOM.focus", expect.anything());
    expect(h.insert).not.toHaveBeenCalled();
  });

  describe("date-like min/max", () => {
    // Happy DOM only implements range validity for number inputs. Model the
    // browser's check for these fixed-width values to cover the plumbing; the
    // Chrome suite covers the browser's own comparison.
    const outside = (input: HTMLInputElement, key: "min" | "max") => {
      const bound = input.getAttribute(key);
      if (!bound || input.value === "") return false;
      return key === "min" ? input.value < bound : input.value > bound;
    };

    it.each([
      ["date", 'min="2026-01-01" max="2026-12-31"', "2027-01-01", "max 2026-12-31"],
      ["date", 'min="2026-01-01" max="2026-12-31"', "2025-12-31", "min 2026-01-01"],
      ["month", 'min="2026-03"', "2026-02", "min 2026-03"],
      ["time", 'max="18:00"', "18:30", "max 18:00"],
    ] as const)("rejects an out-of-range %s value before focus", async (type, attrs, value, bound) => {
      const h = await setup(`<input type="${type}" ${attrs} value="">`);
      vi.spyOn(HTMLInputElement.prototype, "validity", "get").mockImplementation(function (
        this: HTMLInputElement,
      ) {
        return {
          rangeUnderflow: outside(this, "min"),
          rangeOverflow: outside(this, "max"),
        } as ValidityState;
      });
      expect(await h.fill(value)).toMatchObject({
        code: "invalid_params",
        data: { reason: "fill_value_invalid" },
        message: expect.stringContaining(bound),
      });
      expect(h.element.value).toBe("");
      expect(h.send).not.toHaveBeenCalledWith(4, "DOM.focus", expect.anything());
    });

    it("fills a value on the inclusive bounds", async () => {
      const h = await setup('<input type="date" min="2026-01-01" max="2026-12-31" value="">');
      expect(await h.fill("2026-12-31")).toMatchObject({ value_length: 10 });
      expect(h.element.value).toBe("2026-12-31");
    });
  });

  it("stops a background date fill when flush loses focus", async () => {
    const h = await setup('<input type="date" value="">');
    const other = document.createElement("input");
    document.body.append(other);
    h.background(() => {
      other.focus();
    });
    expect(await h.fill("2026-10-14")).toMatchObject({
      code: "cdp_failed",
      data: { reason: "fill_focus_lost" },
    });
    expect(h.element.value).toBe("");
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.sent("Input.dispatchKeyEvent")).toBe(0);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("notifies shadow hosts with a composed input event for date-like fills", async () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<input type="date" value="">';
    const element = shadow.querySelector("input") as HTMLInputElement;
    const manager = new SessionManager({
      agentWindow: {
        create: async () => ({ windowId: 100, initialTabIds: [] }),
        remove: async () => {},
        ensureActiveTab: async () => 4,
      },
    });
    const ctx = await manager.start("aa11");
    ctx.refStore.set("e1", 12, { tabId: 4 });
    const hostInputs: Event[] = [];
    const hostInputValues: string[] = [];
    host.addEventListener("input", (event) => {
      hostInputs.push(event);
      hostInputValues.push(element.value);
    });
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
          throw new Error("date-like fill must not insertText");
        case "Input.dispatchKeyEvent":
          return {};
        case "Runtime.releaseObject":
          return {};
        default:
          throw new Error(`unexpected ${method}`);
      }
    });
    const result = await handleFill(
      manager,
      { session_id: "aa11", ref: "e1", value: "2026-10-14", clear_before: true },
      {
        cdp: { send: send as CdpRunner["send"] },
        tabsApi: {
          get: async (id) => ({ id, windowId: 100, active: true }) as chrome.tabs.Tab,
          query: async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab],
        },
      },
    );
    expect(result).toMatchObject({ value_length: 10 });
    expect(element.value).toBe("2026-10-14");
    expect(hostInputValues).toEqual(["", "2026-10-14"]);
    expect(hostInputs.every((event) => event.composed && event.bubbles)).toBe(true);
  });

  it("accepts maxlength truncation optimistically and reports actual_value + formatted", async () => {
    const h = await setup('<input maxlength="3" value="old">');
    expect(await h.fill()).toMatchObject({
      value_length: 3,
      actual_value: "hel",
      formatted: true,
    });
    expect(h.element.value).toBe("hel");
    expect(h.insert).toHaveBeenCalledOnce();
  });

  it.each([
    true,
    false,
  ])("classifies a DOM.focus fallback rejection on a disabled=%s target", async (disabled) => {
    const h = await setup(`<input ${disabled ? "disabled" : ""} value="old">`);
    vi.spyOn(h.element, "focus").mockImplementation(() => {});
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

  it("fills a foreground document on the 4-call fast path without DOM.focus or dispatchKeyEvent", async () => {
    const h = await setup();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const result = await h.fill();
    expect(result).toMatchObject({ value_length: 5, actual_value: "hello" });
    expect(result).not.toHaveProperty("formatted");
    expect(h.element.value).toBe("hello");
    expect(h.send.mock.calls.map(([, method]) => method)).toEqual([
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
      "Input.insertText",
      "Runtime.callFunctionOn",
      "Runtime.releaseObject",
    ]);
  });

  it("flushes deferred focus on a background non-empty fill and clears focus-initialized defaults", async () => {
    const h = await setup('<input value="">');
    h.background(() => {
      h.element.value = "default";
    });
    const result = await h.fill("hello");
    expect(result).toMatchObject({ value_length: 5, actual_value: "hello" });
    expect(result).not.toHaveProperty("formatted");
    expect(h.element.value).toBe("hello");
    expect(h.sent("Input.dispatchMouseEvent", "mouseMoved")).toBe(1);
    expect(h.sent("Input.dispatchKeyEvent")).toBe(0);
  });

  it("absorbs a value set by a deferred focus listener into a --no-clear append", async () => {
    const h = await setup('<input value="old">');
    h.background(() => {
      h.element.value = "changed";
    });
    expect(await h.fill("!", false)).toMatchObject({ value_length: 8, actual_value: "changed!" });
    expect(h.element.value).toBe("changed!");
  });

  it.each([
    ["the pointer flush does not deliver focus", "undelivered"],
    ["the page is hovered", "hovered"],
    ["the page is hidden", "hidden"],
  ] as const)("falls back to a no-op key press when %s", async (_name, reason) => {
    const h = await setup('<input value="">');
    const hovered = reason !== "undelivered";
    if (reason === "hidden") vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    if (reason === "hovered") {
      const query = document.querySelector.bind(document);
      vi.spyOn(document, "querySelector").mockImplementation((selector: string) =>
        selector === ":hover" ? document.body : query(selector),
      );
    }
    h.background(
      () => {
        h.element.value = "default";
      },
      hovered ? undefined : "key",
    );
    expect(await h.fill("hello")).toMatchObject({ value_length: 5, actual_value: "hello" });
    expect(h.element.value).toBe("hello");
    expect(h.sent("Input.dispatchMouseEvent")).toBe(hovered ? 0 : 1);
    expect(h.send).toHaveBeenCalledWith(4, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      commands: [],
    });
    expect(h.send).toHaveBeenCalledWith(4, "Input.dispatchKeyEvent", { type: "keyUp" });
  });

  it("stops a background non-empty fill when deferred focus redirects without touching other fields", async () => {
    const h = await setup('<input type="password" value="old-secret">');
    const other = document.createElement("input");
    other.value = "keep-existing";
    document.body.append(other);
    h.background(() => {
      other.focus();
      other.select();
    });
    const result = await h.fill("new-super-secret");
    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { reason: "fill_focus_lost" },
    });
    expect(h.element.value).toBe("old-secret");
    expect(other.value).toBe("keep-existing");
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("restores focus once after clearing without typing into another field", async () => {
    const h = await setup();
    const other = document.createElement("input");
    document.body.append(other);
    h.element.addEventListener("input", () => other.focus());
    expect(await h.fill()).toMatchObject({ value_length: 5, actual_value: "hello" });
    expect(h.element.value).toBe("hello");
    expect(other.value).toBe("");
    expect(h.send.mock.calls.filter(([, method]) => method === "DOM.focus")).toHaveLength(1);
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
    expect(h.send.mock.calls.filter(([, method]) => method === "DOM.focus")).toHaveLength(1);
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

  it("succeeds optimistically and returns actual_value + formatted when page formats phone numbers", async () => {
    const h = await setup('<input type="tel" value="">');
    h.element.addEventListener("input", () => {
      const digits = h.element.value.replace(/\D/g, "");
      if (digits.length === 11) {
        h.element.value = `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`;
      }
    });
    const result = await h.fill("13800138000");
    expect(result).toMatchObject({
      value_length: 13,
      actual_value: "138 0013 8000",
      formatted: true,
    });
    expect(h.element.value).toBe("138 0013 8000");
    expect(h.insert).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("reports dynamic maxlength truncation optimistically with actual_value + formatted", async () => {
    const h = await setup();
    h.element.addEventListener(
      "input",
      () => {
        h.element.maxLength = 3;
      },
      { once: true },
    );
    expect(await h.fill()).toMatchObject({
      value_length: 3,
      actual_value: "hel",
      formatted: true,
    });
    expect(h.element.value).toBe("hel");
  });

  it.each([
    "input",
    "change",
    "microtask-change",
  ])("returns post-handler actual_value when %s handler rewrites the field", async (event) => {
    const h = await setup('<input value="">');
    h.element.addEventListener(event === "microtask-change" ? "change" : event, () => {
      if (event === "microtask-change")
        queueMicrotask(() => {
          h.element.value = "100.00";
        });
      else if (h.element.value) h.element.value = "100.00";
    });
    expect(await h.fill("100")).toMatchObject({
      value_length: 6,
      actual_value: "100.00",
      formatted: true,
    });
  });

  it.each([
    '<input type="password">',
    '<input type="text" autocomplete="one-time-code">',
    '<input type="text" autocomplete="billing cc-number">',
    `<input type="text" ${RECORD_PASSWORD_ATTRIBUTE}="">`,
    // A "show password" toggle switches the type to text.
    '<input type="text" name="password">',
    '<input type="text" id="user-pwd" autocomplete="off">',
    '<input type="text" name="Passwd">',
  ])("flags formatted: true while redacting actual_value when sensitive control %s alters the value", async (markup) => {
    const h = await setup(markup);
    h.element.addEventListener("change", () => {
      h.element.value = "other-secret";
    });
    const result = await h.fill("given-secret");
    expect(result).toMatchObject({
      value_length: "other-secret".length,
      formatted: true,
    });
    expect(result).not.toHaveProperty("actual_value");
    expect(JSON.stringify(result)).not.toMatch(/given-secret|other-secret/);
  });

  it.each([
    '<input type="text" name="passport">',
    '<input type="text" name="username" autocomplete="username">',
  ])("still reports actual_value for the non-secret control %s", async (markup) => {
    const h = await setup(markup);
    h.element.addEventListener("change", () => {
      h.element.value = "FORMATTED";
    });
    expect(await h.fill("formatted")).toMatchObject({
      actual_value: "FORMATTED",
      formatted: true,
    });
  });

  it("flags password maxlength truncation with formatted: true without leaking actual_value", async () => {
    const h = await setup('<input type="password" maxlength="6">');
    const truncated = await h.fill("supersecret");
    expect(truncated).toMatchObject({
      value_length: 6,
      formatted: true,
    });
    expect(truncated).not.toHaveProperty("actual_value");
    expect(JSON.stringify(truncated)).not.toMatch(/supers|supersecret/);

    const exact = await h.fill("secret");
    expect(exact).toMatchObject({ value_length: 6 });
    expect(exact).not.toHaveProperty("formatted");
    expect(exact).not.toHaveProperty("actual_value");
    expect(JSON.stringify(exact)).not.toContain("secret");
  });

  it("truncates actual_value to 200 characters while keeping full value_length", async () => {
    const h = await setup("<textarea></textarea>");
    const longText = "x".repeat(260);
    const result = await h.fill(longText);
    expect(result).toMatchObject({
      value_length: 260,
      actual_value: "x".repeat(200),
    });
    expect(result).not.toHaveProperty("formatted");
  });

  it("does not report success for a target replaced by a change handler", async () => {
    const h = await setup();
    h.element.addEventListener("change", () => h.element.replaceWith(h.element.cloneNode()));
    expect(await h.fill()).toMatchObject({
      code: "cdp_failed",
      data: { reason: "fill_target_changed" },
    });
  });

  // Background phases: Step 1, the focus-delivery probe (whose failure only
  // falls back to the key flush), the fallback preparation, and verification.
  it.each([
    1, 3,
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
    if (phase === 1) expect(h.insert).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each([1, 3])("rejects missing results at phase %s", async (phase) => {
    const h = await setup();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const run = h.script.getMockImplementation()!;
    let count = 0;
    h.script.mockImplementation(async (params) =>
      ++count === phase ? { result: { type: "undefined" } } : run(params),
    );
    expect(await h.fill()).toMatchObject({ code: "cdp_failed" });
    if (phase === 1) expect(h.insert).not.toHaveBeenCalled();
  });

  it("stops before typing when nested microtasks from clearing mutate the field", async () => {
    const h = await setup();
    h.element.addEventListener("input", () => {
      queueMicrotask(() =>
        queueMicrotask(() => {
          h.element.value = "reverted";
        }),
      );
    });
    expect(await h.fill()).toMatchObject({
      code: "cdp_failed",
      data: { reason: "fill_target_changed" },
    });
    expect(h.insert).not.toHaveBeenCalled();
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
    expect(h.insert).toHaveBeenCalledWith(requested.replace(/\r\n?/g, "\n"));
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
  ])("surfaces actual_value + formatted when %s append caret command is ignored", async (type) => {
    const h = await setup(`<input type="${type}" value="12">`);
    vi.spyOn(h.element, "selectionStart", "get").mockReturnValue(null);
    vi.spyOn(h.element, "selectionEnd", "get").mockReturnValue(null);
    h.moveToEnd.mockResolvedValueOnce(undefined);
    expect(await h.fill("3", false)).toMatchObject({
      value_length: 3,
      actual_value: "312",
      formatted: true,
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

  it("returns formatted uppercase value without failing or retrying the write", async () => {
    const h = await setup();
    h.element.addEventListener("change", () => {
      h.element.value = h.element.value.toUpperCase();
    });
    expect(await h.fill()).toMatchObject({
      value_length: 5,
      actual_value: "HELLO",
      formatted: true,
    });
    expect(h.element.value).toBe("HELLO");
    expect(h.insert).toHaveBeenCalledOnce();
  });

  it.each([
    ["focus", false],
    ["focus", true],
    ["cancel", false],
    ["cancel", true],
    ["throw", false],
    ["throw", true],
  ] as const)("stops when background focus flush triggers %s (clear=%s) without a key press", async (action, clearBefore) => {
    const h = await setup('<div contenteditable="true" tabindex="0">old</div>');
    Object.defineProperty(h.element, "isContentEditable", { get: () => true });
    Object.defineProperty(h.element, "innerText", { get: () => h.element.textContent ?? "" });
    const controller = new AbortController();
    const other = document.createElement("input");
    document.body.append(other);
    h.background(() => {
      if (action === "focus") other.focus();
      if (action === "cancel") controller.abort();
      if (action === "throw") throw new Error("dispatch failed");
    });
    const result = await h.fill("!", clearBefore, controller.signal);
    expect(result).toMatchObject({ code: action === "cancel" ? "cancelled" : "cdp_failed" });
    expect(h.insert).not.toHaveBeenCalled();
    expect(other.value).toBe("");
    // A refused pointer move falls back to the key press, which is released.
    expect(h.sent("Input.dispatchKeyEvent", "rawKeyDown")).toBe(action === "throw" ? 1 : 0);
    expect(h.sent("Input.dispatchKeyEvent", "keyUp")).toBe(action === "throw" ? 1 : 0);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each([
    "focus",
    "value",
    "cancel",
    "throw",
  ] as const)("stops when caret positioning triggers %s and releases the key", async (action) => {
    const h = await setup('<input type="number" value="12">');
    vi.spyOn(h.element, "selectionStart", "get").mockReturnValue(null);
    vi.spyOn(h.element, "selectionEnd", "get").mockReturnValue(null);
    const controller = new AbortController();
    const other = document.createElement("input");
    document.body.append(other);
    const send = h.send.getMockImplementation()!;
    h.send.mockImplementation(async (tabId, method, params) => {
      const reply = await send(tabId, method, params);
      if (
        method === "Input.dispatchKeyEvent" &&
        (params as { type: string; commands?: string[] }).type === "rawKeyDown" &&
        (params as { commands?: string[] }).commands?.includes("moveToEndOfDocument")
      ) {
        if (action === "focus") other.focus();
        if (action === "value") h.element.value = "99";
        if (action === "cancel") controller.abort();
        if (action === "throw") throw new Error("dispatch failed");
      }
      return reply;
    });
    const result = await h.fill("3", false, controller.signal);
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

  it.each([
    true,
    false,
  ])("flushes background focus before an empty text request (clear_before=%s)", async (clearBefore) => {
    const h = await setup();
    h.background(() => {
      h.element.value = "default";
    });
    expect(await h.fill("", clearBefore)).toMatchObject({ value_length: clearBefore ? 0 : 7 });
    expect(h.element.value).toBe(clearBefore ? "" : "default");
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("does not clear a background text target if deferred focus moves elsewhere", async () => {
    const h = await setup();
    const other = document.createElement("input");
    document.body.append(other);
    h.background(() => {
      other.focus();
    });
    expect(await h.fill("")).toMatchObject({
      code: "cdp_failed",
      data: { reason: "fill_focus_lost" },
    });
    expect(h.element.value).toBe("old");
    expect(h.sent("Input.dispatchKeyEvent")).toBe(0);
  });

  it("cancels after insertion without sending change events", async () => {
    const h = await setup();
    const controller = new AbortController();
    h.insert.mockImplementation(async () => controller.abort());
    expect(await h.fill("hello", true, controller.signal)).toMatchObject({ code: "cancelled" });
    expect(h.script).toHaveBeenCalledTimes(1);
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
