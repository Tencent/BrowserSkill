import type { RecordStepPayload } from "../record-bridge";
import type { RecordingDraftStep } from "./types";

export interface RecordingStepBuffer {
  steps: RecordingDraftStep[];
  currentUrl?: string;
  pendingNavigation: boolean;
  pendingNavigationDeadline?: number;
}

const NAVIGATION_TRIGGER_WINDOW_MS = 3_000;

function toDraftStep(payload: RecordStepPayload): RecordingDraftStep | null {
  const pageUrl = payload.page_url;
  switch (payload.op) {
    case "click":
      return payload.target
        ? {
            op: "click",
            captureTarget: payload.target,
            ...(pageUrl ? { pageUrl } : {}),
          }
        : null;
    case "hover":
      return payload.target
        ? {
            op: "hover",
            captureTarget: payload.target,
            ...(pageUrl ? { pageUrl } : {}),
          }
        : null;
    case "fill":
      return payload.target
        ? {
            op: "fill",
            captureTarget: payload.target,
            value: payload.value ?? "",
            ...(payload.redacted ? { redacted: true } : {}),
            ...(pageUrl ? { pageUrl } : {}),
          }
        : null;
    case "press":
      return payload.key
        ? {
            op: "press",
            key: payload.key,
            ...(payload.target ? { captureTarget: payload.target } : {}),
            ...(payload.modifiers?.length ? { modifiers: payload.modifiers } : {}),
            ...(pageUrl ? { pageUrl } : {}),
          }
        : null;
    case "select":
      return payload.target && payload.values
        ? {
            op: "select",
            captureTarget: payload.target,
            values: payload.values,
            ...(payload.labels?.length ? { labels: payload.labels } : {}),
            ...(pageUrl ? { pageUrl } : {}),
          }
        : null;
    case "navigate":
      return null;
  }
}

function annotateLastStepNavigation(buffer: RecordingStepBuffer, url: string): boolean {
  for (let i = buffer.steps.length - 1; i >= 0; i -= 1) {
    const step = buffer.steps[i];
    if (!step) continue;
    if (step.op === "click" || step.op === "press" || step.op === "select") {
      buffer.steps[i] = { ...step, navigatedTo: url };
      return true;
    }
    break;
  }
  return false;
}

export function observeRecordedNavigation(
  buffer: RecordingStepBuffer,
  url: string,
  causedByAction?: boolean,
): void {
  if (!url || url === buffer.currentUrl) return;
  buffer.currentUrl = url;
  const pendingIsCurrent =
    buffer.pendingNavigation &&
    (buffer.pendingNavigationDeadline === undefined ||
      buffer.pendingNavigationDeadline >= Date.now());

  if (causedByAction === true || (causedByAction === undefined && pendingIsCurrent)) {
    buffer.pendingNavigation = false;
    buffer.pendingNavigationDeadline = undefined;
    if (!annotateLastStepNavigation(buffer, url)) {
      buffer.steps.push({
        op: "navigate",
        url,
        pageUrl: url,
      });
    }
    return;
  }

  buffer.pendingNavigation = false;
  buffer.pendingNavigationDeadline = undefined;
  buffer.steps.push({
    op: "navigate",
    url,
    pageUrl: url,
  });
}

export function appendRecordedPayload(
  buffer: RecordingStepBuffer,
  payload: RecordStepPayload,
): void {
  if (payload.op === "navigate") {
    if (payload.url) {
      observeRecordedNavigation(buffer, payload.url, payload.navigation_caused_by_action);
    }
    return;
  }
  const step = toDraftStep({
    ...payload,
    page_url: payload.page_url ?? buffer.currentUrl,
  });
  if (!step) return;
  buffer.steps.push(step);
  if (step.op === "click" || step.op === "press" || step.op === "select" || step.op === "fill") {
    buffer.pendingNavigation = payload.expects_navigation === true;
    buffer.pendingNavigationDeadline = buffer.pendingNavigation
      ? Date.now() + NAVIGATION_TRIGGER_WINDOW_MS
      : undefined;
  }
}
