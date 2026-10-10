# Structured table and list extraction

Read a loaded page as JSON rows and columns, with document and row provenance.
This is a passive read: extraction never clicks, scrolls, changes focus, fetches
another page, or follows pagination. It requires a matching CLI, daemon and
extension build containing the **tool.extract** method.

## CLI

~~~sh
bsk extract discover --session <id>
bsk extract table --session <id> --selector '#orders'
bsk extract table --session <id> --target <target_id> --format csv --out orders.csv
bsk extract list --session <id> --selector '#results' --item-selector '.result' --fields fields.json
~~~

Choose exactly one of **--selector**, **--target** or **--ref**. A selector must
match one container in the main document. Without these options, table/list
extraction requires exactly one visible semantic container in that document.
Discovery searches open shadow roots and available frames, including OOPIFs.
Use its target_id to read those containers; ordinary observation refs often
describe controls rather than the containing table. A fresh DOM ref is also
accepted; visual-region refs are not.

Discovery handles expire after five minutes and are scoped to the session,
tab, attachment and frame document. Navigation, node removal or a new attachment
invalidates them. Rediscover after such changes. Discovery is capped at 16 frames,
32 returned targets and 8 preview headers per target; partial results are marked.
A discovery selector limits the search to a subtree of the main document. Tables
and grids take priority over lists within the visited DOM/frames. Traversal or
time limits return the complete targets found so far. A target handle supplies
its original tab when --tab-id is omitted; an explicit different tab is rejected.

Fields files (or **--fields-json** with the same object) contain:

~~~json
{
  "fields": [
    { "key": "title", "name": "Title", "selector": "h3", "read": "text" },
    { "key": "url", "selector": "h3 a", "read": "href" },
    { "key": "sku", "selector": ":scope", "read": "attribute", "attribute": "data-sku" }
  ]
}
~~~

Field selectors are relative to each item; **:scope** reads the item itself.
Missing/hidden matches or absent attributes become null. More than one visible
match is an error, rather than an arbitrary choice. Links are resolved against
the document's base URL. Default semantic-list fields are text and url; an item
with multiple visible links retains its text and returns a null url with
ambiguous_default_url. Use explicit field selectors to choose a link. Arbitrary repeated
cards need both a container and an item selector. Fields files are limited to 256 KiB.

## JSON contract

The canonical result has schema_version 1, kind, tab_id, and:

| Field | Meaning |
| --- | --- |
| columns | Stable keys (c1, c2, … for tables), display names, hierarchical header_path, and name_source: header, generated or field. |
| rows | Records keyed by column key. Values are strings or null; order IDs, dates and amounts are not coerced. |
| source | Page URL, frame URL/ID, title, UTC capture time, and explicit selector/target when used. |
| row_sources | Zero-based output row, one-based DOM/ARIA row position including headers, row_kind (data or footer) and diagnostic locator. |
| spans | Merged-cell anchors: output row, column key, row_span and column_span. Covered positions are null, not copied values. |
| coverage | Loaded-DOM scope, returned count, truncation/stop reason, declared ARIA counts and completeness. |
| warnings | Generated names, partial DOM data, varying header associations or unavailable frames. |
| targets | Discovery only: handles, container kinds/names, frame provenance and column previews. |

JSON object member order is not column order. Iterate columns and read
row[column.key]; do not relabel Object.values(row) by position. CSV already uses
this key-based mapping, including tables with more than nine columns.

Native HTML tables and ARIA tables/grids/treegrids support row/column spans, row headers,
multiple header rows, explicit header IDs, footer rows and ARIA row/column indices.
Nested tables are independent targets; their cells do not leak into the parent.
Duplicate names retain different column keys. Missing/empty headers become
Column N; a headerless table keeps its first data row.
Native spans use the browser's HTML parsing rules, including rowspan=0. Invalid
ARIA spans fall back to one with invalid_aria-rowspan/invalid_aria-colspan warnings.
ARIA rows are sorted by logical row index. Split rows sharing an explicit index
are joined only when all fragments supply explicit, non-overlapping column indices
and agree on row kind; ambiguous/conflicting fragments fail. Reordering and merges
are reported as aria_rows_reordered and split_aria_rows_merged. Merged row locators
join the contributing locations with " | ". Treegrid extraction reads loaded rows;
it does not expand groups or infer an unrendered hierarchy.

Hidden rows are omitted. Hidden cells, missing fields and span-covered cells
are null; an existing empty cell is an empty string. Offscreen rendered DOM
content can be read. Script/style/template content, password inputs and
BrowserSkill overlays are excluded. Hidden rows produce hidden_rows_omitted;
their known indices alone do not imply missing virtual rows. Locators are diagnostic, not durable
selectors; ::shadow indicates a shadow boundary.

