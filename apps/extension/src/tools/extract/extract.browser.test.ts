// @vitest-environment node
// Opt in with BSK_CLICK_CHROME. Owns its browser, profile and local fixture server.
// Runs the collector exactly as handleExtract sends it: its source text, in an
// isolated world, followed by the same normalizer and byte budget.
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectExtractDom } from "./collector";
import { fitExtractBudget, normalizeExtract } from "./normalize";
import type { ExtractParams, ExtractResult, RawCapture } from "./types";
import { ExtractionFailure, validateExtract } from "./validation";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type Outcome = { result?: ExtractResult; error?: string };

const range = (count: number) => Array.from({ length: count }, (_, index) => index);
const plainTable = (rows: number, columns: number) =>
  `<div><div><table id="t"><thead><tr>${range(columns)
    .map((column) => `<th>H${column}</th>`)
    .join("")}</tr></thead><tbody>${range(rows)
    .map(
      (row) =>
        `<tr>${range(columns)
          .map((column) => `<td>${row}.${column}</td>`)
          .join("")}</tr>`,
    )
    .join("")}</tbody></table></div></div>`;
// Pinned columns rendered container-major: every left fragment, then every
// centre fragment for the same aria-rowindex.
const pinnedGrid = (rows: number, left: (row: number) => string, centre: (row: number) => string) =>
  `<div id="g" role="grid" aria-rowcount="${rows + 1}">
    <div role="rowgroup"><div role="row" aria-rowindex="1"><span role="columnheader" aria-colindex="1">Symbol</span></div></div>
    <div role="rowgroup"><div role="row" aria-rowindex="1"><span role="columnheader" aria-colindex="2">Price</span><span role="columnheader" aria-colindex="3">Change</span></div></div>
    <div role="rowgroup">${range(rows)
      .map(
        (row) =>
          `<div role="row" aria-rowindex="${row + 2}"><span role="gridcell" aria-colindex="1">${left(row)}</span></div>`,
      )
      .join("")}</div>
    <div role="rowgroup">${range(rows)
      .map(
        (row) =>
          `<div role="row" aria-rowindex="${row + 2}"><span role="gridcell" aria-colindex="2">${centre(row)}</span><span role="gridcell" aria-colindex="3">+${row}%</span></div>`,
      )
      .join("")}</div>
  </div>`;
const cells = (body: string) =>
  `<table id="t"><thead><tr>${"<th>H</th>".repeat(8)}</tr></thead><tbody><tr>${body}</tr></tbody></table>`;
const values = (outcome: Outcome) =>
  outcome.result!.rows.map((row) => outcome.result!.columns.map((column) => row[column.key]));

