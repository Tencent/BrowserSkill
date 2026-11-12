import { describe, expect, it } from "vitest";
import { type HeldText, textDelta } from "./text-delta";
import type { FrameState, TextChange } from "./types";

// The shape of the arena page: a banner named by its children, one of which changes.
const VOM = [
  "@vom 1",
  "@view 1710x858",
  "@layers 1 focus=L1",
  "L1 page",
  '  RootWebArea "Arena"',
  '    banner "Fulfilment board DOM nodes: 6857 Version: rev-0"',
  '      heading "Fulfilment board"',
  '      StaticText "DOM nodes: 6857"',
  '      StaticText "Version: rev-0"',
  '    main "Orders"',
  '      @e1 button "Refresh" [ctx: Orders]',
  '      @e2 link "Open rev-9"',
  '        StaticText "Open rev-9"',
  '      StaticText "Total: 5"',
  '      @context table "Shipment sta"',
  '      row "Shipment status: late"',
].join("\n");
const held: HeldText = { text: VOM, truncated: false };

const frame = (patch: Partial<FrameState> = {}): FrameState => ({
  document: "d",
  focus: "1",
  focusIsDocument: true,
  focusNeutral: true,
  revision: 0,
  structure: 0,
  textual: 0,
  texts: [],
  human: 0,
  busy: false,
  editing: false,
  lastInput: 0,
  fields: [],
  events: [],
  ...patch,
});
const frames = (...list: FrameState[]) => new Map(list.map((state, id) => [id, state]));
const text = (sequence: number, previous_value: string, value: string): TextChange => ({
  sequence,
  id: "9",
  label: "span#delta-pulse-cell",
  previous_value,
  value,
});
/** A frame that logged these replacements, one batch each, and nothing else. */
const after = (texts: TextChange[], patch: Partial<FrameState> = {}) =>
  frames(frame({ revision: 4, structure: texts.length, textual: texts.length, texts, ...patch }));
const delta = (now: ReturnType<typeof frames>, text: HeldText | undefined = held, max?: number) =>
  textDelta(text, max, frames(frame()), now);

