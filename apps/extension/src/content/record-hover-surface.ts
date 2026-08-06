import type { TargetDescriptor } from "@/lib/describe-target";

export interface HoverSurfaceDecision {
  related: boolean;
  reason?: string;
  surface?: Element;
}

export interface HoverSurfaceContext {
  triggerElement: Element;
  triggerTarget: TargetDescriptor;
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
  /\b(menu|dropdown|drop-down|popover|popper|popup|tooltip|flyout|submenu|context-menu|account-menu|user-menu|avatar-menu)\b/i;

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

function isHoverSurfaceElement(el: Element): boolean {
  if (el.matches(HOVER_SURFACE_SELECTOR)) return true;
  if (HOVER_SURFACE_WORD_RE.test(elementTokenText(el))) return true;
  const tag = el.tagName.toLowerCase();
  if ((tag === "ul" || tag === "ol") && el.querySelector("a,button,[role='menuitem']")) {
    return HOVER_SURFACE_WORD_RE.test(elementTokenText(el.parentElement ?? el));
  }
  return false;
}

function closestHoverSurface(clickElement: Element): Element | null {
  let node: Element | null = clickElement;
  let depth = 0;
  while (node && node !== document.body && node !== document.documentElement && depth < 10) {
    if (isHoverSurfaceElement(node)) return node;
    node = node.parentElement;
    depth += 1;
  }
  return null;
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
  return horizontalGap <= 320 && verticalGap <= 320;
}

export function decideHoverSurfaceRelation(
  context: HoverSurfaceContext,
  clickElement: Element,
): HoverSurfaceDecision {
  const clickSurface = closestHoverSurface(clickElement);
  if (clickSurface && isNearTrigger(clickSurface, context.triggerElement)) {
    return { related: true, reason: "click-inside-hover-surface", surface: clickSurface };
  }

  if (context.triggerElement.contains(clickElement) && clickElement !== context.triggerElement) {
    return { related: true, reason: "click-inside-trigger-contained-surface" };
  }

  return { related: false, reason: "click-outside-hover-surface" };
}
