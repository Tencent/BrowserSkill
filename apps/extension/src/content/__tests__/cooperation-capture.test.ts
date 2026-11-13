import { afterEach, expect, it, vi } from "vitest";
import { guardedRunner } from "@/cooperation/action-guard";
import {
  COOPERATION_ARM,
  COOPERATION_DISABLE,
  COOPERATION_READ,
  COOPERATION_READY,
  type FrameState,
  type InputExpectation,
} from "@/cooperation/types";
import {
  OVERLAY_AGENT_OVERLAY_RESET,
  OVERLAY_AGENT_STATE,
  OVERLAY_AUTOMATION_BYPASS,
} from "@/lib/overlay-bridge";
import type { CdpRunner } from "@/tools/shared";
import { attachCooperationCapture } from "../cooperation-capture";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function collector(shadowRoot?: (element: HTMLElement) => ShadowRoot | null) {
  let receive!: (message: unknown, sender: unknown, reply: (result: unknown) => void) => void;
  vi.stubGlobal("chrome", {
    dom: shadowRoot ? { openOrClosedShadowRoot: shadowRoot } : undefined,
    runtime: {
      sendMessage: vi.fn(async () => {}),
      onMessage: {
        addListener: (listener: typeof receive) => {
          receive = listener;
        },
        removeListener: vi.fn(),
      },
    },
  });
  dispose = attachCooperationCapture();
  const read = (
    kind = COOPERATION_READ,
    lease = "first",
    input?: InputExpectation,
  ): FrameState | undefined => {
    let result: unknown;
    receive({ kind, lease, input }, {}, (value) => {
      result = value;
    });
    return result as FrameState | undefined;
  };
  return Object.assign(read, { message: (message: unknown) => receive(message, {}, () => {}) });
}

it("collects and arms page interaction when crypto.randomUUID is unavailable", () => {
  // Ordinary HTTP origins expose getRandomValues but not randomUUID.
  vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
  document.body.innerHTML = '<input aria-label="City" value="Shanghai">';

  const read = collector();
  const initial = read()!;
  expect(initial.document).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  expect(initial.fields).toEqual([expect.objectContaining({ label: "City", value: "Shanghai" })]);
  expect(read(COOPERATION_ARM, "first", { type: "pointerdown", x: 10, y: 20 })).toMatchObject({
    document: initial.document,
    fields: initial.fields,
  });

  dispose!();
  dispose = undefined;
  const restarted = collector();
  expect(restarted()!.document).not.toBe(initial.document);
});

it("retires old collection leases so delayed reads cannot restart collection after stop", () => {
  const read = collector();
  expect(read()).toBeDefined();
  read(COOPERATION_DISABLE);
  expect(read()).toBeUndefined();
  expect(read(COOPERATION_READ, "second")).toBeDefined();
  read(COOPERATION_DISABLE, "first");
  expect(read(COOPERATION_READ, "second")).toBeDefined();
  expect(read(COOPERATION_READ, "first")).toBeUndefined();
});

it("requires the dispatched native time as well as coordinates before attributing an input to the Agent", () => {
  document.body.innerHTML = '<input aria-label="City">';
  const read = collector();
  read();
  const timestamp = Date.now();
  const point = { x: 10, y: 20 };
  const press = (time: number) => {
    const event = new MouseEvent("pointerdown", {
      bubbles: true,
      clientX: point.x,
      clientY: point.y,
    });
    Object.defineProperties(event, {
      isTrusted: { value: true },
      timeStamp: { value: time - performance.timeOrigin },
    });
    completeInput(document.querySelector("input")!, event);
  };
  read(COOPERATION_ARM, "first", { type: "pointerdown", ...point, timestamp });
  press(timestamp);
  expect(read()).toMatchObject({ human: 0, editing: false });
  read(COOPERATION_ARM, "first", { type: "pointerdown", ...point, timestamp });
  press(timestamp + 5);
  expect(read()).toMatchObject({ human: 1, editing: false });
});

it.each([
  "pointerdown",
] as const)("compares native %s in visual viewport coordinates after pinch zoom and pan", (type) => {
  document.body.innerHTML = "<button>Apply</button>";
  const timestamp = 1_790_000_000_000;
  const ticks = 1000;
  vi.spyOn(Date, "now").mockReturnValue(timestamp);
  vi.spyOn(performance, "now").mockReturnValue(ticks);
  vi.stubGlobal("visualViewport", { offsetLeft: 33, offsetTop: 36, scale: 2 });
  const read = collector();
  read();
  const input = { type, x: 280, y: 143, timestamp };
  const dispatch = (clientX: number, clientY: number) => {
    const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
    Object.defineProperties(event, {
      isTrusted: { value: true },
      timeStamp: { value: ticks },
    });
    completeInput(document.querySelector("button")!, event);
  };
  read(COOPERATION_ARM, "first", input);
  dispatch(313, 179);
  expect(read()).toMatchObject({ human: 0, busy: false });

  read(COOPERATION_ARM, "first", input);
  dispatch(280, 143);
  expect(read()).toMatchObject({ human: 1 });
});

// Native events use the renderer's monotonic clock. Its cached epoch origin
// can diverge from the wall clock used by CDP in a long-running browser.
it.each(
  [-120_000, -8.8, -5, -3, -1.5, 0, 1.5, 3, 5, 8.8, 120_000].flatMap((skew) =>
    (["pointerdown", "keydown", "keypress"] as const).map((type) => ({ skew, type })),
  ),
)("attributes $type with $skew ms of epoch drift without swallowing human input", ({
  skew,
  type,
}) => {
  document.body.innerHTML = '<input aria-label="City">';
  const epoch = 1_790_000_000_000;
  const ticks = 50_000;
  vi.spyOn(Date, "now").mockReturnValue(epoch);
  vi.spyOn(performance, "now").mockReturnValue(ticks);
  vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(epoch - ticks + skew);
  const read = collector();
  read();
  const expected: InputExpectation = { type, timestamp: epoch, key: "", x: 10, y: 20 };
  const press = (timeStamp: number) => {
    const event =
      type === "keydown" || type === "keypress"
        ? new KeyboardEvent(type, { bubbles: true, key: "" })
        : new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 20 });
    Object.defineProperties(event, {
      isTrusted: { value: true },
      timeStamp: { value: timeStamp },
    });
    completeInput(document.querySelector("input")!, event);
  };
  read(COOPERATION_ARM, "first", expected);
  press(ticks);
  expect(read()).toMatchObject({ human: 0, editing: false, busy: false });
  read(COOPERATION_ARM, "first", expected);
  press(ticks + 5);
  expect(read()).toMatchObject({ human: 1 });
});

