import type { NavigationCause, StepV3 } from "@/transport/types";
import { shouldIncludeDraft } from "./draft-policy";
import { unmatchedTarget } from "./target-matcher";
import type { RecordingDraftStep } from "./types";

interface CollapsedDraft {
  draft: RecordingDraftStep;
  draftIds: number[];
}

const REDIRECT_QUALIFIERS = new Set(["client_redirect", "server_redirect"]);
const TRANSITION_CAUSES: Record<string, NavigationCause> = {
  typed: "user_typed",
  generated: "user_typed",
  keyword: "user_typed",
  keyword_generated: "user_typed",
  link: "link",
  form_submit: "form_submit",
  reload: "reload",
  auto_bookmark: "browser",
  start_page: "browser",
};

function isRedirect(step: Extract<RecordingDraftStep, { op: "navigate" }>): boolean {
  return (step.transitionQualifiers ?? []).some((qualifier) => REDIRECT_QUALIFIERS.has(qualifier));
}

function collapseRedirects(steps: RecordingDraftStep[]): CollapsedDraft[] {
  const output: CollapsedDraft[] = [];
  steps.forEach((step, index) => {
    const previous = output[output.length - 1];
    if (step.op === "navigate" && previous?.draft.op === "navigate" && isRedirect(step)) {
      previous.draft = {
        ...previous.draft,
        url: step.url,
        postStateId: step.postStateId ?? previous.draft.postStateId,
      };
      previous.draftIds.push(index + 1);
      return;
    }
    output.push({ draft: { ...step }, draftIds: [index + 1] });
  });
  return output;
}

function navigationCause(step: Extract<RecordingDraftStep, { op: "navigate" }>): NavigationCause {
  if (step.cause) return step.cause;
  const qualifiers = step.transitionQualifiers ?? [];
  if (qualifiers.includes("forward_back")) return "history";
  if (qualifiers.includes("from_address_bar")) return "user_typed";
  return TRANSITION_CAUSES[step.transitionType ?? ""] ?? "browser";
}

function selection(values: string[], labels?: string[]): Array<{ value: string; label?: string }> {
  return values.map((value, index) => ({
    value,
    ...(labels?.[index] ? { label: labels[index] } : {}),
  }));
}

function reduceDraft(draft: RecordingDraftStep, id: number): StepV3 | null {
  if (!shouldIncludeDraft(draft)) return null;
  const state = draft.preStateId ?? draft.postStateId;
  const resultState = draft.postStateId ?? draft.preStateId;
  if (!state || !resultState) return null;
  const common = { id, state, result: { state: resultState } };

  switch (draft.op) {
    case "navigate":
      return { op: "navigate", ...common, to: draft.url, cause: navigationCause(draft) };
    case "click":
      return {
        op: "click",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
      };
    case "hover":
      return {
        op: "hover",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
      };
    case "fill":
      return {
        op: "fill",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
        value: draft.value,
        commit: draft.commit ?? "blur",
        ...(draft.redacted ? { redacted: true } : {}),
      };
    case "press":
      return {
        op: "press",
        ...common,
        key: draft.key,
        ...(draft.captureTarget || draft.matchedTarget
          ? { target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget) }
          : {}),
        ...(draft.modifiers?.length ? { modifiers: draft.modifiers } : {}),
      };
    case "select":
      return {
        op: "select",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
        selection: selection(draft.values, draft.labels),
      };
    case "scroll":
      return { op: "scroll", ...common };
  }
}

export interface ReducedTraceV3 {
  steps: StepV3[];
  stepIdByDraftId: Map<number, number>;
}

export function reduceTraceStepsV3(steps: RecordingDraftStep[]): ReducedTraceV3 {
  const output: StepV3[] = [];
  const stepIdByDraftId = new Map<number, number>();
  for (const { draft, draftIds } of collapseRedirects(steps)) {
    const step = reduceDraft(draft, output.length + 1);
    if (!step) continue;
    output.push(step);
    for (const draftId of draftIds) stepIdByDraftId.set(draftId, step.id);
  }
  return { steps: output, stepIdByDraftId };
}
