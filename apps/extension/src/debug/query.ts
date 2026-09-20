import { DEBUG_FIELDS, QUERY_LIMITS } from "./capabilities";
import { requestKind } from "./evidence-model";
import type { DebugParams, DebugRequest, DebugResult } from "./types";

export function matchesRequest(entry: DebugRequest, params: DebugParams): boolean {
  return (
    (!params.url || entry.url.includes(params.url)) &&
    (!params.method || entry.method === params.method) &&
    (!params.resource_type || entry.resource_type === params.resource_type) &&
    (params.status === undefined || entry.status === params.status) &&
    (!params.state || entry.state === params.state) &&
    (!params.kind || params.kind === "all" || requestKind(entry) === params.kind)
  );
}
export function projectFields(entry: DebugRequest, fields?: string[]): DebugRequest {
  if (!fields) return entry;
  const result = { ...entry };
  for (const field of DEBUG_FIELDS) if (!fields.includes(field)) delete result[field];
  return result;
}
const prefix = (text: string, end: number): string =>
  text.slice(
    0,
    /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(end))
      ? end - 1
      : end,
  );
const compactUrl = (url: string): string =>
  url.startsWith("data:")
    ? `${prefix(url, Math.min(url.indexOf(",") < 0 ? 40 : url.indexOf(","), 80))},[inline content omitted]`
    : url;

/** Trim only the response projection, never the stored recording. Always valid JSON. */
export function budgetResult(value: DebugResult, params: DebugParams): DebugResult {
  if (params.action === "export") return value;
  const result = structuredClone(value);
  const budget = params.budget ?? QUERY_LIMITS.budget.default;
  const output = { budget, truncated: false, omitted: [] as string[] };
  result.output = output;
  const omit = (path: string) => {
    output.truncated = true;
    if (!output.omitted.includes(path)) {
      if (output.omitted.length < 12) output.omitted.push(path);
      else output.omitted[11] = "additional_fields";
    }
  };
  // Count the pretty JSON returned by the CLI too, not merely raw string lengths.
  const integerCount = (value: unknown): number => {
    if (typeof value === "number") return Number.isInteger(value) ? 1 : 0;
    if (!value || typeof value !== "object") return 0;
    return Object.values(value).reduce<number>((sum, child) => sum + integerCount(child), 0);
  };
  // Rust serializes integral f64 timestamps/timings with `.0`. Reserve for every
  // integer (a conservative upper bound), plus CLI discovery metadata.
  const size = () =>
    new TextEncoder().encode(JSON.stringify(result, null, 2)).byteLength +
    integerCount(result) * 2 +
    (params.action === "capabilities" ? 1024 : 0);
  for (const request of [...(result.requests ?? []), ...(result.request ? [result.request] : [])]) {
    if (request.url.startsWith("data:")) {
      request.url = compactUrl(request.url);
      omit("inline_url_content");
    }
    const projected = projectFields(request, params.fields);
    for (const key of DEBUG_FIELDS) if (!(key in projected)) delete request[key];
  }
  if (size() <= budget) return result;
  // Large narrative page snapshots are independently available through pages/request reads.
  const shorten = (object: unknown, path: string): void => {
    if (!object || typeof object !== "object") return;
    for (const [key, value] of Object.entries(object)) {
      const at = path ? `${path}.${key}` : key;
      if (
        typeof value === "string" &&
        value.length > 240 &&
        !["id", "run_id", "session_id"].includes(key)
      ) {
        (object as Record<string, unknown>)[key] = `${prefix(value, 200)}…`;
        omit(at);
      } else if (value && typeof value === "object") shorten(value, at);
    }
  };
  // Lists paginate at whole entries so the continuation never skips hidden rows.
  if (params.action === "requests" || params.action === "operations") {
    const entries = params.action === "requests" ? result.requests! : result.operations!;
    while (entries.length > 1 && size() > budget) {
      entries.pop();
      omit(params.action);
    }
    if (output.omitted.includes(params.action)) {
      result.next_since = entries.at(-1)?.sequence ?? value.next_since;
      result.truncated = true;
    }
  }
  if (params.action === "pages" || params.action === "console") {
    const entries = result[params.action] ?? [];
    while (entries.length > 1 && size() > budget) {
      entries.pop();
      omit(params.action);
    }
    if (output.omitted.includes(params.action)) {
      result.next_offset = (params.offset ?? 0) + entries.length;
      result.truncated = true;
    }
  }
  if (size() > budget) {
    shorten(result.run, "run");
    for (const key of [
      "operation",
      "operations",
      "evidence",
      "pages",
      "console",
      "rules",
      "requests",
    ] as const) {
      if (size() <= budget) break;
      shorten(result[key], key);
    }
  }
  // Free metadata space first; selected body slices must always make progress.
  if (result.request && size() > budget) {
    const entry = result.request;
    for (const key of ["request_headers", "response_headers", "timing", "initiator"] as const) {
      if (size() <= budget) break;
      if (entry[key] !== undefined) {
        delete entry[key];
        omit(`request.${key}`);
      }
    }
    if (entry.url.length > 200) {
      entry.url = prefix(entry.url, 200);
      omit("request.url");
    }
    shorten(result.run, "run");
    // Body reads preserve exact content and return an adjusted UTF-16 offset.
    for (const key of ["request_body", "response_body"] as const) {
      const body = entry[key];
      if (body.text === undefined || size() <= budget) continue;
      const original = body.text;
      const originalNext = body.next_offset;
      omit(`request.${key}.text`);
      let low = 0,
        high = original.length;
      body.next_offset = (body.offset ?? 0) + original.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        body.text = original.slice(0, middle);
        if (size() <= budget) low = middle;
        else high = middle - 1;
      }
      if (!low && original.length)
        throw new Error(
          "output budget too small for body slice; increase budget or select fewer fields",
        );
      low = prefix(original, low).length;
      if (!low && original.length)
        throw new Error("increase budget for a complete Unicode character");
      body.text = original.slice(0, low);
      body.next_offset = low < original.length ? (body.offset ?? 0) + low : originalNext;
    }
  }
  for (const key of [
    "evidence",
    "pages",
    "console",
    "rules",
    "replays",
    "requests",
    "operations",
    "runs",
  ] as const) {
    if (size() <= budget) break;
    if (
      key === params.action &&
      ["requests", "operations", "pages", "console", "rules"].includes(params.action)
    )
      continue;
    if (result[key] !== undefined) {
      delete result[key];
      omit(key);
    }
  }
  if (size() > budget && result.operation) {
    const op = result.operation;
    delete op.before;
    delete op.after;
    delete op.observations;
    op.request_ids = [];
    op.console_ids = [];
    omit("operation.details");
  }
  if (size() > budget && result.run) {
    delete result.run;
    omit("run");
  }
  if (size() > budget) throw new Error("output budget too small; increase budget");
  return result;
}
