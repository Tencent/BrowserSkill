import {
  type CaptureTargetDescriptor,
  describeEventTarget,
  describeTarget,
  INTERACTIVE_SELECTOR,
  resolveClickableElement,
  resolveHoverElement,
} from "@/lib/describe-target";
import {
  evaluateHoverTrigger,
  type HoverTriggerDecision,
  type HoverTriggerRect,
  hasDirectHoverInteractiveSignal,
  hasStrongHoverExpansionSignal,
} from "@/lib/hover-trigger-policy";
import type { RecordStepPayload } from "@/lib/record-bridge";
import { shouldRecordPress } from "@/lib/recording/draft-policy";
import { RECORD_PASSWORD_ATTRIBUTE } from "@/lib/sensitive-autocomplete";
import {
  isExtensionOverlayEvent,
  isExtensionOverlayNode,
  isInternalBskMutation,
  isNodeInsideShadowHost,
  isPasswordTypeMutation,
  isSensitiveFormField,
  openOrClosedShadowRoot,
  primaryEventTarget,
  rememberFormerPassword,
  resolveDeepActiveElement,
  visitShadowRoots,
} from "./dom-primitives";
import {
  closestHoverSurfaceCandidate,
  collectScopedHoverSurfaceCandidates,
  decideHoverSurfaceRelation,
  hoverSurfaceSignature,
  isHoverSurfaceCandidateElement,
  isLikelyHoverSurfaceOwner,
  isVisibleSurfaceElement,
} from "./record-hover-surface";

export interface RecordCaptureController {
  stop(): void;
  dispose(): void;
}

interface FillSession {
  element: FillableElement;
  target: CaptureTargetDescriptor;
  baselineValue: string;
  lastValue: string;
  startedAsPassword: boolean;
  pendingCommit?: "enter" | "suggestion" | "blur";
}

interface HoverCandidate {
  element: Element;
  target: CaptureTargetDescriptor;
  recordedAt: number;
  score: number;
  eligible: boolean;
}

interface HoverSurfaceNode {
  element: Element;
  signature: string;
  owner: HoverCandidate;
  parent?: HoverSurfaceNode;
}

type FillableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const HOVER_BEFORE_CLICK_MAX_MS = 10_000;
const HOVER_SURFACE_CONTEXT_MAX_MS = 30_000;
const HOVER_REPLACE_SCORE_MARGIN = 50;
const HOVER_CANDIDATE_LIMIT = 24;
const HOVER_TRIGGER_LABEL_MAX = 48;

function isTextFillable(el: Element): el is FillableElement {
  if (el instanceof HTMLElement && (el.isContentEditable || el.contentEditable === "true")) {
    return true;
  }
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  const type = el.type.toLowerCase();
  return !["checkbox", "radio", "file", "button", "submit", "reset", "image", "hidden"].includes(
    type,
  );
}

function fillableFromTarget(target: EventTarget | null): FillableElement | null {
  if (!(target instanceof Element)) return null;
  if (isTextFillable(target)) return target;
  const el = target.closest('input,textarea,[contenteditable]:not([contenteditable="false"])');
  if (!el || !isTextFillable(el) || isControlInNonEditableRegion(target, el)) return null;
  return el;
}

/**
 * Closed shadow roots retarget editing events to their host; resolve the deep
 * active control so password inputs inside closed Shadow DOM stay tracked and masked.
 */
function resolveClosedShadowEditTarget(raw: EventTarget | null): EventTarget | null {
  if (!(raw instanceof Element) || raw.shadowRoot || !openOrClosedShadowRoot(raw)) {
    return raw;
  }
  const active = resolveDeepActiveElement();
  return active && isNodeInsideShadowHost(active, raw) ? active : raw;
}

/**
 * Buttons and links inside a contenteditable="false" region of an editor, such
 * as attachment or embed actions, are page actions rather than editor text.
 */
function isControlInNonEditableRegion(target: Element, editor: Element): boolean {
  const region = target.closest('[contenteditable="false"]');
  if (!region || !editor.contains(region)) return false;
  const control = resolveClickableElement(target);
  return control !== null && region.contains(control);
}

/** Clicks on search chrome that only focus the nearby input should not become steps. */
function nearbyFillableFromSearchChrome(target: Element): FillableElement | null {
  // Form actions remain clicks, even when they contain an icon beside a search field.
  if (
    target.closest(
      'button,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"]',
    )
  ) {
    return null;
  }
  const container = target.closest(
    '[id*="chat-input"], [id*="search"], [class*="search"], form, [role="search"]',
  );
  if (!container) return null;
  const fillable = container.querySelector(
    'textarea, input[type="search"], input[name="q"], #chat-textarea',
  );
  if (
    !(fillable instanceof HTMLElement) ||
    !isTextFillable(fillable) ||
    fillable === target ||
    fillable.contains(target)
  ) {
    return null;
  }
  // Results, filters and actions that share the search form are page actions; only
  // the field's own wrapper (e.g. a role="combobox" box) counts as focus chrome.
  const control = target.closest(INTERACTIVE_SELECTOR);
  if (control && !control.contains(fillable)) return null;
  return fillable;
}

