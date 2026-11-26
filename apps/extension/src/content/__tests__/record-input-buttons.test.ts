import { describe, expect, it } from "vitest";
import type { RecordStepPayload } from "@/lib/record-bridge";
import { startRecordCapture } from "../record-capture";

const buttons = [
  '<input id="action" type="submit" value="Submit">',
  '<input id="action" type="reset" value="Reset">',
  '<input id="action" type="image" alt="Submit image">',
  '<input id="action" type="button" value="Action">',
  '<button id="action" type="submit"><span>Submit</span></button>',
];

describe("record form button clicks", () => {
  it.each(buttons)("records %s after filling a search field", (markup) => {
    document.body.innerHTML = `<form><input id="q" name="q" aria-label="Query">${markup}</form>`;
    const steps: RecordStepPayload[] = [];
    const capture = startRecordCapture("buttons", (step) => steps.push(step));
    try {
      const input = document.querySelector<HTMLInputElement>("#q")!;
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      input.value = "query";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const action = document.querySelector("#action span") ?? document.querySelector("#action")!;
      action.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
      expect(steps.map((step) => step.op)).toEqual(["fill", "click"]);
      expect(steps[0]).toMatchObject({ value: "query", target: { name: "Query" } });
      expect(steps[1]).toMatchObject({ target: { role: "button" } });
      expect(steps[1].target?.name).toBeTruthy();
    } finally {
      capture.dispose();
    }
  });

  it.each([
    ["text", '<button id="save" type="button">Save</button>', "Save"],
    [
      "image alt",
      '<button id="save" type="button"><img alt="Save" width="40" height="20" src="icon.svg"></button>',
      "Save",
    ],
    [
      "aria-label",
      '<button id="save" type="button" aria-label="Save"><img alt="Save" width="40" height="20" src="icon.svg"></button>',
      "Save",
    ],
  ])("records a %s button click", (_variant, markup, name) => {
    document.body.innerHTML = `${markup}<output id="status">Unsaved</output>`;
    const steps: RecordStepPayload[] = [];
    const capture = startRecordCapture("image-button", (step) => steps.push(step));
    try {
      const button = document.querySelector("#save")!;
      const hit = button.querySelector("img") ?? button;
      hit.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
      expect(steps.filter((step) => step.op === "click")).toEqual([
        expect.objectContaining({
          op: "click",
          target: { tag: "button", role: "button", name },
        }),
      ]);
    } finally {
      capture.dispose();
    }
  });

  it("does not record a button whose only image alt is empty", () => {
    document.body.innerHTML =
      '<button id="save" type="button"><img alt="" src="icon.svg"></button>';
    const steps: RecordStepPayload[] = [];
    const capture = startRecordCapture("decorative-button", (step) => steps.push(step));
    try {
      document
        .querySelector("#save img")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
      expect(steps).toEqual([]);
    } finally {
      capture.dispose();
    }
  });

  it("still ignores search decoration that only focuses the field", () => {
    document.body.innerHTML = '<form><span id="icon">Search</span><input name="q"></form>';
    const steps: RecordStepPayload[] = [];
    const capture = startRecordCapture("decoration", (step) => steps.push(step));
    try {
      document
        .querySelector("#icon")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
      expect(steps).toEqual([]);
    } finally {
      capture.dispose();
    }
  });
});
