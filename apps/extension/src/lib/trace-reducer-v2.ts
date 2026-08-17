import type { CaptureTargetDescriptor } from "@/lib/describe-target";
import type { DraftTraceStep, KeyModifier } from "@/transport/types";

const CLIPBOARD_KEYS = new Set(["a", "c", "v", "x", "A", "C", "V", "X"]);
const MODIFIER_ONLY_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "OS", "Hyper", "Super"]);

export interface TargetDescriptorV2 {
  role?: string;
  name?: string;
  tag: string;
  name_attr?: string;
  placeholder?: string;
  nearby_label?: string;
}

export interface PageRef {
  id: string;
  url: string;
  title?: string;
}

export interface SelectedOptionV2 {
  value: string;
  label?: string;
}

export interface StepEffectV2 {
  navigated_to: string;
}

export type StepV2 =
  | { op: "navigate"; id: number; page: string; to: string; effect?: StepEffectV2 }
  | { op: "click"; id: number; page: string; target: TargetDescriptorV2; effect?: StepEffectV2 }
  | {
      op: "fill";
      id: number;
      page: string;
      target: TargetDescriptorV2;
      value: string;
      redacted?: boolean;
      effect?: StepEffectV2;
    }
  | {
      op: "select";
      id: number;
      page: string;
      target: TargetDescriptorV2;
      selection: SelectedOptionV2[];
      effect?: StepEffectV2;
    }
  | {
      op: "press";
      id: number;
      page: string;
      key: string;
      modifiers?: KeyModifier[];
      target?: TargetDescriptorV2;
      effect?: StepEffectV2;
    };

export interface TraceV2 {
  recorded_at: string;
  started_at?: string;
  purpose?: string;
  entry: { start_url: string };
  pages: PageRef[];
  steps: StepV2[];
}

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
  if (step.op === "scroll" || step.op === "hover") return false;
  if (step.op === "fill" && !(step.value ?? "").trim() && !step.redacted) return false;
  if (step.op === "press" && !shouldRecordPress(step.key, step.modifiers)) return false;
  return true;
}

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
): StepEffectV2 | undefined {
  if (!navigatedTo) return undefined;
  const pageId = urlToId.get(navigatedTo);
  if (!pageId) return undefined;
  return { navigated_to: pageId };
}

function captureTargetToV2Target(capture?: CaptureTargetDescriptor): TargetDescriptorV2 {
  return {
    tag: capture?.tag ?? "unknown",
    ...(capture?.role ? { role: capture.role } : {}),
    ...(capture?.name ? { name: capture.name } : {}),
    ...(capture?.name_attr ? { name_attr: capture.name_attr } : {}),
    ...(capture?.placeholder ? { placeholder: capture.placeholder } : {}),
    ...(capture?.nearby_label ? { nearby_label: capture.nearby_label } : {}),
  };
}

function targetForDraft(step: DraftTraceStep): TargetDescriptorV2 | undefined {
  if (!("target" in step) && !("captureTarget" in step)) return undefined;
  const capture = "captureTarget" in step ? step.captureTarget : undefined;
  if (capture) return captureTargetToV2Target(capture);
  if ("target" in step && step.target && "tag" in (step.target as object)) {
    const legacy = step.target as TargetDescriptorV2 & { tag?: string };
    if (legacy.tag) return legacy;
  }
  return undefined;
}

function toSelection(values: string[], labels?: string[]): SelectedOptionV2[] {
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
): StepV2 | null {
  if (!shouldIncludeDraft(step)) return null;

  const pageUrl = pageUrlForDraft(step, fallbackUrl);
  const page = pageIdFor(pageUrl, urlToId, fallbackUrl);
  const effect =
    "navigated_to" in step ? effectForNavigation(step.navigated_to, urlToId) : undefined;

  switch (step.op) {
    case "navigate":
      return {
        op: "navigate",
        id,
        page: pageIdFor(step.url, urlToId, fallbackUrl),
        to: step.url,
      };
    case "click": {
      const target = targetForDraft(step);
      if (!target) return null;
      return { op: "click", id, page, target, ...(effect ? { effect } : {}) };
    }
    case "hover":
      return null;
    case "fill": {
      const target = targetForDraft(step);
      if (!target) return null;
      return {
        op: "fill",
        id,
        page,
        target,
        value: step.value,
        ...(step.redacted ? { redacted: true } : {}),
      };
    }
    case "press":
      return {
        op: "press",
        id,
        page,
        key: step.key,
        ...(step.target ? { target: targetForDraft(step) } : {}),
        ...(step.modifiers?.length ? { modifiers: step.modifiers } : {}),
        ...(effect ? { effect } : {}),
      };
    case "select": {
      const target = targetForDraft(step);
      if (!target) return null;
      return {
        op: "select",
        id,
        page,
        target,
        selection: toSelection(step.values, step.labels),
        ...(effect ? { effect } : {}),
      };
    }
    case "scroll":
      return null;
  }
}

export interface BuildTraceV2Input {
  steps: DraftTraceStep[];
  startedAt: string;
  startUrl?: string;
  purpose?: string;
}

export function buildTraceV2(input: BuildTraceV2Input): TraceV2 {
  const collapsed = collapseNavigations(input.steps);
  const startUrl =
    input.startUrl ??
    collapsed.find(
      (step): step is Extract<DraftTraceStep, { op: "navigate" }> => step.op === "navigate",
    )?.url ??
    collapsed.find((step) => "page_url" in step && step.page_url)?.page_url ??
    "about:blank";
  const { pages, urlToId } = buildPageRegistry(collapsed, startUrl);
  const out: StepV2[] = [];
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
  return {
    recorded_at: new Date().toISOString(),
    started_at: input.startedAt,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    entry: { start_url: startUrl },
    pages,
    steps: out,
  };
}
