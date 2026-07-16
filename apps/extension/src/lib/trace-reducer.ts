import type {
  DraftTraceStep,
  TraceImportance,
  TraceIntent,
  TraceStep,
} from "@/transport/types";
import {
  inferPageRole,
  siteFromUrl,
  summarizeNavigateShort,
  urlPatternFromUrl,
} from "./url-pattern";

const CONFIRM_NAME_RE = /发布|提交|确认|保存|创建|完成|确定|下一步|登录|注册|publish|submit|confirm|save|create|done|next|login|sign\s*up/i;
const SEARCH_NAME_RE = /搜索|查找|search|query|find/i;
const CLIPBOARD_KEYS = new Set(["a", "c", "v", "x", "A", "C", "V", "X"]);
const MODIFIER_ONLY_KEYS = new Set([
  "Meta",
  "Control",
  "Alt",
  "Shift",
  "OS",
  "Hyper",
  "Super",
]);

function previewValue(value: string, max = 48): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function targetLabel(step: DraftTraceStep): string | undefined {
  if (!("target" in step) || !step.target) return undefined;
  return step.target.name ?? step.target.nearby_label ?? step.target.placeholder ?? step.target.name_attr;
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
  // Drop bare character typing — FillSession already records the value.
  if (key.length === 1 && !hasCtrlOrMeta && !mods.includes("alt")) return false;
  return false;
}

function pageFromDraft(step: DraftTraceStep, fallbackUrl?: string) {
  const raw =
    ("page_url" in step && step.page_url) ||
    (step.op === "navigate" ? step.url : undefined) ||
    ("navigated_to" in step ? step.navigated_to : undefined) ||
    fallbackUrl;
  if (!raw) return undefined;
  const pattern = urlPatternFromUrl(raw);
  return {
    url: raw,
    url_pattern: pattern,
    role: inferPageRole(raw),
  };
}

function inferIntent(step: DraftTraceStep): TraceIntent {
  switch (step.op) {
    case "fill":
    case "select":
      return "provide_input";
    case "navigate":
      return "open_entry";
    case "press": {
      if (step.key === "Enter") {
        const label = targetLabel(step) ?? "";
        if (SEARCH_NAME_RE.test(label) || step.target?.name_attr === "q") return "search";
        return "submit_key";
      }
      if (step.key === "Escape") return "other";
      return "other";
    }
    case "click": {
      const name = step.target.name ?? "";
      if (CONFIRM_NAME_RE.test(name)) return "confirm";
      if (step.target.role === "checkbox" || step.target.role === "switch") return "toggle";
      if (step.target.role === "link") return "open_item";
      return "navigate";
    }
  }
}

function inferImportance(step: DraftTraceStep): TraceImportance {
  if (step.op === "fill" && !(step.value ?? "").trim() && !step.redacted) return "optional";
  if (step.op === "press" && !shouldRecordPress(step.key, step.modifiers)) return "optional";
  return "essential";
}

function rewriteSummary(step: DraftTraceStep): string | undefined {
  switch (step.op) {
    case "navigate":
      return summarizeNavigateShort(step.url);
    case "fill": {
      const label = targetLabel(step) ?? "输入框";
      if (step.redacted) return `在「${label}」填入 ***`;
      return `在「${label}」填入 ${previewValue(step.value)}`;
    }
    case "press": {
      const label = targetLabel(step);
      return label ? `在「${label}」按下 ${step.key}` : `按下 ${step.key}`;
    }
    case "click":
    case "select":
      return step.summary;
  }
}

function toV3Step(step: DraftTraceStep, id: number, fallbackUrl?: string): TraceStep | null {
  if (inferImportance(step) === "optional") return null;
  if (step.op === "press" && !shouldRecordPress(step.key, step.modifiers)) return null;

  const intent = inferIntent(step);
  const page = pageFromDraft(step, fallbackUrl);
  const summary = rewriteSummary(step) ?? step.summary;
  const base = {
    id,
    intent,
    importance: "essential" as const,
    ...(page ? { page } : {}),
    ...(summary ? { summary } : {}),
  };

  switch (step.op) {
    case "click": {
      const nav = step.navigated_to;
      return {
        ...base,
        op: "click",
        target: step.target,
        ...(nav
          ? {
              effect: {
                navigated_to: nav,
                url_pattern_after: urlPatternFromUrl(nav),
              },
            }
          : {}),
      };
    }
    case "fill":
      return {
        ...base,
        op: "fill",
        target: step.target,
        value: step.value,
        ...(step.redacted ? { redacted: true } : {}),
      };
    case "press": {
      const nav = step.navigated_to;
      return {
        ...base,
        op: "press",
        key: step.key,
        ...(step.target ? { target: step.target } : {}),
        ...(step.modifiers?.length ? { modifiers: step.modifiers } : {}),
        ...(nav
          ? {
              effect: {
                navigated_to: nav,
                url_pattern_after: urlPatternFromUrl(nav),
              },
            }
          : {}),
      };
    }
    case "select":
      return {
        ...base,
        op: "select",
        target: step.target,
        values: step.values,
        ...(step.labels?.length ? { labels: step.labels } : {}),
      };
    case "navigate": {
      const pattern = urlPatternFromUrl(step.url);
      return {
        ...base,
        op: "navigate",
        destination: {
          url: step.url,
          url_pattern: pattern,
        },
      };
    }
  }
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

export function buildTraceEntry(startUrl?: string):
  | { start_url?: string; start_url_pattern?: string; site?: string }
  | undefined {
  if (!startUrl) return undefined;
  return {
    start_url: startUrl,
    start_url_pattern: urlPatternFromUrl(startUrl),
    ...(siteFromUrl(startUrl) ? { site: siteFromUrl(startUrl) } : {}),
  };
}

/**
 * Compile capture drafts into LLM textbook steps (trace v3).
 * Variable inputs are NOT extracted here — downstream LLM uses target + value.
 */
export function reduceTraceSteps(steps: DraftTraceStep[]): TraceStep[] {
  const collapsed = collapseNavigations(steps);
  const out: TraceStep[] = [];
  let id = 1;
  let lastUrl: string | undefined;
  for (const draft of collapsed) {
    if (draft.op === "navigate") lastUrl = draft.url;
    else if ("navigated_to" in draft && draft.navigated_to) lastUrl = draft.navigated_to;
    else if ("page_url" in draft && draft.page_url) lastUrl = draft.page_url;
    const step = toV3Step(draft, id, lastUrl);
    if (!step) continue;
    out.push(step);
    id += 1;
  }
  return out;
}