it("fails closed when clock sampling is interrupted rather than accepting a wide input window", () => {
  document.body.innerHTML = "<button>Continue</button>";
  const read = collector();
  read();
  vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 50));
  expect(
    read(COOPERATION_ARM, "first", {
      type: "pointerdown",
      x: 0,
      y: 0,
      timestamp: Date.now(),
    }),
  ).toBeUndefined();
  const event = new MouseEvent("pointerdown", { bubbles: true });
  Object.defineProperties(event, {
    isTrusted: { value: true },
    timeStamp: { value: 120 },
  });
  completeInput(document.querySelector("button")!, event);
  expect(read()).toMatchObject({ human: 1 });
});

it.each([
  -2.2, -1.2, 0.2, 1.3,
])("allows %s ms of clock quantization without a broad input window", (rounding) => {
  document.body.innerHTML = "<button>Continue</button>";
  const read = collector();
  read();
  vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
  vi.spyOn(performance, "now").mockReturnValue(1000);
  read(COOPERATION_ARM, "first", {
    type: "pointerdown",
    x: 0,
    y: 0,
    timestamp: Date.now(),
  });
  const event = new MouseEvent("pointerdown", { bubbles: true });
  Object.defineProperties(event, {
    isTrusted: { value: true },
    timeStamp: { value: 1000 + rounding },
  });
  completeInput(document.querySelector("button")!, event);
  expect(read()).toMatchObject({ human: 0, editing: false, busy: false });
});

it("recognizes the recorded native key timestamp discrepancy but rejects nearby human input", () => {
  document.body.innerHTML = '<input aria-label="Quantity">';
  const read = collector();
  read();
  vi.spyOn(Date, "now").mockReturnValue(1_792_555_077_785);
  vi.spyOn(performance, "now").mockReturnValue(803.6000003814697);
  const input: InputExpectation = { type: "keydown", key: "", timestamp: Date.now() };
  const press = (timeStamp: number) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, key: "" });
    Object.defineProperties(event, { isTrusted: { value: true }, timeStamp: { value: timeStamp } });
    completeInput(document.querySelector("input")!, event);
  };
  read(COOPERATION_ARM, "first", input);
  press(804.8999996185303);
  expect(read()).toMatchObject({ human: 0, editing: false, busy: false });
  read(COOPERATION_ARM, "first", input);
  press(808.6000003814697);
  expect(read()).toMatchObject({ human: 1, editing: true, busy: true });
});

it("consumes a clock-matched expectation once and preserves the next same-position input", () => {
  document.body.innerHTML = "<button>Download</button>";
  const read = collector();
  read();
  const epoch = 1_792_557_963_885;
  const ticks = 12500.300000190737;
  vi.spyOn(Date, "now").mockReturnValue(epoch);
  vi.spyOn(performance, "now").mockReturnValue(12504);
  vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(epoch - ticks);
  const input: InputExpectation = { type: "pointerdown", x: 0, y: 0, timestamp: epoch };
  const press = (timeStamp: number) => {
    const event = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperties(event, { isTrusted: { value: true }, timeStamp: { value: timeStamp } });
    completeInput(document.querySelector("button")!, event);
  };
  read(COOPERATION_ARM, "first", input);
  press(ticks);
  expect(read()).toMatchObject({ human: 0, busy: false });
  // Even an adjacent input in the same precision bucket cannot reuse the lease.
  press(ticks + 0.5);
  expect(read()).toMatchObject({ human: 1 });
  read(COOPERATION_ARM, "first", input);
  press(12509);
  expect(read()).toMatchObject({ human: 2 });
});

it.each([
  "pointerdown",
  "keydown",
  "keypress",
] as const)("recognizes rounded native %s time at the epoch projection without swallowing later human input", (type) => {
  document.body.innerHTML = '<input aria-label="Target">';
  const read = collector();
  read();
  // Captured from a first-attempt native input: the renderer sample and the
  // projected epoch differ by 1.8 ms, and native conversion adds another 0.8 ms.
  const epoch = 1_792_664_525_469;
  const ticks = 5977.199999809265;
  vi.spyOn(Date, "now").mockReturnValue(epoch);
  vi.spyOn(performance, "now").mockReturnValue(ticks);
  vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(epoch - 5979);
  const input: InputExpectation = { type, timestamp: epoch, x: 10, y: 20, key: "Enter" };
  const press = (timeStamp: number) => {
    const event =
      type === "keydown" || type === "keypress"
        ? new KeyboardEvent(type, { bubbles: true, key: "Enter" })
        : new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 20 });
    Object.defineProperties(event, {
      isTrusted: { value: true },
      timeStamp: { value: timeStamp },
    });
    completeInput(document.querySelector("input")!, event);
  };
  read(COOPERATION_ARM, "first", input);
  press(5979.800000190735);
  expect(read()).toMatchObject({ human: 0, editing: false, busy: false });
  read(COOPERATION_ARM, "first", input);
  press(ticks + 5);
  expect(read()).toMatchObject({ human: 1 });
});

function edit(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
  target.focus();
  const before = new InputEvent("beforeinput", {
    bubbles: true,
    composed: true,
    inputType: "insertText",
    data: value,
  });
  Object.defineProperty(before, "isTrusted", { value: true });
  target.dispatchEvent(before);
  target.value = value;
  const input = new InputEvent("input", {
    bubbles: true,
    composed: true,
    inputType: "insertText",
    data: value,
  });
  Object.defineProperty(input, "isTrusted", { value: true });
  target.dispatchEvent(input);
}

function completeInput(target: Element, event: MouseEvent | KeyboardEvent) {
  if (target instanceof HTMLElement) target.focus();
  if (!event.isTrusted) Object.defineProperty(event, "isTrusted", { value: true });
  target.dispatchEvent(event);
  if (event.type === "pointerdown") {
    pointer(target, "pointerup");
    pointer(target, "click");
  } else if (target instanceof HTMLInputElement) {
    edit(target, target.value + "x");
  }
}