function captureGeometry(el: Element): RecordStepPayload["geometry"] {
  const rect = el.getBoundingClientRect();
  return {
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    tag: el.tagName.toLowerCase(),
  };
}

function geometryForEventTarget(
  target: EventTarget | null,
): RecordStepPayload["geometry"] | undefined {
  if (!(target instanceof Element)) return undefined;
  const clickable = resolveClickableElement(target);
  return captureGeometry(clickable ?? target);
}

function fillableValue(el: FillableElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value;
  }
  return el.textContent ?? "";
}

function hoverTriggerAttrs(el: Element): Record<string, string | undefined> {
  return {
    id: el.id || undefined,
    class: typeof el.className === "string" ? el.className || undefined : undefined,
    "data-testid": el.getAttribute("data-testid") ?? undefined,
    "data-test": el.getAttribute("data-test") ?? undefined,
    "data-cy": el.getAttribute("data-cy") ?? undefined,
    "aria-label": el.getAttribute("aria-label") ?? undefined,
    "aria-haspopup": el.getAttribute("aria-haspopup") ?? undefined,
    "aria-controls": el.getAttribute("aria-controls") ?? undefined,
    "aria-expanded": el.getAttribute("aria-expanded") ?? undefined,
    "aria-hidden": el.getAttribute("aria-hidden") ?? undefined,
    "aria-disabled": el.getAttribute("aria-disabled") ?? undefined,
    contenteditable: el.getAttribute("contenteditable") ?? undefined,
    disabled: el.hasAttribute("disabled") ? "" : undefined,
    hidden: el.hasAttribute("hidden") ? "" : undefined,
    inert: el.hasAttribute("inert") ? "" : undefined,
    onclick: el.getAttribute("onclick") ?? undefined,
    onmouseenter: el.getAttribute("onmouseenter") ?? undefined,
    onmouseover: el.getAttribute("onmouseover") ?? undefined,
    role: el.getAttribute("role") ?? undefined,
    tabindex: el.getAttribute("tabindex") ?? undefined,
    title: el.getAttribute("title") ?? undefined,
  };
}

