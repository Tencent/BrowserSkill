import { HISTORY_AGE_MS, HISTORY_BYTES, HISTORY_LIMIT } from "./archive";
import { JOURNAL_BYTES, JOURNAL_PINS, JOURNAL_REQUESTS } from "./journal";

declare const __BSK_EXT_BUILD__: string;
declare const __BSK_EXT_VERSION__: string;
export const DEBUG_ACTIONS = [
  "start",
  "stop",
  "status",
  "requests",
  "request",
  "operations",
  "operation",
  "console",
  "pages",
  "export",
  "rules",
  "rule_add",
  "rule_enable",
  "rule_disable",
  "rule_remove",
  "replay",
  "capabilities",
  "pin",
  "unpin",
] as const;
export const DEBUG_FIELDS = [
  "resource_type",
  "frame_id",
  "status",
  "error",
  "mime_type",
  "duration_ms",
  "transfer_bytes",
  "decoded_bytes",
  "from_cache",
  "from_service_worker",
  "redirect_from",
  "initiator",
  "finished_at",
] as const;
export const QUERY_LIMITS = {
  limit: { min: 1, max: 100, default: 30 },
  max_chars: { min: 1, max: 16384, default: 4096 },
  offset: { min: 0, max: 65536 },
  budget: { min: 4096, max: 262144, default: 32768 },
};
export function debugCapabilities(persistent = true): Record<string, unknown> {
  return {
    schema_version: 1,
    extension: {
      version: typeof __BSK_EXT_VERSION__ === "string" ? __BSK_EXT_VERSION__ : "unknown",
      build: typeof __BSK_EXT_BUILD__ === "string" ? __BSK_EXT_BUILD__ : "unknown",
    },
    actions: DEBUG_ACTIONS.filter((action) => persistent || !["pin", "unpin"].includes(action)),
    parameters: {
      ...QUERY_LIMITS,
      since: { min: 0, semantics: "incremental sequence; merge updates by id" },
      filters: {
        actions: ["requests"],
        url: "case-sensitive substring of retained URL",
        method: "exact HTTP method",
        resource_type: "exact CDP resource type",
        status: "exact HTTP status (100..599)",
        state: ["pending", "complete", "failed", "redirected", "interrupted"],
        kind: ["all", "business", "resource", "extension"],
      },
      fields: {
        actions: ["requests", "request"],
        optional: DEBUG_FIELDS,
        always: [
          "id",
          "run_id",
          "sequence",
          "started_at",
          "method",
          "url",
          "state",
          "request_body",
          "response_body",
          "truncated",
          "intervention",
          "replay_from",
          "replay_id",
          "pinned",
        ],
        detail: "Use part=request/response/headers/timing for large fields",
      },
    },
    output: {
      budget_unit: "UTF-8 JSON bytes",
      export_exempt: true,
      omissions: "output.omitted lists omitted sections; stored evidence is unchanged",
      inline_urls: "data URLs use a compact descriptor",
    },
    storage: {
      persistent,
      request_limit: JOURNAL_REQUESTS,
      request_bytes: JOURNAL_BYTES,
      pin_limit: JOURNAL_PINS,
      history_count: HISTORY_LIMIT,
      history_bytes: HISTORY_BYTES,
      history_age_ms: HISTORY_AGE_MS,
      scope: "owning task only; browser history is available through extension UI",
      overflow: "old low-priority unpinned requests evicted first; reported by run.storage.dropped",
    },
    network_controls: {
      capture_required: true,
      rule_limit: 32,
      replay_limit: 20,
      replay_same_origin: true,
      replay_requires_key: true,
    },
    unsupported: [
      "performance_capture",
      "cross_origin_replay",
      "binary_request_editing",
      "response_rewriting",
    ],
  };
}
