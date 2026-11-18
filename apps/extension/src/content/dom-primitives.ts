import {
  OVERLAY_HOST_LEGACY_ATTR,
  RECORD_PASSWORD_ATTRIBUTE,
  sensitiveAutocomplete,
} from "@/lib/dom-predicates";
import { isOverlayHostElementName, OVERLAY_HOST_MARKER_ATTR } from "@/lib/overlay-bridge";

export const INTERNAL_BSK_ATTR_PREFIX = "data-bsk-";

export function primaryEventTarget(event: Event): EventTarget | null {
  return event.composedPath()[0] ?? event.target;
}

export function isExtensionOverlayElement(element: Element): boolean {
  return (
    isOverlayHostElementName(element.localName) ||
    element.hasAttribute(OVERLAY_HOST_MARKER_ATTR) ||
    element.hasAttribute(OVERLAY_HOST_LEGACY_ATTR)
  );
}

const SHADOW_HOST_HTML_TAGS = new Set([
  "article",
  "aside",
  "blockquote",
  "body",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "main",
  "nav",
  "p",
  "section",
  "span",
]);

export function canHostShadowRoot(localName: string): boolean {
  return localName.includes("-") || SHADOW_HOST_HTML_TAGS.has(localName);
}

/**
 * Resolves an element's open or closed `ShadowRoot` without walking ancestors.
 * Callers must already have excluded extension overlay elements.
 */
export function uncheckedElementShadowRoot(element: Element): ShadowRoot | null {
  if (element.shadowRoot) return element.shadowRoot;
  if (!(element instanceof HTMLElement) || !canHostShadowRoot(element.localName)) {
    return null;
  }
  return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element) ?? null;
}

/**
 * True when `target` is the extension's `<browser-skill-overlay>` host, any
 * `[data-bsk-overlay]` subtree, or any node inside its open/closed ShadowRoot.
 */
export function isExtensionOverlayNode(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  let current: Node | null = target;
  while (current) {
    if (current instanceof ShadowRoot) {
      current = current.host;
      continue;
    }
    if (current instanceof Element && isExtensionOverlayElement(current)) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

export function isExtensionOverlayEvent(event: Event): boolean {
  for (const entry of event.composedPath()) {
    if (isExtensionOverlayNode(entry)) return true;
  }
  return isExtensionOverlayNode(event.target);
}

export function openOrClosedShadowRoot(element: Element): ShadowRoot | null {
  if (isExtensionOverlayNode(element)) return null;
  return uncheckedElementShadowRoot(element);
}

export function resolveDeepActiveElement(
  doc: Document = document,
  getShadowRoot: (element: Element) => ShadowRoot | null = openOrClosedShadowRoot,
): Element | null {
  let active = doc.activeElement;
  if (active && isExtensionOverlayNode(active)) {
    return doc.body ?? doc.documentElement;
  }
  while (active) {
    const nested = getShadowRoot(active)?.activeElement;
    if (!nested || isExtensionOverlayNode(nested)) break;
    active = nested;
  }
  return active;
}

export function isInternalBskAttribute(attributeName: string | null | undefined): boolean {
  return (
    typeof attributeName === "string" &&
    attributeName.toLowerCase().startsWith(INTERNAL_BSK_ATTR_PREFIX)
  );
}

/**
 * True when a DOM mutation was produced solely by BrowserSkill's own overlay
 * host or internal `data-bsk-*` bookkeeping attributes.
 */
export function isInternalBskMutation(record: MutationRecord): boolean {
  if (isExtensionOverlayNode(record.target)) return true;
  if (record.type === "attributes" && isInternalBskAttribute(record.attributeName)) {
    return true;
  }
  if (record.type === "childList") {
    const total = record.addedNodes.length + record.removedNodes.length;
    if (total > 0) {
      let allOverlay = true;
      for (const node of record.addedNodes) {
        if (!isExtensionOverlayNode(node)) {
          allOverlay = false;
          break;
        }
      }
      if (allOverlay) {
        for (const node of record.removedNodes) {
          if (!isExtensionOverlayNode(node)) {
            allOverlay = false;
            break;
          }
        }
      }
      if (allOverlay) return true;
    }
  }
  return false;
}

export function isPasswordTypeMutation(
  record: MutationRecord,
): record is MutationRecord & { target: Element } {
  return record.oldValue?.toLowerCase() === "password" && record.target instanceof Element;
}

export function isSensitiveFormField(
  target: Element,
  formerPasswords?: { has(element: Element): boolean },
): boolean {
  return (
    (target instanceof HTMLInputElement && target.type.toLowerCase() === "password") ||
    target.hasAttribute(RECORD_PASSWORD_ATTRIBUTE) ||
    Boolean(formerPasswords?.has(target)) ||
    sensitiveAutocomplete(target.getAttribute("autocomplete"))
  );
}

export const SUBFRAME_OWNER_TAGS = new Set(["iframe", "frame", "object", "embed", "fencedframe"]);

const NON_OVERLAY_ELEMENT_FILTER: NodeFilter = {
  acceptNode(node) {
    return isExtensionOverlayElement(node as Element)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT;
  },
};

function subtreeHasSubframeElement(root: Element | ShadowRoot, visited: Set<Node>): boolean {
  if (visited.has(root)) return false;
  visited.add(root);
  const doc = root.ownerDocument ?? document;
  if (root instanceof Element) {
    if (isExtensionOverlayElement(root)) return false;
    if (SUBFRAME_OWNER_TAGS.has(root.localName)) return true;
    const nestedShadow = uncheckedElementShadowRoot(root);
    if (nestedShadow && subtreeHasSubframeElement(nestedShadow, visited)) return true;
  }
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, NON_OVERLAY_ELEMENT_FILTER);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (visited.has(current)) continue;
    visited.add(current);
    const element = current as Element;
    if (SUBFRAME_OWNER_TAGS.has(element.localName)) return true;
    const nestedShadow = uncheckedElementShadowRoot(element);
    if (nestedShadow && subtreeHasSubframeElement(nestedShadow, visited)) return true;
  }
  return false;
}

