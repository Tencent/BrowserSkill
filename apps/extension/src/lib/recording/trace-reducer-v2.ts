import type { PageRefV2, SelectedOptionV2, StepV2, TraceV2 } from "@/transport/types";
import { resolveDraftStartUrl, shouldIncludeDraft } from "./draft-policy";
import type { RecordingDraftStep } from "./types";

/** Collapse consecutive navigations to the last hop. */
function collapseNavigations(steps: RecordingDraftStep[]): RecordingDraftStep[] {
  const out: RecordingDraftStep[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    if (step.op === "navigate" && prev?.op === "navigate") {
      out[out.length - 1] = step;
      continue;
    }
    out.push(step);
  }
  return out;
}

function collectUrls(steps: RecordingDraftStep[], startUrl?: string): string[] {
  const urls: string[] = [];
  if (startUrl) urls.push(startUrl);
  for (const step of steps) {
    if (step.op === "navigate") {
      urls.push(step.url);
      continue;
    }
    if (step.pageUrl) urls.push(step.pageUrl);
    if ("navigatedTo" in step && step.navigatedTo) urls.push(step.navigatedTo);
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }
  return unique;
}

function buildPageRegistry(
  steps: RecordingDraftStep[],
  startUrl?: string,
): { pages: PageRefV2[]; urlToId: Map<string, string> } {
  const urls = collectUrls(steps, startUrl);
  const urlToId = new Map<string, string>();
  const pages = urls.map((url, index) => {
    const id = `p${index + 1}`;
    urlToId.set(url, id);
    return { id, url };
  });
  return { pages, urlToId };
}

function pageIdFor(
  url: string | undefined,
  urlToId: Map<string, string>,
  fallbackUrl?: string,
): string {
  if (url && urlToId.has(url)) return urlToId.get(url)!;
  if (fallbackUrl && urlToId.has(fallbackUrl)) return urlToId.get(fallbackUrl)!;
  return urlToId.values().next().value ?? "p1";
}

function pageUrlForDraft(step: RecordingDraftStep, fallbackUrl?: string): string | undefined {
  if (step.op === "navigate") return step.pageUrl ?? step.url;
  if (step.pageUrl) return step.pageUrl;
  return fallbackUrl;
}

function effectForNavigation(
  navigatedTo: string | undefined,
  urlToId: Map<string, string>,
): StepV2["effect"] {
  if (!navigatedTo) return undefined;
  const pageId = urlToId.get(navigatedTo);
  if (!pageId) return undefined;
  return { navigated_to: pageId };
}

function withEffect(step: StepV2, effect: StepV2["effect"]): StepV2 {
  if (!effect) return step;
  return { ...step, effect };
}

function toSelection(values: string[], labels?: string[]): SelectedOptionV2[] {
  return values.map((value, index) => ({
    value,
    ...(labels?.[index] ? { label: labels[index] } : {}),
  }));
}

function toV2Step(
  step: RecordingDraftStep,
  id: number,
  urlToId: Map<string, string>,
  fallbackUrl?: string,
): StepV2 | null {
  if (!shouldIncludeDraft(step)) return null;

  const pageUrl = pageUrlForDraft(step, fallbackUrl);
  const page = pageIdFor(pageUrl, urlToId, fallbackUrl);

  switch (step.op) {
    case "navigate":
      return {
        op: "navigate",
        id,
        page: pageIdFor(step.url, urlToId, fallbackUrl),
        to: step.url,
      };
    case "click":
      if (!step.captureTarget) return null;
      return withEffect(
        {
          op: "click",
          id,
          page,
          target: step.captureTarget,
        },
        effectForNavigation(step.navigatedTo, urlToId),
      );
    case "fill":
      if (!step.captureTarget) return null;
      return {
        op: "fill",
        id,
        page,
        target: step.captureTarget,
        value: step.value,
        ...(step.redacted ? { redacted: true } : {}),
      };
    case "press":
      return withEffect(
        {
          op: "press",
          id,
          page,
          key: step.key,
          ...(step.captureTarget ? { target: step.captureTarget } : {}),
          ...(step.modifiers?.length ? { modifiers: step.modifiers } : {}),
        },
        effectForNavigation(step.navigatedTo, urlToId),
      );
    case "select":
      if (!step.captureTarget) return null;
      return withEffect(
        {
          op: "select",
          id,
          page,
          target: step.captureTarget,
          selection: toSelection(step.values, step.labels),
        },
        effectForNavigation(step.navigatedTo, urlToId),
      );
    // `hover` only exists in Trace v3. Peers that negotiate v2 predate the
    // step variant and fail to decode the whole result if we emit it.
    case "hover":
    case "scroll":
    case "switch_tab":
      return null;
  }
}

interface ReducedTrace {
  pages: PageRefV2[];
  steps: StepV2[];
}

/**
 * Compile capture drafts into record-only trace v2 steps.
 * Variable inputs are NOT classified here — executing agents infer that at run time.
 */
function reduceTraceSteps(steps: RecordingDraftStep[], startUrl?: string): ReducedTrace {
  const collapsed = collapseNavigations(steps);
  const { pages, urlToId } = buildPageRegistry(collapsed, startUrl);
  const out: StepV2[] = [];
  let id = 1;
  let lastUrl = startUrl;
  for (const draft of collapsed) {
    if (draft.op === "navigate") lastUrl = draft.url;
    else if ("navigatedTo" in draft && draft.navigatedTo) lastUrl = draft.navigatedTo;
    else if (draft.pageUrl) lastUrl = draft.pageUrl;
    const step = toV2Step(draft, id, urlToId, lastUrl);
    if (!step) continue;
    out.push(step);
    id += 1;
  }
  return { pages, steps: out };
}

function resolveTraceStartUrl(
  drafts: RecordingDraftStep[],
  startUrl?: string,
  pages?: PageRefV2[],
): string {
  return resolveDraftStartUrl(drafts, startUrl, pages?.[0]?.url);
}

export function buildTraceV2(input: {
  steps: RecordingDraftStep[];
  startedAt: string;
  startUrl?: string;
  purpose?: string;
}): TraceV2 {
  const { pages, steps } = reduceTraceSteps(input.steps, input.startUrl);
  return {
    recorded_at: new Date().toISOString(),
    started_at: input.startedAt,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    entry: { start_url: resolveTraceStartUrl(input.steps, input.startUrl, pages) },
    pages,
    steps,
  };
}
