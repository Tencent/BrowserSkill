import {
  type CaptureTargetDescriptor,
  describeEventTarget,
  describeTarget,
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
import {
  isRecordCancelMessage,
  isRecordStartMessage,
  isRecordStopMessage,
  RECORD_CANCEL,
  RECORD_START,
  RECORD_STEP,
  RECORD_STOP,
  type RecordCancelMessage,
  type RecordStartAck,
  type RecordStartMessage,
  type RecordStepPayload,
  type RecordStopAck,
  type RecordStopMessage,
} from "@/lib/record-bridge";
import { shouldRecordPress } from "@/lib/trace-reducer";
import {
  closestHoverSurfaceCandidate,
  collectHoverSurfaceStates,
  decideHoverSurfaceRelation,
  type HoverSurfaceState,
  isHoverSurfaceCandidateElement,
  isLikelyHoverSurfaceOwner,
} from "./record-hover-surface";

const pendingStepSends = new Map<string, Set<Promise<boolean>>>();
const failedStepDeliveries = new Set<string>();
const failedStepPayloads = new Map<string, RecordStepPayload[]>();
const pendingStopFlushes = new Map<string, Promise<RecordStopAck>>();
const knownRecordRequests = new Set<string>();

function deliverRecordStep(requestId: string, step: RecordStepPayload): Promise<boolean> {
  const payload = { type: RECORD_STEP, requestId, step };
  return Promise.resolve(chrome.runtime.sendMessage(payload)).then(
    () => true,
    () => {
      failedStepDeliveries.add(requestId);
      const failed = failedStepPayloads.get(requestId) ?? [];
      failed.push(step);
      failedStepPayloads.set(requestId, failed);
      return false;
    },
  );
}

function sendRecordStep(requestId: string, step: RecordStepPayload): void {
  const pending = deliverRecordStep(requestId, step);
  const sends = pendingStepSends.get(requestId) ?? new Set<Promise<boolean>>();
  sends.add(pending);
  pendingStepSends.set(requestId, sends);
  void pending.then(() => {
    sends.delete(pending);
    if (sends.size === 0) pendingStepSends.delete(requestId);
  });
}

export interface RecordCaptureController {
  dispose(): void;
}

interface FillSession {
  element: FillableElement;
  target: CaptureTargetDescriptor;
  baselineValue: string;
  lastValue: string;
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

function eventTarget(event: Event): EventTarget | null {
  return event.composedPath()[0] ?? event.target;
}

function isOverlayTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  const root = document.documentElement;
  let node: Node | null = target;
  while (node && node !== root) {
    if (node instanceof Element && node.hasAttribute("data-bsk-overlay")) {
      return true;
    }
    const rootNode: Node | Document | ShadowRoot = node.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      const host: Element = rootNode.host;
      if (host.hasAttribute("data-bsk-overlay")) {
        return true;
      }
      node = host;
    } else {
      node = node.parentNode;
    }
  }
  return false;
}

function isTextFillable(el: Element): el is FillableElement {
  if (el instanceof HTMLElement && (el.isContentEditable || el.contentEditable === "true")) {
    return true;
  }
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  const type = el.type.toLowerCase();
  return type !== "checkbox" && type !== "radio" && type !== "file" && type !== "button";
}

function fillableFromTarget(target: EventTarget | null): FillableElement | null {
  if (!(target instanceof Element)) return null;
  if (isTextFillable(target)) return target;
  const el = target.closest('input,textarea,[contenteditable]:not([contenteditable="false"])');
  if (el && isTextFillable(el)) return el;
  return null;
}

/** Clicks on search chrome that only focus the nearby input should not become steps. */
function nearbyFillableFromSearchChrome(target: Element): FillableElement | null {
  const container = target.closest(
    '[id*="chat-input"], [id*="search"], [class*="search"], form, [role="search"]',
  );
  if (!container) return null;
  const fillable = container.querySelector(
    'textarea, input[type="search"], input[name="q"], #chat-textarea',
  );
  if (
    fillable instanceof HTMLElement &&
    isTextFillable(fillable) &&
    fillable !== target &&
    !fillable.contains(target)
  ) {
    return fillable;
  }
  return null;
}

function captureGeometry(el: Element): RecordStepPayload["geometry"] {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return {
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    position: style.position,
    tag: el.tagName.toLowerCase(),
  };
}

