import type {
  DraftTraceStep,
  FillCommit,
  NavigationCause,
  Step,
  TraceState,
} from "@/transport/types";
import {
  DEFAULT_FILL_COMMIT,
  fnv1a64,
  mapNavigationCause,
  nextStateId,
  resetStateIdCounterForTests,
} from "./record-constants";

const CLIPBOARD_KEYS = new Set(["a", "c", "v", "x", "A", "C", "V", "X"]);
const MODIFIER_ONLY_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "OS", "Hyper", "Super"]);

export function shouldRecordPress(
  key: string,
  modifiers?: Array<"alt" | "ctrl" | "meta" | "shift">,
): boolean {
  if (MODIFIER_ONLY_KEYS.has(key)) return false;
  const mods = modifiers ?? [];
  const hasCtrlOrMeta = mods.includes("ctrl") || mods.includes("meta");
  if (hasCtrlOrMeta && CLIPBOARD_KEYS.has(key)) return false;
  if (key === "Enter" || key === "Escape") return true;
  if (key.length === 1 && !hasCtrlOrMeta && !mods.includes("alt")) return false;
  return false;
}

function shouldIncludeDraft(step: DraftTraceStep): boolean {
  if (step.op === "fill" && !(step.value ?? "").trim() && !step.redacted) return false;
  if (step.op === "press" && !shouldRecordPress(step.key, step.modifiers)) return false;
  return true;
}

/** A reduced draft plus the capture-order ids of every draft folded into it. */
interface CollapsedDraft {
  draft: DraftTraceStep;
  draftIds: number[];
}

/**
 * Collapse a redirect chain into a single hop.
 *
 * The surviving step keeps the *first* hop's origin state and cause — that is
 * where the user was and why they left — and the *last* hop's destination, so
 * the intermediate URL the browser only passed through never becomes the
 * step's `state` or `to`.
 */
function collapseNavigations(steps: DraftTraceStep[]): CollapsedDraft[] {
  const out: CollapsedDraft[] = [];
  steps.forEach((step, index) => {
    const draftId = index + 1;
    const prev = out[out.length - 1];
    if (step.op === "navigate" && prev?.draft.op === "navigate") {
      prev.draft = {
        ...prev.draft,
        url: step.url,
        postStateId: step.postStateId ?? prev.draft.postStateId,
      };
      prev.draftIds.push(draftId);
      return;
    }
    out.push({ draft: step, draftIds: [draftId] });
  });
  return out;
}

export interface StateRegistryEntry extends TraceState {
  contentHash: string;
  rawVomText: string;
  stepsHere: number[];
}

export function stateDedupKey(body: string, url: string): string {
  return `${fnv1a64(body)}:${url}`;
}

/** Register or reuse a page observation in the states dictionary. */
export function registerObservation(
  registry: Map<string, StateRegistryEntry>,
  input: {
    url: string;
    title?: string;
    rawVomText: string;
    truncated?: boolean;
  },
): string {
  const key = stateDedupKey(input.rawVomText, input.url);
  for (const entry of registry.values()) {
    if (entry.contentHash === key) return entry.id;
  }
  const id = nextStateId();
  registry.set(id, {
    id,
    url: input.url,
    ...(input.title ? { title: input.title } : {}),
    truncated: input.truncated ?? false,
    contentHash: key,
    rawVomText: input.rawVomText,
    stepsHere: [],
  });
  return id;
}

function toSelection(
  values: string[],
  labels?: string[],
): Array<{ value: string; label?: string }> {
  return values.map((value, index) => ({
    value,
    ...(labels?.[index] ? { label: labels[index] } : {}),
  }));
}

function navigateCauseForDraft(
  draft: Extract<DraftTraceStep, { op: "navigate" }>,
): NavigationCause {
  if (draft.cause) return draft.cause;
  const mapped = mapNavigationCause({
    transitionType: draft.transitionType,
    transitionQualifiers: draft.transitionQualifiers,
  });
  return mapped ?? "browser";
}

function toV3Step(draft: DraftTraceStep, id: number): Step | null {
  if (!shouldIncludeDraft(draft)) return null;
  // An action the user really performed must not disappear because one of its
  // observations is missing — a capture racing a document swap is routine, and
  // the last step of a recording is the most exposed to it. Fall back to the
  // endpoint we do know; only a step with no observation at all has nothing to
  // point at.
  const preState = draft.preStateId ?? draft.postStateId;
  const postState = draft.postStateId ?? draft.preStateId;
  if (!preState || !postState) return null;

  const common = { id, state: preState, result: { state: postState } };

  switch (draft.op) {
    case "navigate":
      return {
        op: "navigate",
        ...common,
        to: draft.url,
        cause: navigateCauseForDraft(draft),
      };
    case "click":
      return { op: "click", ...common, target: draft.target };
    case "hover":
      return { op: "hover", ...common, target: draft.target };
    case "fill":
      return {
        op: "fill",
        ...common,
        target: draft.target,
        value: draft.value,
        commit: draft.commit ?? DEFAULT_FILL_COMMIT,
        ...(draft.redacted ? { redacted: true } : {}),
      };
    case "press":
      return {
        op: "press",
        ...common,
        key: draft.key,
        ...(draft.target ? { target: draft.target } : {}),
        ...(draft.modifiers?.length ? { modifiers: draft.modifiers } : {}),
      };
    case "select":
      return {
        op: "select",
        ...common,
        target: draft.target,
        selection: toSelection(draft.values, draft.labels),
      };
    case "scroll":
      return { op: "scroll", ...common };
  }
}

export interface ReducedTrace {
  states: TraceState[];
  steps: Step[];
  /**
   * Capture-order draft id (`draftIndex + 1`) → published step id. Collapsed
   * and dropped drafts make the two diverge, so anything the recorder tagged
   * with a draft id (`steps_here`, inline annotations) must be remapped.
   */
  stepIdByDraftId: Map<number, number>;
}

/**
 * Compile capture drafts into record-only trace v3 steps.
 * Drafts must already carry `preStateId` / `postStateId` from the recorder.
 */
export function reduceTraceSteps(
  steps: DraftTraceStep[],
  registry: Map<string, StateRegistryEntry>,
): ReducedTrace {
  const collapsed = collapseNavigations(steps);
  const out: Step[] = [];
  const stepIdByDraftId = new Map<number, number>();
  let id = 1;
  for (const { draft, draftIds } of collapsed) {
    const step = toV3Step(draft, id);
    if (!step) continue;
    out.push(step);
    for (const draftId of draftIds) stepIdByDraftId.set(draftId, id);
    id += 1;
  }
  const states = [...registry.values()].map(
    ({ contentHash: _hash, rawVomText: _body, stepsHere: _steps, ...state }) => state,
  );
  return { states, steps: out, stepIdByDraftId };
}

export function resolveTraceStartUrl(
  drafts: DraftTraceStep[],
  startUrl?: string,
  states?: TraceState[],
): string {
  if (startUrl) return startUrl;
  const navigate = drafts.find((step): step is Extract<DraftTraceStep, { op: "navigate" }> => {
    return step.op === "navigate";
  });
  if (navigate) return navigate.url;
  for (const draft of drafts) {
    if ("page_url" in draft && draft.page_url) return draft.page_url;
  }
  return states?.[0]?.url ?? "about:blank";
}

export type { FillCommit, NavigationCause };
/** Test seam */
export { resetStateIdCounterForTests };
