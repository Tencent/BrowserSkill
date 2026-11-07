import { describe, expect, it } from "vitest";
import type { RecordStepPayload } from "@/lib/record-bridge";
import { startRecordCapture } from "../record-capture";

describe("record editable values", () => {
  it.each([
    ["Alpha<div style='display:block'>Beta</div>", "Alpha\nBeta"],
    ["Alpha<br>Beta", "Alpha\nBeta"],
    ["Alpha<div style='display:block'><br></div>", "Alpha\n"],
    ["<br>", ""],
  ])("preserves the value of %s", (markup, value) => {
    document.body.innerHTML = '<div contenteditable="true" aria-label="Editor">before</div>';
    const editor = document.querySelector<HTMLElement>("div")!;
    // happy-dom does not reflect the contenteditable attribute into this property.
    editor.contentEditable = "true";
    const steps: RecordStepPayload[] = [];
    const capture = startRecordCapture("lines", (step) => steps.push(step));
    try {
      editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      editor.innerHTML = markup;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      expect(steps).toEqual([
        expect.objectContaining({
          op: "fill",
          value,
          target: expect.objectContaining({ name: "Editor" }),
        }),
      ]);
    } finally {
      capture.dispose();
    }
  });
});