function pointer(target: Element, type: string) {
  const event = new MouseEvent(type, { bubbles: true, composed: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  target.dispatchEvent(event);
}

it("keeps scrolling and ineffective keys out of human control and its quiet clock", () => {
  document.body.innerHTML = '<input aria-label="City">';
  const read = collector();
  read();
  const target = document.querySelector("input")!;
  for (const type of ["wheel", "scroll"]) pointer(target, type);
  for (const key of ["Shift", "Tab", "ArrowLeft", "Backspace", "Escape"]) {
    for (const type of ["keydown", "keyup"]) {
      const event = new KeyboardEvent(type, { bubbles: true, key });
      Object.defineProperty(event, "isTrusted", { value: true });
      target.dispatchEvent(event);
    }
  }
  expect(read()).toMatchObject({
    human: 0,
    lastInput: 0,
    busy: false,
    editing: false,
    pending: false,
  });
});

it("waits for a possible click without revoking control, and releases a cancelled gesture", () => {
  document.body.innerHTML = "<button>Apply</button>";
  const read = collector();
  read();
  const target = document.querySelector("button")!;
  pointer(target, "pointerdown");
  expect(read()).toMatchObject({ human: 0, busy: false, pending: true, lastInput: 0 });
  pointer(target, "pointercancel");
  expect(read()).toMatchObject({ human: 0, pending: false, lastInput: 0 });
  pointer(target, "pointerdown");
  pointer(target, "pointerup");
  pointer(target, "click");
  expect(read()).toMatchObject({
    human: 1,
    editing: false,
    pending: false,
    events: [{ type: "click" }],
  });
});

it("ignores toolbar gestures while allowing them to finish a page-originated press", async () => {
  document.body.innerHTML =
    "<button>Apply</button><browser-skill-overlay><button>Pause</button></browser-skill-overlay>";
  const read = collector();
  const first = read()!;
  const toolbar = document.querySelector("browser-skill-overlay button")!;
  pointer(toolbar, "pointerdown");
  pointer(toolbar, "pointerup");
  pointer(toolbar, "click");
  expect(read()).toMatchObject({ revision: first.revision, human: 0, pending: false });
  pointer(document.querySelector("button")!, "pointerdown");
  pointer(toolbar, "pointerup");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(read()).toMatchObject({ human: 0, pending: false });
});

it("confirms changed content and releases editing when the field becomes readonly", () => {
  document.body.innerHTML = '<input aria-label="City" value="old">';
  const read = collector();
  read();
  const target = document.querySelector("input")!;
  edit(target, "old");
  expect(read()?.human).toBe(0);
  edit(target, "new");
  expect(read()).toMatchObject({ human: 1, editing: true, fields: [{ value: "new" }] });
  target.readOnly = true;
  expect(read()?.editing).toBe(false);
});

it("keeps native file-selection notifications out of text editing and field values", () => {
  document.body.innerHTML = '<input type="file">';
  const read = collector();
  read();
  for (const type of ["input", "change"]) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "isTrusted", { value: true });
    document.querySelector("input")!.dispatchEvent(event);
  }
  expect(read()).toMatchObject({ human: 0, editing: false, fields: [] });
});

it("protects an unfinished composition without inventing an edit when it is cancelled", () => {
  document.body.innerHTML = "<input>";
  const read = collector();
  read();
  const target = document.querySelector("input")!;
  for (const type of ["compositionstart", "compositionend"]) {
    const event = new CompositionEvent(type, { bubbles: true });
    Object.defineProperty(event, "isTrusted", { value: true });
    target.dispatchEvent(event);
    expect(read()).toMatchObject({
      human: 0,
      pending: type === "compositionstart",
      editing: false,
    });
  }
});

