import {
  BSK_OVERLAY_SELECTOR,
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
    if (current instanceof Element) {
      if (isExtensionOverlayElement(current) || current.closest(BSK_OVERLAY_SELECTOR)) {
        return true;
      }
    }
    const root: Node = current.getRootNode();
    if (root instanceof ShadowRoot) {
      current = root.host;
    } else {
      current = current instanceof Element ? null : current.parentElement;
    }
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
  return (
    element.shadowRoot ??
    (element instanceof HTMLElement
      ? (globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element) ?? null)
      : null)
  );
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

const SUBFRAME_OWNER_SELECTOR = "iframe,frame,object,embed,fencedframe";
const SUBFRAME_OWNER_TAGS = new Set(["iframe", "frame", "object", "embed", "fencedframe"]);

function subtreeHasSubframeElement(root: Element | ShadowRoot): boolean {
  if (root instanceof Element) {
    if (isExtensionOverlayNode(root)) return false;
    if (SUBFRAME_OWNER_TAGS.has(root.localName)) return true;
    const nestedShadow = openOrClosedShadowRoot(root);
    if (nestedShadow && subtreeHasSubframeElement(nestedShadow)) return true;
  }
  for (const match of root.querySelectorAll(SUBFRAME_OWNER_SELECTOR)) {
    if (!isExtensionOverlayNode(match)) return true;
  }
  for (const element of root.querySelectorAll("*")) {
    if (isExtensionOverlayNode(element)) continue;
    const nestedShadow = openOrClosedShadowRoot(element);
    if (nestedShadow && subtreeHasSubframeElement(nestedShadow)) return true;
  }
  return false;
}

export function hasAddedSubframeElement(records: MutationRecord[]): boolean {
  for (const record of records) {
    if (record.type !== "childList" || isExtensionOverlayNode(record.target)) continue;
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (subtreeHasSubframeElement(node)) return true;
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