export function hasAddedSubframeElement(records: MutationRecord[]): boolean {
  const visited = new Set<Node>();
  for (const record of records) {
    if (record.type !== "childList" || isExtensionOverlayNode(record.target)) continue;
    for (const node of record.addedNodes) {
      if (!(node instanceof Element) || isExtensionOverlayNode(node)) continue;
      if (subtreeHasSubframeElement(node, visited)) return true;
    }
  }
  return false;
}

/**
 * Ensures repeated `chrome.scripting.executeScript` calls of the same WXT
 * runtime content script on the same `Document` are strictly idempotent:
 * WXT's `new ContentScriptContext(name)` dispatches
 * `${runtimeId}:${name}:wxt:content-script-started` on `document` before
 * entering `main(ctx)`. Intercepting that event in the capture phase while the
 * first context is still valid preserves the live ShadowRoot, ports, and
 * listeners, while still allowing cleanup after an extension reload
 * (`ctx.isInvalid === true`).
 */
export function claimIdempotentContentScript(
  ctx: { readonly isInvalid?: boolean; abort?: (reason?: unknown) => void },
  contentScriptName: string,
  mountedSymbol: symbol,
): (() => void) | null {
  const win = window as unknown as Record<symbol, string | undefined>;
  const runtimeId = chrome.runtime?.id ?? "mounted";
  if (win[mountedSymbol] === runtimeId) {
    ctx.abort?.("Duplicate runtime injection skipped");
    return null;
  }
  win[mountedSymbol] = runtimeId;
  const startedEventName = `${runtimeId}:${contentScriptName}:wxt:content-script-started`;
  const preserveWhileValid = (event: Event) => {
    if (!ctx.isInvalid) {
      event.stopImmediatePropagation();
    }
  };
  document.addEventListener(startedEventName, preserveWhileValid, true);
  return () => {
    document.removeEventListener(startedEventName, preserveWhileValid, true);
    if (win[mountedSymbol] === runtimeId) {
      delete win[mountedSymbol];
    }
  };
}