const fixtures: Record<string, string> = {
  contentVisibility: `<table id="t"><tr><td>Visible<div style="content-visibility: hidden"><span style="content-visibility: visible; visibility: visible">Hidden text</span></div></td><td><div style="content-visibility: auto; position: absolute; top: 100000px">Offscreen text</div></td></tr></table>
    <div style="content-visibility: hidden"><table id="hiddenTable"><tr><td>Hidden table</td></tr></table><ul id="hiddenList"><li>Hidden item</li></ul></div>
    <ul id="l"><li>Visible item<div style="content-visibility: hidden"><a href="/hidden">Hidden link</a></div></li></ul>`,
  ignoredContentVisibility: `<table id="t" style="content-visibility: hidden"><caption style="content-visibility: hidden">Caption</caption><tbody style="content-visibility: hidden"><tr style="content-visibility: hidden"><td><span style="content-visibility: hidden">Inline text</span><div style="display: contents; content-visibility: hidden">Contents text</div></td><td><span style="display: inline list-item; content-visibility: hidden">Inline item</span></td><td style="content-visibility: hidden">Hidden cell</td></tr></tbody></table>`,
  rows1000: plainTable(1000, 3),
  wide: plainTable(600, 100),
  template: cells(`<td>
        John
        Smith
    </td><td>
        <span class="badge">
          Shipped
        </span>
        on
        <time>2026-10-01</time>
    </td>`),
  blocks: cells(
    "<td><div><h4>Wireless Mouse</h4><small>SKU-1</small></div></td><td><dl><dt>Status</dt><dd>Paid</dd></dl></td>",
  ),
  slot: `${cells("<td><x-cell>Alice</x-cell></td>")}<script>
    customElements.define("x-cell", class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<span><slot></slot></span>'; }
    });</script>`,
  unrendered: cells(
    '<td><svg width="10" height="10"><title>Verified</title><desc>check icon</desc><circle r="4" cx="5" cy="5"/><text x="0" y="9">✓</text></svg>Alice</td><td><details><summary>More</summary>Secret body</details></td>',
  ),
  controls: `${cells(
    '<td><select><option>Pending</option><option selected>Shipped</option></select></td><td><input value="42"></td><td><textarea>old</textarea></td><td><input type="password" value="hunter2">x</td>',
  )}<script>document.querySelector("textarea").value = "edited";</script>`,
  indented: `<table id="t"><tr>${"<th>H</th>".repeat(5)}</tr>${range(500)
    .map(
      (row) =>
        `<tr id="r${row}">${range(5)
          .map(() => `<td>\n${" ".repeat(200)}v${row}\n${" ".repeat(200)}</td>`)
          .join("")}</tr>`,
    )
    .join("")}</table>`,
  theadCells:
    '<table id="t"><thead><tr><td>Order</td><td>Amount</td></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  lenientSpans:
    '<table id="t"><tr><th>A</th><th>B</th><th>C</th></tr><tr><td colspan="">1</td><td colspan="2 ">2</td></tr><tr><td colspan="0">x</td><td rowspan="2px">y</td><td>z</td></tr></table>',
  ariaOrder:
    '<div id="g" role="treegrid"><div role="row" aria-rowindex="1"><span role="columnheader" aria-colindex="1">A</span></div><div role="row" aria-rowindex="3"><span role="gridcell" aria-colindex="1">r3</span></div><div role="row" aria-rowindex="2"><span role="gridcell" aria-colindex="1">r2</span></div></div>',
  nativeRecycled:
    '<table id="t" aria-rowcount="3"><thead><tr aria-rowindex="1"><th>A</th></tr></thead><tbody><tr aria-rowindex="3"><td>k</td></tr><tr aria-rowindex="2"><td>j</td></tr></tbody></table>',
  listRecycled:
    '<ul id="l"><li aria-posinset="2" aria-setsize="2">second</li><li aria-posinset="1" aria-setsize="2">first</li></ul>',
  invalidAria:
    '<div id="g" role="grid"><div role="row" aria-rowindex=""><span role="columnheader" aria-colindex="first">A</span></div><div role="row" aria-rowindex="2"><span role="gridcell">1</span></div></div><ul id="l"><li aria-setsize="unknown" aria-posinset="x">a</li></ul>',
  pinned: pinnedGrid(
    20,
    (row) => `SYM${row}`,
    (row) => `${100 + row}.00`,
  ),
  pinnedBudget: pinnedGrid(
    300,
    (row) => `S${row}`,
    (row) => `price-${String(row).padStart(5, "0")}`,
  ),
  hiddenRow:
    '<table id="t"><tr><th>A</th></tr><tr><td>1</td></tr><tr style="display:none"><td>detail</td></tr><tr><td>2</td></tr></table>',
  discovery: `${range(40)
    .map((index) => `<ul><li><a href="/n${index}">nav ${index}</a></li></ul>`)
    .join(
      "",
    )}<table aria-label="Scores"><thead><tr><th>Team</th><th>Pts</th></tr></thead><tbody><tr><th scope="row">Lions</th><td>3</td></tr><tr><th>Tigers</th><td>1</td></tr></tbody></table>`,
  layout:
    '<table role="presentation"><tr><td>layout</td></tr></table><table><tr><th>A</th></tr><tr><td>1</td></tr></table>',
};