describe("textDelta", () => {
  it("patches the text and the name derived from it, exactly as a capture renders them", () => {
    const result = delta(after([text(1, "Version: rev-0", "Version: rev-1")]));
    expect(result).toMatchObject({
      lines: [
        {
          line: 6,
          previous: '    banner "Fulfilment board DOM nodes: 6857 Version: rev-0"',
          text: '    banner "Fulfilment board DOM nodes: 6857 Version: rev-1"',
        },
        {
          line: 9,
          previous: '      StaticText "Version: rev-0"',
          text: '      StaticText "Version: rev-1"',
        },
      ],
      changes: [
        {
          frame_id: 0,
          kind: "text",
          label: "span#delta-pulse-cell",
          previous_value: "Version: rev-0",
          value: "Version: rev-1",
          lines: [6, 9],
        },
      ],
      text: VOM.replaceAll("rev-0", "rev-1"),
      focusMoved: false,
    });
  });

  it("continues from the patched text: rev-1 to rev-2, then two changes read as one", () => {
    const first = delta(after([text(1, "Version: rev-0", "Version: rev-1")]));
    if (typeof first === "string") throw new Error(first);
    const second = textDelta(
      { ...held, text: first.text },
      undefined,
      after([text(1, "Version: rev-0", "Version: rev-1")]),
      after([
        text(1, "Version: rev-0", "Version: rev-1"),
        text(2, "Version: rev-1", "Version: rev-2"),
      ]),
    );
    expect(second).toMatchObject({ text: VOM.replaceAll("rev-0", "rev-2") });
    expect(second).toMatchObject({ changes: [{ previous_value: "Version: rev-1" }] });

    const both = delta(
      after([
        text(1, "Version: rev-0", "Version: rev-1"),
        text(2, "Version: rev-1", "Version: rev-2"),
      ]),
    );
    expect(both).toMatchObject({
      text: VOM.replaceAll("rev-0", "rev-2"),
      changes: [{ previous_value: "Version: rev-0", value: "Version: rev-2", lines: [6, 9] }],
    });
    expect(both).toMatchObject({ lines: [{ line: 6 }, { line: 9 }] });
  });

  it("refuses activity no frame logged, and reports a text put back as no change", () => {
    expect(delta(after([]))).toBe("unlogged_activity");
    expect(
      delta(
        after([
          text(1, "Version: rev-0", "Version: rev-1"),
          text(2, "Version: rev-1", "Version: rev-0"),
        ]),
      ),
    ).toMatchObject({ lines: [], changes: [], text: VOM });
  });

  it("accepts a focus move only when no focus style can show or hide content", () => {
    const moved = { focus: "5", focusIsDocument: false };
    const changed = [text(1, "Version: rev-0", "Version: rev-1")];
    expect(delta(after(changed, moved))).toMatchObject({ focusMoved: true });
    expect(delta(after(changed, { ...moved, focusNeutral: false }))).toBe("focus_changed");
    expect(
      textDelta(held, undefined, frames(frame({ focusNeutral: false })), after(changed, moved)),
    ).toBe("focus_changed");
  });

  it.each([
    ["no_held_text", () => textDelta(undefined, undefined, frames(frame()), after([]))],
    ["token_budget_changed", () => delta(after([]), held, 1000)],
    ["document_replaced", () => delta(after([], { document: "other" }))],
    ["document_replaced", () => delta(frames(frame(), frame()))],
    [
      "multiple_frames",
      () => textDelta(held, undefined, frames(frame(), frame()), frames(frame(), frame())),
    ],
    // A real DOM change: a batch that was not only text.
    ["structure_changed", () => delta(after([], { structure: 1 }))],
    ["human_activity", () => delta(after([], { human: 1 }))],
    ["fields_changed", () => delta(after([], { fields: [{ label: "City", value: "Oslo" }] }))],
    // The bounded log dropped a replacement this agent never saw.
    [
      "text_log_gap",
      () => delta(after([text(3, "a", "b")], { textual: 3, structure: 3, textFloor: 2 })),
    ],
    // Hidden, or beyond where the observation was cut.
    ["text_outside_observation", () => delta(after([text(1, "Hidden: 1", "Hidden: 2")]))],
    // The same words on a line that is not the text or its ancestor.
    [
      "text_ambiguous",
      () =>
        delta(after([text(1, "Total: 5", "Total: 6")]), {
          ...held,
          text: `${VOM}\n      StaticText "Total: 5"`,
        }),
    ],
    // A control's name: its ref keeps that name.
    ["text_ambiguous", () => delta(after([text(1, "Refresh", "Reload")]))],
    ["text_names_other_content", () => delta(after([text(1, "Open rev-9", "Open rev-10")]))],
    // A label cut at 80 characters ends inside the text.
    [
      "text_cut_by_truncation",
      () => delta(after([text(1, "Shipment status: late", "Shipment arrived")])),
    ],
  ] as const)("refuses with %s", (reason, run) => {
    expect(run()).toBe(reason);
  });

  it("keeps a truncated observation cut at the same line", () => {
    const cut = { ...held, truncated: true, maxTokens: 200 };
    expect(delta(after([text(1, "Version: rev-0", "Version: rev-1")]), cut, 200)).toMatchObject({
      lines: [{ line: 6 }, { line: 9 }],
    });
    expect(
      delta(
        after([text(1, "Version: rev-0", "Version: rev-0 and then a good deal more to read")]),
        cut,
        200,
      ),
    ).toBe("token_budget_shift");
    // Untruncated text may grow while it stays inside the budget.
    const grown = [text(1, "Version: rev-0", "Version: rev-0 and then a good deal more to read")];
    expect(delta(after(grown), { ...held, maxTokens: 5000 }, 5000)).toMatchObject({
      lines: [{ line: 6 }, { line: 9 }],
    });
    expect(delta(after(grown), { ...held, maxTokens: 120 }, 120)).toBe("token_budget_shift");
  });
});
