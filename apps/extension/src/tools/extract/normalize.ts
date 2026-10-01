import type {
  CollectorOptions,
  ExtractColumn,
  ExtractResult,
  ExtractSource,
  RawCapture,
  RawCell,
} from "./types";
import { ExtractionFailure } from "./validation";

/** Normalize captured facts without further reads from the live document. */
export function normalizeExtract(
  raw: RawCapture,
  options: CollectorOptions,
  tabId: number,
  source: ExtractSource,
): ExtractResult {
  const result: ExtractResult = {
    schema_version: 1,
    kind: options.action,
    tab_id: tabId,
    source,
    columns: [],
    rows: [],
    row_sources: [],
    spans: [],
    coverage: {
      scope: "loaded_dom",
      rows_returned: 0,
      truncated: raw.truncated,
      dataset_complete: raw.truncated ? "incomplete" : "unknown",
      ...(raw.stop_reason ? { stop_reason: raw.stop_reason } : {}),
      ...(raw.declared_rows !== undefined ? { declared_rows: raw.declared_rows } : {}),
      ...(raw.declared_columns !== undefined ? { declared_columns: raw.declared_columns } : {}),
    },
    warnings: [...new Set(raw.warnings)],
  };
  if (options.action === "list") {
    const fields = options.fields ?? [
      { key: "text", name: "Text" },
      { key: "url", name: "URL" },
    ];
    result.columns = fields.map((field) => ({
      key: field.key,
      name: field.name ?? field.key,
      header_path: [],
      name_source: "field",
    }));
    result.rows = raw.items;
    result.row_sources = raw.item_sources;
    if (
      (raw.item_sources[0]?.source_row ?? 1) > 1 ||
      raw.item_sources.some(
        (row, index) => index > 0 && row.source_row > raw.item_sources[index - 1].source_row + 1,
      ) ||
      (raw.declared_rows !== undefined &&
        (raw.declared_rows === -1 || raw.declared_rows > raw.items.length))
    ) {
      result.coverage.dataset_complete = "incomplete";
      result.warnings.push("partial_dom_dataset");
    }
  } else if (options.action === "table") {
    type Slot = { cell: RawCell; row: number; column: number; end: number; group: number };
    const active: (Slot | undefined)[] = [];
    const matrix: (Slot | undefined)[][] = [];
    const groupEnds = new Map<number, number>();
    const headers = new Map<string, RawCell>();
    for (const row of raw.rows) {
      groupEnds.set(row.group, Math.max(groupEnds.get(row.group) ?? 0, row.source_row));
      for (const cell of row.cells) if (cell.id) headers.set(cell.id, cell);
    }
    let width = 0;
    for (const [rowIndex, row] of raw.rows.entries()) {
      const slots: (Slot | undefined)[] = [];
      for (let col = 0; col < active.length; col++) {
        const slot = active[col];
        if (slot && slot.group === row.group && slot.end >= row.source_row) slots[col] = slot;
        else active[col] = undefined;
      }
      let cursor = 0;
      for (const cell of row.cells) {
        if (cell.column_index !== undefined) cursor = cell.column_index - 1;
        else while (slots[cursor]) cursor++;
        if (cursor < 0 || cursor + cell.column_span > options.max_columns)
          throw new ExtractionFailure("extract_limit", "Logical table width exceeds max_columns");
        const end = Math.min(
          groupEnds.get(row.group)!,
          cell.row_span === 0 ? groupEnds.get(row.group)! : row.source_row + cell.row_span - 1,
        );
        const slot: Slot = { cell, row: rowIndex, column: cursor, end, group: row.group };
        for (let col = cursor; col < cursor + cell.column_span; col++) {
          if (slots[col])
            throw new ExtractionFailure(
              "extract_structure_invalid",
              "Overlapping table cells or ARIA indices",
            );
          slots[col] = slot;
          if (end > row.source_row) active[col] = slot;
        }
        cursor += cell.column_span;
      }
      width = Math.max(width, slots.length);
      matrix.push(slots);
    }
    for (let col = 0; col < width; col++) {
      const path: string[] = [];
      const seen = new Set<RawCell>();
      for (const [rowIndex, row] of raw.rows.entries()) {
        if (row.kind !== "header") continue;
        const cell = matrix[rowIndex][col]?.cell;
        if (cell?.text && cell.header && !seen.has(cell)) {
          path.push(cell.text);
          seen.add(cell);
        }
      }
      // Explicit header IDs take precedence when the page supplies them.
      const associations = raw.rows.flatMap((row, rowIndex) => {
        if (row.kind === "header") return [];
        const cell = matrix[rowIndex][col]?.cell;
        if (!cell?.headers.length) return [];
        const names = cell.headers
          .map((id) => headers.get(id))
          .filter((header) => header?.header && header.text)
          .map((header) => header!.text!);
        return names.length ? [names] : [];
      });
      const explicit = associations[0];
      if (
        explicit &&
        associations.some((names) => JSON.stringify(names) !== JSON.stringify(explicit))
      )
        result.warnings.push("varying_cell_header_associations");
      const headerPath = explicit ?? path;
      const column: ExtractColumn = {
        key: `c${col + 1}`,
        name: headerPath.length ? headerPath.join(" / ") : `Column ${col + 1}`,
        header_path: headerPath,
        name_source: headerPath.length ? "header" : "generated",
      };
      result.columns.push(column);
    }
    for (const [rowIndex, row] of raw.rows.entries()) {
      if (row.kind === "header") continue;
      const output: Record<string, string | null> = Object.create(null);
      for (let col = 0; col < width; col++) {
        const slot = matrix[rowIndex][col];
        const key = result.columns[col].key;
        output[key] = slot?.row === rowIndex && slot.column === col ? slot.cell.text : null;
        if (slot?.row === rowIndex && slot.column === col) {
          const rowSpan =
            slot.cell.row_span === 0 ? slot.end - row.source_row + 1 : slot.cell.row_span;
          if (slot.cell.row_span === 0 && raw.truncated)
            result.warnings.push("rowspan_zero_extent_truncated");
          if (rowSpan > 1 || slot.cell.column_span > 1)
            result.spans.push({
              row: result.rows.length,
              column: key,
              row_span: rowSpan,
              column_span: slot.cell.column_span,
            });
        }
      }
      result.row_sources.push({
        row: result.rows.length,
        source_row: row.source_row,
        row_kind: row.kind,
        locator: row.locator,
      });
      result.rows.push(output);
    }
    if (result.columns.some((column) => column.name_source === "generated"))
      result.warnings.push("generated_column_names");
    if (
      raw.rows.some(
        (row, index) => index > 0 && row.source_row > raw.rows[index - 1].source_row + 1,
      ) ||
      (raw.rows[0]?.source_row ?? 1) > 1 ||
      (raw.declared_rows !== undefined &&
        (raw.declared_rows === -1 || raw.declared_rows > raw.rows.length)) ||
      (raw.declared_columns !== undefined &&
        (raw.declared_columns === -1 || raw.declared_columns > width))
    ) {
      result.coverage.dataset_complete = "incomplete";
      result.warnings.push("partial_dom_dataset");
    }
  }
  result.coverage.rows_returned = result.rows.length;
  result.warnings = [...new Set(result.warnings)];
  return result;
}

/** The budget includes metadata, provenance and spans; never slice serialized JSON. */
export function fitExtractBudget(result: ExtractResult, maxBytes: number): ExtractResult {
  const byteSize = () => new TextEncoder().encode(JSON.stringify(result)).length;
  if (byteSize() <= maxBytes) return result;
  result.coverage.truncated = true;
  result.coverage.dataset_complete = "incomplete";
  result.coverage.stop_reason = "byte_limit";
  const rows = result.rows;
  const sources = result.row_sources;
  const spans = result.spans;
  let low = 0;
  let high = rows.length;
  const use = (count: number) => {
    result.rows = rows.slice(0, count);
    result.row_sources = sources.slice(0, count);
    result.spans = spans.filter((span) => span.row < count);
    result.coverage.rows_returned = count;
  };
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    use(mid);
    if (byteSize() <= maxBytes) low = mid;
    else high = mid - 1;
  }
  use(low);
  if ((rows.length && !low) || byteSize() > maxBytes)
    throw new ExtractionFailure(
      "extract_limit",
      "Metadata or the first complete row exceeds max_bytes",
    );
  return result;
}
