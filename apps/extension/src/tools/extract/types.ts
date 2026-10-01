/** Wire types mirrored by bsk-protocol/tools/extract.rs. */
export type ExtractAction = "discover" | "table" | "list";
export interface ExtractField {
  key: string;
  name?: string;
  selector: string;
  read: "text" | "href" | "attribute";
  attribute?: string;
}
export interface ExtractParams {
  session_id: string;
  tab_id?: number;
  action: ExtractAction;
  selector?: string;
  ref?: string;
  target_id?: string;
  item_selector?: string;
  fields?: ExtractField[];
  max_rows?: number;
  max_columns?: number;
  max_bytes?: number;
  timeout_ms?: number;
}
export interface ExtractColumn {
  key: string;
  name: string;
  header_path: string[];
  name_source: "header" | "generated" | "field";
}
export interface ExtractSource {
  page_url: string;
  frame_url: string;
  frame_id: string;
  title: string;
  captured_at: string;
  selector?: string;
  target_id?: string;
}
export interface ExtractRowSource {
  row: number;
  /** One-based DOM/ARIA row index, including headers. */
  source_row: number;
  row_kind: "data" | "footer";
  locator: string;
}
export interface ExtractSpan {
  row: number;
  column: string;
  row_span: number;
  column_span: number;
}
export interface ExtractCoverage {
  scope: "loaded_dom";
  rows_returned: number;
  truncated: boolean;
  dataset_complete: "unknown" | "incomplete";
  stop_reason?: string;
  /** Page-declared counts; ARIA row counts include headers. */
  declared_rows?: number;
  declared_columns?: number;
}
export interface ExtractTarget {
  target_id: string;
  kind: "table" | "list";
  name: string;
  frame_url: string;
  frame_id: string;
  columns: string[];
}
export interface ExtractResult {
  schema_version: 1;
  kind: ExtractAction;
  tab_id: number;
  source: ExtractSource;
  columns: ExtractColumn[];
  rows: Record<string, string | null>[];
  row_sources: ExtractRowSource[];
  spans: ExtractSpan[];
  coverage: ExtractCoverage;
  warnings: string[];
  targets?: ExtractTarget[];
}

export interface CollectorOptions {
  action: ExtractAction;
  selector?: string;
  item_selector?: string;
  fields?: ExtractField[];
  anchored: boolean;
  max_rows: number;
  max_columns: number;
  max_bytes: number;
  timeout_ms: number;
}
export interface RawCell {
  text: string | null;
  id: string;
  headers: string[];
  scope: string;
  header: boolean;
  row_span: number;
  column_span: number;
  column_index?: number;
}
export interface RawRow {
  cells: RawCell[];
  source_row: number;
  group: number;
  kind: "header" | "data" | "footer";
  locator: string;
}
export interface RawTarget {
  kind: "table" | "list";
  name: string;
  columns: string[];
  /** DOM node in the renderer; decoded CDP node identity in the handler. */
  node: { backendNodeId: number };
}
export interface RawCapture {
  frame_url: string;
  title: string;
  captured_at: string;
  rows: RawRow[];
  items: Record<string, string | null>[];
  item_sources: ExtractRowSource[];
  targets: RawTarget[];
  truncated: boolean;
  stop_reason?: string;
  declared_rows?: number;
  declared_columns?: number;
  warnings: string[];
  error?: { reason: string; message: string };
}
