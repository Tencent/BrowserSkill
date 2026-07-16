/**
 * Build a semantic TargetDescriptor for an interacted element.
 *
 * Trace steps are an LLM *textbook*: each click must say what to look for
 * on screen (usually a short visible name). Tag-only noise like
 * `{ "tag": "div" }` / “点击div” is useless and must not be recorded.
 */

export interface TargetDescriptor {
  role?: string;
  name?: string;
  tag: string;
  name_attr?: string;
  placeholder?: string;
  nearby_label?: string;
}

/** Max length for a label that is still a useful “find this on screen” hint. */
const ACTIONABLE_LABEL_MAX = 48;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max = 80): string {
  const trimmed = normalizeWhitespace(value);
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/** Short, human label an LLM can search for in a snapshot. */
export function isActionableLabel(name: string): boolean {
  const trimmed = normalizeWhitespace(name);
  if (!trimmed) return false;
  if (trimmed.length > ACTIONABLE_LABEL_MAX) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  return true;
}

function labelledByText(el: Element): string | null {
  const ids = el.getAttribute("aria-labelledby");
  if (!ids) return null;
  const parts = ids
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .map(normalizeWhitespace)
    .filter(Boolean);
  return parts.length ? truncate(parts.join(" ")) : null;
}

function associatedLabelText(el: Element): string | null {
  if (!(el instanceof HTMLElement) || !el.id) return null;
  const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
  if (!label) return null;
  const text = normalizeWhitespace(label.textContent ?? "");
  return text ? truncate(text) : null;
}

function wrappingLabelText(el: Element): string | null {
  const label = el.closest("label");
  if (!label) return null;
  const clone = label.cloneNode(true) as HTMLElement;
  for (const control of clone.querySelectorAll("input,textarea,select,button")) {
    control.remove();
  }
  const text = normalizeWhitespace(clone.textContent ?? "");
  return text ? truncate(text) : null;
}

function placeholderOrTitle(el: Element): string | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const ph = normalizeWhitespace(el.placeholder);
    if (ph) return truncate(ph);
  }
  const title = normalizeWhitespace(el.getAttribute("title") ?? "");
  return title ? truncate(title) : null;
}

function ownText(el: Element): string | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return null;
  }
  const text = normalizeWhitespace(el.textContent ?? "");
  return text ? truncate(text) : null;
}

/** Prefer a compact title inside links (e.g. SERP result `<h3>`), not the whole blob. */
function compactLinkName(el: Element): string | null {
  const heading = el.querySelector("h1, h2, h3, h4");
  if (heading) {
    const text = normalizeWhitespace(heading.textContent ?? "");
    if (text) return truncate(text);
  }
  const img = el.querySelector("img[alt]");
  if (img instanceof HTMLImageElement) {
    const alt = normalizeWhitespace(img.alt);
    if (alt) return truncate(alt);
  }
  const clone = el.cloneNode(true) as HTMLElement;
  for (const junk of clone.querySelectorAll("cite, script, style, svg, noscript")) {
    junk.remove();
  }
  const text = normalizeWhitespace(clone.textContent ?? "");
  if (!text) return null;
  const withoutUrl = text.replace(/https?:\/\/\S+/g, "").trim();
  return truncate(withoutUrl || text);
}

/** Visible accessible name preference order for LLM textbooks. */
export function accessibleName(el: Element): string | undefined {
  const ariaLabel = normalizeWhitespace(el.getAttribute("aria-label") ?? "");
  if (ariaLabel) return truncate(ariaLabel);

  const labelledBy = labelledByText(el);
  if (labelledBy) return labelledBy;

  const forLabel = associatedLabelText(el);
  if (forLabel) return forLabel;

  const wrapLabel = wrappingLabelText(el);
  if (wrapLabel) return wrapLabel;

  const alt =
    el instanceof HTMLImageElement
      ? normalizeWhitespace(el.alt)
      : normalizeWhitespace(el.getAttribute("alt") ?? "");
  if (alt) return truncate(alt);

  const ph = placeholderOrTitle(el);
  if (ph) return ph;

  const tag = el.tagName.toLowerCase();
  if (tag === "a" || el.getAttribute("role") === "link") {
    const linkName = compactLinkName(el);
    if (linkName) return linkName;
  }

  const text = ownText(el);
  if (text) return text;

  if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) {
    const value = normalizeWhitespace(el.value);
    if (value && (el instanceof HTMLButtonElement || el.type === "submit" || el.type === "button")) {
      return truncate(value);
    }
  }

  return undefined;
}

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "summary",
  "select",
  'input:not([type="hidden"])',
  "textarea",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="treeitem"]',
  '[role="combobox"]',
  '[contenteditable]:not([contenteditable="false"])',
].join(",");

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "checkbox",
  "radio",
  "switch",
  "treeitem",
  "combobox",
  "textbox",
  "searchbox",
  "slider",
]);

function looksClickable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.matches(INTERACTIVE_SELECTOR)) return true;
  const role = normalizeWhitespace(el.getAttribute("role") ?? "").toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.tabIndex >= 0) return true;
  try {
    if (getComputedStyle(el).cursor === "pointer") return true;
  } catch {
    // happy-dom / detached nodes
  }
  const cls = typeof el.className === "string" ? el.className : "";
  if (/\b(btn|button|link|clickable|action)\b/i.test(cls)) return true;
  return false;
}

