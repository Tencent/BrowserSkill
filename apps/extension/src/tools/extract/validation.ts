import type { RpcError, RpcErrorReason } from "@/transport/types";
import type { CollectorOptions, ExtractParams } from "./types";

export class ExtractionFailure extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}
export function extractionFailure(error: ExtractionFailure): RpcError {
  const code = ["extract_target_stale", "selector_not_found"].includes(error.reason)
    ? "not_found"
    : error.reason === "extract_limit"
      ? "unsupported"
      : "invalid_params";
  const knownReasons: RpcErrorReason[] = [
    "extract_params_invalid",
    "extract_target_stale",
    "extract_target_ambiguous",
    "extract_target_hidden",
    "extract_selector_invalid",
    "extract_structure_invalid",
    "extract_field_ambiguous",
    "extract_limit",
    "selector_not_found",
  ];
  const reason =
    knownReasons.find((value) => value === error.reason) ?? "extract_structure_invalid";
  return { code, message: error.message, data: { reason } };
}
export function validateExtract(params: ExtractParams): CollectorOptions {
  const invalid = (message: string): never => {
    throw new ExtractionFailure("extract_params_invalid", message);
  };
  if (!params || !["discover", "table", "list"].includes(params.action))
    invalid("action must be discover, table, or list");
  const bound = (
    value: number | undefined,
    fallback: number,
    maximum: number,
    name: string,
    minimum = 1,
  ): number => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      invalid(`${name} must be an integer from ${minimum} to ${maximum}`);
    return value;
  };
  for (const key of ["selector", "ref", "target_id", "item_selector"] as const) {
    const value = params[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 2_048))
      invalid(`${key} must be a non-empty string of at most 2048 characters`);
  }
  if (
    [params.selector, params.ref, params.target_id].filter((value) => value !== undefined).length >
    1
  )
    invalid("selector, ref, and target_id are mutually exclusive");
  if (params.action === "discover" && (params.ref !== undefined || params.target_id !== undefined))
    invalid("discover accepts a selector scope, not a ref or target_id");
  if (
    params.action !== "list" &&
    (params.item_selector !== undefined || params.fields !== undefined)
  )
    invalid("item_selector and fields require action=list");
  const maxColumns = bound(params.max_columns, 100, 200, "max_columns");
  if (params.fields !== undefined) {
    if (!Array.isArray(params.fields) || !params.fields.length || params.fields.length > maxColumns)
      invalid("fields must be a non-empty array within max_columns");
    const keys = new Set<string>();
    for (const field of params.fields) {
      if (
        !field ||
        typeof field.key !== "string" ||
        !field.key.trim() ||
        field.key.length > 128 ||
        ["__proto__", "constructor", "prototype"].includes(field.key) ||
        keys.has(field.key)
      )
        invalid("field keys must be unique non-empty names (reserved object keys are not allowed)");
      keys.add(field.key);
      if (
        typeof field.selector !== "string" ||
        !field.selector.trim() ||
        field.selector.length > 2_048
      )
        invalid("each field requires a CSS selector");
      if (!["text", "href", "attribute"].includes(field.read))
        invalid("field read must be text, href, or attribute");
      if (
        field.name !== undefined &&
        (typeof field.name !== "string" || !field.name.trim() || field.name.length > 500)
      )
        invalid("field name must be a non-empty string of at most 500 characters");
      if (field.read === "attribute") {
        if (
          typeof field.attribute !== "string" ||
          !/^[a-zA-Z][a-zA-Z0-9_:.-]{0,127}$/.test(field.attribute)
        )
          invalid("attribute reads require a valid attribute name");
      } else if (field.attribute !== undefined)
        invalid("attribute is only valid for attribute reads");
    }
  } else if (params.action === "list" && maxColumns < 2)
    invalid("default list extraction requires two columns");
  return {
    action: params.action,
    selector: params.selector,
    item_selector: params.item_selector,
    fields: params.fields,
    anchored: !!(params.ref || params.target_id),
    max_rows: bound(params.max_rows, 500, 5_000, "max_rows"),
    max_columns: maxColumns,
    max_bytes: bound(params.max_bytes, 1_048_576, 4_194_304, "max_bytes", 1_024),
    timeout_ms: bound(params.timeout_ms, 5_000, 15_000, "timeout_ms", 100),
  };
}
