import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECORD_START, RECORD_STOP, type RecordStepPayload } from "@/lib/record-bridge";
import { handleRecordContentMessage, startRecordCapture } from "../record-capture";

vi.stubGlobal("chrome", {
  runtime: {
    sendMessage: vi.fn(() => Promise.resolve()),
  },
});

function mockRect(
  el: Element,
  rect: { left: number; top: number; width: number; height: number },
): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x: rect.left,
    y: rect.top,
    top: rect.top,
    left: rect.left,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({}),
  });
}

function mockHoverStyle(pointerElements: Element[], positionedElements: Element[] = []): void {
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
    const style = {
      cursor: pointerElements.includes(el) ? "pointer" : "",
      display: "block",
      pointerEvents: "auto",
      position: positionedElements.includes(el) ? "absolute" : "static",
      visibility: "visible",
    } as CSSStyleDeclaration;
    return style;
  });
}

function mouseOver(el: Element): void {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
}

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

  it("keeps a failed STOP retryable and redelivers its recorded step", async () => {
    document.body.innerHTML = `<label for="retry">Draft</label><input id="retry" />`;
    const sendMessage = vi.mocked(chrome.runtime.sendMessage);
    sendMessage.mockReset();
    sendMessage.mockRejectedValueOnce(new Error("service worker unavailable"));
    sendMessage.mockResolvedValueOnce(undefined);

    let activeRequestId: string | null = null;
    let capture: ReturnType<typeof startRecordCapture> | null = null;
    const onStop = vi.fn();
    const dispatch = (
      message:
        | { type: typeof RECORD_START; requestId: string; startedAtMs?: number }
        | { type: typeof RECORD_STOP; requestId: string },
      sendResponse?: (response: unknown) => void,
    ) =>
      handleRecordContentMessage(
        message,
        {
          activeRequestId,
          capture,
          setActiveRequestId: (id) => {
            activeRequestId = id;
          },
          setCapture: (next) => {
            capture = next;
          },
          onStart: vi.fn(),
          onStop,
        },
        sendResponse,
      );

    dispatch({ type: RECORD_START, requestId: "rec-retry" });
    const input = document.querySelector("input")!;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.value = "dirty final value";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const firstResponse = vi.fn();
    expect(dispatch({ type: RECORD_STOP, requestId: "rec-retry" }, firstResponse)).toBe(true);
    await vi.waitFor(() =>
      expect(firstResponse).toHaveBeenCalledWith({
        ok: false,
        error: "failed to deliver one or more recorded steps",
      }),
    );
    expect(activeRequestId).toBe("rec-retry");
    expect(onStop).not.toHaveBeenCalled();

    const retryResponse = vi.fn();
    expect(dispatch({ type: RECORD_STOP, requestId: "rec-retry" }, retryResponse)).toBe(true);
    await vi.waitFor(() => expect(retryResponse).toHaveBeenCalledWith({ ok: true }));

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(activeRequestId).toBeNull();
    expect(onStop).toHaveBeenCalledTimes(1);
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

  it("records a hover trigger before clicking its revealed menu item", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <ul class="user-menu dropdown-menu">
        <li><a href="/u/me">My profile</a></li>
      </ul>
    `;
    const capture = startRecordCapture("rec-hover-menu", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".user-menu")!;
    const item = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    mockRect(menu, { left: 820, top: 48, width: 160, height: 80 });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "Open user navigation menu" },
      geometry: { tag: "button", rect: { x: 900, y: 8, w: 32, h: 32 } },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { role: "link", name: "My profile" },
    });
  });

  it("records hover for compact topbar image buttons before menu item clicks", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="image" style="position: absolute; top: 8px; left: 900px; width: 32px; height: 32px;">
        <img alt="image" />
      </button>
      <ul class="user-menu dropdown-menu">
        <li><a href="/u/me">My profile</a></li>
      </ul>
    `;
    const capture = startRecordCapture("rec-hover-topbar", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".user-menu")!;
    const item = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    mockRect(menu, { left: 820, top: 48, width: 160, height: 80 });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "image" },
    });
  });

  it("records hover when the revealed menu item is inside the hover root", () => {
    document.body.innerHTML = `
      <div class="user dropdown" role="button" aria-label="image">
        <img alt="image" />
        <ul>
          <li><a href="/u/me">My profile</a></li>
        </ul>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-contained-menu", (step) => steps.push(step));
    const trigger = document.querySelector('[role="button"]')!;
    const menu = document.querySelector("ul")!;
    const item = document.querySelector("a")!;
    mockRect(trigger, { left: 900, top: 8, width: 32, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 160, height: 80 });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "image" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { role: "link", name: "My profile" },
    });
  });

  it("does not let a revealed topbar menu link replace the pending hover trigger", () => {
    document.body.innerHTML = `
      <a href="/u/me" aria-label="image" style="position: absolute; top: 8px; left: 900px; width: 32px; height: 32px;">
        <img alt="image" />
      </a>
      <ul class="user-menu dropdown-menu">
        <li><a class="dropdown-item profile-link" href="/u/me">My profile</a></li>
      </ul>
    `;
    const capture = startRecordCapture("rec-hover-topbar-link", (step) => steps.push(step));
    const trigger = document.querySelector('a[aria-label="image"]')!;
    const menu = document.querySelector(".user-menu")!;
    const item = document.querySelector("ul a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue({
      x: 820,
      y: 72,
      top: 72,
      left: 820,
      right: 916,
      bottom: 104,
      width: 96,
      height: 32,
      toJSON: () => ({}),
    });
    mockRect(menu, { left: 820, top: 48, width: 160, height: 80 });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = {
        cursor: el === item ? "pointer" : "",
        pointerEvents: "auto",
      } as CSSStyleDeclaration;
      return style;
    });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "link", name: "image" },
    });
  });

  it("keeps the first hover trigger over a later lower-score accepted hover", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu" aria-haspopup="menu" aria-expanded="false">
        <img alt="image" />
      </button>
      <a class="account-menu" role="button" href="/u/me">My profile</a>
    `;
    const capture = startRecordCapture("rec-hover-latch", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const laterHover = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(laterHover, "getBoundingClientRect").mockReturnValue({
      x: 820,
      y: 72,
      top: 72,
      left: 820,
      right: 916,
      bottom: 104,
      width: 96,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = {
        cursor: el === laterHover ? "pointer" : "",
        pointerEvents: "auto",
      } as CSSStyleDeclaration;
      return style;
    });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    laterHover.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    laterHover.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "Open user navigation menu" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { role: "button", name: "My profile" },
    });
  });

  it("keeps the menu opener hover when moving over an accepted menu item", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
      <ul class="create-menu dropdown-menu">
        <li class="dropdown-item" tabindex="0">文档C+D</li>
      </ul>
    `;
    const capture = startRecordCapture("rec-hover-menu-opener", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const item = document.querySelector("li")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([item]);

    mouseOver(trigger);
    mouseOver(item);
    click(item);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { tag: "li", name: "文档C+D" },
    });
  });

  it("does not latch a plain div action item inside a hover surface", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
      <div class="create-menu dropdown-menu">
        <div class="tg-menu-item" tabindex="0">文档C+D</div>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-menu-div-action", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const item = document.querySelector(".tg-menu-item")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([item]);

    mouseOver(trigger);
    mouseOver(item);
    click(item);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { tag: "div", name: "文档C+D" },
    });
  });

  it("keeps the opener hover when a surface action is clicked after the short latch window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T03:43:36.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
        <div class="create-menu dropdown-menu">
          <div class="tg-menu-item" tabindex="0">文档C+D</div>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-menu-div-action-slow", (step) =>
        steps.push(step),
      );
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const item = document.querySelector(".tg-menu-item")!;
      mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
      mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
      mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
      mockHoverStyle([item]);

      mouseOver(trigger);
      vi.setSystemTime(new Date("2026-08-07T03:43:47.000Z"));
      mouseOver(item);
      click(item);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({
        op: "click",
        target: { tag: "div", name: "文档C+D" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("infers a non-policy opener hover from the later surface action", () => {
    document.body.innerHTML = `
      <button type="button">新建</button>
      <div class="create-menu dropdown-menu">
        <div class="tg-menu-item" tabindex="0">文档C+D</div>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-infer-opener", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const item = document.querySelector(".tg-menu-item")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([trigger, item]);

    mouseOver(trigger);
    mouseOver(item);
    click(item);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { tag: "div", name: "文档C+D" },
    });
  });

  it("does not record a strong-looking surface item when clicking that item itself", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
      <div class="create-menu dropdown-menu">
        <li tabindex="0" aria-expanded="false"><div>文档C+D</div></li>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-false-submenu", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const item = document.querySelector("li")!;
    const itemInner = document.querySelector("li div")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([item, itemInner]);

    mouseOver(trigger);
    mouseOver(item);
    click(itemInner);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { tag: "div", name: "文档C+D" },
    });
  });

  it("records cascaded hover triggers before clicking inside the final surface", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
      <ul class="create-menu dropdown-menu">
        <li class="dropdown-item" tabindex="0" aria-haspopup="menu">更多模板</li>
      </ul>
      <div role="menu" class="template-submenu">
        <button type="button">Blank doc</button>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-cascade", (step) => steps.push(step));
    const trigger = document.querySelector("button[aria-label]")!;
    const menu = document.querySelector(".create-menu")!;
    const submenu = document.querySelector(".template-submenu")!;
    const nestedTrigger = document.querySelector("li")!;
    const finalAction = document.querySelector(".template-submenu button")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(nestedTrigger, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([nestedTrigger, finalAction]);

    mouseOver(trigger);
    mockRect(submenu, { left: 984, top: 48, width: 160, height: 80 });
    mockRect(finalAction, { left: 984, top: 48, width: 136, height: 32 });
    mouseOver(nestedTrigger);
    click(finalAction);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "hover",
      target: { tag: "li", name: "更多模板" },
    });
    expect(steps[2]).toMatchObject({
      op: "click",
      target: { role: "button", name: "Blank doc" },
    });
  });

  it("infers the full hover opener chain for nested menu actions", () => {
    document.body.innerHTML = `
      <button type="button">新建</button>
      <div class="create-menu dropdown-menu">
        <li tabindex="0" aria-expanded="false">文档C+D</li>
      </div>
      <div role="menu" class="format-submenu">
        <span tabindex="0">Markdown</span>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-nested-infer", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const submenu = document.querySelector(".format-submenu")!;
    const nestedTrigger = document.querySelector("li")!;
    const finalAction = document.querySelector("span")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(nestedTrigger, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([trigger, nestedTrigger, finalAction]);

    mouseOver(trigger);
    mockRect(submenu, { left: 984, top: 48, width: 160, height: 80 });
    mockRect(finalAction, { left: 984, top: 48, width: 136, height: 32 });
    mouseOver(nestedTrigger);
    mouseOver(finalAction);
    click(finalAction);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "hover",
      target: { tag: "li", name: "文档C+D" },
    });
    expect(steps[2]).toMatchObject({
      op: "click",
      target: { tag: "span", name: "Markdown" },
    });
  });

  it("uses the nested hover trigger label without descendant submenu text", () => {
    document.body.innerHTML = `
      <button type="button">新建</button>
      <div class="create-menu dropdown-menu">
        <li tabindex="0" aria-haspopup="menu">
          <span>多维表格</span>
          <div>
            <span tabindex="0">表格视图</span>
            <div tabindex="0">看板视图</div>
            <span>甘特视图</span>
            <span>日历视图</span>
            <span>相册视图</span>
            <span>架构视图</span>
            <span>神奇表单</span>
          </div>
        </li>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-nested-compact-label", (step) =>
      steps.push(step),
    );
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const nestedTrigger = document.querySelector("li")!;
    const submenu = document.querySelector("li > div")!;
    const finalAction = document.querySelector("li > div div")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(nestedTrigger, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([trigger, nestedTrigger, finalAction], [submenu]);

    mouseOver(trigger);
    mockRect(submenu, { left: 984, top: 48, width: 180, height: 220 });
    mockRect(finalAction, { left: 984, top: 48, width: 136, height: 32 });
    mouseOver(nestedTrigger);
    mouseOver(finalAction);
    click(finalAction);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "hover",
      target: { tag: "li", name: "多维表格" },
    });
    expect(JSON.stringify(steps[1]?.target)).not.toContain("看板视图");
    expect(steps[2]).toMatchObject({
      op: "click",
      target: { tag: "div", name: "看板视图" },
    });
  });

  it("does not let a stale pass-through shortcut hover claim a later submenu", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T06:39:40.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button">新建</button>
        <div class="create-menu dropdown-menu">
          <li class="create-menu-item-doc" tabindex="0">
            <span class="menu-item-label">文档</span>
            <span class="text-font-tips">C+D</span>
          </li>
          <li class="create-menu-item-vika" tabindex="0" aria-haspopup="menu">
            <div class="t-dropdown__item-content">
              <span class="menu-item-label">多维表格</span>
            </div>
            <div class="t-dropdown__submenu-wrapper">
              <span tabindex="0">看板视图</span>
            </div>
          </li>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-stale-shortcut", (step) => steps.push(step));
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const shortcut = document.querySelector(".text-font-tips")!;
      const nestedTrigger = document.querySelector(".create-menu-item-vika")!;
      const submenu = document.querySelector(".t-dropdown__submenu-wrapper")!;
      const finalAction = document.querySelector(".t-dropdown__submenu-wrapper span")!;
      mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
      mockRect(menu, { left: 820, top: 48, width: 180, height: 160 });
      mockRect(shortcut, { left: 950, top: 56, width: 29, height: 22 });
      mockRect(nestedTrigger, { left: 820, top: 92, width: 160, height: 32 });
      mockHoverStyle([trigger, shortcut, nestedTrigger, finalAction], [submenu]);

      mouseOver(trigger);
      mouseOver(shortcut);
      mockRect(submenu, { left: 984, top: 92, width: 160, height: 80 });
      mockRect(finalAction, { left: 984, top: 92, width: 136, height: 32 });
      mouseOver(nestedTrigger);
      vi.runOnlyPendingTimers();
      mouseOver(finalAction);
      click(finalAction);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({
        op: "hover",
        target: { tag: "li", name: "多维表格" },
      });
      expect(JSON.stringify(steps)).not.toContain("C+D");
      expect(steps[2]).toMatchObject({
        op: "click",
        target: { tag: "span", name: "看板视图" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an item inside a newly opened menu claim the parent surface", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T07:12:08.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button">新建</button>
        <div class="create-menu dropdown-menu">
          <li class="create-menu-item-doc" tabindex="0">文档C+D</li>
          <li class="create-menu-item-vika" tabindex="0" aria-haspopup="menu">
            <span>多维表格</span>
          </li>
        </div>
        <div class="t-dropdown__submenu-wrapper">
          <span tabindex="0">看板视图</span>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-parent-surface-owner", (step) =>
        steps.push(step),
      );
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const passThrough = document.querySelector(".create-menu-item-doc")!;
      const nestedTrigger = document.querySelector(".create-menu-item-vika")!;
      const submenu = document.querySelector(".t-dropdown__submenu-wrapper")!;
      const finalAction = document.querySelector(".t-dropdown__submenu-wrapper span")!;
      mockRect(trigger, { left: 42, top: 72, width: 60, height: 32 });
      mockRect(passThrough, { left: 17, top: 113, width: 184, height: 34 });
      mockRect(nestedTrigger, { left: 17, top: 228, width: 184, height: 34 });
      mockHoverStyle([trigger, passThrough, nestedTrigger, finalAction]);

      mouseOver(trigger);
      mockRect(menu, { left: 8, top: 104, width: 201, height: 439 });
      mouseOver(passThrough);
      vi.runOnlyPendingTimers();
      mockRect(submenu, { left: 201, top: 213, width: 114, height: 267 });
      mockRect(finalAction, { left: 209, top: 257, width: 97, height: 34 });
      mouseOver(nestedTrigger);
      vi.runOnlyPendingTimers();
      mouseOver(finalAction);
      click(finalAction);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({
        op: "hover",
        target: { tag: "li", name: "多维表格" },
      });
      expect(JSON.stringify(steps)).not.toContain("文档C+D");
    } finally {
      vi.useRealTimers();
    }
  });

  it("infers an unowned existing parent surface when a nested submenu is opened", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T07:28:10.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button">新建</button>
        <div class="create-menu dropdown-menu">
          <li class="create-menu-item-doc" tabindex="0">文档C+D</li>
          <li class="create-menu-item-vika" tabindex="0" aria-haspopup="menu">
            <div class="t-dropdown__item-content">
              <span class="menu-item-label">多维表格</span>
            </div>
          </li>
        </div>
        <div class="t-dropdown__submenu-wrapper">
          <span tabindex="0">看板视图</span>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-existing-parent-surface", (step) =>
        steps.push(step),
      );
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const passThrough = document.querySelector(".create-menu-item-doc")!;
      const nestedTrigger = document.querySelector(".create-menu-item-vika")!;
      const submenu = document.querySelector(".t-dropdown__submenu-wrapper")!;
      const finalAction = document.querySelector(".t-dropdown__submenu-wrapper span")!;
      mockRect(trigger, { left: 42, top: 72, width: 60, height: 32 });
      mockRect(menu, { left: 8, top: 104, width: 201, height: 439 });
      mockRect(passThrough, { left: 17, top: 113, width: 184, height: 34 });
      mockRect(nestedTrigger, { left: 17, top: 228, width: 184, height: 34 });
      mockHoverStyle([trigger, passThrough, nestedTrigger, finalAction]);

      mouseOver(passThrough);
      mouseOver(trigger);
      vi.runOnlyPendingTimers();
      mockRect(submenu, { left: 201, top: 213, width: 114, height: 267 });
      mockRect(finalAction, { left: 209, top: 257, width: 97, height: 34 });
      mouseOver(nestedTrigger);
      vi.runOnlyPendingTimers();
      mouseOver(finalAction);
      click(finalAction);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({
        op: "hover",
        target: { tag: "li", name: "多维表格" },
      });
      expect(JSON.stringify(steps)).not.toContain("文档C+D");
    } finally {
      vi.useRealTimers();
    }
  });

  it("assigns a side submenu to the vertically aligned hover trigger", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T06:55:38.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button">新建</button>
        <div class="create-menu dropdown-menu">
          <li class="create-menu-item-doc" tabindex="0">
            <span class="menu-item-label">文档</span>
            <span class="text-font-tips">C+D</span>
          </li>
          <li class="create-menu-item-vika" tabindex="0" aria-haspopup="menu">
            <div class="t-dropdown__item-content">
              <span class="menu-item-label">多维表格</span>
            </div>
          </li>
        </div>
        <div class="t-dropdown__submenu-wrapper">
          <li class="create-submenu-item-vika-kanban" tabindex="0">
            <span>看板视图</span>
          </li>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-side-submenu-alignment", (step) =>
        steps.push(step),
      );
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const passThrough = document.querySelector(".create-menu-item-doc")!;
      const nestedTrigger = document.querySelector(".create-menu-item-vika")!;
      const submenu = document.querySelector(".t-dropdown__submenu-wrapper")!;
      const finalAction = document.querySelector(".t-dropdown__submenu-wrapper span")!;
      mockRect(trigger, { left: 42, top: 72, width: 60, height: 32 });
      mockRect(menu, { left: 8, top: 104, width: 201, height: 439 });
      mockRect(passThrough, { left: 17, top: 113, width: 184, height: 34 });
      mockRect(nestedTrigger, { left: 17, top: 228, width: 184, height: 34 });
      mockHoverStyle([trigger, passThrough, nestedTrigger, finalAction]);

      mouseOver(trigger);
      mouseOver(passThrough);
      mockRect(submenu, { left: 201, top: 213, width: 114, height: 267 });
      mockRect(finalAction, { left: 209, top: 257, width: 97, height: 34 });
      mouseOver(nestedTrigger);
      mouseOver(finalAction);
      vi.runOnlyPendingTimers();
      click(finalAction);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({
        op: "hover",
        target: { tag: "li", name: "多维表格" },
      });
      expect(JSON.stringify(steps)).not.toContain("文档C+D");
      expect(steps[2]).toMatchObject({
        op: "click",
        target: { tag: "span", name: "看板视图" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("outputs only one parent path for noisy nested menu hover movement", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T07:02:36.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button">新建</button>
        <div class="create-menu dropdown-menu">
          <li class="create-menu-item-doc" tabindex="0">
            <span class="menu-item-label">文档</span>
            <span class="text-font-tips">C+D</span>
          </li>
          <li class="create-menu-item-vika" tabindex="0" aria-haspopup="menu">
            <div class="t-dropdown__item-content" tabindex="0">
              <span class="menu-item-label">多维表格</span>
            </div>
          </li>
        </div>
        <div class="t-dropdown__submenu-wrapper">
          <div class="create-submenu-item-vika-kanban" tabindex="0">
            <div class="create-submenu-item-label" tabindex="0">
              <span>表格视图</span>
            </div>
          </div>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-noisy-nested-path", (step) => steps.push(step));
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const passThrough = document.querySelector(".create-menu-item-doc")!;
      const nestedTrigger = document.querySelector(".create-menu-item-vika")!;
      const nestedInner = document.querySelector(".t-dropdown__item-content")!;
      const submenu = document.querySelector(".t-dropdown__submenu-wrapper")!;
      const finalItem = document.querySelector(".create-submenu-item-vika-kanban")!;
      const finalHoverItem = document.querySelector(".create-submenu-item-label")!;
      const finalAction = document.querySelector(".create-submenu-item-vika-kanban")!;
      mockRect(trigger, { left: 42, top: 72, width: 60, height: 32 });
      mockRect(menu, { left: 8, top: 104, width: 201, height: 439 });
      mockRect(passThrough, { left: 17, top: 113, width: 184, height: 34 });
      mockRect(nestedTrigger, { left: 17, top: 228, width: 184, height: 34 });
      mockRect(nestedInner, { left: 25, top: 234, width: 168, height: 22 });
      mockHoverStyle([
        trigger,
        passThrough,
        nestedTrigger,
        nestedInner,
        finalItem,
        finalHoverItem,
        finalAction,
      ]);

      mouseOver(trigger);
      mouseOver(nestedTrigger);
      mouseOver(nestedInner);
      mockRect(submenu, { left: 201, top: 213, width: 114, height: 267 });
      mockRect(finalItem, { left: 209, top: 257, width: 97, height: 34 });
      mockRect(finalHoverItem, { left: 209, top: 257, width: 97, height: 34 });
      mockRect(finalAction, { left: 209, top: 257, width: 97, height: 34 });
      mouseOver(passThrough);
      mouseOver(nestedInner);
      mouseOver(finalHoverItem);
      vi.runOnlyPendingTimers();
      click(finalAction);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({
        op: "hover",
        target: { name: "多维表格" },
      });
      expect(JSON.stringify(steps)).not.toContain("文档C+D");
      expect(JSON.stringify(steps)).not.toContain('"表格视图","tag":"div"');
      expect(steps.filter((step) => step.op === "hover")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not infer sibling items in the same surface as hover openers", () => {
    document.body.innerHTML = `
      <button type="button">新建</button>
      <div class="create-menu dropdown-menu">
        <li tabindex="0" aria-expanded="false">文档C+D</li>
        <span tabindex="0">Markdown</span>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-same-surface-action", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const category = document.querySelector("li")!;
    const finalAction = document.querySelector("span")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 320, height: 80 });
    mockRect(category, { left: 820, top: 48, width: 160, height: 32 });
    mockRect(finalAction, { left: 984, top: 48, width: 136, height: 32 });
    mockHoverStyle([trigger, category, finalAction]);

    mouseOver(trigger);
    mouseOver(category);
    mouseOver(finalAction);
    click(finalAction);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { tag: "span", name: "Markdown" },
    });
  });

  it("records avatar div hover with a semantic image target", () => {
    document.body.innerHTML = `
      <div class="tg-avatar tg-avatar--img tg-avatar--shape-hexagon">
        <img class="tg-avatar__image" />
      </div>
      <ul class="user-menu dropdown-menu">
        <li><a href="/u/me">My profile</a></li>
      </ul>
    `;
    const capture = startRecordCapture("rec-hover-avatar-div", (step) => steps.push(step));
    const trigger = document.querySelector(".tg-avatar")!;
    const image = document.querySelector("img")!;
    const menu = document.querySelector(".user-menu")!;
    const item = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    mockRect(menu, { left: 820, top: 48, width: 160, height: 80 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      cursor: "pointer",
      pointerEvents: "auto",
    } as CSSStyleDeclaration);

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    image.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { tag: "img", role: "img", name: "image" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { role: "link", name: "My profile" },
    });
  });

  it("does not let unrelated topbar hovers or menu pass-through items own an avatar menu", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T08:08:45.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button" aria-label="Star">Star</button>
        <div class="tg-avatar tg-avatar--img tg-avatar--shape-hexagon">
          <img class="tg-avatar__image" />
        </div>
        <ul class="user-menu dropdown-menu">
          <li><a href="/u/me">My profile</a></li>
          <li><a href="/dashboard/groups">My groups</a></li>
        </ul>
      `;
      const star = document.querySelector("button")!;
      const avatar = document.querySelector(".tg-avatar")!;
      const image = document.querySelector("img")!;
      const menu = document.querySelector(".user-menu")!;
      const profile = document.querySelector('a[href="/u/me"]')!;
      const groups = document.querySelector('a[href="/dashboard/groups"]')!;
      let menuRect = { left: 0, top: 0, width: 0, height: 0 };
      let profileRect = { left: 0, top: 0, width: 0, height: 0 };
      let groupsRect = { left: 0, top: 0, width: 0, height: 0 };
      mockRect(star, { left: 760, top: 8, width: 60, height: 32 });
      mockRect(avatar, { left: 900, top: 8, width: 32, height: 32 });
      mockRect(image, { left: 900, top: 8, width: 32, height: 32 });
      vi.spyOn(menu, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: menuRect.left,
            y: menuRect.top,
            top: menuRect.top,
            left: menuRect.left,
            right: menuRect.left + menuRect.width,
            bottom: menuRect.top + menuRect.height,
            width: menuRect.width,
            height: menuRect.height,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      vi.spyOn(profile, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: profileRect.left,
            y: profileRect.top,
            top: profileRect.top,
            left: profileRect.left,
            right: profileRect.left + profileRect.width,
            bottom: profileRect.top + profileRect.height,
            width: profileRect.width,
            height: profileRect.height,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      vi.spyOn(groups, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: groupsRect.left,
            y: groupsRect.top,
            top: groupsRect.top,
            left: groupsRect.left,
            right: groupsRect.left + groupsRect.width,
            bottom: groupsRect.top + groupsRect.height,
            width: groupsRect.width,
            height: groupsRect.height,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      mockHoverStyle([star, avatar, image, profile, groups]);
      const capture = startRecordCapture("rec-hover-avatar-menu-pass-through", (step) =>
        steps.push(step),
      );

      mouseOver(star);
      mouseOver(avatar);
      mouseOver(image);
      menuRect = { left: 820, top: 48, width: 160, height: 96 };
      profileRect = { left: 830, top: 56, width: 120, height: 28 };
      groupsRect = { left: 830, top: 88, width: 120, height: 28 };
      vi.runOnlyPendingTimers();
      mouseOver(profile);
      mouseOver(groups);
      click(groups);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { tag: "img", role: "img", name: "image" },
      });
      expect(steps[1]).toMatchObject({
        op: "click",
        target: { role: "link", name: "My groups" },
      });
      expect(JSON.stringify(steps)).not.toContain("Star");
      expect(JSON.stringify(steps)).not.toContain("My profile");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not record hover before an unrelated page click", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <main>
        <a href="/projects">Projects</a>
      </main>
    `;
    const capture = startRecordCapture("rec-hover-unrelated-click", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const link = document.querySelector("main a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["click"]);
    expect(steps[0]).toMatchObject({
      op: "click",
      target: { role: "link", name: "Projects" },
    });
  });

  it("records hover before filling a field inside the hover surface", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <div class="user-menu dropdown-menu">
        <label for="nickname">Nickname</label>
        <input id="nickname" />
      </div>
    `;
    const capture = startRecordCapture("rec-hover-fill-surface", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".user-menu")!;
    const input = document.querySelector("input")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 96 });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    input.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.value = "Ada";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "fill"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "Open user navigation menu" },
    });
    expect(steps[1]).toMatchObject({
      op: "fill",
      target: { tag: "input" },
      value: "Ada",
    });
  });

  it("records hover before selecting inside the hover surface", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <div class="user-menu dropdown-menu">
        <select aria-label="Status">
          <option value="online">Online</option>
          <option value="away">Away</option>
        </select>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-select-surface", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".user-menu")!;
    const select = document.querySelector("select")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 96 });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    select.value = "away";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "select"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "Open user navigation menu" },
    });
    expect(steps[1]).toMatchObject({
      op: "select",
      target: { role: "combobox", name: "Status" },
      values: ["away"],
      labels: ["Away"],
    });
  });

  it("records hover before clicking an unlabelled positioned floating surface", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <div style="position: absolute; top: 48px; left: 820px; width: 160px; height: 80px;">
        <a href="/u/me">My profile</a>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-plain-floating-surface", (step) =>
      steps.push(step),
    );
    const trigger = document.querySelector("button")!;
    const surface = document.querySelector("div")!;
    const link = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      x: 820,
      y: 48,
      top: 48,
      left: 820,
      right: 980,
      bottom: 128,
      width: 160,
      height: 80,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = {
        cursor: "",
        display: "block",
        pointerEvents: "auto",
        position: el === surface ? "absolute" : "static",
        visibility: "visible",
      } as CSSStyleDeclaration;
      return style;
    });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "Open user navigation menu" },
    });
  });

  it("does not treat ordinary document-flow divs as hover surfaces", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <div>
        <a href="/u/me">My profile</a>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-plain-flow-surface", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const link = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      cursor: "",
      display: "block",
      pointerEvents: "auto",
      position: "static",
      visibility: "visible",
    } as CSSStyleDeclaration);

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["click"]);
  });

  it("does not treat unlabelled sticky containers as hover surfaces", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <div style="position: sticky; top: 48px; left: 820px; width: 160px; height: 80px;">
        <a href="/u/me">My profile</a>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-sticky-surface", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const surface = document.querySelector("div")!;
    const link = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      x: 820,
      y: 48,
      top: 48,
      left: 820,
      right: 980,
      bottom: 128,
      width: 160,
      height: 80,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = {
        cursor: "",
        display: "block",
        pointerEvents: "auto",
        position: el === surface ? "sticky" : "static",
        visibility: "visible",
      } as CSSStyleDeclaration;
      return style;
    });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["click"]);
  });

  it("does not record hover before clicking the same trigger", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
    `;
    const capture = startRecordCapture("rec-hover-same-trigger", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["click"]);
  });

  it("does not record hover for ordinary controls without popup signals", () => {
    const capture = startRecordCapture("rec-hover-noise", (step) => steps.push(step));
    const button = document.querySelector("button")!;

    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["click"]);
  });
});