it("releases composition protection when the person finishes editing with a page click", async () => {
  document.body.innerHTML = "<input><button>Done</button>";
  const read = collector();
  read();
  const target = document.querySelector("input")!;
  target.focus();
  const start = new CompositionEvent("compositionstart", { bubbles: true });
  Object.defineProperty(start, "isTrusted", { value: true });
  target.dispatchEvent(start);
  edit(target, "上");
  expect(read()).toMatchObject({ editing: true, busy: true });
  // Some native cancellation/focus paths omit compositionend. The actual
  // click ending the edit must release that stale composition state too.
  pointer(document.querySelector("button")!, "click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(read()).toMatchObject({ editing: false, busy: false, pending: false });
});

it("keeps a real drag held after Chrome cancels its pointer stream", () => {
  document.body.innerHTML = '<div draggable="true">Move</div>';
  const read = collector();
  read();
  const target = document.querySelector("div")!;
  pointer(target, "pointerdown");
  pointer(target, "dragstart");
  pointer(target, "pointercancel");
  expect(read()).toMatchObject({ human: 1, busy: true, pending: false });
  pointer(target, "dragend");
  expect(read()).toMatchObject({ human: 1, busy: false, pending: false });
});

it("retires native text attribution by command id and preserves subsequent human typing", async () => {
  document.body.innerHTML = '<input type="password" aria-label="Password"><button>Next</button>';
  const read = collector();
  read();
  const target = document.querySelector("input")!;
  const next = document.querySelector("button")!;
  target.focus();
  read(COOPERATION_ARM, "first", {
    type: "beforeinput",
    text: "private synthetic text",
    id: "new",
  });
  read(COOPERATION_ARM, "first", { type: "clear", id: "old" });
  edit(target, "private synthetic text");
  expect(read()).toMatchObject({ human: 0, editing: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Moving focus away from a password field after insertText dispatches a native
  // change event on blur; it must not be misclassified as human intervention.
  next.focus();
  const blurChange = new Event("change", { bubbles: true });
  Object.defineProperty(blurChange, "isTrusted", { value: true });
  target.dispatchEvent(blurChange);
  expect(read()).toMatchObject({ human: 0, editing: false, fields: [] });
  target.focus();
  read(COOPERATION_ARM, "first", {
    type: "beforeinput",
    text: "manual synthetic text",
    id: "last",
  });
  read(COOPERATION_ARM, "first", { type: "clear", id: "last" });
  edit(target, "manual synthetic text");
  const state = read();
  expect(state).toMatchObject({ human: 1, editing: true, fields: [] });
  next.focus();
  target.dispatchEvent(blurChange);
  expect(read()).toMatchObject({ human: 1, editing: false, fields: [] });
  expect(JSON.stringify(state)).not.toMatch(/private synthetic text|manual synthetic text/);
});

it("preserves editing when clicking inside a contenteditable host and releases on non-editable controls", () => {
  document.body.innerHTML =
    '<div id="editor" contenteditable="true" tabindex="0"><p>Paragraph</p><button id="chip" contenteditable="false" type="button">Remove</button></div><button id="outside" type="button">Done</button>';
  const read = collector();
  read();
  const editor = document.querySelector<HTMLElement>("#editor")!;
  const paragraph = editor.querySelector<HTMLElement>("p")!;
  const chip = editor.querySelector<HTMLElement>("#chip")!;
  Object.defineProperty(editor, "isContentEditable", { get: () => true });
  Object.defineProperty(paragraph, "isContentEditable", { get: () => true });
  Object.defineProperty(chip, "isContentEditable", { get: () => false });
  editor.focus();
  const before = new InputEvent("beforeinput", {
    bubbles: true,
    composed: true,
    inputType: "insertText",
    data: "Edited",
  });
  Object.defineProperty(before, "isTrusted", { value: true });
  editor.dispatchEvent(before);
  paragraph.textContent = "Edited";
  const input = new InputEvent("input", {
    bubbles: true,
    composed: true,
    inputType: "insertText",
    data: "Edited",
  });
  Object.defineProperty(input, "isTrusted", { value: true });
  editor.dispatchEvent(input);
  expect(read()).toMatchObject({ human: 1, editing: true });

  pointer(paragraph, "pointerdown");
  pointer(paragraph, "pointerup");
  pointer(paragraph, "click");
  expect(read()).toMatchObject({ human: 2, editing: true });

  pointer(chip, "pointerdown");
  pointer(chip, "pointerup");
  pointer(chip, "click");
  expect(read()).toMatchObject({ human: 3, editing: false });
});

it("releases select pointer state when the native menu swallows pointerup or is cancelled with Escape", () => {
  document.body.innerHTML =
    '<select aria-label="Category"><option value="a">A</option><option value="b">B</option></select>';
  const read = collector();
  read();
  const select = document.querySelector("select")!;

  pointer(select, "pointerdown");
  expect(read()).toMatchObject({ human: 0, pending: true, busy: false });
  const escape = new KeyboardEvent("keydown", { bubbles: true, key: "Escape" });
  Object.defineProperty(escape, "isTrusted", { value: true });
  select.dispatchEvent(escape);
  const escapeUp = new KeyboardEvent("keyup", { bubbles: true, key: "Escape" });
  Object.defineProperty(escapeUp, "isTrusted", { value: true });
  select.dispatchEvent(escapeUp);
  expect(read()).toMatchObject({ human: 0, pending: false, busy: false });

  pointer(select, "pointerdown");
  expect(read()).toMatchObject({ human: 0, pending: true, busy: false });
  select.value = "b";
  for (const type of ["input", "change"]) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "isTrusted", { value: true });
    select.dispatchEvent(event);
  }
  expect(read()).toMatchObject({
    human: 1,
    pending: false,
    busy: false,
    editing: false,
  });
});

it("publishes scroll transitions once per burst and ignores idle window blur", () => {
  vi.useFakeTimers();
  document.body.innerHTML = "<button>Apply</button>";
  const read = collector();
  const initial = read()!;
  vi.mocked(chrome.runtime.sendMessage).mockClear();

  window.dispatchEvent(new Event("blur"));
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  expect(read()!.revision).toBe(initial.revision);

  document.dispatchEvent(new Event("scroll"));
  document.dispatchEvent(new Event("scroll"));
  document.dispatchEvent(new Event("scroll"));
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  expect(read()?.scrolling).toBe(true);

  vi.advanceTimersByTime(120);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
  expect(read()?.scrolling).toBe(false);
  vi.useRealTimers();
});

it("releases an editing hold when the window blurs so switching back to chat hands control back", () => {
  document.body.innerHTML = '<input aria-label="City" value="Shanghai">';
  const read = collector();
  read();
  const target = document.querySelector("input")!;
  edit(target, "Beijing");
  expect(read()).toMatchObject({ human: 1, editing: true, busy: false });

  window.dispatchEvent(new Event("blur"));
  expect(read()).toMatchObject({ human: 1, editing: false, busy: false, pending: false });
});

it("clears text attribution when preparation fails before native dispatch", async () => {
  document.body.innerHTML = "<input>";
  const read = collector();
  read();
  const target = document.querySelector("input")!;
  target.focus();
  const native = vi.fn();
  const runner = guardedRunner({ send: native } as CdpRunner, {
    prepare: async (input) => {
      read(COOPERATION_ARM, "first", input);
      throw new Error("target changed");
    },
    finishInput: async (input) => {
      read(COOPERATION_ARM, "first", { type: "clear", id: input.id });
    },
  });
  await expect(runner.send(7, "Input.insertText", { text: "same text" })).rejects.toThrow(
    "target changed",
  );
  expect(native).not.toHaveBeenCalled();
  edit(target, "same text");
  expect(read()).toMatchObject({ human: 1, editing: true });
});

it("prioritizes a human key even when its text matches a pending native insertion", () => {
  document.body.innerHTML = "<input>";
  const read = collector();
  read();
  const target = document.querySelector("input")!;
  target.focus();
  read(COOPERATION_ARM, "first", { type: "beforeinput", text: "x", id: "agent" });
  const key = new KeyboardEvent("keydown", { bubbles: true, key: "x" });
  Object.defineProperty(key, "isTrusted", { value: true });
  target.dispatchEvent(key);
  edit(target, "x");
  expect(read()).toMatchObject({ human: 1, editing: true });
});

it("recognizes editing events retargeted from a closed shadow input", () => {
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.querySelector<HTMLElement>("#host")!;
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = '<input aria-label="Closed note">';
  const read = collector((element) => (element === host ? root : null));
  read();
  const target = root.querySelector("input")!;
  target.focus();
  const dispatch = (type: string) => {
    const event = new InputEvent(type, {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: "human",
    });
    Object.defineProperty(event, "isTrusted", { value: true });
    host.dispatchEvent(event);
  };
  dispatch("beforeinput");
  target.value = "human";
  dispatch("input");
  expect(read()).toMatchObject({ human: 1, editing: true, fields: [{ value: "human" }] });
});

it.each([
  '<input readonly value="selected">',
  '<input type="checkbox">',
  '<input type="radio">',
  '<input type="range">',
  "<select><option>Selected</option></select>",
])("returns control after a discrete control interaction: %s", (html) => {
  document.body.innerHTML = html;
  const read = collector();
  read();
  const target = document.body.firstElementChild!;
  pointer(target, "pointerdown");
  pointer(target, "pointerup");
  pointer(target, "click");
  expect(read()).toMatchObject({ human: 1, editing: false, busy: false });
});

it("distinguishes identically labelled fields and observes open shadow controls", () => {
  document.body.innerHTML = '<input aria-label="Choice"><div id="host"></div>';
  const shadow = document.querySelector("#host")!.attachShadow({ mode: "open" });
  shadow.innerHTML = '<input aria-label="Choice" value="second">';
  const read = collector();
  const first = read()!;
  expect(first.fields).toHaveLength(2);
  expect(new Set(first.fields.map((f) => f.id)).size).toBe(2);
  expect(first.fieldsComplete).toBe(true);
  edit(shadow.querySelector("input")!, "human note");
  expect(read()).toMatchObject({ editing: true, events: [{ type: "input", label: "Choice" }] });
});

it("keeps native input attribution valid across renderer delay without accepting nearby human input", () => {
  document.body.innerHTML = "<button>Continue</button>";
  const read = collector();
  read();
  const timestamp = Date.now();
  read(COOPERATION_ARM, "first", { type: "pointerdown", x: 0, y: 0, timestamp });
  vi.spyOn(Date, "now").mockReturnValue(timestamp + 500);
  const event = new MouseEvent("pointerdown", { bubbles: true });
  Object.defineProperties(event, {
    isTrusted: { value: true },
    timeStamp: { value: timestamp - performance.timeOrigin },
  });
  document.querySelector("button")!.dispatchEvent(event);
  expect(read()).toMatchObject({ human: 0 });
  completeInput(
    document.querySelector("button")!,
    new MouseEvent("pointerdown", { bubbles: true }),
  );
  expect(read()).toMatchObject({ human: 1 });
  vi.restoreAllMocks();
});

it("attributes a keyless caret command to the Agent while preserving subsequent human input", async () => {
  document.body.innerHTML = '<input aria-label="Quantity" value="1">';
  const read = collector();
  read();
  const press = (key: string, timestamp: number) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, key });
    Object.defineProperties(event, {
      isTrusted: { value: true },
      timeStamp: { value: timestamp - performance.timeOrigin },
    });
    completeInput(document.querySelector("input")!, event);
  };
  const cdp = {
    send: vi.fn(async (_tabId, _method, params) => {
      // Chromium emits an empty key for native editor commands without a key descriptor.
      press(params.key ?? "", params.timestamp * 1000);
      return {};
    }),
  } as CdpRunner;
  const runner = guardedRunner(cdp, {
    prepare: async (input) => {
      read(COOPERATION_ARM, "first", input);
    },
  });
  await runner.send(7, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    commands: ["moveToEndOfDocument"],
  });
  expect(read()).toMatchObject({ human: 0, editing: false, busy: false });
  press("2", Date.now());
  expect(read()).toMatchObject({ human: 1, editing: true, busy: true });
});