function geometryForEventTarget(
  target: EventTarget | null,
): RecordStepPayload["geometry"] | undefined {
  if (!(target instanceof Element)) return undefined;
  const clickable = target.closest(
    'a,button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[contenteditable="true"]',
  );
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
): RecordCaptureController {
  const emitStep = (step: RecordStepPayload) => {
    sendStep({ page_url: location.href, ...step });
  };
  const hoverSurfaceStateMap = (states: HoverSurfaceState[]): Map<Element, string> =>
    new Map(states.map((state) => [state.element, state.signature]));
  let fillSession: FillSession | null = null;
  let composing = false;
  let lastUrl = location.href;
  let keyboardActivation: { target: EventTarget | null; recordedAt: number } | undefined;
  let pendingHover: HoverCandidate | null = null;
  const recentHoverCandidates: HoverCandidate[] = [];
  const emittedHoverElements = new WeakSet<Element>();
  let hoverSurfaceStates = hoverSurfaceStateMap(collectHoverSurfaceStates());
  const hoverSurfaceNodes = new Map<Element, HoverSurfaceNode>();
  let generatedControlClick: Element | null = null;
  let navigationActionPending = false;
  let navigationActionVersion = 0;
  const committedValues = new WeakMap<FillableElement, string>();

  const markNavigationAction = () => {
    navigationActionPending = true;
    const version = ++navigationActionVersion;
    setTimeout(() => {
      if (navigationActionVersion === version) {
        navigationActionPending = false;
      }
    }, 0);
  };

  const emitFill = (session: FillSession) => {
    if (session.lastValue === session.baselineValue) return;
    const isPassword =
      session.element instanceof HTMLInputElement && session.element.type === "password";
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
    };
  };

  const emitNavigateIfChanged = (causedByAction?: boolean) => {
    if (location.href === lastUrl) return;
    commitFillSession();
    lastUrl = location.href;
    emitStep({
      op: "navigate",
      url: location.href,
      ...(causedByAction !== undefined ? { navigation_caused_by_action: causedByAction } : {}),
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

  const surfaceStateContaining = (
    target: Element,
    states: HoverSurfaceState[],
  ): HoverSurfaceState | undefined => smallestContaining(target, states, (state) => state.element);

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

  const nodeForUnownedSurface = (
    surfaceState: HoverSurfaceState,
    currentStates: HoverSurfaceState[],
    now: number,
  ): HoverSurfaceNode | undefined => {
    const owner = inferOwnerForSurface(surfaceState.element, now);
    if (!owner) return undefined;
    const parent = parentSurfaceNodeForOwner(owner, currentStates, now);
    const node: HoverSurfaceNode = {
      element: surfaceState.element,
      signature: surfaceState.signature,
      owner,
      ...(parent ? { parent } : {}),
    };
    hoverSurfaceNodes.set(surfaceState.element, node);
    return node;
  };

  const ownedSurfaceForAction = (target: Element): HoverSurfaceNode | undefined => {
    const closestSurface = closestHoverSurfaceCandidate(target);
    if (closestSurface) {
      const owned = hoverSurfaceNodes.get(closestSurface);
      if (owned) return owned;
    }
    const ownedContaining = ownedSurfaceContaining(target);
    if (ownedContaining) return ownedContaining;
    const now = Date.now();
    const currentStates = collectHoverSurfaceStates();
    pruneGoneHoverSurfaces(currentStates);
    const surfaceState = closestSurface
      ? currentStates.find((state) => state.element === closestSurface)
      : surfaceStateContaining(target, currentStates);
    hoverSurfaceStates = hoverSurfaceStateMap(currentStates);
    if (!surfaceState) return undefined;
    return nodeForUnownedSurface(surfaceState, currentStates, now);
  };

  const pruneGoneHoverSurfaces = (currentStates: HoverSurfaceState[]) => {
    const current = new Set(currentStates.map((state) => state.element));
    for (const element of hoverSurfaceNodes.keys()) {
      if (!current.has(element)) hoverSurfaceNodes.delete(element);
    }
  };

  const parentSurfaceNodeForOwner = (
    owner: HoverCandidate,
    currentStates: HoverSurfaceState[],
    now: number,
  ): HoverSurfaceNode | undefined => {
    const ownedParent = ownedSurfaceContaining(owner.element);
    if (ownedParent) return ownedParent;
    const parentState = surfaceStateContaining(owner.element, currentStates);
    if (!parentState) return undefined;
    const parentOwner = inferOwnerForSurface(parentState.element, now, owner);
    if (!parentOwner) return undefined;
    const parentNode: HoverSurfaceNode = {
      element: parentState.element,
      signature: parentState.signature,
      owner: parentOwner,
    };
    hoverSurfaceNodes.set(parentState.element, parentNode);
    return parentNode;
  };

  const createSurfaceNode = (
    state: HoverSurfaceState,
    owner: HoverCandidate,
    currentStates: HoverSurfaceState[],
    now: number,
  ): HoverSurfaceNode | undefined => {
    const parent = parentSurfaceNodeForOwner(owner, currentStates, now);
    if (parent?.element === state.element) return undefined;
    if (now - owner.recordedAt > HOVER_SURFACE_CONTEXT_MAX_MS) return undefined;
    if (!isLikelyHoverSurfaceOwner(owner.element, state.element)) return undefined;
    const node: HoverSurfaceNode = {
      element: state.element,
      signature: state.signature,
      owner,
      ...(parent ? { parent } : {}),
    };
    hoverSurfaceNodes.set(state.element, node);
    return node;
  };

  const bindChangedHoverSurfaces = (
    previousStates: Map<Element, string>,
    currentStates: HoverSurfaceState[],
    now: number,
  ) => {
    for (const state of currentStates) {
      if (previousStates.get(state.element) === state.signature) continue;
      const owner = inferOwnerForSurface(state.element, now);
      if (!owner) continue;
      createSurfaceNode(state, owner, currentStates, now);
    }
  };

  const refreshHoverSurfaces = (previousStates = hoverSurfaceStates) => {
    const now = Date.now();
    const currentStates = collectHoverSurfaceStates();
    pruneGoneHoverSurfaces(currentStates);
    bindChangedHoverSurfaces(previousStates, currentStates, now);
    hoverSurfaceStates = hoverSurfaceStateMap(currentStates);
  };

  const scheduleHoverSurfaceRefresh = (previousStates: Map<Element, string>) => {
    setTimeout(() => refreshHoverSurfaces(previousStates), 0);
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
    const target = describeEventTarget(eventTarget(event));
    if (!target) return;
    markNavigationAction();
    emitStep({
      op: "click",
      target,
      geometry: geometryForEventTarget(eventTarget(event)),
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
    const target = eventTarget(event);
    if (isOverlayTarget(target)) return;
    const now = Date.now();
    if (pendingHover && target instanceof Element && pendingHover.element.contains(target)) {
      if (now - pendingHover.recordedAt <= HOVER_BEFORE_CLICK_MAX_MS) return;
      pendingHover = null;
    }
    const candidate = hoverCandidateFromEvent(target);
    if (candidate) {
      const previousSurfaceStates = new Map(hoverSurfaceStates);
      rememberHoverCandidate(candidate);
      refreshHoverSurfaces(previousSurfaceStates);
      scheduleHoverSurfaceRefresh(previousSurfaceStates);
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
    if (event.button !== 0) return;
    const target = eventTarget(event);
    if (isOverlayTarget(target)) return;
    if (event.detail === 0 && generatedControlClick !== null && target === generatedControlClick) {
      generatedControlClick = null;
      return;
    }
    if (
      event.detail === 0 &&
      keyboardActivation?.target === target &&
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
      markNavigationAction();
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
    const target = fillableFromTarget(eventTarget(event));
    if (target) ensureFillSession(target);
  };

  const onFocusOut = (event: FocusEvent) => {
    const target = fillableFromTarget(eventTarget(event));
    if (!target) return;
    if (!fillSession || fillSession.element !== target) return;
    syncFillSessionValue(target);
    commitFillSession();
  };

  const onInput = (event: Event) => {
    const target = fillableFromTarget(eventTarget(event));
    if (!target) return;
    if (composing) return;
    ensureFillSession(target);
    syncFillSessionValue(target);
  };

  const onCompositionStart = () => {
    composing = true;
  };

  const onCompositionEnd = (event: CompositionEvent) => {
    composing = false;
    const target = fillableFromTarget(eventTarget(event));
    if (target) {
      ensureFillSession(target);
      syncFillSessionValue(target);
    }
  };

  const onChange = (event: Event) => {
    commitFillSession();
    const target = eventTarget(event);
    if (target instanceof HTMLSelectElement) {
      emitHoverCandidateBeforeAction(target);
      const values = Array.from(target.selectedOptions).map((opt) => opt.value);
      const labels = Array.from(target.selectedOptions).map((opt) =>
        (opt.label || opt.textContent || opt.value).trim(),
      );
      const desc = describeTarget(target);
      markNavigationAction();
      emitStep({
        op: "select",
        target: desc,
        geometry: captureGeometry(target),
        values,
        labels,
        expects_navigation: true,
      });
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (isOverlayTarget(eventTarget(event))) return;
    const target = eventTarget(event);
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
    markNavigationAction();
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

  const urlObserver = new MutationObserver(() => emitNavigateIfChanged());
  urlObserver.observe(document, { subtree: true, childList: true });
  const onUrlEvent = () => emitNavigateIfChanged();
  // Wrap: passing commitFillSession directly would forward the DOM event as
  // the `commit` argument and stamp it onto the recorded fill step.
  const onPageHide = () => commitFillSession();
  window.addEventListener("hashchange", onUrlEvent);
  window.addEventListener("popstate", onUrlEvent);
  window.addEventListener("pagehide", onPageHide);

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args: Parameters<History["pushState"]>) {
    originalPushState.apply(this, args);
    emitNavigateIfChanged(navigationActionPending ? true : undefined);
  };
  history.replaceState = function (...args: Parameters<History["replaceState"]>) {
    originalReplaceState.apply(this, args);
    emitNavigateIfChanged(navigationActionPending ? true : undefined);
  };

  return {
    dispose() {
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
      urlObserver.disconnect();
      window.removeEventListener("hashchange", onUrlEvent);
      window.removeEventListener("popstate", onUrlEvent);
      window.removeEventListener("pagehide", onPageHide);
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
    },
  };
}

export type RecordContentMessage = RecordStartMessage | RecordStopMessage | RecordCancelMessage;

export function isRecordContentMessage(msg: unknown): msg is RecordContentMessage {
  return isRecordStartMessage(msg) || isRecordStopMessage(msg) || isRecordCancelMessage(msg);
}

export function handleRecordContentMessage(
  message: RecordContentMessage,
  state: {
    activeRequestId: string | null;
    capture: RecordCaptureController | null;
    setActiveRequestId(id: string | null): void;
    setCapture(capture: RecordCaptureController | null): void;
    onStart(requestId: string, startedAtMs?: number): void;
    onStop(): void;
  },
  sendResponse?: (response: RecordStartAck | RecordStopAck) => void,
): boolean {
  if (isRecordStartMessage(message)) {
    if (!knownRecordRequests.has(message.requestId)) {
      knownRecordRequests.add(message.requestId);
      failedStepDeliveries.delete(message.requestId);
      failedStepPayloads.delete(message.requestId);
    }
    state.capture?.dispose();
    state.setCapture(
      startRecordCapture(message.requestId, (step) => {
        sendRecordStep(message.requestId, step);
      }),
    );
    state.setActiveRequestId(message.requestId);
    state.onStart(message.requestId, message.startedAtMs);
    sendResponse?.({ ok: true });
    return sendResponse !== undefined;
  }

  if (isRecordStopMessage(message) || isRecordCancelMessage(message)) {
    // Require an active recording that matches this requestId — otherwise a
    // stray STOP/CANCEL (e.g. after teardown) would still run finishStop and
    // clear overlay state even though nothing was capturing.
    if (!state.activeRequestId || state.activeRequestId !== message.requestId) {
      return false;
    }
    state.capture?.dispose();
    state.setCapture(null);
    const finishStop = () => {
      state.onStop();
      state.setActiveRequestId(null);
    };
    if (isRecordStopMessage(message) && sendResponse) {
      const existingFlush = pendingStopFlushes.get(message.requestId);
      if (existingFlush) {
        void existingFlush.then(sendResponse);
        return true;
      }

      const failedBeforeStop = [...(failedStepPayloads.get(message.requestId) ?? [])];
      if (failedBeforeStop.length > 0) {
        failedStepPayloads.delete(message.requestId);
        failedStepDeliveries.delete(message.requestId);
      }
      const pending = [...(pendingStepSends.get(message.requestId) ?? [])];
      const flush = Promise.all(pending).then(async (delivered): Promise<RecordStopAck> => {
        const retried = await Promise.all(
          failedBeforeStop.map((step) => deliverRecordStep(message.requestId, step)),
        );
        const succeeded =
          delivered.every(Boolean) &&
          retried.every(Boolean) &&
          !failedStepDeliveries.has(message.requestId);
        if (succeeded) {
          failedStepDeliveries.delete(message.requestId);
          failedStepPayloads.delete(message.requestId);
          knownRecordRequests.delete(message.requestId);
          finishStop();
        }
        return succeeded
          ? { ok: true }
          : {
              ok: false,
              error: "failed to deliver one or more recorded steps",
            };
      });
      pendingStopFlushes.set(message.requestId, flush);
      void flush.then(sendResponse).finally(() => {
        if (pendingStopFlushes.get(message.requestId) === flush) {
          pendingStopFlushes.delete(message.requestId);
        }
      });
      return true;
    }
    if (isRecordCancelMessage(message)) {
      failedStepDeliveries.delete(message.requestId);
      failedStepPayloads.delete(message.requestId);
      pendingStopFlushes.delete(message.requestId);
      knownRecordRequests.delete(message.requestId);
    }
    finishStop();
    return false;
  }

  return false;
}

export { RECORD_CANCEL, RECORD_START, RECORD_STEP, RECORD_STOP };
