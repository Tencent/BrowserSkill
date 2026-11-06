export interface ReadField {
  key: string;
  read: "text" | "attribute" | "value" | "checked" | "exists";
  selector?: string;
  attribute?: string;
}
export interface ReadParams {
  session_id: string;
  tab_id?: number;
  selector?: string;
  ref?: string;
  fields?: ReadField[];
  max_nodes?: number;
  max_bytes?: number;
  timeout_ms?: number;
}
export interface ReadOptions {
  selector?: string;
  fields: ReadField[];
  max_nodes: number;
  max_bytes: number;
  timeout_ms: number;
  sensitive: string;
}
export interface RawRead {
  frame_url: string;
  title: string;
  captured_at: string;
  items: {
    node: { backendNodeId: number };
    values: Record<string, string | boolean | null>;
    redacted: string[];
  }[];
  truncated: boolean;
  error?: {
    reason: "read_limit" | "read_selector_invalid" | "read_field_ambiguous" | "read_target_stale";
    message: string;
  };
}
export interface ReadResult extends Omit<RawRead, "items" | "error"> {
  tab_id: number;
  page_url: string;
  frame_id: string;
  scope: "current_dom";
  items: { ref: string; values: Record<string, string | boolean | null>; redacted: string[] }[];
}
