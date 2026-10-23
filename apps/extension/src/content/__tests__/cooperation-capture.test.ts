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

function collector() {
  let receive!: (message: unknown, sender: unknown, reply: (result: unknown) => void) => void;
  vi.stubGlobal("chrome", {
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
  return (
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
}

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
    document.querySelector("input")!.dispatchEvent(event);
  };
  read(COOPERATION_ARM, "first", { type: "pointerdown", ...point, timestamp });
  press(timestamp);
  expect(read()).toMatchObject({ human: 0, editing: false });
  read(COOPERATION_ARM, "first", { type: "pointerdown", ...point, timestamp });
  press(timestamp + 5);
  expect(read()).toMatchObject({ human: 1, editing: true });
});

// Native events use the renderer's monotonic clock. Its cached epoch origin
// can diverge from the wall clock used by CDP in a long-running browser.
it.each(
  [-120_000, -8.8, -5, -3, -1.5, 0, 1.5, 3, 5, 8.8, 120_000].flatMap((skew) =>
    (["pointerdown", "keydown", "wheel"] as const).map((type) => ({ skew, type })),
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
      type === "keydown"
        ? new KeyboardEvent(type, { bubbles: true, key: "" })
        : new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 20 });
    Object.defineProperties(event, {
      isTrusted: { value: true },
      timeStamp: { value: timeStamp },
    });
    document.querySelector("input")!.dispatchEvent(event);
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
  document.querySelector("button")!.dispatchEvent(event);
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
  document.querySelector("button")!.dispatchEvent(event);
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
    document.querySelector("input")!.dispatchEvent(event);
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
    document.querySelector("button")!.dispatchEvent(event);
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
  "wheel",
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
      type === "keydown"
        ? new KeyboardEvent(type, { bubbles: true, key: "Enter" })
        : new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 20 });
    Object.defineProperties(event, {
      isTrusted: { value: true },
      timeStamp: { value: timeStamp },
    });
    document.querySelector("input")!.dispatchEvent(event);
  };
  read(COOPERATION_ARM, "first", input);
  press(5979.800000190735);
  expect(read()).toMatchObject({ human: 0, editing: false, busy: false });
  read(COOPERATION_ARM, "first", input);
  press(ticks + 5);
  expect(read()).toMatchObject({ human: 1 });
});

function pointer(target: Element, type: string) {
  const event = new MouseEvent(type, { bubbles: true, composed: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  target.dispatchEvent(event);
}

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
  pointer(shadow.querySelector("input")!, "pointerdown");
  expect(read()).toMatchObject({ editing: true, events: [{ label: "Choice" }] });
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
  pointer(document.querySelector("button")!, "pointerdown");
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
    document.querySelector("input")!.dispatchEvent(event);
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
  expect(read()).toMatchObject({ human: 1, editing: false, busy: false });
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
