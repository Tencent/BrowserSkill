import { beforeEach, describe, expect, it } from "vitest";
import {
  describeEventTarget,
  describeTarget,
  isMeaningfulClickTarget,
  resolveClickableElement,
  resolveHoverElement,
} from "../describe-target";

describe("describeTarget", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("prefers aria-label and button role", () => {
    document.body.innerHTML = `<button aria-label="发布">go</button>`;
    const el = document.querySelector("button")!;
    expect(describeTarget(el)).toEqual({
      tag: "button",
      role: "button",
      name: "发布",
    });
  });

  it("uses label text and name_attr for inputs", () => {
    document.body.innerHTML = `
      <label for="svc">服务名称</label>
      <input id="svc" name="serviceName" />
    `;
    const el = document.querySelector("input")!;
    expect(describeTarget(el)).toEqual({
      tag: "input",
      role: "textbox",
      name: "服务名称",
      name_attr: "serviceName",
    });
  });

  it("never invents CSS selectors or @eN", () => {
    document.body.innerHTML = `<a href="/x">详情</a>`;
    const desc = describeTarget(document.querySelector("a")!);
    expect(JSON.stringify(desc)).not.toMatch(/@e\d+|nth-of-type|#/);
    expect(desc).toEqual({ tag: "a", role: "link", name: "详情" });
  });

  it("prefers heading text inside SERP-style links", () => {
    document.body.innerHTML = `
      <a href="https://www.tencent.com">
        <h3>Tencent 腾讯</h3>
        <cite>https://www.tencent.com</cite>
      </a>
    `;
    expect(describeTarget(document.querySelector("a")!).name).toBe("Tencent 腾讯");
  });
});

describe("LLM textbook click targets", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("rejects tag-only targets the LLM cannot find", () => {
    expect(isMeaningfulClickTarget({ tag: "div" })).toBe(false);
  });

  it("treats a short visible name as the teaching signal", () => {
    expect(isMeaningfulClickTarget({ tag: "div", name: "发布" })).toBe(true);
  });

  it("ignores anonymous layout chrome and lifts child clicks to the named button", () => {
    document.body.innerHTML = `
      <div id="noise">background</div>
      <button type="button"><span id="icon">发布</span></button>
    `;
    expect(describeEventTarget(document.querySelector("#noise"))).toBeNull();
    expect(describeEventTarget(document.querySelector("#icon"))).toEqual({
      tag: "button",
      role: "button",
      name: "发布",
    });
  });

  it("does not attach layout sibling text as nearby_label on buttons", () => {
    document.body.innerHTML = `
      <div>background</div>
      <button type="button" id="pub">发布</button>
    `;
    expect(describeTarget(document.querySelector("#pub")!)).toEqual({
      tag: "button",
      role: "button",
      name: "发布",
    });
  });

  it("keeps nearby_label for form fields from a preceding label-like sibling", () => {
    document.body.innerHTML = `
      <div>服务名称</div>
      <input id="svc" />
    `;
    expect(describeTarget(document.querySelector("#svc")!)).toEqual(
      expect.objectContaining({
        tag: "input",
        nearby_label: "服务名称",
      }),
    );
  });

  it("does not treat plain text blocks as clicks", () => {
    document.body.innerHTML = `<p id="copy">说明文字</p>`;
    expect(describeEventTarget(document.querySelector("#copy"))).toBeNull();
  });

  it("records custom button-like controls by their visible label", () => {
    document.body.innerHTML = `<div class="btn" id="pub" style="cursor: pointer">发布</div>`;
    expect(describeEventTarget(document.querySelector("#pub"))).toEqual(
      expect.objectContaining({ tag: "div", name: "发布" }),
    );
  });

  it.each([1, 2])("resolves a button through %i shadow roots", (depth: number) => {
    document.body.innerHTML = '<button aria-label="Save"><span></span></button>';
    const button = document.querySelector("button")!;
    let icon = button.firstElementChild!;
    for (let level = 0; level < depth; level++) {
      const root = icon.attachShadow({ mode: "open" });
      root.innerHTML = "<span>Icon</span>";
      icon = root.firstElementChild!;
    }

    expect(resolveClickableElement(icon)).toBe(button);
    expect(resolveHoverElement(icon)).toBe(button);
    expect(describeEventTarget(icon)).toEqual({ tag: "button", role: "button", name: "Save" });
  });

  it("prefers an interactive control inside the shadow root", () => {
    document.body.innerHTML = '<button aria-label="Outer"><span></span></button>';
    const root = document.querySelector("span")!.attachShadow({ mode: "open" });
    root.innerHTML = '<button aria-label="Inner"><span>Icon</span></button>';

    expect(resolveClickableElement(root.querySelector("span")!)).toBe(root.querySelector("button"));
    expect(describeEventTarget(root.querySelector("span"))).toEqual({
      tag: "button",
      role: "button",
      name: "Inner",
    });
  });

  it("resolves slotted icons to the shadow button that receives their events", () => {
    document.body.innerHTML = '<div id="host"><span>Icon</span></div>';
    const host = document.querySelector("#host")!;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<button aria-label="Save"><slot></slot></button>';
    const icon = host.firstElementChild!;
    // happy-dom does not expose assignedSlot; real slot assignment is checked in Chrome.
    Object.defineProperty(icon, "assignedSlot", { value: root.querySelector("slot") });

    expect(resolveClickableElement(icon)).toBe(root.querySelector("button"));
    expect(describeEventTarget(icon)).toEqual({ tag: "button", role: "button", name: "Save" });
  });

  it("resolves custom controls and unnamed hover triggers across a shadow root", () => {
    document.body.innerHTML = '<div class="btn" aria-label="Open"><span></span></div>';
    const control = document.body.firstElementChild!;
    const root = control.firstElementChild!.attachShadow({ mode: "open" });
    root.innerHTML = "<span>Icon</span>";
    const icon = root.firstElementChild!;

    expect(resolveClickableElement(icon)).toBe(control);
    control.removeAttribute("aria-label");
    expect(resolveClickableElement(icon)).toBeNull();
    expect(resolveHoverElement(icon)).toBe(control);
  });

  it("keeps anonymous shadow content out of recorded clicks", () => {
    const root = document.body
      .appendChild(document.createElement("div"))
      .attachShadow({ mode: "open" });
    root.innerHTML = "<span>Icon</span>";

    expect(resolveClickableElement(root.firstElementChild!)).toBeNull();
    expect(describeEventTarget(root.firstElementChild)).toBeNull();
  });
});