it("detects silent value changes beyond the bounded delta and excludes password values", () => {
  document.body.innerHTML =
    Array.from(
      { length: 65 },
      (_, index) => `<input aria-label="Field ${index}" value="old">`,
    ).join("") + '<input type="password" value="private-value">';
  const read = collector();
  const first = read()!;
  expect(first.fieldsComplete).toBe(false);
  expect(first.fields).toHaveLength(64);
  document.querySelectorAll("input")[64].value = "new";
  const second = read()!;
  expect(second.revision).toBeGreaterThan(first.revision);
  expect(JSON.stringify(second)).not.toContain("private-value");
});

it("keeps codes and card details the person types out of field state", () => {
  document.body.innerHTML =
    '<input aria-label="Code" autocomplete="one-time-code">' +
    '<input aria-label="Card" autocomplete="billing cc-number">' +
    '<input aria-label="City">';
  const read = collector();
  read();
  for (const [input, value] of [...document.querySelectorAll("input")].map(
    (input, index) => [input, ["482913", "4111111111111111", "Shanghai"][index]] as const,
  )) {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const state = read()!;
  expect(state.fields).toEqual([expect.objectContaining({ label: "City", value: "Shanghai" })]);
  expect(JSON.stringify(state)).not.toMatch(/482913|4111111111111111/);
});

it("keeps a password field shown as text and newly marked secret fields out of field state", () => {
  document.body.innerHTML =
    '<input id="pw" type="password" aria-label="Password">' +
    '<input id="code" type="text" aria-label="Code" value="482913">';
  const read = collector();
  expect(read()?.fields).toEqual([expect.objectContaining({ label: "Code", value: "482913" })]);

  const pw = document.querySelector<HTMLInputElement>("#pw")!;
  pw.type = "text";
  pw.value = "BSK_SYNTHETIC_PASSWORD";
  pw.dispatchEvent(new Event("input", { bubbles: true }));

  const code = document.querySelector<HTMLInputElement>("#code")!;
  code.setAttribute("autocomplete", "one-time-code");

  const state = read()!;
  expect(state.fields).toEqual([]);
  expect(JSON.stringify(state)).not.toMatch(/BSK_SYNTHETIC_PASSWORD|482913/);
});

it("does not describe ambiguous or truncated field values as complete incremental evidence", () => {
  document.body.innerHTML =
    '<input aria-label="City"><input aria-label="City"><textarea aria-label="Notes"></textarea>';
  document.querySelector("textarea")!.value = "x".repeat(600);
  const read = collector();
  expect(read()?.fieldsComplete).toBe(false);
  const first = read()!;
  document.querySelector("textarea")!.value = "x".repeat(599) + "y";
  expect(read()!.revision).toBeGreaterThan(first.revision);
});

it("does not acquire an editing lease when scrolling over an input", () => {
  document.body.innerHTML = '<input aria-label="City">';
  const read = collector();
  read();
  pointer(document.querySelector("input")!, "wheel");
  expect(read()).toMatchObject({ human: 0, editing: false, busy: false });
});

it("listens for wheel only while collecting so pages keep legacy mousewheel handlers", () => {
  // Chromium does not run a node's `mousewheel` listeners when it has a `wheel` listener.
  const added = [vi.spyOn(document, "addEventListener"), vi.spyOn(window, "addEventListener")];
  const removed = vi.spyOn(window, "removeEventListener");
  const wheel = (...spies: (typeof removed)[]) =>
    spies.flatMap((spy) => spy.mock.calls).filter(([type]) => type === "wheel").length;
  const read = collector();
  expect(wheel(...added)).toBe(0);
  read();
  expect(wheel(...added)).toBe(1);
  read(COOPERATION_DISABLE);
  expect(wheel(removed)).toBe(1);
});

it("attributes an Agent wheel that an earlier document listener stops", () => {
  document.body.innerHTML = '<input type="number" aria-label="Volume" value="5">';
  const field = document.querySelector("input")!;
  // Registered by the page before cooperation starts; its wheel handler changes the value.
  const stop = (event: Event) => {
    event.stopImmediatePropagation();
    field.value = String(Number(field.value) + 1);
    const input = new InputEvent("input", { bubbles: true });
    Object.defineProperty(input, "isTrusted", { value: true });
    field.dispatchEvent(input);
  };
  document.addEventListener("wheel", stop, true);
  try {
    const read = collector();
    read();
    const timestamp = Date.now();
    const point = { x: 10, y: 20 };
    const wheel = () => {
      // happy-dom's WheelEvent is not a MouseEvent; Chromium's is.
      const event = new MouseEvent("wheel", { bubbles: true, clientX: point.x, clientY: point.y });
      Object.defineProperties(event, {
        isTrusted: { value: true },
        timeStamp: { value: timestamp - performance.timeOrigin },
      });
      field.dispatchEvent(event);
    };
    read(COOPERATION_ARM, "first", { type: "wheel", ...point, timestamp });
    wheel();
    expect(read()).toMatchObject({ human: 0 });
    wheel();
    expect(read()).toMatchObject({ human: 1 });
  } finally {
    document.removeEventListener("wheel", stop, true);
  }
});

it("preserves editing across a focus transition into a shadow field", async () => {
  document.body.innerHTML =
    '<input type="range"><div id="host" tabindex="0"></div><button>Done</button>';
  const root = document.querySelector("#host")!.attachShadow({ mode: "open" });
  root.innerHTML = '<input aria-label="Shadow note">';
  const read = collector();
  read();
  const outer = document.querySelector<HTMLInputElement>("input")!;
  const focusout = (target: Element, relatedTarget: Element) => {
    const event = new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget });
    Object.defineProperty(event, "isTrusted", { value: true });
    target.dispatchEvent(event);
  };
  outer.focus();
  const input = root.querySelector<HTMLInputElement>("input")!;
  pointer(input, "pointerdown");
  focusout(outer, root.host);
  input.focus();
  pointer(input, "pointerup");
  edit(input, "human note");
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(read()).toMatchObject({ editing: true, busy: false });
  focusout(input, document.querySelector("button")!);
  document.querySelector("button")!.focus();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(read()).toMatchObject({ editing: false });
});