describe.skipIf(!process.env.BSK_CLICK_CHROME)("real browser structured extraction", () => {
  let extract: (fixture: string, params: Omit<ExtractParams, "session_id">) => Promise<Outcome>;
  let finish: () => Promise<void>;

  beforeAll(async () => {
    const { withChrome } = await import(
      new URL(
        "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      const name = new URL(request.url ?? "/", "http://fixture").pathname.slice(1);
      response.end(`<!doctype html><title>${name}</title><body>${fixtures[name] ?? ""}</body>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let release!: () => void;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const browser = withChrome(
      { executable: process.env.BSK_CLICK_CHROME, deviceScale: 1, zoom: 1, startupTimeout: 30_000 },
      async (send: Send) => {
        const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
          url: "about:blank",
        });
        const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const local: Send = (method, params) => send(method, params, sessionId);
        await local("Page.enable");
        extract = async (fixture, params) => {
          await local("Page.navigate", { url: `${origin}/${fixture}` });
          await expect
            .poll(async () => {
              const reply = await local<{ result: { value: string } }>("Runtime.evaluate", {
                expression: "document.readyState === 'complete' && document.title",
                returnByValue: true,
              });
              return reply.result.value;
            })
            .toBe(fixture);
          const { frameTree } = await local<{ frameTree: { frame: { id: string } } }>(
            "Page.getFrameTree",
          );
          const world = await local<{ executionContextId: number }>("Page.createIsolatedWorld", {
            frameId: frameTree.frame.id,
            worldName: "bsk-extract",
          });
          const options = validateExtract({ session_id: "s", ...params });
          const reply = await local<{
            result: { value: RawCapture };
            exceptionDetails?: unknown;
          }>("Runtime.callFunctionOn", {
            executionContextId: world.executionContextId,
            functionDeclaration: collectExtractDom.toString(),
            arguments: [{ value: options }],
            returnByValue: true,
          });
          expect(reply.exceptionDetails).toBeUndefined();
          const raw = reply.result.value;
          if (raw.error) return { error: `${raw.error.reason}: ${raw.error.message}` };
          const source = {
            page_url: origin,
            frame_url: raw.frame_url,
            frame_id: frameTree.frame.id,
            title: raw.title,
            captured_at: raw.captured_at,
          };
          try {
            const result = fitExtractBudget(
              normalizeExtract(raw, options, 1, source),
              options.max_bytes,
            );
            if (options.action === "discover")
              result.targets = raw.targets.map((target) => ({
                target_id: "",
                kind: target.kind,
                name: target.name,
                columns: target.columns,
                frame_id: "",
                frame_url: "",
              }));
            return { result };
          } catch (error) {
            if (error instanceof ExtractionFailure)
              return { error: `${error.reason}: ${error.message}` };
            throw error;
          }
        };
        ready();
        await closed;
      },
    );
    finish = async () => {
      release();
      await browser;
      await new Promise((resolve) => server.close(resolve));
    };
    await Promise.race([started, browser]);
  }, 60_000);

  afterAll(async () => {
    await finish?.();
  });

  it("reaches the row cap for long and wide tables without row ids", async () => {
    for (const [fixture, columns] of [
      ["rows1000", 3],
      ["wide", 100],
    ] as const) {
      const { result } = await extract(fixture, { action: "table", selector: "#t" });
      expect(result!.rows).toHaveLength(500);
      expect(result!.columns).toHaveLength(columns);
      expect(result!.coverage.stop_reason).toBe("row_limit");
    }
  });

  it("returns rendered cell text", async () => {
    expect(values(await extract("template", { action: "table", selector: "#t" }))[0]).toEqual([
      "John Smith",
      "Shipped on 2026-10-01",
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(
      values(await extract("blocks", { action: "table", selector: "#t" }))[0].slice(0, 2),
    ).toEqual(["Wireless Mouse\nSKU-1", "Status\nPaid"]);
    expect(values(await extract("slot", { action: "table", selector: "#t" }))[0][0]).toBe("Alice");
    // SVG text still renders (as a block, matching innerText); title/desc and
    // closed details content do not.
    expect(
      values(await extract("unrendered", { action: "table", selector: "#t" }))[0].slice(0, 2),
    ).toEqual(["✓\nAlice", "More"]);
    expect(
      values(await extract("controls", { action: "table", selector: "#t" }))[0].slice(0, 4),
    ).toEqual(["Shipped", "42", "edited", "x"]);
  });

  it("omits content-visibility hidden text without dropping auto offscreen content", async () => {
    expect(values(await extract("contentVisibility", { action: "table", selector: "#t" }))).toEqual(
      [["Visible", "Offscreen text"]],
    );
    const list = await extract("contentVisibility", { action: "list", selector: "#l" });
    expect(list.result!.rows).toEqual([{ text: "Visible item", url: null }]);
  });

  it("does not discover or extract containers inside content-visibility hidden subtrees", async () => {
    const discovery = await extract("contentVisibility", { action: "discover" });
    expect(discovery.result!.targets!.map((target) => target.name)).toEqual(["t", "l"]);
    for (const [action, selector] of [
      ["table", "#hiddenTable"],
      ["list", "#hiddenList"],
    ] as const) {
      expect((await extract("contentVisibility", { action, selector })).error).toMatch(
        /^extract_target_hidden:/,
      );
    }
  });

  it("keeps text where content-visibility does not apply to the display type", async () => {
    expect(
      values(await extract("ignoredContentVisibility", { action: "table", selector: "#t" })),
    ).toEqual([["Inline textContents text", "Inline item", null]]);
    const discovery = await extract("ignoredContentVisibility", { action: "discover" });
    expect(discovery.result!.targets!.map((target) => target.name)).toEqual(["Caption"]);
  });

  it("charges the byte budget for emitted text, not template indentation", async () => {
    const { result } = await extract("indented", {
      action: "table",
      selector: "#t",
      max_bytes: 102_400,
    });
    expect(result!.rows).toHaveLength(500);
    expect(result!.coverage.truncated).toBe(false);
  });

  it("names columns from td headers and parses spans like the browser", async () => {
    const thead = await extract("theadCells", { action: "table", selector: "#t" });
    expect(thead.result!.columns.map((column) => column.name)).toEqual(["Order", "Amount"]);
    expect(values(await extract("lenientSpans", { action: "table", selector: "#t" }))).toEqual([
      ["1", "2", null],
      ["x", "y", "z"],
    ]);
  });

  it("sorts recycled rows and tolerates invalid ARIA positions", async () => {
    const grid = await extract("ariaOrder", { action: "table", selector: "#g" });
    expect(values(grid)).toEqual([["r2"], ["r3"]]);
    expect(grid.result!.warnings).toContain("aria_rows_reordered");
    expect(values(await extract("nativeRecycled", { action: "table", selector: "#t" }))).toEqual([
      ["j"],
      ["k"],
    ]);
    const list = await extract("listRecycled", { action: "list", selector: "#l" });
    expect(list.result!.rows.map((row) => row.text)).toEqual(["first", "second"]);
    expect(list.result!.row_sources.map((source) => source.source_row)).toEqual([1, 2]);
    const invalidGrid = await extract("invalidAria", { action: "table", selector: "#g" });
    expect(values(invalidGrid)).toEqual([["1"]]);
    expect(invalidGrid.result!.warnings).toEqual(
      expect.arrayContaining(["invalid_aria-rowindex", "invalid_aria-colindex"]),
    );
    const invalidList = await extract("invalidAria", { action: "list", selector: "#l" });
    expect(invalidList.result!.rows.map((row) => row.text)).toEqual(["a"]);
    expect(invalidList.result!.warnings).toEqual(
      expect.arrayContaining(["invalid_aria-setsize", "invalid_aria-posinset"]),
    );
  });

  it("keeps pinned-column rows whole under row and byte limits", async () => {
    const capped = await extract("pinned", { action: "table", selector: "#g", max_rows: 5 });
    expect(values(capped)).toEqual(
      range(5).map((row) => [`SYM${row}`, `${100 + row}.00`, `+${row}%`]),
    );
    expect(capped.result!.coverage.stop_reason).toBe("row_limit");
    const budget = await extract("pinnedBudget", {
      action: "table",
      selector: "#g",
      max_bytes: 4096,
    });
    expect(budget.result!.rows.length).toBeGreaterThan(0);
    expect(values(budget).flat()).not.toContain(null);
    expect(budget.result!.warnings).toContain("split_aria_rows_incomplete");
  });

  it("separates hidden rows from missing virtual rows", async () => {
    const { result } = await extract("hiddenRow", { action: "table", selector: "#t" });
    expect(values({ result })).toEqual([["1"], ["2"]]);
    expect(result!.warnings).toEqual(["hidden_rows_omitted"]);
    expect(result!.coverage.dataset_complete).toBe("unknown");
  });

  it("ranks tables first, previews column headers and skips layout tables", async () => {
    const { result } = await extract("discovery", { action: "discover" });
    expect(result!.targets![0]).toMatchObject({
      kind: "table",
      name: "Scores",
      columns: ["Team", "Pts"],
    });
    expect(result!.coverage.stop_reason).toBe("target_limit");
    expect(values(await extract("layout", { action: "table" }))).toEqual([["1"]]);
  });
});