Text follows open shadow roots and assigned slots, collapses ordinary template
whitespace, and keeps BR/block boundaries and preformatted whitespace. Text-like
inputs and textareas return live values; selects return selected option labels
(one per line for multiple selections). Password/hidden inputs and checkbox,
radio, file and image input values are not exported as text. This is DOM-based
text extraction, not OCR or a complete reproduction of CSS generated content.

Span counts retain the page-declared extent, including omitted rows. HTML
rowspan=0 is resolved within the collected row group; if collection was truncated,
the rowspan_zero_extent_truncated warning marks that extent as provisional.

**coverage.dataset_complete is never asserted true.** It is unknown when
the loaded DOM provides no proof of completeness, or incomplete on truncation,
known missing ARIA rows/columns, or unavailable frames. A grid declaring 101 rows
but loading only rows 51–52 is not a 100-record export. Compare returned counts,
declared counts and warnings before using the result for totals.

## Budgets and failure behavior

| Option | Default | Allowed range |
| --- | --- | --- |
| --max-rows | 500 | 1–5000 data/footer rows |
| --max-columns | 100 | 1–200 logical columns |
| --max-bytes | 1048576 | 1024–4194304 bytes of compact canonical JSON, including metadata |
| --timeout-ms | 5000 | 100–15000 milliseconds |

These are upper bounds, not promises that every page will reach them. The collector
also caps traversal work at 100,000 steps and header fragments at 32. Wider or
more deeply nested content can exhaust work or byte budgets first. Row locator
sibling positions are cached so ordinary long tables do not incur quadratic scans.
Time checking is
cooperative inside the collector; cancellation prevents publishing a cancelled
result and releases remote object groups. An unresponsive renderer remains
subject to the existing CDP/transport timeouts.

Only complete rows are returned. If metadata or the first complete row cannot
fit, extraction fails explicitly. Pretty-printed JSON and CSV files may exceed
the compact JSON budget. Ambiguous selectors/fields, malformed ARIA layouts,
unsupported targets and stale handles return structured errors. No automatic
pagination, infinite-scroll traversal, canvas/OCR, closed shadow-root discovery
or spreadsheet type inference is performed.

## CSV and files

JSON is the default. Without **--out**, JSON or CSV goes to stdout; CSV
summaries/warnings go to stderr. With **--out**, the CLI writes on its own host
and prints a receipt; the global **--json** flag makes that receipt JSON.
CSV plus global **--json** requires **--out**.

CSV uses UTF-8 and CRLF record separators, quoting commas, quotes and newlines.
Duplicate column names are disambiguated. Every row includes _source_url,
_source_frame_url and _source_row. A file export also writes **<file>.meta.json**
with canonical columns, CSV headers, source, row provenance, spans, coverage,
warnings, null positions and the CSV SHA-256.

Raw CSV preserves strings, including formula-like values. Use **--csv-safe**
when opening untrusted page data in a spreadsheet: it prefixes formula-like
values with an apostrophe and records originals in metadata's escaped_cells.
Spreadsheet applications may still infer numbers/dates from raw CSV; use JSON
or explicit import types when preserving leading zeroes matters.

Existing output or metadata files are refused unless **--overwrite** is supplied.
Each file is staged beside its destination and committed atomically. The CSV and
metadata are two separate commits, **not a filesystem transaction**; the sidecar
is committed first. A failure between commits reports an error, and the SHA-256
allows a consumer to detect a mismatched pair.

## DSH plugin

The existing **browser_inspect** tool gains **action: "extract"**:

~~~text
browser_inspect({ action: "extract", session: "<id>", extractKind: "discover" })
browser_inspect({ action: "extract", session: "<id>", extractKind: "table", extractTarget: "<target_id>" })
browser_inspect({ action: "extract", session: "<id>", extractKind: "table", selector: "#orders",
  extractFormat: "csv", extractOutput: "/absolute/path/orders.csv", csvSafe: true })
~~~

List extraction uses itemSelector and the fields-object JSON string in
extractFields. Budgets are maxRows, maxColumns, maxBytes and extractTimeoutMs. CSV requires an
output path so the plugin always receives structured JSON. The plugin uses the
normal session registry, runner and queue; it does not introduce arbitrary
page-script evaluation. Output paths are on the CLI host; relative paths resolve
against that process's working directory. Prefer absolute paths in harness calls.

## Implementation

The extension collector reads DOM facts in an isolated world; a pure normalizer
builds the logical table. CDP document checks surround collection, and discovery
retains bounded node identities rather than remote objects or page contents.
The daemon classifies tool.extract as a passive read and forwards the protocol.
The CLI owns CSV encoding and local files.

Focused normalization/lifecycle and CSV tests accompany the implementation.
