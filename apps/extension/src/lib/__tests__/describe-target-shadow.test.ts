import { beforeEach, describe, expect, it } from "vitest";
import { startRecordCapture } from "@/content/record-capture";
import type { RecordStepPayload } from "@/lib/record-bridge";
import { appendRecordedPayload, type RecordingStepBuffer } from "@/lib/recording/step-buffer";
import { reduceTraceStepsV3 } from "@/lib/recording/trace-reducer-v3";
import { describeEventTarget, describeTarget } from "../describe-target";

describe("describeTarget shadow root aria-labelledby scoping", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves aria-labelledby within the target element's ShadowRoot when outer document has no matching ID", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <span id="name">Save</span>
      <button id="action" type="button" aria-labelledby="name"></button>
    `;
    const button = shadow.querySelector("#action")!;
    expect(describeTarget(button)).toEqual({
      tag: "button",
      role: "button",
      name: "Save",
    });
    expect(describeEventTarget(button)).toEqual({
      tag: "button",
      role: "button",
      name: "Save",
    });
  });

  it("prefers same-ShadowRoot IDs over conflicting light-DOM IDs", () => {
    document.body.innerHTML = `<span id="name">Delete account</span><div id="host"></div>`;
    const host = document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <span id="name">Save</span>
      <button id="action" type="button" aria-labelledby="name"></button>
    `;
    const button = shadow.querySelector("#action")!;
    expect(describeTarget(button).name).toBe("Save");
    expect(describeEventTarget(button)?.name).toBe("Save");
  });

  it("joins multiple IDREFs in the same ShadowRoot and skips missing IDs", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <span id="verb">Save</span>
      <span id="noun">changes</span>
      <button id="action" type="button" aria-labelledby="  verb missing noun  "></button>
    `;
    const button = shadow.querySelector("#action")!;
    expect(describeTarget(button)).toEqual({
      tag: "button",
      role: "button",
      name: "Save changes",
    });
  });

  it("does not cross shadow boundaries in either direction or leak onto detached elements", () => {
    document.body.innerHTML = `
      <span id="outer-only">Outer label</span>
      <button id="light-btn" type="button" value="" aria-labelledby="shadow-only"></button>
      <div id="host"></div>
    `;
    const outerHost = document.getElementById("host")!;
    const outerShadow = outerHost.attachShadow({ mode: "open" });
    outerShadow.innerHTML = `
      <span id="shadow-only">Outer shadow label</span>
      <button id="shadow-btn" type="button" value="" aria-labelledby="outer-only"></button>
      <div id="inner-host"></div>
    `;
    const innerHost = outerShadow.getElementById("inner-host")!;
    const innerShadow = innerHost.attachShadow({ mode: "open" });
    innerShadow.innerHTML = `
      <button id="inner-btn" type="button" value="" aria-labelledby="shadow-only outer-only"></button>
    `;

    expect(describeTarget(document.getElementById("light-btn")!).name).toBeUndefined();
    expect(describeTarget(outerShadow.getElementById("shadow-btn")!).name).toBeUndefined();
    expect(describeTarget(innerShadow.getElementById("inner-btn")!).name).toBeUndefined();

    const detachedWrapper = document.createElement("div");
    detachedWrapper.innerHTML = `<span id="outer-only">Detached</span><button type="button" value="" aria-labelledby="outer-only"></button>`;
    expect(describeTarget(detachedWrapper.querySelector("button")!).name).toBeUndefined();
  });

  it("keeps aria-label ahead of aria-labelledby inside a ShadowRoot", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <span id="name">Secondary</span>
      <button id="action" type="button" aria-label="Primary" aria-labelledby="name"></button>
    `;
    expect(describeTarget(shadow.getElementById("action")!).name).toBe("Primary");
  });

  it("records clicks on ShadowRoot aria-labelledby buttons with and without conflicting outer IDs", () => {
    for (const hasOuterDuplicate of [false, true]) {
      document.body.innerHTML = `${
        hasOuterDuplicate ? '<span id="name">Delete account</span>' : ""
      }<div id="host"></div>`;
      const host = document.getElementById("host")!;
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <span id="name">Save</span>
        <button id="action" type="button" aria-labelledby="name"></button>
      `;

      const payloads: RecordStepPayload[] = [];
      const capture = startRecordCapture("rec-shadow", (step) => payloads.push(step), {
        captureNavigation: false,
      });
      try {
        const button = shadow.getElementById("action") as HTMLButtonElement;
        button.click();
      } finally {
        capture.dispose();
      }

      const buffer: RecordingStepBuffer = {
        steps: [],
        navigation: { pendingNavigation: false },
      };
      for (const payload of payloads) {
        appendRecordedPayload(buffer, payload);
      }
      for (const step of buffer.steps) {
        step.preStateId = "s1";
        step.postStateId = "s2";
      }
      const reduced = reduceTraceStepsV3(buffer.steps);
      expect(reduced.steps).toHaveLength(1);
      expect(reduced.steps[0]).toMatchObject({
        op: "click",
        target: {
          role: "button",
          name: "Save",
        },
      });
    }
  });
});
