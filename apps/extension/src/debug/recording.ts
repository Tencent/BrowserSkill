import { operationEvidence, operationWindow } from "./evidence-model";
import { requestProjection } from "./network-store";
import type { DebugParams, DebugRecording, DebugResult } from "./types";

/** Read retained data only. This path never attaches to or evaluates a website. */
export function readRecording(recording: DebugRecording, params: DebugParams): DebugResult {
  const result: DebugResult = { session_id: recording.run.session_id, run: recording.run };
  const since = params.since ?? 0;
  const limit = params.limit ?? 30;
  if (params.action === "export") return { ...result, recording };
  if (params.action === "pages") return { ...result, pages: recording.pages };
  if (params.action === "console") return { ...result, console: recording.console };
  if (params.action === "request") {
    const entry = recording.requests.find((item) => item.id === params.id);
    if (!entry) throw new Error("request not found or evicted");
    return {
      ...result,
      request: requestProjection(
        entry,
        params.part,
        params.offset,
        params.max_chars,
        params.pointer,
      ),
    };
  }
  if (params.action === "requests" || params.action === "operations") {
    const requests = params.action === "requests";
    const entries = (requests ? recording.requests : recording.operations)
      .filter((entry) => entry.sequence > since)
      .sort((a, b) => a.sequence - b.sequence);
    const page = entries.slice(0, limit);
    const data = requests
      ? {
          requests: recording.requests
            .filter((item) => page.includes(item))
            .sort((a, b) => a.sequence - b.sequence)
            .map((item) => requestProjection(item)),
        }
      : {
          operations: recording.operations
            .filter((item) => page.includes(item))
            .sort((a, b) => a.sequence - b.sequence)
            .map(
              ({ before: _before, after: _after, observations: _observations, ...item }) => item,
            ),
        };
    return {
      ...result,
      ...data,
      next_since: page.at(-1)?.sequence ?? recording.run.next_since,
      truncated:
        entries.length > limit ||
        (requests ? recording.run.dropped_requests : recording.run.dropped_operations) > 0,
    };
  }
  if (params.action === "operation") {
    const operation = recording.operations.find((entry) => entry.id === params.id);
    if (!operation) throw new Error("operation not found or evicted");
    const evidence = operationEvidence(recording, operation);
    const window = operationWindow(recording, operation);
    return {
      ...result,
      operation,
      evidence,
      requests: recording.requests
        .filter((entry) => evidence.links.some((link) => link.request_id === entry.id))
        .map((entry) => requestProjection(entry)),
      console: recording.console
        .filter(
          (entry) =>
            entry.at >= operation.started_at &&
            entry.at <= window.end &&
            entry.at < window.next_start,
        )
        .map((entry) => ({
          ...entry,
          relation: entry.at <= window.immediate ? "window" : "delayed",
        })),
    };
  }
  throw new Error("unsupported history action");
}
