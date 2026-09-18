/** Opt-in, task-owned evidence. All timestamps are epoch milliseconds. */
export type DebugAction =
  | "start"
  | "stop"
  | "status"
  | "requests"
  | "request"
  | "operations"
  | "operation"
  | "compare";

export interface DebugParams {
  session_id: string;
  action: DebugAction;
  tab_id?: number;
  run_id?: string;
  id?: string;
  before?: string;
  after?: string;
  name?: string;
  since?: number;
  limit?: number;
  /** Detail projection. Metadata never includes body text. */
  part?: "metadata" | "request" | "response" | "headers" | "timing";
  offset?: number;
  max_chars?: number;
  /** RFC 6901 JSON pointer, applied to a complete redacted body. */
  pointer?: string;
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
}

export interface DebugConsole {
  id: string;
  at: number;
  level: string;
  text: string;
  count: number;
  last_at: number;
  stack?: string;
}

export interface DebugPage {
  at: number;
  url?: string;
  title?: string;
  text?: string;
  state: "available" | "unavailable";
  truncated?: boolean;
}

export interface DebugOperation {
  id: string;
  run_id: string;
  sequence: number;
  method: string;
  target?: string;
  started_at: number;
  finished_at?: number;
  /** Time-window correlation, never a causal assertion. */
  window_end?: number;
  state: "running" | "completed" | "error" | "interrupted";
  error?: string;
  before?: DebugPage;
  after?: DebugPage;
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
}

export interface DebugComparison {
  before: DebugOperation;
  after: DebugOperation;
  before_requests: DebugRequest[];
  after_requests: DebugRequest[];
  before_console: DebugConsole[];
  after_console: DebugConsole[];
  /** A diff is evidence, not a declaration that the bug is fixed. */
  same_target: boolean;
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
  comparison?: DebugComparison;
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
