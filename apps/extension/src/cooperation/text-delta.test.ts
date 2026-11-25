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
    // A derived name is cut at 240 characters without a mark.
    [
      "text_names_other_content",
      () => delta(after([text(1, "Version: rev-0", `Version: ${"x".repeat(240)}`)])),
    ],
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

  it("uses structured VomLineMetadata so placeholder attributes and landmark names containing 'canvas ' are classified accurately", () => {
    const trickyVom = [
      "@vom 1",
      "@view 1280x720",
      "@layers 1 focus=L1",
      "L1 page",
      '  RootWebArea "Studio"',
      '    @e1 textbox placeholder="Version: rev-0"',
      '    banner "Paint on canvas Version: rev-0"',
      '      StaticText "Paint on canvas Version: rev-0"',
    ].join("\n");
    const trickyHeld: HeldText = { text: trickyVom, truncated: false };

    // A landmark whose label happens to contain `canvas ` is NOT a `[visual:screenshot]` canvas line;
    // structured VOM metadata patches both the landmark's derived name and its StaticText cleanly.
    const res = delta(
      after([text(1, "Paint on canvas Version: rev-0", "Paint on canvas Version: rev-1")]),
      trickyHeld,
    );
    expect(res).toMatchObject({
      lines: [
        {
          line: 7,
          previous: '    banner "Paint on canvas Version: rev-0"',
          text: '    banner "Paint on canvas Version: rev-1"',
        },
        {
          line: 8,
          previous: '      StaticText "Paint on canvas Version: rev-0"',
          text: '      StaticText "Paint on canvas Version: rev-1"',
        },
      ],
    });

    // Meanwhile, an unnamed textbox with `placeholder="Version: rev-0"` has no quoted node name
    // or StaticText line, so changing `"Version: rev-0"` refuses rather than mutating placeholder attributes.
    expect(
      delta(after([text(1, "Version: rev-0", "Version: rev-1")]), {
        text: [
          "@vom 1",
          "@view 1280x720",
          "@layers 1 focus=L1",
          "L1 page",
          '  RootWebArea "Studio"',
          '    @e1 textbox placeholder="Version: rev-0"',
        ].join("\n"),
        truncated: false,
      }),
    ).toBe("text_ambiguous");
  });

  it("replaces only inside the quoted name segment when UI text matches or overlaps role names", () => {
    const roleOverlapVom = [
      "@vom 1",
      "@view 1280x720",
      "@layers 1 focus=L1",
      "L1 page",
      '  RootWebArea "App"',
      '    status "Current status"',
      '      StaticText "Current"',
      '      status "status"',
      '    status "Ready"',
      '    timer "time"',
      '    main "Orders"',
      '      StaticText "main"',
    ].join("\n");

    const statusRes = delta(after([text(1, "status", "Saved")]), {
      text: roleOverlapVom,
      truncated: false,
    });
    expect(statusRes).toMatchObject({
      lines: [
        {
          line: 6,
          previous: '    status "Current status"',
          text: '    status "Current Saved"',
        },
        {
          line: 8,
          previous: '      status "status"',
          text: '      status "Saved"',
        },
      ],
    });
    if (typeof statusRes === "string") throw new Error(statusRes);
    expect(statusRes.text).toContain('    status "Ready"');
    expect(statusRes.text).not.toContain('Saved "status"');

    const timerRes = delta(after([text(1, "time", "00:01")]), {
      text: roleOverlapVom,
      truncated: false,
    });
    expect(timerRes).toMatchObject({
      lines: [
        {
          line: 10,
          previous: '    timer "time"',
          text: '    timer "00:01"',
        },
      ],
    });
    if (typeof timerRes === "string") throw new Error(timerRes);
    expect(timerRes.text).not.toContain('00:01r "time"');

    // Sibling/ancestor role name `main` must not cause false hit when `StaticText "main"` updates.
    const mainRes = delta(after([text(1, "main", "home")]), {
      text: roleOverlapVom,
      truncated: false,
    });
    expect(mainRes).toMatchObject({
      lines: [
        {
          line: 12,
          previous: '      StaticText "main"',
          text: '      StaticText "home"',
        },
      ],
    });
    if (typeof mainRes === "string") throw new Error(mainRes);
    expect(mainRes.text).toContain('    main "Orders"');

    // Escaped quotes and `$&` replacement patterns stay properly escaped inside quotes.
    const escapedVom = [
      "@vom 1",
      "@view 1280x720",
      "@layers 1 focus=L1",
      "L1 page",
      '  RootWebArea "App"',
      '    status "status \\"v1\\""',
    ].join("\n");
    const escapedRes = delta(after([text(1, 'status "v1"', 'Saved "$&"')]), {
      text: escapedVom,
      truncated: false,
    });
    expect(escapedRes).toMatchObject({
      lines: [
        {
          line: 6,
          previous: '    status "status \\"v1\\""',
          text: '    status "Saved \\"$&\\""',
        },
      ],
    });
  });

  it("refuses to patch when the changed text also appears in an active-scope block or clears to empty", () => {
    const scopeVom = [
      "@vom 1",
      "@view 1280x720",
      "@layers 1 focus=L1",
      "L1 page",
      '  RootWebArea "Shop"',
      '    @e1 button "Products" [expanded]',
      "      [§ active: Products]",
      "        Shoes Bags",
      '    StaticText "Shoes"',
    ].join("\n");
    expect(delta(after([text(1, "Shoes", "Boots")]), { text: scopeVom, truncated: false })).toBe(
      "text_ambiguous",
    );
    // Unescaped quotes inside active-scope lines must also block patching instead of going stale.
    const quotedScopeVom = [
      "@vom 1",
      "@view 1280x720",
      "@layers 1 focus=L1",
      "L1 page",
      '  RootWebArea "Orders"',
      '    @e1 button "Details" [expanded]',
      "      [§ active: Details]",
      '        Order "A" pending',
      '    StaticText "Order \\"A\\" pending"',
    ].join("\n");
    expect(
      delta(after([text(1, 'Order "A" pending', 'Order "A" shipped')]), {
        text: quotedScopeVom,
        truncated: false,
      }),
    ).toBe("text_ambiguous");
    // Active-scope body lines silently clip at 160 chars without an ellipsis; edits within
    // that clipped prefix must refuse with text_cut_by_truncation instead of going stale.
    const longBefore = `Alpha ${"x".repeat(170)}`;
    const longAfter = `Beta ${"x".repeat(170)}`;
    const truncatedScopeVom = [
      "@vom 1",
      "@view 1280x720",
      "@layers 1 focus=L1",
      "L1 page",
      '  RootWebArea "Orders"',
      '    @e1 button "Details" [expanded]',
      "      [§ active: Details]",
      `        ${longBefore.slice(0, 160)}`,
      `    StaticText "${longBefore}"`,
    ].join("\n");
    expect(
      delta(after([text(1, longBefore, longAfter)]), {
        text: truncatedScopeVom,
        truncated: false,
      }),
    ).toBe("text_cut_by_truncation");
    expect(delta(after([text(1, "Total: 5", "")]), held)).toBe("structure_changed");
  });
});