/**
 * Resolve the element a click should describe for the LLM textbook.
 * Never falls back to an anonymous layout `div`.
 */
export function resolveClickableElement(target: Element): Element | null {
  const interactive = target.closest(INTERACTIVE_SELECTOR);
  if (interactive instanceof Element) return interactive;

  let node: Element | null = target;
  let depth = 0;
  while (node && node !== document.body && node !== document.documentElement && depth < 8) {
    const name = accessibleName(node);
    if (name && isActionableLabel(name) && looksClickable(node)) {
      return node;
    }
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

/**
 * Teachable clicks: the LLM must get a label it can later find via snapshot
 * (visible name), or at least a form `name_attr` for checkbox/radio.
 * Recording “点击div” with no name fails this bar.
 */
export function isMeaningfulClickTarget(target: TargetDescriptor): boolean {
  const name = target.name?.trim();
  if (name && isActionableLabel(name)) return true;
  if (
    (target.role === "checkbox" || target.role === "radio" || target.tag === "input") &&
    target.name_attr
  ) {
    return true;
  }
  return false;
}

export function inferRole(el: Element): string | undefined {
  const explicit = normalizeWhitespace(el.getAttribute("role") ?? "").toLowerCase();
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "img") return "img";
  if (tag === "summary") return "button";
  if (el instanceof HTMLElement && (el.isContentEditable || el.contentEditable === "true")) {
    return "textbox";
  }
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button" || type === "image" || type === "reset") {
      return "button";
    }
    if (type === "range") return "slider";
    return "textbox";
  }
  return undefined;
}

/**
 * Nearby labels help the LLM name form fields. Only apply to fillable
 * controls — never to buttons/links, where a previous layout sibling
 * (e.g. a chrome `<div>`) would pollute the textbook target.
 */
function nearbyLabelText(el: Element): string | undefined {
  if (
    !(
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    )
  ) {
    return undefined;
  }
  if (el.id) {
    const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const text = byFor ? normalizeWhitespace(byFor.textContent ?? "") : "";
    if (text) return truncate(text, ACTIONABLE_LABEL_MAX);
  }
  const wrapped = el.closest("label");
  if (wrapped) {
    const clone = wrapped.cloneNode(true) as HTMLLabelElement;
    for (const control of clone.querySelectorAll("input, textarea, select, button")) {
      control.remove();
    }
    const text = normalizeWhitespace(clone.textContent ?? "");
    if (text) return truncate(text, ACTIONABLE_LABEL_MAX);
  }
  const prev = el.previousElementSibling;
  if (prev && /^(LABEL|SPAN|DIV|P|DT)$/i.test(prev.tagName)) {
    const text = normalizeWhitespace(prev.textContent ?? "");
    if (text && text.length <= ACTIONABLE_LABEL_MAX) return text;
  }
  return undefined;
}

export function describeTarget(el: Element): TargetDescriptor {
  const tag = el.tagName.toLowerCase();
  const role = inferRole(el);
  const name = accessibleName(el);
  const nameAttr =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLButtonElement
      ? normalizeWhitespace(el.name) || undefined
      : normalizeWhitespace(el.getAttribute("name") ?? "") || undefined;
  const placeholder =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? normalizeWhitespace(el.placeholder) || undefined
      : normalizeWhitespace(el.getAttribute("placeholder") ?? "") || undefined;
  const nearby = nearbyLabelText(el);

  return {
    tag,
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(nameAttr ? { name_attr: nameAttr } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(nearby && nearby !== name ? { nearby_label: nearby } : {}),
  };
}

export function describeEventTarget(target: EventTarget | null): TargetDescriptor | null {
  if (!(target instanceof Element)) return null;
  const clickable = resolveClickableElement(target);
  if (!clickable) return null;
  const desc = describeTarget(clickable);
  return isMeaningfulClickTarget(desc) ? desc : null;
}

export function summarizeClick(target: TargetDescriptor): string {
  const label = target.name
    ? `「${target.name}」`
    : target.name_attr
      ? `「${target.name_attr}」`
      : null;
  // Callers must filter with isMeaningfulClickTarget; never teach “点击div”.
  if (!label) return "点击控件";
  if (target.role === "button" || target.tag === "button") {
    return `点击${label}按钮`;
  }
  if (target.role === "link" || target.tag === "a") {
    return `点击${label}链接`;
  }
  return `点击${label}`;
}

export function summarizeFill(target: TargetDescriptor, value: string, redacted?: boolean): string {
  const label = target.name
    ? `「${target.name}」`
    : target.name_attr
      ? `「${target.name_attr}」`
      : "输入框";
  return `在${label}填入 ${redacted ? "***" : value}`;
}

export function summarizePress(key: string, target?: TargetDescriptor | null): string {
  if (target?.name) return `在「${target.name}」上按下 ${key}`;
  return `按下 ${key}`;
}

export function summarizeSelect(
  target: TargetDescriptor,
  values: string[],
  labels?: string[],
): string {
  const label = target.name ? `「${target.name}」` : "下拉框";
  const shown = labels?.length ? labels.join(", ") : values.join(", ");
  return `在${label}选择 ${shown}`;
}

export function summarizeNavigate(url: string): string {
  return `页面跳转到 ${url}`;
}
