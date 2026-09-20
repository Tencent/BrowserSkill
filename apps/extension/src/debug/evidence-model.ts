import type {
  DebugConsole,
  DebugEvidence,
  DebugField,
  DebugOperation,
  DebugPage,
  DebugRecording,
  DebugRequest,
  DebugValue,
} from "./types";

export function requestKind(request: DebugRequest): "business" | "resource" | "extension" {
  if (
    /^(?:chrome|moz)-extension:/.test(request.url) ||
    /(?:chrome|moz)-extension:\/\//.test(request.initiator ?? "")
  )
    return "extension";
  if (
    ["Fetch", "XHR", "Document"].includes(request.resource_type ?? "") ||
    !["GET", "HEAD"].includes(request.method) ||
    /json/.test(request.mime_type ?? "")
  )
    return "business";
  return "resource";
}

export function consoleSource(
  url?: string,
  browserSource?: string,
): NonNullable<DebugConsole["source"]> {
  if (/^(?:chrome|moz)-extension:/.test(url ?? "")) return "extension";
  if (
    browserSource &&
    ["deprecation", "intervention", "violation", "security"].includes(browserSource)
  )
    return "browser";
  if (/^https?:/.test(url ?? "")) return "website";
  return "unknown";
}

export function relatedRequests(
  recording: DebugRecording,
  operation: DebugOperation,
): DebugEvidence["links"] {
  const { immediate, end, next_start } = operationWindow(recording, operation);
  return recording.requests
    .filter(
      (request) =>
        request.started_at >= operation.started_at &&
        request.started_at <= end &&
        request.started_at < next_start,
    )
    .map((request) => ({
      request_id: request.id,
      relation: request.started_at <= immediate ? "window" : "delayed",
    }));
}
export function operationWindow(
  recording: DebugRecording,
  operation: DebugOperation,
): { immediate: number; end: number; next_start: number } {
  const index = recording.operations.findIndex((item) => item.id === operation.id);
  const next = index >= 0 ? recording.operations[index + 1] : undefined;
  const immediate = operation.window_end ?? operation.finished_at ?? operation.started_at;
  const end = Math.min(
    operation.observation_end ?? immediate,
    next?.started_at ?? Infinity,
    recording.run.stopped_at ?? Infinity,
  );
  return { immediate, end, next_start: next?.started_at ?? Infinity };
}

function fields(page?: DebugPage): DebugField[] {
  return page?.fields ?? [];
}
function uniqueField(page: DebugPage | undefined, key: string): DebugField | undefined {
  const matches = fields(page).filter((field) => field.key === key);
  return matches.length === 1 ? matches[0] : undefined;
}
function value(
  field: DebugField | undefined,
  page: DebugPage | undefined,
  source: string,
): DebugValue {
  return field
    ? { state: field.state, value: field.value, source, at: page?.at }
    : { state: "not_recorded" };
}

interface Leaf {
  path: string;
  name: string;
  value: string;
  truncated: boolean;
}
function payload(request: DebugRequest, part: "request" | "response"): Leaf[] {
  const body = part === "request" ? request.request_body : request.response_body;
  if (body.state !== "available" || !body.text || body.text.length > 65536) return [];
  const result: Leaf[] = [];
  const visit = (data: unknown, path: string, name: string, depth: number) => {
    if (depth > 5 || result.length >= 32) return;
    if (data !== null && typeof data === "object") {
      if (Array.isArray(data)) return; // Array indices and repeated names are not field identities.
      for (const [key, child] of Object.entries(data).slice(0, 32))
        visit(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, key, depth + 1);
    } else
      result.push({
        path,
        name,
        value: String(data).slice(0, 256),
        truncated: String(data).length > 256,
      });
  };
  try {
    visit(JSON.parse(body.text), "", "", 0);
  } catch {
    if (
      part === "request" &&
      /x-www-form-urlencoded/.test(request.request_headers?.["content-type"] ?? "")
    ) {
      for (const [name, raw] of new URLSearchParams(body.text)) {
        if (result.length === 32) break;
        result.push({ name, path: name, value: raw.slice(0, 256), truncated: raw.length > 256 });
      }
    }
  }
  return result;
}

