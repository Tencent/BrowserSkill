import type { DraftTraceStep, NavigationCause } from "@/transport/types";
import type { RecordStepPayload } from "./record-bridge";
import { mapNavigationCause } from "./record-constants";

export interface RecordingStepBuffer {
  steps: DraftTraceStep[];
  currentUrl?: string;
  pendingNavigation: boolean;
  pendingNavigationDeadline?: number;
  lastTransitionType?: string;
  lastTransitionQualifiers?: string[];
}

const NAVIGATION_TRIGGER_WINDOW_MS = 3_000;

function toDraftStep(payload: RecordStepPayload): DraftTraceStep | null {
  const pageUrl = payload.page_url;
  const geometry = payload.geometry;
  switch (payload.op) {
    case "click":
      return payload.target
        ? {
            op: "click",
            target: { unmatched: true },
            captureTarget: payload.target,
            ...(geometry ? { geometry } : {}),
            ...(pageUrl ? { page_url: pageUrl } : {}),
          }
        : null;
    case "hover":
      return payload.target
        ? {
            op: "hover",
            target: { unmatched: true },
            captureTarget: payload.target,
            ...(geometry ? { geometry } : {}),
            ...(pageUrl ? { page_url: pageUrl } : {}),
          }
        : null;
    case "fill":
      return payload.target
        ? {
            op: "fill",
            target: { unmatched: true },
            captureTarget: payload.target,
            ...(geometry ? { geometry } : {}),
            value: payload.value ?? "",
            ...(payload.commit ? { commit: payload.commit } : {}),
            ...(payload.redacted ? { redacted: true } : {}),
            ...(pageUrl ? { page_url: pageUrl } : {}),
          }
        : null;
    case "press":
      return payload.key
        ? {
            op: "press",
            key: payload.key,
            ...(payload.target
              ? { target: { unmatched: true }, captureTarget: payload.target }
              : {}),
            ...(geometry ? { geometry } : {}),
            ...(payload.modifiers?.length ? { modifiers: payload.modifiers } : {}),
            ...(pageUrl ? { page_url: pageUrl } : {}),
          }
        : null;
    case "select":
      return payload.target && payload.values
        ? {
            op: "select",
            target: { unmatched: true },
            captureTarget: payload.target,
            ...(geometry ? { geometry } : {}),
            values: payload.values,
            ...(payload.labels?.length ? { labels: payload.labels } : {}),
            ...(pageUrl ? { page_url: pageUrl } : {}),
          }
        : null;
    case "scroll":
      return { op: "scroll", ...(pageUrl ? { page_url: pageUrl } : {}) };
    case "navigate":
      return null;
  }
}

/** Annotate the latest action with `navigated_to`. Returns its index, or -1. */
function annotateLastStepNavigation(buffer: RecordingStepBuffer, url: string): number {
  for (let i = buffer.steps.length - 1; i >= 0; i -= 1) {
    const step = buffer.steps[i];
    if (!step) continue;
    if (step.op === "click" || step.op === "press" || step.op === "select" || step.op === "fill") {
      // Mutate in place: an in-flight settle holds this object, and replacing
      // it would strand that settle's observation on the discarded copy.
      step.navigated_to = url;
      return i;
    }
    break;
  }
  return -1;
}

function causeFromBuffer(buffer: RecordingStepBuffer): NavigationCause | null {
  return mapNavigationCause({
    transitionType: buffer.lastTransitionType,
    transitionQualifiers: buffer.lastTransitionQualifiers,
  });
}

/** Outcome of folding a main-frame URL change into the draft buffer. */
export type NavigationObserveResult =
  | { kind: "noop" }
  | { kind: "annotated"; index: number }
  | { kind: "appended"; index: number }
  /**
   * Redirect hop: do not emit a step yet. The recorder coalesces the chain and
   * emits one `navigate` after `waitForPageSettled` on the final URL.
   */
  | { kind: "coalesce_redirect"; url: string };

export function observeRecordedNavigation(
  buffer: RecordingStepBuffer,
  url: string,
  causedByAction?: boolean,
  transitionType?: string,
  transitionQualifiers?: string[],
): NavigationObserveResult {
  if (!url || url === buffer.currentUrl) return { kind: "noop" };
  buffer.currentUrl = url;
  if (transitionType !== undefined) buffer.lastTransitionType = transitionType;
  if (transitionQualifiers !== undefined) {
    buffer.lastTransitionQualifiers = transitionQualifiers;
  }

  const pendingIsCurrent =
    buffer.pendingNavigation &&
    (buffer.pendingNavigationDeadline === undefined ||
      buffer.pendingNavigationDeadline >= Date.now());

  if (causedByAction === true || (causedByAction === undefined && pendingIsCurrent)) {
    buffer.pendingNavigation = false;
    buffer.pendingNavigationDeadline = undefined;
    const annotatedIndex = annotateLastStepNavigation(buffer, url);
    if (annotatedIndex >= 0) {
      return { kind: "annotated", index: annotatedIndex };
    }
    const cause = causeFromBuffer(buffer);
    if (cause === null) {
      return { kind: "coalesce_redirect", url };
    }
    buffer.steps.push({
      op: "navigate",
      url,
      page_url: url,
      cause,
      transitionType: buffer.lastTransitionType,
      transitionQualifiers: buffer.lastTransitionQualifiers,
    });
    return { kind: "appended", index: buffer.steps.length - 1 };
  }

  buffer.pendingNavigation = false;
  buffer.pendingNavigationDeadline = undefined;
  const cause = causeFromBuffer(buffer);
  if (cause === null) {
    return { kind: "coalesce_redirect", url };
  }
  buffer.steps.push({
    op: "navigate",
    url,
    page_url: url,
    cause,
    transitionType: buffer.lastTransitionType,
    transitionQualifiers: buffer.lastTransitionQualifiers,
  });
  return { kind: "appended", index: buffer.steps.length - 1 };
}

/**
 * Buffer one captured payload. Returns the index of the draft it appended, or
 * `null` when the payload produced none (an unnamed click target, a navigation
 * that only annotated the previous draft, …). Callers must not fall back to
 * "the last draft" on `null`: that would re-match an already recorded step
 * against a newer observation and overwrite its origin state.
 */
export function appendRecordedPayload(
  buffer: RecordingStepBuffer,
  payload: RecordStepPayload,
): number | null {
  if (payload.op === "navigate") {
    if (!payload.url) return null;
    const result = observeRecordedNavigation(
      buffer,
      payload.url,
      payload.navigation_caused_by_action,
      payload.transitionType,
      payload.transitionQualifiers,
    );
    return result.kind === "appended" ? result.index : null;
  }
  const step = toDraftStep({
    ...payload,
    page_url: payload.page_url ?? buffer.currentUrl,
  });
  if (!step) return null;
  buffer.steps.push(step);
  if (step.op === "click" || step.op === "press" || step.op === "select" || step.op === "fill") {
    buffer.pendingNavigation = payload.expects_navigation === true;
    buffer.pendingNavigationDeadline = buffer.pendingNavigation
      ? Date.now() + NAVIGATION_TRIGGER_WINDOW_MS
      : undefined;
  }
  return buffer.steps.length - 1;
}