it("announces renderer readiness once after the collection listener exists", () => {
  const read = collector();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ kind: COOPERATION_READY });
  expect(read()).toHaveProperty("document");
});

it("classifies a non-submitted media timeline without masking business fields", () => {
  document.body.innerHTML =
    '<video id="preview"></video><label>Playback progress<input id="timeline" type="range" value="1"></label><input aria-label="Order total" value="100"><input type="range" aria-label="Order amount" value="10">';
  const read = collector();
  const before = read()!;
  expect(before.fields[0]).toMatchObject({ value: "1", kind: "media_progress" });
  expect(before.fields.slice(1).every((field) => field.kind === undefined)).toBe(true);
  const progress = document.querySelector<HTMLInputElement>("#timeline")!;
  progress.value = "2";
  expect(read()!.fields[0]).toMatchObject({ value: "2", kind: "media_progress" });
  progress.name = "order_amount";
  expect(read()!.fields[0].kind).toBeUndefined();
});

it.each([
  "form",
  "external",
  "ambiguous",
  "missing",
])("does not classify a %s timeline as incidental", (kind) => {
  document.body.innerHTML =
    '<video id="preview"></video><input id="timeline" type="range" aria-label="Playback progress">';
  const timeline = document.querySelector<HTMLInputElement>("#timeline")!;
  if (kind === "form") {
    const form = document.createElement("form");
    document.body.append(form);
    form.append(timeline);
  }
  if (kind === "external") {
    const form = document.createElement("form");
    form.id = "order";
    document.body.append(form);
    timeline.setAttribute("form", "order");
  }
  if (kind === "ambiguous") document.body.append(document.createElement("video"));
  if (kind === "missing") document.querySelector("video")!.remove();
  expect(collector()()!.fields[0].kind).toBeUndefined();
});

it("reports programmatic focus changes even without a human event", () => {
  document.body.innerHTML = '<button id="pause">Pause</button><input id="order">';
  const read = collector();
  const first = read()!.focus;
  document.querySelector<HTMLInputElement>("#order")!.focus();
  const current = read()!;
  expect(current.focus).not.toBe(first);
  expect(current.human).toBe(0);
});

it("records media sources independently of playback time, including runtime-only source changes", () => {
  document.body.innerHTML = '<video><source src="one.webm" type="video/webm"></video>';
  const video = document.querySelector("video")!;
  const source = video.querySelector("source")!;
  const read = collector();
  const first = read()!;
  video.currentTime = 1;
  expect(read()!.media).toEqual(first.media);
  source.src = "two.webm";
  const changed = read()!;
  expect(changed.media).not.toEqual(first.media);
  expect(changed.revision).toBeGreaterThan(first.revision);
  Object.defineProperty(video, "currentSrc", { configurable: true, value: "selected.webm" });
  const selected = read()!;
  expect(selected.media![0].currentSrc).toBe("selected.webm");
  expect(selected.revision).toBeGreaterThan(changed.revision);
  Object.defineProperty(video, "srcObject", { configurable: true, value: {} });
  const stream = read()!;
  expect(stream.media![0].srcObject).toEqual(expect.any(String));
  Object.defineProperty(video, "srcObject", { configurable: true, value: {} });
  expect(read()!.media![0].srcObject).not.toBe(stream.media![0].srcObject);
});

