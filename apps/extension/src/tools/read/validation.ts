import {
  RECORD_PASSWORD_ATTRIBUTE,
  SENSITIVE_AUTOCOMPLETE_SELECTOR,
} from "@/lib/sensitive-autocomplete";
import type { RpcError, RpcErrorReason } from "@/transport/types";
import type { ReadOptions, ReadParams } from "./types";

export class ReadFailure extends Error {
  constructor(
    readonly reason: RpcErrorReason,
    message: string,
  ) {
    super(message);
  }
}
export function readError(error: ReadFailure): RpcError {
  return {
    code:
      error.reason === "read_target_stale"
        ? "not_found"
        : error.reason === "read_limit"
          ? "unsupported"
          : "invalid_params",
    message: error.message,
    data: {
      reason: error.reason,
      phase: "read",
      effect_state: "none",
      recovery:
        "Inspect the current document and target. Use read/extract for data and explicit expect conditions before input; a read never renews control or authorizes replay.",
    },
  };
}
export function validateRead(params: ReadParams): ReadOptions {
  const invalid = (message: string): never => {
    throw new ReadFailure("read_params_invalid", message);
  };
  // context_id is validated by cooperation; it grants no extra authority to this read.
  const allowed = [
    "session_id",
    "tab_id",
    "context_id",
    "_audit_id",
    "_operation_id",
    "selector",
    "ref",
    "fields",
    "max_nodes",
    "max_bytes",
    "timeout_ms",
  ];
  if (!params || Object.keys(params).some((key) => !allowed.includes(key)))
    invalid(
      `read accepts declarative DOM fields only; unexpected fields: ${Object.keys(params ?? {})
        .filter((key) => !allowed.includes(key))
        .join(", ")}`,
    );
  if (params.ref !== undefined && params.selector !== undefined)
    invalid("ref and selector are mutually exclusive");
  for (const value of [params.ref, params.selector])
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 2048))
      invalid("target must be a non-empty ref or CSS selector of at most 2048 characters");
  const fields = params.fields ?? [{ key: "text", read: "text" as const }];
  if (!Array.isArray(fields) || !fields.length || fields.length > 32)
    invalid("fields must contain 1..32 definitions");
  const keys = new Set<string>();
  for (const field of fields) {
    if (
      !field ||
      Object.keys(field).some((key) => !["key", "read", "selector", "attribute"].includes(key)) ||
      typeof field.key !== "string" ||
      !field.key.trim() ||
      field.key.length > 128 ||
      ["__proto__", "constructor", "prototype"].includes(field.key) ||
      keys.has(field.key)
    )
      invalid("field keys must be unique, non-empty and non-reserved");
    keys.add(field.key);
    if (!["text", "attribute", "value", "checked", "exists"].includes(field.read))
      invalid("read must be text, attribute, value, checked or exists");
    if (
      field.selector !== undefined &&
      (typeof field.selector !== "string" || !field.selector.trim() || field.selector.length > 2048)
    )
      invalid("field selector must be a bounded CSS selector");
    if (field.read === "attribute") {
      if (
        typeof field.attribute !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_:.-]{0,127}$/.test(field.attribute)
      )
        invalid("attribute read requires an attribute name");
    } else if (field.attribute !== undefined) invalid("attribute requires read=attribute");
  }
  const bound = (value: number | undefined, fallback: number, min: number, max: number) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max)
      invalid(`read limit must be an integer in ${min}..${max}`);
    return value;
  };
  return {
    selector: params.selector,
    fields,
    max_nodes: bound(params.max_nodes, 100, 1, 1000),
    max_bytes: bound(params.max_bytes, 262144, 1024, 1048576),
    timeout_ms: bound(params.timeout_ms, 3000, 100, 10000),
    sensitive: `input[type="password"],input[type="file"],input[type="hidden"],[${RECORD_PASSWORD_ATTRIBUTE}],${SENSITIVE_AUTOCOMPLETE_SELECTOR}`,
  };
}
