export interface HoverSurfaceDecision {
  related: boolean;
  reason?: string;
  surface?: Element;
}

export interface HoverSurfaceContext {
  triggerElement: Element;
}

export interface HoverSurfaceState {
  element: Element;
  signature: string;
}

const HOVER_SURFACE_SELECTOR = [
  '[role="menu"]',
  '[role="menubar"]',
  '[role="listbox"]',
  '[role="dialog"]',
  '[role="tooltip"]',
  '[aria-modal="true"]',
  "[data-popper-placement]",
  "[data-floating-ui-placement]",
  "[data-headlessui-state]",
  "[data-radix-popper-content-wrapper]",
].join(",");

const HOVER_SURFACE_WORD_RE =
  /(^|[^a-z0-9])(menu|dropdown|drop-down|popover|popper|popup|tooltip|flyout|submenu|context-menu|account-menu|user-menu|avatar-menu)(?=[^a-z0-9]|$)/i;
const HOVER_SURFACE_ITEM_RE =
  /(^|[^a-z0-9])((dropdown|menu|submenu|context-menu)-?item|item-(text|label|content)|item__?(text|label|content))(?=[^a-z0-9]|$)/i;
const HOVER_SURFACE_MAX_AXIS_GAP = 96;
const HOVER_SURFACE_MAX_DIAGONAL_GAP = 16;
const HOVER_SURFACE_MAX_VIEWPORT_AREA_RATIO = 0.5;

function elementTokenText(el: Element): string {
  return [
    el.id,
    typeof el.className === "string" ? el.className : "",
    el.getAttribute("data-testid"),
    el.getAttribute("data-test"),
    el.getAttribute("data-cy"),
    el.getAttribute("aria-label"),
    el.getAttribute("role"),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

export function isRecognizedHoverSurfaceElement(el: Element): boolean {
  if (el.matches(HOVER_SURFACE_SELECTOR)) return true;
  const tokenText = elementTokenText(el);
  if (HOVER_SURFACE_WORD_RE.test(tokenText) && !HOVER_SURFACE_ITEM_RE.test(tokenText)) {
    return true;
  }
  const tag = el.tagName.toLowerCase();
  if ((tag === "ul" || tag === "ol") && el.querySelector("a,button,[role='menuitem']")) {
    return HOVER_SURFACE_WORD_RE.test(elementTokenText(el.parentElement ?? el));
  }
  return false;
}

function isVisibleSurfaceElement(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (style.pointerEvents === "none" || style.visibility === "hidden" || style.display === "none") {
    return false;
  }
  return rectFor(el) !== null;
}

export function closestRecognizedHoverSurface(element: Element): Element | null {
  let node: Element | null = element;
  let depth = 0;
  while (node && node !== document.body && node !== document.documentElement && depth < 10) {
    if (isRecognizedHoverSurfaceElement(node)) return node;
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

export function isPositionedFloatingElement(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (!["absolute", "fixed"].includes(style.position)) return false;
  if (style.pointerEvents === "none" || style.visibility === "hidden" || style.display === "none") {
    return false;
  }
  const rect = rectFor(el);
  if (!rect) return false;
  const viewportArea = window.innerWidth * window.innerHeight;
  const area = rect.width * rect.height;
  return (
    area > 0 && (!viewportArea || area <= viewportArea * HOVER_SURFACE_MAX_VIEWPORT_AREA_RATIO)
  );
}

export function isHoverSurfaceCandidateElement(el: Element): boolean {
  return isRecognizedHoverSurfaceElement(el) || isPositionedFloatingElement(el);
}

export function closestHoverSurfaceCandidate(element: Element): Element | null {
  let node: Element | null = element;
  let depth = 0;
  while (node && node !== document.body && node !== document.documentElement && depth < 10) {
    if (isHoverSurfaceCandidateElement(node)) return node;
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

function closestFloatingSurface(clickElement: Element): Element | null {
  let node: Element | null = clickElement;
  let depth = 0;
  while (node && node !== document.body && node !== document.documentElement && depth < 10) {
    if (isPositionedFloatingElement(node)) return node;
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

function hoverSurfaceSignature(el: Element): string {
  const rect = rectFor(el);
  return [
    rect
      ? `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`
      : "",
    (el.textContent ?? "").trim().slice(0, 512),
  ].join("|");
}

export function collectHoverSurfaceStates(): HoverSurfaceState[] {
  const states: HoverSurfaceState[] = [];
  for (const el of document.querySelectorAll("*")) {
    if (isHoverSurfaceCandidateElement(el) && isVisibleSurfaceElement(el)) {
      states.push({ element: el, signature: hoverSurfaceSignature(el) });
    }
  }
  return states;
}

function rectFor(el: Element): DOMRect | null {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

function isNearTrigger(surface: Element, trigger: Element): boolean {
  const surfaceRect = rectFor(surface);
  const triggerRect = rectFor(trigger);
  if (!surfaceRect || !triggerRect) return true;
  const horizontalOverlap =
    Math.min(triggerRect.right, surfaceRect.right) - Math.max(triggerRect.left, surfaceRect.left);
  const verticalOverlap =
    Math.min(triggerRect.bottom, surfaceRect.bottom) - Math.max(triggerRect.top, surfaceRect.top);
  const horizontalGap = Math.max(
    0,
    triggerRect.left - surfaceRect.right,
    surfaceRect.left - triggerRect.right,
  );
  const verticalGap = Math.max(
    0,
    triggerRect.top - surfaceRect.bottom,
    surfaceRect.top - triggerRect.bottom,
  );
  if (horizontalOverlap > 0 && verticalGap <= HOVER_SURFACE_MAX_AXIS_GAP) return true;
  if (verticalOverlap > 0 && horizontalGap <= HOVER_SURFACE_MAX_AXIS_GAP) return true;
  return (
    horizontalGap <= HOVER_SURFACE_MAX_DIAGONAL_GAP && verticalGap <= HOVER_SURFACE_MAX_DIAGONAL_GAP
  );
}

export function decideHoverSurfaceRelation(
  context: HoverSurfaceContext,
  clickElement: Element,
): HoverSurfaceDecision {
  const clickSurface = closestRecognizedHoverSurface(clickElement);
  if (clickSurface && isNearTrigger(clickSurface, context.triggerElement)) {
    return { related: true, reason: "click-inside-hover-surface", surface: clickSurface };
  }

  const floatingSurface = closestFloatingSurface(clickElement);
  if (floatingSurface && isNearTrigger(floatingSurface, context.triggerElement)) {
    return {
      related: true,
      reason: "click-inside-near-floating-surface",
      surface: floatingSurface,
    };
  }

  if (context.triggerElement.contains(clickElement) && clickElement !== context.triggerElement) {
    return { related: true, reason: "click-inside-trigger-contained-surface" };
  }

  return { related: false, reason: "click-outside-hover-surface" };
}
