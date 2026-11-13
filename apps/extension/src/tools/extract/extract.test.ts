import { beforeEach, describe, expect, it } from "vitest";
import { collectExtractDom } from "./collector";
import { fitExtractBudget, normalizeExtract } from "./normalize";
import type { ExtractParams, RawCapture } from "./types";
import { validateExtract } from "./validation";

const orders = `<table id="orders">
  <thead><tr><th>订单号</th><th>客户</th><th>金额</th><th>状态</th><th>备注</th></tr></thead>
  <tbody>
    <tr id="order-1"><td>000123</td><td>张三</td><td>￥1,280.00</td><td>已支付</td><td>中文, "引号"<br>第二行</td></tr>
    <tr><td>000124</td><td>李四</td><td>￥88.50</td><td>待发货</td><td></td></tr>
    <tr><td>000125</td><td>王五</td><td>-12.00</td><td>已退款</td><td>=SUM(1,1)</td></tr>
    <tr hidden><td>SECRET-HIDDEN</td></tr>
  </tbody>
</table>`;
const grid = `<div id="virtual-grid" role="grid" aria-rowcount="101" aria-colcount="4">
  <div role="row" aria-rowindex="1"><span role="columnheader" aria-colindex="1">订单号</span><span role="columnheader" aria-colindex="2">金额</span><span role="columnheader" aria-colindex="4">状态</span></div>
  <div role="row" aria-rowindex="51"><span role="gridcell" aria-colindex="1">V-050</span><span role="gridcell" aria-colindex="2">100.00</span><span role="gridcell" aria-colindex="4">已支付</span></div>
  <div role="row" aria-rowindex="52"><span role="gridcell" aria-colindex="1">V-051</span><span role="gridcell" aria-colindex="2">200.00</span><span role="gridcell" aria-colindex="4">待支付</span></div>
</div>`;
const searchResults = `<div id="search-results">
  <article class="result"><h3><a href="/docs/extract">结构化提取指南</a></h3></article>
  <article class="result"><h3><a href="/docs/provenance">数据来源说明</a></h3></article>
</div>`;

