import type { DraftTraceStep, PageRef, SelectedOption, Step } from "@/transport/types";

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
  // Drop bare character typing — FillSession already records the value.
  if (key.length === 1 && !hasCtrlOrMeta && !mods.includes("alt")) return false;
  return false;
}

function shouldIncludeDraft(step: DraftTraceStep): boolean {
  if (step.op === "fill" && !(step.value ?? "").trim() && !step.redacted) return false;
  if (step.op === "press" && !shouldRecordPress(step.key, step.modifiers)) return false;
  return true;
}

/** Collapse consecutive navigations to the last hop. */
function collapseNavigations(steps: DraftTraceStep[]): DraftTraceStep[] {
  const out: DraftTraceStep[] = [];
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

function collectUrls(steps: DraftTraceStep[], startUrl?: string): string[] {
  const urls: string[] = [];
  if (startUrl) urls.push(startUrl);
  for (const step of steps) {
    if (step.op === "navigate") {
      urls.push(step.url);
      continue;
    }
    if ("page_url" in step && step.page_url) urls.push(step.page_url);
    if ("navigated_to" in step && step.navigated_to) urls.push(step.navigated_to);
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
  steps: DraftTraceStep[],
  startUrl?: string,
): { pages: PageRef[]; urlToId: Map<string, string> } {
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

function pageUrlForDraft(step: DraftTraceStep, fallbackUrl?: string): string | undefined {
  if (step.op === "navigate") return step.page_url ?? step.url;
  if ("page_url" in step && step.page_url) return step.page_url;
  return fallbackUrl;
}

function effectForNavigation(
  navigatedTo: string | undefined,
  urlToId: Map<string, string>,
): Step["effect"] {
  if (!navigatedTo) return undefined;
  const pageId = urlToId.get(navigatedTo);
  if (!pageId) return undefined;
  return { navigated_to: pageId };
}

function withEffect(step: Step, effect: Step["effect"]): Step {
  if (!effect) return step;
  return { ...step, effect };
}

function toSelection(values: string[], labels?: string[]): SelectedOption[] {
  return values.map((value, index) => ({
    value,
    ...(labels?.[index] ? { label: labels[index] } : {}),
  }));
}

function toV2Step(
  step: DraftTraceStep,
  id: number,
  urlToId: Map<string, string>,
  fallbackUrl?: string,
): Step | null {
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
      return withEffect(
        {
          op: "click",
          id,
          page,
          target: step.target,
        },
        effectForNavigation(step.navigated_to, urlToId),
      );
    case "fill":
      return {
        op: "fill",
        id,
        page,
        target: step.target,
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
          ...(step.target ? { target: step.target } : {}),
          ...(step.modifiers?.length ? { modifiers: step.modifiers } : {}),
        },
        effectForNavigation(step.navigated_to, urlToId),
      );
    case "select":
      return withEffect(
        {
          op: "select",
          id,
          page,
          target: step.target,
          selection: toSelection(step.values, step.labels),
        },
        effectForNavigation(step.navigated_to, urlToId),
      );
  }
}

export interface ReducedTrace {
  pages: PageRef[];
  steps: Step[];
}

/**
 * Compile capture drafts into record-only trace v2 steps.
 * Variable inputs are NOT classified here — executing agents infer that at run time.
 */
export function reduceTraceSteps(steps: DraftTraceStep[], startUrl?: string): ReducedTrace {
  const collapsed = collapseNavigations(steps);
  const { pages, urlToId } = buildPageRegistry(collapsed, startUrl);
  const out: Step[] = [];
  let id = 1;
  let lastUrl = startUrl;
  for (const draft of collapsed) {
    if (draft.op === "navigate") lastUrl = draft.url;
    else if ("navigated_to" in draft && draft.navigated_to) lastUrl = draft.navigated_to;
    else if ("page_url" in draft && draft.page_url) lastUrl = draft.page_url;
    const step = toV2Step(draft, id, urlToId, lastUrl);
    if (!step) continue;
    out.push(step);
    id += 1;
  }
  return { pages, steps: out };
}

export function resolveTraceStartUrl(
  drafts: DraftTraceStep[],
  startUrl?: string,
  pages?: PageRef[],
): string {
  if (startUrl) return startUrl;
  const navigate = drafts.find((step): step is Extract<DraftTraceStep, { op: "navigate" }> => {
    return step.op === "navigate";
  });
  if (navigate) return navigate.url;
  for (const draft of drafts) {
    if ("page_url" in draft && draft.page_url) return draft.page_url;
  }
  return pages?.[0]?.url ?? "about:blank";
}