function hoverTriggerRect(el: Element): HoverTriggerRect {
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

function hoverTriggerStyle(el: Element): { cursor?: string; pointerEvents?: string } {
  if (!(el instanceof HTMLElement)) return {};
  const style = getComputedStyle(el);
  return { cursor: style.cursor, pointerEvents: style.pointerEvents };
}

function hasHoverGraphicDescendant(el: Element): boolean {
  return el.querySelector("img,svg,use,path,i") !== null;
}

function normalizeLabelText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateLabel(value: string, max = HOVER_TRIGGER_LABEL_MAX): string {
  const normalized = normalizeLabelText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function collectHoverTriggerLabelText(root: Element): string {
  let text = "";
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += ` ${node.textContent ?? ""}`;
      return;
    }
    if (!(node instanceof Element)) return;
    if (node !== root && isHoverSurfaceCandidateElement(node)) {
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  for (const child of root.childNodes) visit(child);
  return normalizeLabelText(text);
}

function compactHoverTargetName(
  el: Element,
  desc: CaptureTargetDescriptor,
): CaptureTargetDescriptor {
  if (!desc.name) return desc;
  const fullText = normalizeLabelText(el.textContent ?? "");
  const compactName = collectHoverTriggerLabelText(el);
  if (!compactName || compactName === desc.name) return desc;
  const compactComparable = compactName.replace(/\s+/g, "");
  const descComparable = desc.name.replace(/…$/, "").replace(/\s+/g, "");
  const fullTextComparable = fullText.replace(/\s+/g, "");
  if (
    descComparable.startsWith(compactComparable) &&
    fullTextComparable.startsWith(descComparable) &&
    compactName.length < desc.name.length
  ) {
    return { ...desc, name: truncateLabel(compactName) };
  }
  return desc;
}

function isWeakHoverTarget(target: CaptureTargetDescriptor): boolean {
  return !target.role && !target.name && target.tag === "div";
}

function looksLikeAvatarElement(el: Element): boolean {
  const className = typeof el.className === "string" ? el.className : "";
  return /\b(avatar|user-avatar)\b/i.test(className);
}

function normalizeHoverTarget(
  el: Element,
  desc: CaptureTargetDescriptor,
  decision: HoverTriggerDecision,
): CaptureTargetDescriptor {
  if (desc.role === "img" && !desc.name && looksLikeAvatarElement(el)) {
    return { ...desc, name: "image" };
  }
  if (
    isWeakHoverTarget(desc) &&
    (looksLikeAvatarElement(el) ||
      (hasHoverGraphicDescendant(el) && decision.reasons.includes("icon-only")))
  ) {
    return { tag: "img", role: "img", name: "image" };
  }
  return desc;
}

function hoverTriggerSignals(el: Element, desc: CaptureTargetDescriptor) {
  if (!(el instanceof HTMLElement)) return null;
  const style = hoverTriggerStyle(el);
  return {
    tag: el.tagName.toLowerCase(),
    role: desc.role,
    label: desc.name,
    attrs: hoverTriggerAttrs(el),
    rect: hoverTriggerRect(el),
    cursor: style.cursor,
    pointerEvents: style.pointerEvents,
    hasGraphicDescendant: hasHoverGraphicDescendant(el),
  };
}

function hoverCandidateFromEvent(target: EventTarget | null): HoverCandidate | null {
  if (!(target instanceof Element)) return null;
  const element = resolveHoverElement(target);
  if (!element) return null;
  const desc = describeTarget(element);
  const signals = hoverTriggerSignals(element, desc);
  if (!signals) return null;
  const decision = evaluateHoverTrigger(signals);
  const hasExpansionSignal = hasStrongHoverExpansionSignal(signals);
  const hasDirectSignal = hasDirectHoverInteractiveSignal(signals);
  if (!decision.eligible && !hasExpansionSignal && !hasDirectSignal) return null;
  if (!decision.eligible && !desc.name && !desc.role) return null;
  const normalizedTarget = normalizeHoverTarget(
    element,
    compactHoverTargetName(element, desc),
    decision,
  );
  const now = Date.now();
  return {
    element,
    target: normalizedTarget,
    recordedAt: now,
    score: decision.score,
    eligible: decision.eligible,
  };
}

function shouldReplaceHoverCandidate(
  current: HoverCandidate,
  next: HoverCandidate,
  now: number,
): boolean {
  if (next.element === current.element) return false;
  if (now - current.recordedAt > HOVER_BEFORE_CLICK_MAX_MS) return true;
  if (current.element.contains(next.element)) return false;
  if (next.element.contains(current.element)) return true;
  return next.score >= current.score + HOVER_REPLACE_SCORE_MARGIN;
}

/** Clicks that only pick an autocomplete/suggestion value — not a semantic submit action. */
function isInputCompletionClick(target: EventTarget | null, session: FillSession | null): boolean {
  if (!session || !(target instanceof Element)) return false;
  if (session.element.contains(target)) return false;

  const option = target.closest('[role="option"]');
  if (option?.closest('[role="listbox"]')) return true;

  const suggestionRoot = target.closest(
    [
      '[id*="Sug"]',
      '[id*="sug"]',
      '[class*="suggest"]',
      '[class*="autocomplete"]',
      '[class*="typeahead"]',
      "[data-autocomplete]",
    ].join(", "),
  );
  if (suggestionRoot && !suggestionRoot.contains(session.element)) return true;

  return false;
}

function scheduleInputCompletionCommit(
  sessionElement: FillableElement,
  syncFillSessionValue: (el: FillableElement) => void,
  commitFillSession: () => void,
  hasSessionFor: (el: FillableElement) => boolean,
): void {
  const syncAndCommit = () => {
    if (!hasSessionFor(sessionElement)) return;
    syncFillSessionValue(sessionElement);
    commitFillSession();
  };
  syncFillSessionValue(sessionElement);
  queueMicrotask(syncAndCommit);
  setTimeout(syncAndCommit, 0);
}

export function startRecordCapture(
  _requestId: string,
  sendStep: (step: RecordStepPayload) => void,
  options: { captureNavigation?: boolean } = {},
): RecordCaptureController {
  const emitStep = (step: RecordStepPayload) => {
    sendStep({ page_url: location.href, ...step });
  };
  let fillSession: FillSession | null = null;
  let composing = false;
  let lastUrl = location.href;
  let keyboardActivation: { target: EventTarget | null; recordedAt: number } | undefined;
  let pendingHover: HoverCandidate | null = null;
  const recentHoverCandidates: HoverCandidate[] = [];
  const emittedHoverElements = new WeakSet<Element>();
  const hoverSurfaceNodes = new Map<Element, HoverSurfaceNode>();
  const hoverSurfaceSignatures = new Map<Element, string>();
  const dirtyHoverElements = new Set<Element>();
  let hoverRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const collectHoverMutations = (records: MutationRecord[]) => {
    for (const record of records) {
      if (isInternalBskMutation(record)) continue;
      if (dirtyHoverElements.size >= 64) break;
      if (record.type === "childList") {
        if (
          record.target instanceof Element &&
          record.target !== document.body &&
          record.target !== document.documentElement
        ) {
          dirtyHoverElements.add(record.target);
        }
        for (const added of record.addedNodes) {
          if (dirtyHoverElements.size >= 64) break;
          if (added instanceof Element) dirtyHoverElements.add(added);
        }
      } else if (record.target instanceof Element) {
        dirtyHoverElements.add(record.target);
      }
    }
  };
  const hoverMutationObserver = new MutationObserver(collectHoverMutations);
  if (document.documentElement) {
    hoverMutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "aria-hidden",
        "aria-expanded",
        "data-state",
        "open",
      ],
    });
  }
  for (const el of collectScopedHoverSurfaceCandidates()) {
    if (isHoverSurfaceCandidateElement(el) && isVisibleSurfaceElement(el)) {
      hoverSurfaceSignatures.set(el, hoverSurfaceSignature(el));
    }
  }
  let generatedControlClick: Element | null = null;
  const committedValues = new WeakMap<FillableElement, string>();
  // A "show password" toggle switches type=password to text; keep masking those
  // fields across the light DOM and open/closed ShadowRoots until recording cleanup.
  const formerPasswords = new Set<Element>();
  const observedPasswordRoots = new WeakSet<Node>();
  const markFormerPasswordElement = (element: Element) => {
    formerPasswords.add(element);
    rememberFormerPassword(element);
    element.setAttribute(RECORD_PASSWORD_ATTRIBUTE, "");
  };
  const observePasswordRoot = (root: Document | ShadowRoot) => {
    if (observedPasswordRoots.has(root)) return;
    observedPasswordRoots.add(root);
    typeObserver.observe(root, {
      subtree: true,
      childList: true,
      attributeFilter: ["type"],
      attributeOldValue: true,
    });
  };
  const handlePasswordMutations = (records: MutationRecord[]) => {
    const visited = new Set<Node>();
    for (const record of records) {
      if (isPasswordTypeMutation(record)) {
        markFormerPasswordElement(record.target);
      } else if (record.type === "childList" && !isExtensionOverlayNode(record.target)) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) visitShadowRoots(node, observePasswordRoot, visited);
        }
      }
    }
  };
  const typeObserver = new MutationObserver(handlePasswordMutations);
  visitShadowRoots(document, observePasswordRoot);

  // `attachShadow()` on an already-connected host emits no childList mutation;
  // observe newly attached roots on interaction before page handlers toggle `type`.
  const observeEventShadowRoots = (event: Event) => {
    for (const entry of event.composedPath()) {
      if (entry instanceof ShadowRoot) {
        if (!observedPasswordRoots.has(entry)) {
          visitShadowRoots(entry, observePasswordRoot);
        }
      } else if (entry instanceof Element) {
        const nested = openOrClosedShadowRoot(entry);
        // Closed roots hide nested descendants from composedPath(), so always
        // scan them for lazily attached inner ShadowRoots.
        if (nested && (!entry.shadowRoot || !observedPasswordRoots.has(nested))) {
          visitShadowRoots(nested, observePasswordRoot);
        }
      }
    }
  };

  const emitFill = (session: FillSession) => {
    if (session.lastValue === session.baselineValue) return;
    handlePasswordMutations(typeObserver.takeRecords());
    if (
      session.startedAsPassword &&
      session.element instanceof HTMLInputElement &&
      session.element.type.toLowerCase() !== "password"
    ) {
      markFormerPasswordElement(session.element);
    }
    const isPassword =
      session.startedAsPassword || isSensitiveFormField(session.element, formerPasswords);
    const value = isPassword ? "***" : session.lastValue;
    emitStep({
      op: "fill",
      target: session.target,
      geometry: captureGeometry(session.element),
      value,
      commit: session.pendingCommit ?? "blur",
      ...(isPassword ? { redacted: true } : {}),
    });
  };

  const commitFillSession = (commit: "enter" | "suggestion" | "blur" = "blur") => {
    if (!fillSession || composing) return;
    const session = fillSession;
    session.pendingCommit = commit;
    fillSession = null;
    emitFill(session);
    committedValues.set(session.element, session.lastValue);
  };

  const syncFillSessionValue = (el: FillableElement) => {
    if (!fillSession || fillSession.element !== el) return;
    fillSession.lastValue = fillableValue(el);
  };

  const ensureFillSession = (el: FillableElement) => {
    if (fillSession?.element === el) return;
    if (fillSession) commitFillSession();
    const currentValue = fillableValue(el);
    const baselineValue = committedValues.get(el) ?? currentValue;
    fillSession = {
      element: el,
      target: describeTarget(el),
      baselineValue,
      lastValue: currentValue,
      startedAsPassword: el instanceof HTMLInputElement && el.type.toLowerCase() === "password",
    };
  };

  const emitNavigateIfChanged = () => {
    if (location.href === lastUrl) return;
    commitFillSession();
    lastUrl = location.href;
    emitStep({
      op: "navigate",
      url: location.href,
    });
  };

  const rememberHoverCandidate = (hover: HoverCandidate) => {
    const duplicate = recentHoverCandidates.findIndex(
      (candidate) => candidate.element === hover.element,
    );
    if (duplicate >= 0) recentHoverCandidates.splice(duplicate, 1);
    recentHoverCandidates.push(hover);
    if (recentHoverCandidates.length > HOVER_CANDIDATE_LIMIT) {
      recentHoverCandidates.splice(0, recentHoverCandidates.length - HOVER_CANDIDATE_LIMIT);
    }
  };

  const surfaceArea = (el: Element): number => {
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height;
  };

  const smallestContaining = <T>(
    target: Element,
    items: Iterable<T>,
    elementFor: (item: T) => Element,
  ): T | undefined => {
    let best: T | undefined;
    for (const item of items) {
      const element = elementFor(item);
      if (!element.contains(target)) continue;
      if (!best || surfaceArea(element) < surfaceArea(elementFor(best))) {
        best = item;
      }
    }
    return best;
  };

  const ownedSurfaceContaining = (target: Element): HoverSurfaceNode | undefined =>
    smallestContaining(target, hoverSurfaceNodes.values(), (node) => node.element);

  const pruneGoneHoverSurfaces = () => {
    for (const element of hoverSurfaceNodes.keys()) {
      if (!element.isConnected || !isVisibleSurfaceElement(element)) {
        hoverSurfaceNodes.delete(element);
        hoverSurfaceSignatures.delete(element);
      }
    }
    for (const element of hoverSurfaceSignatures.keys()) {
      if (!element.isConnected || !isVisibleSurfaceElement(element)) {
        hoverSurfaceSignatures.delete(element);
      }
    }
  };

  const inferOwnerForSurface = (
    surface: Element,
    now: number,
    before?: HoverCandidate,
  ): HoverCandidate | undefined => {
    for (let index = recentHoverCandidates.length - 1; index >= 0; index -= 1) {
      const candidate = recentHoverCandidates[index];
      if (!candidate) continue;
      if (before && candidate.element === before.element) continue;
      if (before && candidate.recordedAt > before.recordedAt) continue;
      if (surface.contains(candidate.element)) continue;
      if (now - candidate.recordedAt > HOVER_SURFACE_CONTEXT_MAX_MS) continue;
      if (isLikelyHoverSurfaceOwner(candidate.element, surface)) return candidate;
    }
    return undefined;
  };

  const parentSurfaceNodeForOwner = (
    owner: HoverCandidate,
    now: number,
  ): HoverSurfaceNode | undefined => {
    const ownedParent = ownedSurfaceContaining(owner.element);
    if (ownedParent) return ownedParent;
    const parentSurface = closestHoverSurfaceCandidate(owner.element);
    if (!parentSurface || !isVisibleSurfaceElement(parentSurface)) return undefined;
    const parentOwner = inferOwnerForSurface(parentSurface, now, owner);
    if (!parentOwner) return undefined;
    const parentNode: HoverSurfaceNode = {
      element: parentSurface,
      signature: hoverSurfaceSignature(parentSurface),
      owner: parentOwner,
    };
    hoverSurfaceNodes.set(parentSurface, parentNode);
    return parentNode;
  };

  const bindSurfaceNode = (
    surface: Element,
    signature: string,
    now: number,
  ): HoverSurfaceNode | undefined => {
    const existing = hoverSurfaceNodes.get(surface);
    if (existing && existing.signature === signature) return existing;
    const owner = inferOwnerForSurface(surface, now);
    if (!owner) return existing;
    const parent = parentSurfaceNodeForOwner(owner, now);
    if (parent?.element === surface) return existing;
    if (now - owner.recordedAt > HOVER_SURFACE_CONTEXT_MAX_MS) return existing;
    const node: HoverSurfaceNode = {
      element: surface,
      signature,
      owner,
      ...(parent ? { parent } : {}),
    };
    hoverSurfaceNodes.set(surface, node);
    return node;
  };

  const ensureSurfaceNode = (surface: Element, now: number): HoverSurfaceNode | undefined => {
    if (!isVisibleSurfaceElement(surface)) {
      hoverSurfaceNodes.delete(surface);
      hoverSurfaceSignatures.delete(surface);
      return undefined;
    }
    const signature = hoverSurfaceSignature(surface);
    hoverSurfaceSignatures.set(surface, signature);
    return bindSurfaceNode(surface, signature, now);
  };

  const refreshHoverSurfaces = (triggerElement?: Element, now = Date.now()) => {
    collectHoverMutations(hoverMutationObserver.takeRecords());
    const mutated = dirtyHoverElements.size > 0 ? [...dirtyHoverElements] : undefined;
    dirtyHoverElements.clear();
    pruneGoneHoverSurfaces();
    const candidates = collectScopedHoverSurfaceCandidates(
      triggerElement,
      mutated,
      hoverSurfaceNodes.keys(),
    );
    for (const element of candidates) {
      if (!isHoverSurfaceCandidateElement(element) || !isVisibleSurfaceElement(element)) {
        hoverSurfaceNodes.delete(element);
        hoverSurfaceSignatures.delete(element);
        continue;
      }
      const signature = hoverSurfaceSignature(element);
      const previousSignature = hoverSurfaceSignatures.get(element);
      hoverSurfaceSignatures.set(element, signature);
      if (previousSignature === signature) continue;
      bindSurfaceNode(element, signature, now);
    }
  };

  const scheduleHoverSurfaceRefresh = (triggerElement: Element) => {
    if (hoverRefreshTimer !== null) clearTimeout(hoverRefreshTimer);
    hoverRefreshTimer = setTimeout(() => {
      hoverRefreshTimer = null;
      if (stopped) return;
      refreshHoverSurfaces(triggerElement);
    }, 0);
  };

  const ownedSurfaceForAction = (target: Element): HoverSurfaceNode | undefined => {
    const now = Date.now();
    const lastHover = recentHoverCandidates[recentHoverCandidates.length - 1]?.element;
    refreshHoverSurfaces(lastHover, now);
    const closestSurface = closestHoverSurfaceCandidate(target);
    if (closestSurface) {
      const owned = ensureSurfaceNode(closestSurface, now);
      if (owned) return owned;
    }
    return ownedSurfaceContaining(target);
  };

  const emitHoverStep = (hover: HoverCandidate) => {
    if (emittedHoverElements.has(hover.element)) return;
    emitStep({
      op: "hover",
      target: hover.target,
      geometry: captureGeometry(hover.element),
    });
    emittedHoverElements.add(hover.element);
  };

  const surfaceOwnerChain = (
    surface: HoverSurfaceNode,
    actionElement: Element,
    now: number,
  ): HoverCandidate[] => {
    const chain: HoverCandidate[] = [];
    const selected = new WeakSet<Element>();
    const surfaces: HoverSurfaceNode[] = [];
    let node: HoverSurfaceNode | undefined = surface;
    while (node && surfaces.length < 4) {
      surfaces.unshift(node);
      node = node.parent;
    }
    for (const owned of surfaces) {
      const owner = owned.owner;
      if (owner.element === actionElement || actionElement.contains(owner.element)) {
        continue;
      }
      if (selected.has(owner.element)) continue;
      if (emittedHoverElements.has(owner.element)) continue;
      if (now - owner.recordedAt > HOVER_SURFACE_CONTEXT_MAX_MS) continue;
      selected.add(owner.element);
      chain.push(owner);
    }
    return chain;
  };

  const containedHoverOwnerForAction = (
    actionElement: Element,
    now: number,
  ): HoverCandidate | undefined => {
    for (let index = recentHoverCandidates.length - 1; index >= 0; index -= 1) {
      const candidate = recentHoverCandidates[index];
      if (!candidate) continue;
      if (candidate.element === actionElement) continue;
      if (!candidate.element.contains(actionElement)) continue;
      if (now - candidate.recordedAt > HOVER_SURFACE_CONTEXT_MAX_MS) continue;
      return candidate;
    }
    return undefined;
  };

  const emitClick = (event: MouseEvent) => {
    // Only record clicks an LLM can re-identify (named interactive controls).
    const rawTarget = primaryEventTarget(event);
    const target = describeEventTarget(rawTarget);
    if (!target) return;
    emitStep({
      op: "click",
      target,
      geometry: geometryForEventTarget(rawTarget),
      expects_navigation: true,
    });
  };

  const emitHoverCandidateBeforeAction = (actionTarget: EventTarget | null) => {
    if (!(actionTarget instanceof Element)) return;
    const actionElement = resolveClickableElement(actionTarget) ?? actionTarget;
    const surface = ownedSurfaceForAction(actionElement);
    const now = Date.now();
    const containedOwner = surface ? undefined : containedHoverOwnerForAction(actionElement, now);
    const hoverChain = surface
      ? surfaceOwnerChain(surface, actionElement, now)
      : containedOwner
        ? [containedOwner]
        : [];
    if (hoverChain.length === 0) {
      pendingHover = null;
      return;
    }
    for (const hover of hoverChain) emitHoverStep(hover);
    pendingHover = null;
  };

  const onMouseOver = (event: MouseEvent) => {
    if (isExtensionOverlayEvent(event)) return;
    const target = primaryEventTarget(event);
    const now = Date.now();
    if (pendingHover && target instanceof Element && pendingHover.element.contains(target)) {
      if (now - pendingHover.recordedAt <= HOVER_BEFORE_CLICK_MAX_MS) return;
      pendingHover = null;
    }
    // Flush surfaces opened by the previous hover candidate (e.g., via bubble-phase
    // mouseover listeners or CSS :hover) before registering the next candidate so
    // crossing a neighboring toolbar button cannot steal ownership of an open menu.
    const previousCandidate = recentHoverCandidates[recentHoverCandidates.length - 1];
    if (previousCandidate) {
      refreshHoverSurfaces(previousCandidate.element, now);
    }
    if (target instanceof Element) {
      const surface = closestHoverSurfaceCandidate(target);
      if (surface) {
        ensureSurfaceNode(surface, now);
      }
    }
    const candidate = hoverCandidateFromEvent(target);
    if (candidate) {
      rememberHoverCandidate(candidate);
      refreshHoverSurfaces(candidate.element, now);
      scheduleHoverSurfaceRefresh(candidate.element);
    }
    const hover = candidate?.eligible ? candidate : null;
    if (pendingHover && target instanceof Element) {
      const relation = decideHoverSurfaceRelation({ triggerElement: pendingHover.element }, target);
      if (relation.related && now - pendingHover.recordedAt <= HOVER_BEFORE_CLICK_MAX_MS) {
        return;
      }
    }
    if (!hover) return;
    if (pendingHover && !shouldReplaceHoverCandidate(pendingHover, hover, now)) {
      return;
    }
    pendingHover = hover;
  };

  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || isExtensionOverlayEvent(event)) return;
    observeEventShadowRoots(event);
    const target = primaryEventTarget(event);
    if (event.detail === 0 && generatedControlClick !== null && target === generatedControlClick) {
      generatedControlClick = null;
      return;
    }
    if (
      event.detail === 0 &&
      keyboardActivation &&
      (keyboardActivation.target === target ||
        (target instanceof Element &&
          !target.shadowRoot &&
          keyboardActivation.target instanceof Node &&
          isNodeInsideShadowHost(keyboardActivation.target, target))) &&
      Date.now() - keyboardActivation.recordedAt < 500
    ) {
      keyboardActivation = undefined;
      return;
    }

    const label = target instanceof Element ? target.closest("label") : null;
    const nestedInteractive =
      target instanceof Element ? target.closest("a,button,input,select,textarea") : null;
    if (label instanceof HTMLLabelElement && !nestedInteractive) {
      commitFillSession();
      generatedControlClick = label.control;
      emitClick(event);
      return;
    }

    const fillable = fillableFromTarget(target);
    if (fillable) {
      emitHoverCandidateBeforeAction(fillable);
      ensureFillSession(fillable);
      return;
    }

    if (target instanceof Element) {
      const nearbyFillable = nearbyFillableFromSearchChrome(target);
      if (nearbyFillable) {
        emitHoverCandidateBeforeAction(nearbyFillable);
        ensureFillSession(nearbyFillable);
        return;
      }
    }

    if (isInputCompletionClick(target, fillSession)) {
      const sessionElement = fillSession!.element;
      scheduleInputCompletionCommit(
        sessionElement,
        syncFillSessionValue,
        () => commitFillSession("suggestion"),
        (el) => fillSession?.element === el,
      );
      return;
    }

    commitFillSession();
    if (target instanceof Element && target.closest("select")) return;
    emitHoverCandidateBeforeAction(target);
    emitClick(event);
  };

  const onFocusIn = (event: FocusEvent) => {
    if (isExtensionOverlayEvent(event)) return;
    observeEventShadowRoots(event);
    const target = fillableFromTarget(resolveClosedShadowEditTarget(primaryEventTarget(event)));
    if (target) ensureFillSession(target);
  };

  const onFocusOut = (event: FocusEvent) => {
    if (isExtensionOverlayEvent(event)) return;
    const rawTarget = primaryEventTarget(event);
    const target =
      fillableFromTarget(resolveClosedShadowEditTarget(rawTarget)) ??
      (fillSession &&
      rawTarget instanceof Element &&
      !rawTarget.shadowRoot &&
      isNodeInsideShadowHost(fillSession.element, rawTarget)
        ? fillSession.element
        : null);
    if (!target) return;
    if (!fillSession || fillSession.element !== target) return;
    syncFillSessionValue(target);
    commitFillSession();
  };

  const onInput = (event: Event) => {
    if (isExtensionOverlayEvent(event)) return;
    observeEventShadowRoots(event);
    const rawTarget = resolveClosedShadowEditTarget(primaryEventTarget(event));
    // A native <select> in a shadow root fires a non-composed `change` that
    // never reaches the document; its composed `input` does.
    if (rawTarget instanceof HTMLSelectElement && rawTarget.getRootNode() instanceof ShadowRoot) {
      recordSelect(rawTarget);
      return;
    }
    const target = fillableFromTarget(rawTarget);
    if (!target) return;
    if (composing) return;
    ensureFillSession(target);
    syncFillSessionValue(target);
  };

  const onCompositionStart = (event: CompositionEvent) => {
    if (isExtensionOverlayEvent(event)) return;
    composing = true;
  };

  const onCompositionEnd = (event: CompositionEvent) => {
    if (isExtensionOverlayEvent(event)) return;
    composing = false;
    const target = fillableFromTarget(resolveClosedShadowEditTarget(primaryEventTarget(event)));
    if (target) {
      ensureFillSession(target);
      syncFillSessionValue(target);
    }
  };

  const recordSelect = (target: HTMLSelectElement) => {
    commitFillSession();
    emitHoverCandidateBeforeAction(target);
    const values = Array.from(target.selectedOptions).map((opt) => opt.value);
    const labels = Array.from(target.selectedOptions).map((opt) =>
      (opt.label || opt.textContent || opt.value).trim(),
    );
    const desc = describeTarget(target);
    emitStep({
      op: "select",
      target: desc,
      geometry: captureGeometry(target),
      values,
      labels,
      expects_navigation: true,
    });
  };

  const onChange = (event: Event) => {
    if (isExtensionOverlayEvent(event)) return;
    const target = resolveClosedShadowEditTarget(primaryEventTarget(event));
    if (target instanceof HTMLSelectElement) {
      recordSelect(target);
    } else {
      commitFillSession();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (isExtensionOverlayEvent(event)) return;
    observeEventShadowRoots(event);
    const target = resolveClosedShadowEditTarget(primaryEventTarget(event));
    const fillable = fillableFromTarget(target);
    if (fillable) {
      ensureFillSession(fillable);
      syncFillSessionValue(fillable);
    }
    const modifiers = [
      ...(event.altKey ? (["alt"] as const) : []),
      ...(event.ctrlKey ? (["ctrl"] as const) : []),
      ...(event.metaKey ? (["meta"] as const) : []),
      ...(event.shiftKey ? (["shift"] as const) : []),
    ];
    if (!shouldRecordPress(event.key, modifiers)) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const submitTarget =
        event.key === "Enter" && fillable
          ? fillable
              .closest("form")
              ?.querySelector(
                'button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]',
              )
          : null;
      keyboardActivation = {
        target: submitTarget ?? target,
        recordedAt: Date.now(),
      };
    }
    if (fillable) {
      commitFillSession(event.key === "Enter" ? "enter" : "blur");
    }
    const desc = describeEventTarget(target);
    if (!desc && !event.key) return;
    emitHoverCandidateBeforeAction(target);
    emitStep({
      op: "press",
      key: event.key,
      ...(desc ? { target: desc, geometry: geometryForEventTarget(target) } : {}),
      ...(modifiers.length ? { modifiers } : {}),
      expects_navigation: event.key === "Enter",
    });
  };

  document.addEventListener("click", onClick, true);
  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("compositionstart", onCompositionStart, true);
  document.addEventListener("compositionend", onCompositionEnd, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("keydown", onKeyDown, true);

  const captureNavigation = options.captureNavigation ?? true;
  const urlObserver = captureNavigation
    ? new MutationObserver((records) => {
        if (records.every(isInternalBskMutation)) return;
        emitNavigateIfChanged();
      })
    : null;
  urlObserver?.observe(document, { subtree: true, childList: true });
  const onUrlEvent = () => emitNavigateIfChanged();
  // Wrap: passing commitFillSession directly would forward the DOM event as
  // the `commit` argument and stamp it onto the recorded fill step.
  const onPageHide = () => commitFillSession();
  if (captureNavigation) {
    window.addEventListener("hashchange", onUrlEvent);
    window.addEventListener("popstate", onUrlEvent);
  }
  window.addEventListener("pagehide", onPageHide);

  let stopped = false;
  let disposed = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    handlePasswordMutations(typeObserver.takeRecords());
    commitFillSession();
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("compositionstart", onCompositionStart, true);
    document.removeEventListener("compositionend", onCompositionEnd, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (hoverRefreshTimer !== null) {
      clearTimeout(hoverRefreshTimer);
      hoverRefreshTimer = null;
    }
    hoverMutationObserver.disconnect();
    dirtyHoverElements.clear();
    urlObserver?.disconnect();
    if (captureNavigation) {
      window.removeEventListener("hashchange", onUrlEvent);
      window.removeEventListener("popstate", onUrlEvent);
    }
    window.removeEventListener("pagehide", onPageHide);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    typeObserver.disconnect();
    for (const element of formerPasswords) element.removeAttribute(RECORD_PASSWORD_ATTRIBUTE);
    formerPasswords.clear();
  };

  return { stop, dispose };
}
