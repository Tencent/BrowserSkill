import type { RecordingDraftStep } from "./types";

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

export function shouldIncludeDraft(step: RecordingDraftStep): boolean {
  return step.op !== "press" || shouldRecordPress(step.key, step.modifiers);
}

export function resolveDraftStartUrl(
  drafts: RecordingDraftStep[],
  explicitStartUrl?: string,
  fallbackUrl?: string,
): string {
  if (explicitStartUrl) return explicitStartUrl;
  const navigation = drafts.find(
    (step): step is Extract<RecordingDraftStep, { op: "navigate" }> => step.op === "navigate",
  );
  if (navigation) return navigation.url;
  return drafts.find((step) => step.pageUrl)?.pageUrl ?? fallbackUrl ?? "about:blank";
}