it("collects media and deep focus in open shadow roots", () => {
  document.body.innerHTML = '<div id="host"></div>';
  const root = document.querySelector("#host")!.attachShadow({ mode: "open" });
  root.innerHTML = '<audio><source src="one.ogg"></audio><button>Pause</button>';
  const read = collector();
  expect(read()!.focusIsDocument).toBe(true);
  root.querySelector<HTMLButtonElement>("button")!.focus();
  const focused = read()!;
  expect(focused.focusIsDocument).toBe(false);
  expect(focused.media).toHaveLength(1);
  root.querySelector("source")!.src = "two.ogg";
  expect(read()!.media).not.toEqual(focused.media);
});

it("collects source and recipient changes inside closed shadow roots", () => {
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.querySelector<HTMLElement>("#host")!;
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML =
    '<video><source src="one.webm"></video><button>Pause</button><button>Buy</button>';
  const read = collector((element) => (element === host ? root : null));
  const buttons = root.querySelectorAll<HTMLButtonElement>("button");
  buttons[0].focus();
  const first = read()!;
  expect(host.shadowRoot).toBeNull();
  expect(first.media).toHaveLength(1);
  buttons[1].focus();
  root.querySelector("source")!.src = "two.webm";
  const changed = read()!;
  expect(changed.focus).not.toBe(first.focus);
  expect(changed.media).not.toEqual(first.media);
  expect(changed.revision).toBeGreaterThan(first.revision);
});

it.each([
  "matched",
  "wrong-time",
  "expired",
] as const)("attributes an atomic Enter keypress only in its native task (%s)", async (scenario) => {
  document.body.innerHTML = '<form><input aria-label="Query"></form>';
  const target = document.querySelector("input")!;
  const form = document.querySelector("form")!;
  const read = collector();
  read();
  const timestamp = Date.now();
  const key = (type: string, offset = 0) => {
    const event = new KeyboardEvent(type, { key: "Enter", bubbles: true });
    Object.defineProperties(event, {
      isTrusted: { value: true },
      timeStamp: { value: timestamp + offset - performance.timeOrigin },
    });
    target.dispatchEvent(event);
  };
  const submit = () => {
    const event = new Event("submit", { bubbles: true });
    Object.defineProperty(event, "isTrusted", { value: true });
    form.dispatchEvent(event);
  };
  read(COOPERATION_ARM, "first", { type: "keydown", key: "Enter", timestamp, keypress: true });
  key("keydown");
  if (scenario === "expired") await new Promise((resolve) => setTimeout(resolve, 0));
  key("keypress", scenario === "wrong-time" ? 5 : 0);
  submit();
  key("keyup");
  expect(read()?.human).toBe(scenario === "matched" ? 0 : 1);
  // A later unarmed person still owns their keypress and submission.
  key("keydown", 10);
  key("keypress", 10);
  submit();
  key("keyup", 10);
  expect(read()?.human).toBe(scenario === "matched" ? 1 : 2);
});

function trusted<T extends Event>(event: T): T {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

it("blocks accidental page input without changing the shared-control context", () => {
  document.body.innerHTML = '<input aria-label="City"><button>Submit</button>';
  const read = collector();
  const before = read()!;
  read.message({
    type: OVERLAY_AGENT_STATE,
    epoch: "worker",
    generation: 1,
    sessionId: "task",
    mode: "control",
    lockInput: true,
    inputLocked: true,
  });
  const field = document.querySelector("input")!;
  const page = vi.fn();
  for (const type of [
    "pointerdown",
    "mousedown",
    "click",
    "keydown",
    "beforeinput",
    "wheel",
    "paste",
  ])
    field.addEventListener(type, page);
  const events = [
    new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    new MouseEvent("click", { bubbles: true, cancelable: true }),
    new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
    new InputEvent("beforeinput", {
      inputType: "insertText",
      data: "a",
      bubbles: true,
      cancelable: true,
    }),
    new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }),
    new Event("paste", { bubbles: true, cancelable: true }),
  ];
  for (const event of events) expect(field.dispatchEvent(trusted(event))).toBe(false);
  expect(page).not.toHaveBeenCalled();
  expect(read()).toMatchObject({
    human: before.human,
    revision: before.revision,
    busy: false,
    pending: false,
    editing: false,
  });
  // Site-script effects are still allowed and observed.
  field.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(page).toHaveBeenCalledOnce();
});

it("keeps Agent keyboard input available while blocking a real key during overlay bypass", () => {
  document.body.innerHTML = '<input aria-label="City">';
  const read = collector();
  read();
  read.message({
    type: OVERLAY_AGENT_STATE,
    epoch: "worker",
    generation: 1,
    sessionId: "task",
    mode: "control",
    inputLocked: true,
  });
  read.message({ type: OVERLAY_AUTOMATION_BYPASS, enabled: true });
  const field = document.querySelector("input")!;
  field.focus();
  const received = vi.fn();
  field.addEventListener("keydown", received);
  const timestamp = Date.now();
  read(COOPERATION_ARM, "first", { type: "keydown", key: "a", timestamp });
  const key = trusted(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
  Object.defineProperty(key, "timeStamp", { value: timestamp - performance.timeOrigin });
  expect(field.dispatchEvent(key)).toBe(true);
  const accidental = trusted(
    new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true }),
  );
  expect(field.dispatchEvent(accidental)).toBe(false);
  expect(received).toHaveBeenCalledOnce();
  expect(read()).toMatchObject({ human: 0, editing: false });
});

