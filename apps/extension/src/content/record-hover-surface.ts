import { isExtensionOverlayElement } from "./dom-primitives";

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

export const HOVER_SURFACE_SELECTOR = [
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

const MAX_LOCAL_CONTAINER_CHILDREN = 24;

export function collectScopedHoverSurfaceCandidates(
  trigger?: Element,
  mutated?: Iterable<Element>,
  tracked?: Iterable<Element>,
): Element[] {
  const candidates = new Set<Element>();
  const addCandidate = (el: Element | null | undefined) => {
    if (el?.isConnected && !isExtensionOverlayElement(el)) candidates.add(el);
  };
  const addDirectChildrenIfSmall = (container: Element | null | undefined) => {
    if (
      !container ||
      container === document.documentElement ||
      container.children.length > MAX_LOCAL_CONTAINER_CHILDREN
    ) {
      return;
    }
    for (let i = 0; i < container.children.length; i += 1) {
      addCandidate(container.children[i]);
    }
  };

  if (tracked) {
    for (const el of tracked) addCandidate(el);
  }
  for (const el of document.querySelectorAll(HOVER_SURFACE_SELECTOR)) {
    addCandidate(el);
  }
  if (trigger?.isConnected) {
    for (const attr of ["aria-controls", "aria-owns", "popovertarget"] as const) {
      const ids = trigger.getAttribute(attr);
      if (!ids) continue;
      for (const id of ids.trim().split(/\s+/)) {
        if (id) addCandidate(document.getElementById(id));
      }
    }
    let container: Element | null = trigger;
    for (let depth = 0; depth < 3 && container; depth += 1) {
      if (container === document.body || container === document.documentElement) break;
      addDirectChildrenIfSmall(container);
      container = container.parentElement;
    }
  }
  if (mutated) {
    for (const el of mutated) {
      if (!el.isConnected || isExtensionOverlayElement(el)) continue;
      addCandidate(el);
      addCandidate(closestHoverSurfaceCandidate(el));
      addDirectChildrenIfSmall(el);
    }
  }
  return [...candidates];
}

const HOVER_SURFACE_WORD_RE =
  /(^|[^a-z0-9])(dropdown-menu|drop-down-menu|menu-list|popover__(popper|content|content-body)|popover-content|popper|popup|flyout|submenu|submenu-wrapper|context-menu|account-menu|user-menu|avatar-menu)(?=[^a-z0-9]|$)/i;
const HOVER_SURFACE_ITEM_RE =
  /(^|[^a-z0-9])((dropdown|menu|submenu|context-menu)(-|__?)?(item|link)|item-(text|label|content)|item__?(text|label|content))(?=[^a-z0-9]|$)/i;
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
  if (isExtensionOverlayElement(el)) return false;
  if (el.matches(HOVER_SURFACE_SELECTOR)) return true;
  const tokenText = elementTokenText(el);
  if (HOVER_SURFACE_WORD_RE.test(tokenText) && !HOVER_SURFACE_ITEM_RE.test(tokenText)) {
    return true;
  }
  return false;
}

export function isVisibleSurfaceElement(el: Element): boolean {
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
  if (!(el instanceof HTMLElement) || isExtensionOverlayElement(el)) return false;
  const style = getComputedStyle(el);
  if (style.position !== "absolute") return false;
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

export function hoverSurfaceSignature(el: Element): string {
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

function surfaceRelationMetrics(surface: Element, trigger: Element) {
  const surfaceRect = rectFor(surface);
  const triggerRect = rectFor(trigger);
  if (!surfaceRect || !triggerRect) return null;
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
  return {
    surfaceRect,
    triggerRect,
    horizontalOverlap,
    verticalOverlap,
    horizontalGap,
    verticalGap,
  };
}

function isNearTrigger(surface: Element, trigger: Element): boolean {
  const metrics = surfaceRelationMetrics(surface, trigger);
  if (!metrics) return true;
  const { horizontalOverlap, verticalOverlap, horizontalGap, verticalGap } = metrics;
  if (horizontalOverlap > 0 && verticalGap <= HOVER_SURFACE_MAX_AXIS_GAP) return true;
  if (verticalOverlap > 0 && horizontalGap <= HOVER_SURFACE_MAX_AXIS_GAP) return true;
  return (
    horizontalGap <= HOVER_SURFACE_MAX_DIAGONAL_GAP && verticalGap <= HOVER_SURFACE_MAX_DIAGONAL_GAP
  );
}

export function isLikelyHoverSurfaceOwner(trigger: Element, surface: Element): boolean {
  const metrics = surfaceRelationMetrics(surface, trigger);
  if (!metrics) return true;
  const {
    surfaceRect,
    triggerRect,
    horizontalOverlap,
    verticalOverlap,
    horizontalGap,
    verticalGap,
  } = metrics;
  const opensVertically =
    horizontalOverlap > 0 &&
    verticalGap <= HOVER_SURFACE_MAX_AXIS_GAP &&
    (triggerRect.bottom <= surfaceRect.top + 8 || surfaceRect.bottom <= triggerRect.top + 8);
  const opensSideways =
    verticalOverlap > 0 &&
    horizontalGap <= HOVER_SURFACE_MAX_AXIS_GAP &&
    (triggerRect.right <= surfaceRect.left + 8 || surfaceRect.right <= triggerRect.left + 8);
  const opensFromCorner =
    horizontalGap > 0 &&
    verticalGap > 0 &&
    horizontalGap <= HOVER_SURFACE_MAX_DIAGONAL_GAP &&
    verticalGap <= HOVER_SURFACE_MAX_DIAGONAL_GAP;
  return opensVertically || opensSideways || opensFromCorner;
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