function extract(
  selector: string | undefined,
  patch: Partial<ExtractParams> = {},
  context: Element = document.documentElement,
) {
  const options = validateExtract({
    session_id: "test",
    action: "table",
    ...(selector ? { selector } : {}),
    ...patch,
  });
  const raw = collectExtractDom.call(context, options);
  if (raw.error) throw new Error(`${raw.error.reason}: ${raw.error.message}`);
  return fitExtractBudget(
    normalizeExtract(raw, options, 7, {
      page_url: "https://example.com/orders",
      frame_url: raw.frame_url,
      title: raw.title,
      frame_id: "root",
      captured_at: raw.captured_at,
      ...(selector ? { selector } : {}),
    }),
    options.max_bytes,
  );
}
beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  // happy-dom ships no UA stylesheet, so `[hidden]` would not hide anything and
  // the collector would see a visible box where a browser sees none. Emulate the
  // one UA rule that matters, first in document order so author rules still win
  // exactly as they do in a browser.
  const ua = document.createElement("style");
  ua.textContent = "[hidden] { display: none; }";
  document.head.appendChild(ua);
});
describe("structured extraction facts", () => {
  it.each([
    { transform: "uppercase", value: "paid", expected: "PAID" },
    { transform: "lowercase", value: "PAID", expected: "paid" },
    { transform: "none", value: "PaId", expected: "PaId" },
  ])("applies text-transform: $transform to text nodes", ({ transform, value, expected }) => {
    document.body.innerHTML = `<table id="t"><tr><td style="text-transform:${transform}">${value}</td></tr></table>`;
    expect(extract("#t").rows).toEqual([{ c1: expected }]);
  });

  it("inherits CSS case transforms and respects nested overrides and line breaks", () => {
    document.head.innerHTML = `<style>
      #t { text-transform: uppercase; }
      #t em { text-transform: lowercase; }
      #t .literal { text-transform: none; }
    </style>`;
    document.body.innerHTML = `<table id="t"><thead><tr><th>status</th></tr></thead>
      <tbody><tr><td>pa<span>id</span><em>DONE</em><span class="literal">MiXeD</span><br>new  line</td></tr></tbody></table>`;
    const result = extract("#t");
    expect(result.columns[0].name).toBe("STATUS");
    expect(result.rows).toEqual([{ c1: "PAIDdoneMiXeD\nNEW LINE" }]);
  });

  it("transforms list text without changing attribute reads", () => {
    document.body.innerHTML = `<ul id="l" style="text-transform:uppercase"><li><span data-status="paid">paid</span></li></ul>`;
    const result = extract("#l", {
      action: "list",
      fields: [
        { key: "text", selector: "span", read: "text" },
        { key: "raw", selector: "span", read: "attribute", attribute: "data-status" },
      ],
    });
    expect(result.rows).toEqual([{ text: "PAID", raw: "paid" }]);
  });

  it.each([
    { language: "tr", transform: "uppercase", value: "iı", expected: "İI" },
    { language: "tr", transform: "lowercase", value: "Iİ", expected: "ıi" },
    { language: "de", transform: "uppercase", value: "straße", expected: "STRASSE" },
    { language: "invalid_tag", transform: "uppercase", value: "paid", expected: "PAID" },
  ])("uses $language case mappings for $transform", ({ language, transform, value, expected }) => {
    document.body.innerHTML = `<table id="t" lang="${language}"><tr><td style="text-transform:${transform}">${value}</td></tr></table>`;
    expect(extract("#t").rows).toEqual([{ c1: expected }]);
  });

  it("charges the byte budget for transformed Unicode text", () => {
    const options = validateExtract({
      session_id: "test",
      action: "table",
      selector: "#t",
      max_bytes: 1024,
    });
    for (const transform of ["none", "uppercase"]) {
      document.body.innerHTML = `<table id="t"><tr><td style="text-transform:${transform}">${"ŉ".repeat(400)}</td></tr></table>`;
      const raw = collectExtractDom.call(document.documentElement, options);
      if (transform === "none") expect(raw.error).toBeUndefined();
      else
        expect(raw.error).toMatchObject({
          reason: "extract_limit",
          message: "Text byte budget exceeded",
        });
    }
  });

  it.each(["hidden", "auto", "visible"])("respects content-visibility: %s", (visibility) => {
    document.body.innerHTML = `<table id="t"><tr><td>Visible<div style="content-visibility: ${visibility}"><span style="content-visibility: visible; visibility: visible">Extra</span></div></td></tr></table>`;
    expect(extract("#t").rows).toEqual([
      { c1: visibility === "hidden" ? "Visible" : "Visible\nExtra" },
    ]);
  });

  it("preserves identifiers, currency, multiline text, empty cells and row provenance", () => {
    document.body.innerHTML = orders;
    const result = extract("#orders");
    expect(result.columns.map((column) => column.name)).toEqual([
      "订单号",
      "客户",
      "金额",
      "状态",
      "备注",
    ]);
    expect(result.rows).toEqual([
      { c1: "000123", c2: "张三", c3: "￥1,280.00", c4: "已支付", c5: '中文, "引号"\n第二行' },
      { c1: "000124", c2: "李四", c3: "￥88.50", c4: "待发货", c5: "" },
      { c1: "000125", c2: "王五", c3: "-12.00", c4: "已退款", c5: "=SUM(1,1)" },
    ]);
    expect(result.row_sources[0]).toMatchObject({
      row: 0,
      source_row: 2,
      row_kind: "data",
      locator: "#order-1",
    });
    expect(result.coverage).toMatchObject({ truncated: false, dataset_complete: "unknown" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("associates multilevel column headers and retains row headers as data", () => {
    document.body.innerHTML = `<table id="financial">
      <thead><tr><th rowspan="2">地区</th><th colspan="2" scope="colgroup">营收</th><th rowspan="2">订单数</th></tr><tr><th>本月</th><th>上月</th></tr></thead>
      <tbody><tr><th scope="row">华东</th><td>12,000</td><td>10,500</td><td>80</td></tr></tbody>
    </table>`;
    const result = extract("#financial");
    expect(result.columns.map((column) => column.header_path)).toEqual([
      ["地区"],
      ["营收", "本月"],
      ["营收", "上月"],
      ["订单数"],
    ]);
    expect(result.rows[0]).toEqual({ c1: "华东", c2: "12,000", c3: "10,500", c4: "80" });
  });
  it("retains merged cell anchors and spans without multiplying values", () => {
    document.body.innerHTML = `<table id="merged">
      <thead><tr><th>订单</th><th>商品</th><th>数量</th></tr></thead>
      <tbody><tr><td rowspan="2">A-001</td><td>键盘</td><td>1</td></tr><tr><td>鼠标</td><td>2</td></tr><tr><td>A-002</td><td colspan="2">取消，未计费</td></tr></tbody>
      <tfoot><tr><th scope="row">汇总</th><td></td><td>3</td></tr></tfoot>
    </table>`;
    const result = extract("#merged");
    expect(result.rows).toEqual([
      { c1: "A-001", c2: "键盘", c3: "1" },
      { c1: null, c2: "鼠标", c3: "2" },
      { c1: "A-002", c2: "取消，未计费", c3: null },
      { c1: "汇总", c2: "", c3: "3" },
    ]);
    expect(result.spans).toEqual([
      { row: 0, column: "c1", row_span: 2, column_span: 1 },
      { row: 2, column: "c2", row_span: 1, column_span: 2 },
    ]);
    expect(result.row_sources[3].row_kind).toBe("footer");
  });
  it("does not mix nested table rows or text into the outer table", () => {
    document.body.innerHTML = `<table id="nested"><thead><tr><th>名称</th><th>说明</th></tr></thead>
      <tbody><tr><td>组合套餐</td><td>配件如下<table id="inner"><thead><tr><th>SKU</th><th>数量</th></tr></thead><tbody><tr><td>SKU-1</td><td>2</td></tr></tbody></table></td></tr></tbody>
    </table>`;
    expect(extract("#nested").rows).toEqual([{ c1: "组合套餐", c2: "配件如下" }]);
    expect(extract("#inner").rows).toEqual([{ c1: "SKU-1", c2: "2" }]);
  });
  it("keeps duplicate names distinct and does not consume the first headerless data row", () => {
    document.body.innerHTML = `<table id="duplicate-headers"><thead><tr><th>标签</th><th>标签</th><th></th></tr></thead><tbody><tr><td>甲</td><td>乙</td><td>丙</td></tr></tbody></table>
      <table id="no-headers"><tr><td>第一条</td><td>001</td></tr><tr><td>第二条</td><td>002</td></tr></table>`;
    expect(
      extract("#duplicate-headers").columns.map((column) => [column.key, column.name]),
    ).toEqual([
      ["c1", "标签"],
      ["c2", "标签"],
      ["c3", "Column 3"],
    ]);
    expect(extract("#no-headers").rows).toEqual([
      { c1: "第一条", c2: "001" },
      { c1: "第二条", c2: "002" },
    ]);
    expect(extract("#no-headers").warnings).toContain("generated_column_names");
  });
  it("preserves ARIA gaps and reports partial data even without output truncation", () => {
    document.body.innerHTML = grid;
    const result = extract("#virtual-grid");
    expect(result.rows).toEqual([
      { c1: "V-050", c2: "100.00", c3: null, c4: "已支付" },
      { c1: "V-051", c2: "200.00", c3: null, c4: "待支付" },
    ]);
    expect(result.row_sources.map((row) => row.source_row)).toEqual([51, 52]);
    expect(result.coverage).toMatchObject({
      truncated: false,
      dataset_complete: "incomplete",
      declared_rows: 101,
      declared_columns: 4,
    });
  });
  it("returns a valid zero-row table with its columns", () => {
    document.body.innerHTML =
      '<table id="empty"><thead><tr><th>编号</th><th>状态</th></tr></thead><tbody></tbody></table>';
    const result = extract("#empty");
    expect(result.rows).toEqual([]);
    expect(result.columns.map((column) => column.name)).toEqual(["编号", "状态"]);
  });
  it("extracts scoped list fields with URLs and missing values", () => {
    document.body.innerHTML = searchResults;
    const result = extract("#search-results", {
      action: "list",
      item_selector: ".result",
      fields: [
        { key: "title", selector: "h3", read: "text" },
        { key: "url", selector: "a", read: "href" },
        { key: "missing", selector: ".missing", read: "text" },
      ],
    });
    expect(result.rows[0]).toEqual({
      title: "结构化提取指南",
      url: new URL("/docs/extract", document.baseURI).href,
      missing: null,
    });
    expect(result.rows).toHaveLength(2);
  });
  it("extracts a simple semantic list without a field schema", () => {
    document.body.innerHTML =
      '<ul id="news-links"><li><a href="/news/one">第一条消息</a></li><li><a href="/news/two">第二条消息</a></li></ul>';
    const result = extract("#news-links", { action: "list" });
    expect(result.columns.map((column) => column.key)).toEqual(["text", "url"]);
    expect(result.rows.map((row) => row.text)).toEqual(["第一条消息", "第二条消息"]);
  });
  it("reports a row cap with complete records", () => {
    document.body.innerHTML = orders;
    const result = extract("#orders", { max_rows: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.coverage).toMatchObject({ truncated: true, stop_reason: "row_limit" });
  });
  it("rejects missing, ambiguous, hidden and invalid targets", () => {
    document.body.innerHTML =
      '<table id="one"></table><table id="two"></table><table id="hidden-table" hidden></table>';
    expect(() => extract("#missing")).toThrow("selector_not_found");
    expect(() => extract("table")).toThrow("extract_target_ambiguous");
    expect(() => extract("#hidden-table")).toThrow("extract_target_hidden");
    expect(() => extract("[")).toThrow("extract_selector_invalid");
  });
  it("rejects ambiguous fields instead of silently selecting the first match", () => {
    document.body.innerHTML = searchResults;
    document
      .querySelector(".result")!
      .insertAdjacentHTML("beforeend", '<a href="/duplicate">Duplicate</a>');
    expect(() =>
      extract("#search-results", {
        action: "list",
        item_selector: ".result",
        fields: [{ key: "url", selector: "a", read: "href" }],
      }),
    ).toThrow("extract_field_ambiguous");
  });
  it("discovers DOM and open shadow containers without exposing hidden or overlay contents", () => {
    document.body.innerHTML =
      '<div id="shadow-host"></div><table id="hidden-table" hidden><tr><td>SECRET</td></tr></table>';
    const shadow = document.querySelector("#shadow-host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<table id="shadow-table"><tr><th>Shadow</th></tr></table>';
    document.body.insertAdjacentHTML(
      "beforeend",
      "<browser-skill-overlay><ul><li>SECRET-OVERLAY</li></ul></browser-skill-overlay>",
    );
    const options = validateExtract({ session_id: "test", action: "discover" });
    const raw = collectExtractDom.call(document.documentElement, options);
    expect(raw.error).toBeUndefined();
    const names = raw.targets.map((target) => target.name);
    expect(names).toContain("shadow-table");
    expect(names).not.toContain("hidden-table");
    expect(names).not.toContain("ul");
  });
  it("interprets rowspan=0 within its own row group", () => {
    document.body.innerHTML =
      '<table id="zero"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td rowspan="0">Group</td><td>1</td></tr><tr><td>2</td></tr></tbody><tbody><tr><td>Next</td><td>3</td></tr></tbody></table>';
    const result = extract("#zero");
    expect(result.rows).toEqual([
      { c1: "Group", c2: "1" },
      { c1: null, c2: "2" },
      { c1: "Next", c2: "3" },
    ]);
    expect(result.spans).toEqual([{ row: 0, column: "c1", row_span: 2, column_span: 1 }]);
  });
  it("honors explicit header associations", () => {
    document.body.innerHTML =
      '<table id="ids"><thead><tr><th id="a">A</th><th id="b">B</th></tr></thead><tbody><tr><td headers="b">B value</td><td headers="a">A value</td></tr></tbody></table>';
    expect(extract("#ids").columns.map((column) => column.name)).toEqual(["B", "A"]);
  });
  it("enforces logical column limits and invalid ARIA overlap", () => {
    document.body.innerHTML = orders;
    expect(() => extract("#orders", { max_columns: 2 })).toThrow("extract_limit");
    document.body.innerHTML = grid;
    document
      .querySelector('#virtual-grid [aria-rowindex="51"] [aria-colindex="2"]')!
      .setAttribute("aria-colindex", "1");
    expect(() => extract("#virtual-grid")).toThrow("Overlapping");
  });
  it("includes provenance in the byte budget and never emits partial JSON/rows", () => {
    document.body.innerHTML =
      '<table id="budget"><tr><th>A</th></tr>' +
      Array.from({ length: 30 }, (_, i) => `<tr><td>${i} ${"中文".repeat(20)}</td></tr>`).join("") +
      "</table>";
    const result = extract("#budget", { max_bytes: 2048 });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(30);
    expect(result.row_sources).toHaveLength(result.rows.length);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(2048);
    expect(result.coverage.truncated).toBe(true);
    expect(result.coverage.dataset_complete).toBe("incomplete");
  });
  it("tracks virtual list positions and excludes nested list items", () => {
    document.body.innerHTML =
      '<ul id="virtual"><li aria-posinset="51" aria-setsize="100">One</li><li aria-posinset="52" aria-setsize="100">Two</li></ul>';
    const result = extract("#virtual", { action: "list" });
    expect(result.row_sources.map((row) => row.source_row)).toEqual([51, 52]);
    expect(result.coverage).toMatchObject({ dataset_complete: "incomplete", declared_rows: 100 });
    document.body.innerHTML =
      '<ul id="outer"><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>';
    expect(extract("#outer", { action: "list" }).row_sources.map((row) => row.source_row)).toEqual([
      1, 2,
    ]);
  });
  it("rejects oversized first-cell text or metadata without returning a partial row", () => {
    document.body.innerHTML = '<table id="huge"><tr><td>' + "x".repeat(5000) + "</td></tr></table>";
    expect(() => extract("#huge", { max_bytes: 1024 })).toThrow("Text byte budget");
    document.body.innerHTML =
      '<table id="huge"><tr id="' + "x".repeat(3000) + '"><td>Value</td></tr></table>';
    expect(() => extract("#huge")).toThrow("Locator ID");
  });
  it("bounds caller parameters and disallows duplicate/reserved field keys", () => {
    for (const patch of [
      { max_rows: 0 },
      { max_columns: 201 },
      { max_bytes: 10 },
      { timeout_ms: Infinity },
      { selector: "#a", target_id: "xt_test" },
      { action: "list", fields: [{ key: "__proto__", selector: "a", read: "text" }] },
      {
        action: "list",
        fields: [
          { key: "x", selector: "a", read: "text" },
          { key: "x", selector: "b", read: "text" },
        ],
      },
    ])
      expect(() =>
        validateExtract({ session_id: "test", action: "table", ...patch } as ExtractParams),
      ).toThrow();
  });
  it("omits sensitive autocomplete and former-password input values from extracted tables and lists", () => {
    document.body.innerHTML = `<table id="pay">
      <tr><th>字段</th><th>值</th></tr>
      <tr><td>验证码</td><td><input type="text" autocomplete="one-time-code" value="482913">ok</td></tr>
      <tr><td>卡号</td><td><input type="text" autocomplete="billing cc-number" value="4111111111111111"></td></tr>
      <tr><td>密码</td><td><input type="text" data-bsk-record-password="" value="BSK_SYNTHETIC_PASSWORD"></td></tr>
    </table>
    <ul id="items">
      <li><input class="secret" type="text" autocomplete="section-login current-password" value="hunter2"><span class="name">Alice</span></li>
    </ul>`;
    const tableResult = extract("#pay");
    expect(tableResult.rows).toEqual([
      { c1: "验证码", c2: "ok" },
      { c1: "卡号", c2: "" },
      { c1: "密码", c2: "" },
    ]);
    expect(JSON.stringify(tableResult)).not.toMatch(
      /482913|4111111111111111|BSK_SYNTHETIC_PASSWORD/,
    );

    const listResult = extract("#items", {
      action: "list",
      fields: [
        { key: "secret", selector: ".secret", read: "attribute", attribute: "value" },
        { key: "name", selector: ".name", read: "text" },
      ],
    });
    expect(listResult.rows).toEqual([{ secret: null, name: "Alice" }]);
    expect(JSON.stringify(listResult)).not.toContain("hunter2");
  });

  it("distinguishes an empty dataset from unknown completeness", () => {
    const options = validateExtract({ session_id: "test", action: "table" });
    const raw: RawCapture = {
      frame_url: "about:blank",
      title: "",
      captured_at: "now",
      rows: [],
      items: [],
      item_sources: [],
      targets: [],
      truncated: false,
      warnings: [],
    };
    expect(
      normalizeExtract(raw, options, 7, {
        page_url: "",
        frame_url: "",
        frame_id: "root",
        title: "",
        captured_at: "now",
      }).coverage.dataset_complete,
    ).toBe("unknown");
  });

  it("extracts a target that author CSS made visible despite hidden", () => {
    document.body.innerHTML =
      '<table id="t" hidden style="display:table"><tr><td>Inline</td></tr></table>';
    expect(extract("#t").rows).toEqual([{ c1: "Inline" }]);

    document.body.innerHTML =
      '<style>#t { display: table; }</style><table id="t" hidden><tr><td>Sheet</td></tr></table>';
    expect(extract("#t").rows).toEqual([{ c1: "Sheet" }]);

    document.body.innerHTML = '<table id="t" hidden><tr><td>Secret</td></tr></table>';
    expect(() => extract("#t")).toThrow("extract_target_hidden");
  });

  it("extracts content under a hidden ancestor that author CSS made visible", () => {
    document.body.innerHTML =
      '<style>#host { display: block; }</style><div id="host" hidden><table id="t"><tr><td>Visible</td></tr></table></div>';
    expect(extract("#t").rows).toEqual([{ c1: "Visible" }]);

    document.body.innerHTML =
      '<div id="host" hidden><table id="t"><tr><td>Secret</td></tr></table></div>';
    expect(() => extract("#t")).toThrow("extract_target_hidden");
  });

  it("extracts slotted list items, slotted links and closed details positions without leaking nested lists", () => {
    document.body.innerHTML = `<div id="host">
      <li slot="second"><a href="/second">Second</a><ul id="inner"><li><a href="/inner">Inner</a></li></ul></li>
      <li slot="first"><a href="/first">First</a></li>
      <li slot="unused"><a href="/unused">Unused</a></li>
      <a slot="slotted-link" href="/fourth">Fourth</a>
    </div>`;
    const shadow = document.querySelector("#host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<ul id="l">
      <slot name="first"></slot>
      <details><summary>More</summary><li>Hidden details</li></details>
      <slot name="second"></slot>
      <li><slot name="slotted-link"></slot></li>
    </ul>`;
    const outer = extract(undefined, { action: "list", ref: "list" }, shadow.querySelector("#l")!);
    expect(outer.rows).toEqual([
      { text: "First", url: new URL("/first", document.baseURI).href },
      { text: "Second\nInner", url: new URL("/second", document.baseURI).href },
      { text: "Fourth", url: new URL("/fourth", document.baseURI).href },
    ]);
    expect(outer.row_sources.map((row) => row.source_row)).toEqual([1, 3, 4]);
    expect(outer.warnings).toEqual(["hidden_rows_omitted"]);

    const inner = extract("#inner", { action: "list" });
    expect(inner.rows).toEqual([{ text: "Inner", url: new URL("/inner", document.baseURI).href }]);
  });
});
