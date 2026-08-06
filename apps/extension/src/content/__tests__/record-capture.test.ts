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

  it("records a hover trigger before clicking its revealed menu item", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <ul class="user-menu dropdown-menu">
        <li><a href="/u/me">My profile</a></li>
      </ul>
    `;
    const capture = startRecordCapture("rec-hover-menu", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
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

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "Open user navigation menu" },
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
