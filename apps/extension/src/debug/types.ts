/** Opt-in, task-owned evidence. All timestamps are epoch milliseconds. */
export type DebugAction =
  | "start"
  | "stop"
  | "status"
  | "requests"
  | "request"
  | "operations"
  | "operation"
  | "console"
  | "pages"
  | "export"
  | "rules"
  | "rule_add"
  | "rule_enable"
  | "rule_disable"
  | "rule_remove"
  | "replay";

export interface DebugRequestEdit {
  url?: string;
  method?: string;
  headers?: Record<string, string | null>;
  body?: string;
  /** Top-level JSON object edits; applied to the live request, before redaction. */
  json?: { set?: Record<string, unknown>; remove?: string[]; rename?: Record<string, string> };
}
export interface DebugRuleSpec {
  name?: string;
  match: { url: string; method?: string; resource_type?: "Fetch" | "XHR" | "Document" };
  effect:
    | { type: "block" }
    | ({ type: "modify" } & DebugRequestEdit)
    | {
        type: "mock";
        status: number;
        headers?: Record<string, string>;
        body: string;
        delay_ms?: number;
      };
  /** Defaults to one match. Zero means until disabled or capture ends. */
  times?: number;
}
export interface DebugRule extends DebugRuleSpec {
  id: string;
  state: "enabled" | "disabled" | "exhausted" | "removed" | "stopped";
  hits: number;
  failures: number;
  created_at: number;
  last_error?: string;
}
export interface DebugReplaySpec extends Omit<DebugRequestEdit, "json"> {
  /** Reusing a key in the same capture never sends another request. */
  key: string;
}
export interface DebugReplay {
  id: string;
  key: string;
  source_request_id: string;
  request_id?: string;
  state: "running" | "complete" | "failed" | "interrupted";
  error?: string;
}
export interface DebugIntervention {
  rule_id: string;
  type: "block" | "modify" | "mock";
  state: "pending" | "applied" | "failed" | "cancelled";
  error?: string;
  /** Small redacted change summary; retained request body is the effective body. */
  changes?: string[];
}

export interface DebugParams {
  session_id: string;
  action: DebugAction;
  tab_id?: number;
  run_id?: string;
  id?: string;
  name?: string;
  since?: number;
  limit?: number;
  /** Detail projection. Metadata never includes body text. */
  part?: "metadata" | "request" | "response" | "headers" | "timing";
  offset?: number;
  max_chars?: number;
  /** RFC 6901 JSON pointer, applied to a complete redacted body. */
  pointer?: string;
  rule?: DebugRuleSpec;
  replay?: DebugReplaySpec;
}

export interface DebugBody {
  state: "pending" | "available" | "empty" | "truncated" | "unavailable" | "omitted" | "evicted";
  reason?: string;
  text?: string;
  chars?: number;
  offset?: number;
  next_offset?: number;
  redacted?: boolean;
}

export interface DebugRequest {
  id: string;
  run_id: string;
  sequence: number;
  started_at: number;
  finished_at?: number;
  method: string;
  url: string;
  resource_type?: string;
  frame_id?: string;
  state: "pending" | "complete" | "failed" | "redirected" | "interrupted";
  status?: number;
  error?: string;
  mime_type?: string;
  duration_ms?: number;
  transfer_bytes?: number;
  decoded_bytes?: number;
  from_cache?: boolean;
  from_service_worker?: boolean;
  redirect_from?: string;
  initiator?: string;
  request_headers?: Record<string, string>;
  response_headers?: Record<string, string>;
  timing?: Record<string, number>;
  request_body: DebugBody;
  response_body: DebugBody;
  truncated?: boolean;
  intervention?: DebugIntervention;
  replay_from?: string;
  replay_id?: string;
}

export interface DebugConsole {
  id: string;
  at: number;
  level: string;
  text: string;
  count: number;
  last_at: number;
  stack?: string;
  source?: "website" | "extension" | "browser" | "unknown";
  source_url?: string;
  relation?: "window" | "delayed";
}

export interface DebugField {
  key: string;
  name?: string;
  label: string;
  value?: string;
  state: "available" | "redacted" | "truncated";
}

export interface DebugPage {
  at: number;
  url?: string;
  title?: string;
  text?: string;
  state: "available" | "unavailable";
  truncated?: boolean;
  fields?: DebugField[];
  fields_partial?: boolean;
  navigation?: string;
}

export interface DebugOperation {
  id: string;
  run_id: string;
  sequence: number;
  method: string;
  target?: string;
  source?: "human" | "agent";
  started_at: number;
  finished_at?: number;
  /** Time-window correlation, never a causal assertion. */
  window_end?: number;
  state: "running" | "completed" | "error" | "interrupted";
  error?: string;
  before?: DebugPage;
  after?: DebugPage;
  observations?: DebugPage[];
  observation_end?: number;
  observation_limited?: boolean;
  request_ids: string[];
  console_ids: string[];
  truncated: boolean;
}

export interface DebugRun {
  id: string;
  session_id: string;
  tab_id: number;
  name: string;
  url: string;
  started_at: number;
  stopped_at?: number;
  state: "capturing" | "stopped";
  stop_reason?: string;
  requests: number;
  operations: number;
  errors: number;
  dropped_requests: number;
  dropped_operations: number;
  dropped_console: number;
  coverage: string[];
  next_since: number;
  active_rules?: number;
  saved_at?: number;
  storage_error?: string;
  environment?: { extension_version?: string; user_agent?: string };
}

export interface DebugValue {
  state: string;
  value?: string;
  source?: string;
  at?: number;
}
export interface DebugFieldTrace {
  key: string;
  label: string;
  before: DebugValue;
  input: DebugValue;
  submitted: DebugValue[];
  response: DebugValue[];
  later: DebugValue;
}
export interface DebugEvidence {
  fields: DebugFieldTrace[];
  payloads: {
    request_id: string;
    part: string;
    path: string;
    value: string;
    truncated?: boolean;
  }[];
  links: { request_id: string; relation: "window" | "delayed" }[];
  gaps: string[];
  changes: { added: string[]; removed: string[]; truncated: boolean };
  observations: DebugPage[];
}

/** Portable, already-redacted snapshot. Also used by browser-local history. */
export interface DebugRecording {
  version: 1;
  saved_at: number;
  run: DebugRun;
  requests: DebugRequest[];
  operations: DebugOperation[];
  console: DebugConsole[];
  pages: DebugPage[];
  rules?: DebugRule[];
  replays?: DebugReplay[];
}

export interface DebugResult {
  session_id: string;
  run?: DebugRun;
  runs?: DebugRun[];
  requests?: DebugRequest[];
  request?: DebugRequest;
  operations?: DebugOperation[];
  operation?: DebugOperation;
  console?: DebugConsole[];
  pages?: DebugPage[];
  recording?: DebugRecording;
  evidence?: DebugEvidence;
  rules?: DebugRule[];
  replays?: DebugReplay[];
  replay?: DebugReplay;
  next_since?: number;
  truncated?: boolean;
}

export interface DebugTask {
  session_id: string;
  created_at: number;
  tab_id?: number;
  title?: string;
  url?: string;
  run?: DebugRun;
}
