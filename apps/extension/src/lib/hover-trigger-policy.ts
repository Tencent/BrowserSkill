export interface HoverTriggerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HoverTriggerSignals {
  tag: string;
  role?: string;
  label?: string;
  attrs?: Record<string, string | undefined>;
  rect?: HoverTriggerRect | null;
  cursor?: string;
  pointerEvents?: string;
  hasGraphicDescendant?: boolean;
  cssHoverMatch?: boolean;
}

export interface HoverTriggerDecision {
  eligible: boolean;
  score: number;
  reasons: string[];
}

const HOVER_TRIGGER_MIN_SCORE = 45;
const HOVER_POPUP_SIGNAL_RE =
  /(menu|dropdown|popover|popup|avatar|profile|account|user|more|ellipsis|caret)/;
const HOVER_TEXT_ITEM_RE = /(^|[\s_-])(dropdown-item|menu-item|context-menu-item|option)($|[\s_-])/;

function attr(signals: HoverTriggerSignals, name: string): string | undefined {
  return signals.attrs?.[name.toLowerCase()];
}

export function isUnsafeHoverTrigger(signals: HoverTriggerSignals): boolean {
  const tag = signals.tag.toLowerCase();
  if (["input", "textarea", "select", "option"].includes(tag)) return true;
  if ((attr(signals, "contenteditable") ?? "").toLowerCase() === "true") return true;
  if (attr(signals, "disabled") !== undefined || attr(signals, "inert") !== undefined) return true;
  return (attr(signals, "aria-disabled") ?? "").toLowerCase() === "true";
}

export function hasHoverPopupSignal(signals: HoverTriggerSignals): boolean {
  const attrs = signals.attrs ?? {};
  const haystack = [
    attrs.id,
    attrs.class,
    attrs["data-testid"],
    attrs["data-test"],
    attrs["data-cy"],
    attrs["aria-label"],
    attrs["aria-haspopup"],
    attrs["aria-controls"],
    attrs.title,
    signals.role === "button" ? signals.label : undefined,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return HOVER_POPUP_SIGNAL_RE.test(haystack);
}

export function hasStrongHoverExpansionSignal(signals: HoverTriggerSignals): boolean {
  return (
    signals.cssHoverMatch === true ||
    attr(signals, "aria-haspopup") !== undefined ||
    (attr(signals, "aria-expanded") ?? "").toLowerCase() === "false"
  );
}

export function hasDirectHoverInteractiveSignal(signals: HoverTriggerSignals): boolean {
  const tag = signals.tag.toLowerCase();
  const role = (signals.role ?? "").toLowerCase();
  return (
    ["button", "a", "summary"].includes(tag) ||
    ["button", "link", "menuitem", "tab", "combobox"].includes(role) ||
    attr(signals, "tabindex") !== undefined ||
    signals.cursor === "pointer" ||
    attr(signals, "onclick") !== undefined ||
    attr(signals, "onmouseenter") !== undefined ||
    attr(signals, "onmouseover") !== undefined ||
    attr(signals, "aria-haspopup") !== undefined ||
    attr(signals, "aria-expanded") === "false"
  );
}

export function evaluateHoverTrigger(signals: HoverTriggerSignals): HoverTriggerDecision {
  const rect = signals.rect;
  if (
    !rect ||
    rect.w <= 0 ||
    rect.h <= 0 ||
    signals.pointerEvents === "none" ||
    attr(signals, "hidden") !== undefined ||
    attr(signals, "inert") !== undefined ||
    (attr(signals, "aria-hidden") ?? "").toLowerCase() === "true" ||
    isUnsafeHoverTrigger(signals)
  ) {
    return { eligible: false, score: 0, reasons: [] };
  }

  const area = rect.w * rect.h;
  if (area <= 0 || area > 160_000) {
    return { eligible: false, score: 0, reasons: [] };
  }

  const reasons: string[] = [];
  let score = 0;
  const tag = signals.tag.toLowerCase();
  const role = (signals.role ?? "").toLowerCase();
  const label = signals.label?.trim();
  const graphic = signals.hasGraphicDescendant === true;
  const directInteractive = hasDirectHoverInteractiveSignal(signals);
  const popupSignal = hasHoverPopupSignal(signals);
  const isTextNavigationItem =
    (tag === "a" ||
      tag === "li" ||
      role === "link" ||
      role === "option" ||
      role.startsWith("menuitem") ||
      HOVER_TEXT_ITEM_RE.test(attr(signals, "class") ?? "")) &&
    !graphic &&
    !!label &&
    label.toLowerCase() !== "image";
  const compactTopbarIcon =
    (role === "button" || role === "link" || tag === "button" || tag === "a") &&
    graphic &&
    rect.y < 120 &&
    rect.w <= 96 &&
    rect.h <= 96 &&
    (!label || label.toLowerCase() === "image");
  const surfaceTriggerEvidence =
    (popupSignal && !isTextNavigationItem) ||
    compactTopbarIcon ||
    hasStrongHoverExpansionSignal(signals);
  if (!directInteractive || !surfaceTriggerEvidence) {
    return { eligible: false, score: 0, reasons: [] };
  }

  if (attr(signals, "aria-haspopup") !== undefined) {
    score += 80;
    reasons.push("aria-haspopup");
  }
  if ((attr(signals, "aria-expanded") ?? "").toLowerCase() === "false") {
    score += 55;
    reasons.push("collapsed");
  }
  if (popupSignal) {
    score += 45;
    reasons.push("popup-signal");
  }
  if (tag === "button" || role === "button") {
    score += 30;
    reasons.push("button");
  }
  if (signals.cursor === "pointer") {
    score += 25;
    reasons.push("pointer");
  }
  if (graphic && (!label || label.toLowerCase() === "image")) {
    score += 40;
    reasons.push("icon-only");
  }
  if (rect.y < 120) {
    score += 25;
    reasons.push("topbar");
  }
  if (rect.w <= 80 && rect.h <= 80) {
    score += 20;
    reasons.push("compact");
  }
  if (signals.cssHoverMatch) {
    score += 40;
    reasons.push("css-hover");
  }

  return { eligible: score >= HOVER_TRIGGER_MIN_SCORE, score, reasons };
}