/** Conservative, deterministic projections of retained facts; no semantic/causal inference. */
export function operationEvidence(
  record: DebugRecording,
  operation: DebugOperation,
): DebugEvidence {
  const links = relatedRequests(record, operation);
  const requests = record.requests.filter((request) =>
    links.some((link) => link.request_id === request.id),
  );
  const gaps = new Set<string>(
    record.run.coverage.filter((value) => value.startsWith("evidence_")),
  );
  if (operation.state === "running") gaps.add("operation_running");
  if (operation.state === "interrupted") gaps.add("operation_interrupted");
  if (record.run.dropped_requests || record.run.dropped_operations || record.run.dropped_console)
    gaps.add("capacity_limit");
  if (record.run.coverage.includes("initial_load_not_recorded"))
    gaps.add("initial_load_not_recorded");
  if (record.run.coverage.includes("manual_capture_unavailable"))
    gaps.add("manual_capture_unavailable");
  if (record.run.coverage.includes("interrupted_checkpoint")) gaps.add("interrupted_checkpoint");
  if (operation.observation_limited) gaps.add("observation_limit");
  if (operation.before?.state !== "available") gaps.add("before_unavailable");
  if (!operation.before?.fields || operation.before.fields_partial) gaps.add("fields_partial");
  if (!operation.after || operation.after.state !== "available") gaps.add("after_unavailable");
  if (operation.before?.truncated || operation.after?.truncated) gaps.add("page_truncated");
  for (const request of requests.filter((item) => requestKind(item) === "business")) {
    if (request.intervention) gaps.add(`control_${request.intervention.type}`);
    if (request.intervention?.state === "pending") gaps.add("control_pending");
    if (request.intervention && ["failed", "cancelled"].includes(request.intervention.state))
      gaps.add("control_failed");
    if (request.replay_from) gaps.add("request_replayed");
    if (request.state === "pending") gaps.add("request_pending");
    if (request.state === "interrupted") gaps.add("request_interrupted");
    for (const body of [request.request_body, request.response_body]) {
      if (!["empty", "available"].includes(body.state)) gaps.add(`body_${body.state}`);
    }
  }
  const prior = record.operations.slice(
    0,
    Math.max(
      0,
      record.operations.findIndex((item) => item.id === operation.id),
    ),
  );
  const boundary = prior.findLastIndex(
    (item) => !["tool.fill", "tool.select"].includes(item.method),
  );
  const inputs = prior.slice(boundary + 1);
  if (["tool.fill", "tool.select"].includes(operation.method)) inputs.push(operation);
  const inputPage =
    [operation.before, ...inputs.flatMap((item) => [item.before, item.after])]
      .filter((page): page is DebugPage => !!page)
      .sort((a, b) => a.at - b.at)
      .at(-1) ?? operation.before;
  const nextLoad = record.pages.find(
    (page) =>
      page.at > operation.started_at &&
      !!page.navigation &&
      fields(page).some((field) => fields(inputPage).some((input) => input.key === field.key)),
  );
  if (
    nextLoad &&
    record.operations.some(
      (item) =>
        item.started_at > operation.started_at &&
        item.started_at < nextLoad.at &&
        !["tool.navigate", "tool.reload"].includes(item.method),
    )
  )
    gaps.add("intervening_operations");
  if (
    fields(inputPage).some(
      (field) =>
        field.state === "truncated" ||
        fields(inputPage).filter((item) => item.key === field.key).length > 1,
    )
  )
    gaps.add("fields_partial");
  const navigation = nextLoad
    ? record.operations.findLast(
        (item) =>
          item.started_at > operation.started_at &&
          item.started_at <= nextLoad.at &&
          ["tool.navigate", "tool.reload"].includes(item.method),
      )
    : undefined;
  const loadedPage =
    nextLoad && navigation?.after?.state === "available" && navigation.after.at >= nextLoad.at
      ? { ...navigation.after, navigation: nextLoad.navigation }
      : nextLoad;
  const observations = [...(operation.observations ?? []), ...(loadedPage ? [loadedPage] : [])]
    .sort((a, b) => a.at - b.at)
    .slice(-9);
  const laterPage = loadedPage ?? observations.at(-1) ?? operation.after;
  const leaves = requests
    .filter(
      (item) =>
        requestKind(item) === "business" &&
        !item.replay_from &&
        (!item.intervention ||
          (item.intervention.state === "applied" && item.intervention.type !== "block")),
    )
    .slice(0, 12)
    .flatMap((request) =>
      (["request", "response"] as const).map((part) => ({
        request,
        part,
        leaves: payload(request, part),
      })),
    );
  const payloads: DebugEvidence["payloads"] = leaves
    .flatMap(({ request, part, leaves }) =>
      leaves.map((leaf) => ({
        request_id: request.id,
        part,
        path: leaf.path,
        value: leaf.value,
        ...(leaf.truncated ? { truncated: true } : {}),
      })),
    )
    .slice(0, 96);
  const traces = fields(inputPage)
    .filter((field, _index, all) => all.filter((item) => item.key === field.key).length === 1)
    .slice(0, 16)
    .map((field) => {
      const originalPage =
        inputs.find((item) => uniqueField(item.before, field.key))?.before ?? operation.before;
      const exact = (part: "request" | "response"): DebugValue[] =>
        leaves
          .filter((item) => item.part === part)
          .flatMap((item) => {
            const matches = item.leaves.filter((leaf) => leaf.name === field.name);
            const body =
              part === "request" ? item.request.request_body : item.request.response_body;
            if (!["available", "empty"].includes(body.state))
              return [{ state: `body_${body.state}`, source: item.request.id }];
            return matches.length === 1
              ? [
                  {
                    state:
                      matches[0].value === "[redacted]"
                        ? "redacted"
                        : matches[0].truncated
                          ? "truncated"
                          : "available",
                    value: matches[0].value,
                    source: `${item.request.id} ${matches[0].path}`,
                    at: part === "request" ? item.request.started_at : item.request.finished_at,
                  },
                ]
              : [];
          });
      return {
        key: field.key,
        label: field.label,
        before: value(uniqueField(originalPage, field.key), originalPage, "before"),
        input: value(field, inputPage, "input"),
        submitted: exact("request"),
        response: exact("response"),
        later: value(
          uniqueField(laterPage, field.key),
          laterPage,
          nextLoad ? `page:${nextLoad.navigation}` : "after",
        ),
      };
    });
  const comparable =
    operation.before?.state === "available" &&
    operation.after?.state === "available" &&
    typeof operation.before.text === "string" &&
    typeof operation.after.text === "string";
  const before = (comparable ? (operation.before?.text ?? "") : "").split("\n").filter(Boolean);
  const after = (comparable ? (operation.after?.text ?? "") : "").split("\n").filter(Boolean);
  const added = after.filter((line) => !before.includes(line));
  const removed = before.filter((line) => !after.includes(line));
  return {
    fields: traces,
    payloads,
    links,
    gaps: [...gaps],
    changes: {
      added: added.slice(0, 16),
      removed: removed.slice(0, 16),
      truncated:
        added.length > 16 ||
        removed.length > 16 ||
        !!operation.before?.truncated ||
        !!operation.after?.truncated,
    },
    observations,
  };
}