it("unlocks on handover and return, ignores stale states, and releases on collector disable", () => {
  document.body.innerHTML = '<input aria-label="City">';
  const read = collector();
  read();
  const state = (generation: number, inputLocked: boolean, mode = "control") =>
    read.message({
      type: OVERLAY_AGENT_STATE,
      epoch: "worker",
      generation,
      sessionId: "task",
      mode,
      inputLocked,
    });
  const key = () =>
    document.querySelector("input")!.dispatchEvent(
      trusted(
        new KeyboardEvent("keydown", {
          key: "a",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  expect(key()).toBe(true);
  state(1, true);
  expect(key()).toBe(false);
  state(3, false);
  state(2, true);
  expect(key()).toBe(true);
  state(4, true);
  expect(key()).toBe(false);
  read.message({
    type: OVERLAY_AGENT_OVERLAY_RESET,
    epoch: "worker",
    generation: 5,
    sessionId: "task",
  });
  state(4, true);
  expect(key()).toBe(true);
  state(6, true);
  expect(key()).toBe(false);
  read(COOPERATION_DISABLE);
  state(7, true);
  expect(key()).toBe(true);
  expect(read()).toBeUndefined();
});

const page =
  '<header><span id="cell" data-rev="0">Version: rev-0</span><p id="other">Other</p></header>';
/** How far each counter moved across `change`, and what the frame logged for it. */
function across(read: () => FrameState | undefined, change: () => void) {
  const before = read()!;
  change();
  const after = read()!;
  return {
    structure: after.structure - before.structure,
    textual: after.textual! - before.textual!,
    texts: after.texts!.slice(before.texts!.length),
    after,
  };
}

it("logs a batch that only replaces visible text, whichever way the page writes it", () => {
  document.body.innerHTML = page;
  const read = collector();
  const cell = document.querySelector<HTMLElement>("#cell")!;

  // The arena's own update: page-private data and textContent in one task.
  const first = across(read, () => {
    cell.dataset.rev = "1";
    cell.textContent = "Version: rev-1";
  });
  expect(first).toMatchObject({ structure: 1, textual: 1 });
  expect(first.texts).toEqual([
    {
      sequence: first.after.textual,
      id: expect.any(String),
      label: "span#cell",
      previous_value: "Version: rev-0",
      value: "Version: rev-1",
    },
  ]);

  const second = across(read, () => {
    (cell.firstChild as Text).data = "  Version:\n rev-2 ";
  });
  expect(second).toMatchObject({ structure: 1, textual: 1 });
  expect(second.texts).toMatchObject([
    { previous_value: "Version: rev-1", value: "Version: rev-2" },
  ]);

  // Two writes before anyone reads are one replacement, first text to last.
  const third = across(read, () => {
    cell.textContent = "Version: rev-3";
    cell.textContent = "Version: rev-4";
  });
  expect(third.texts).toMatchObject([
    { previous_value: "Version: rev-2", value: "Version: rev-4" },
  ]);
});

it.each<[string, () => unknown]>([
  ["a node is added", () => document.querySelector("header")!.append(document.createElement("b"))],
  ["text appears where there was none", () => document.querySelector("header")!.append("new")],
  ["text is emptied", () => (document.querySelector("#cell")!.textContent = "")],
  ["a class changes", () => document.querySelector("#cell")!.setAttribute("class", "hidden")],
  ["the element is hidden", () => document.querySelector("#cell")!.setAttribute("hidden", "")],
  // The observation reads data-state, and a style sheet reads data-shown.
  ["observed data changes", () => document.querySelector("#cell")!.setAttribute("data-state", "x")],
  ["styled data changes", () => document.querySelector("#cell")!.setAttribute("data-shown", "no")],
  ["a heading changes", () => (document.querySelector("h2")!.textContent = "Renamed")],
  ["a label changes", () => (document.querySelector("label")!.textContent = "Renamed")],
  // Refs inside a row or list item are identified by its text.
  ["a list item changes", () => (document.querySelector("li")!.textContent = "Renamed")],
  ["a table cell changes", () => (document.querySelector("td")!.textContent = "Renamed")],
  ["a name source changes", () => (document.querySelector("#named")!.textContent = "Renamed")],
  ["the old text is not unique", () => (document.querySelector("#twin")!.textContent = "Solo")],
  [
    "text changes along with structure",
    () => {
      document.querySelector("#cell")!.textContent = "Version: rev-1";
      document.querySelector("#other")!.remove();
    },
  ],
])("keeps requiring a fresh observation when %s", (_name, change) => {
  document.body.innerHTML = `<style>[data-shown="no"] { display: none }</style>${page}
    <h2>Title</h2><label>Name</label><span id="named">Describes</span>
    <button aria-describedby="named">Go</button><i id="twin">Twin</i><i>Twin</i>
    <ul><li>Item</li></ul><table><tbody><tr><td>Cell</td></tr></tbody></table>`;
  const read = collector();
  expect(across(read, change)).toMatchObject({ structure: 1, textual: 0, texts: [] });
});

it("marks the log incomplete once it drops a replacement", () => {
  document.body.innerHTML = page;
  const read = collector();
  const cell = document.querySelector("#cell")!;
  read();
  for (let version = 1; version <= 70; version++) {
    // Reads are spaced out: the collector refuses to index a text ticker.
    vi.setSystemTime(Date.now() + 200);
    cell.textContent = `Version: rev-${version}`;
    read();
  }
  const state = read()!;
  expect(state.textual).toBe(70);
  expect(state.texts).toHaveLength(64);
  expect(state.texts![0]).toMatchObject({ sequence: 7, value: "Version: rev-7" });
  expect(state.textFloor).toBe(6);
});

it("stops logging text that changes more than ten times a second", () => {
  document.body.innerHTML = page;
  const read = collector();
  const cell = document.querySelector("#cell")!;
  read();
  for (let version = 1; version <= 12; version++) {
    cell.textContent = `Version: rev-${version}`;
    read();
  }
  expect(read()).toMatchObject({ structure: 12, textual: 10 });
});

it("reports whether a style tied to focus could show or hide content", () => {
  document.body.innerHTML = `<style>
      button:focus { outline: 2px solid; color: red }
      #menu-button:focus + .panel { display: block }
    </style>
    <button id="plain">Plain</button>
    <div class="menu"><button id="menu-button">Open</button><div class="panel">Panel</div></div>`;
  const read = collector();
  expect(read()).toMatchObject({ focusNeutral: true });
  document.querySelector<HTMLElement>("#plain")!.focus();
  expect(read()).toMatchObject({ focusNeutral: true });
  document.querySelector<HTMLElement>("#menu-button")!.focus();
  expect(read()).toMatchObject({ focusNeutral: false });
});
