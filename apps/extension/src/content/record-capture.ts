import { describeEventTarget, describeTarget, type TargetDescriptor } from "@/lib/describe-target";
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

const pendingStepSends = new Map<string, Set<Promise<boolean>>>();
const failedStepDeliveries = new Set<string>();
const knownRecordRequests = new Set<string>();

function sendRecordStep(requestId: string, step: RecordStepPayload): void {
  const payload = { type: RECORD_STEP, requestId, step };
  const pending = Promise.resolve(chrome.runtime.sendMessage(payload)).then(
    () => true,
    () => {
      failedStepDeliveries.add(requestId);
      return false;
    },
  );
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
  target: TargetDescriptor;
  baselineValue: string;
  lastValue: string;
}

type FillableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

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

function fillableValue(el: FillableElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value;
  }
  return el.textContent ?? "";
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
  let fillSession: FillSession | null = null;
  let composing = false;
  let lastUrl = location.href;
  let keyboardActivation: { target: EventTarget | null; recordedAt: number } | undefined;
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
      value,
      ...(isPassword ? { redacted: true } : {}),
    });
  };

  const commitFillSession = () => {
    if (!fillSession || composing) return;
    const session = fillSession;
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

  const emitClick = (event: MouseEvent) => {
    // Only record clicks an LLM can re-identify (named interactive controls).
    const target = describeEventTarget(eventTarget(event));
    if (!target) return;
    markNavigationAction();
    emitStep({
      op: "click",
      target,
      expects_navigation: true,
    });
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
      ensureFillSession(fillable);
      return;
    }

    if (target instanceof Element) {
      const nearbyFillable = nearbyFillableFromSearchChrome(target);
      if (nearbyFillable) {
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
        commitFillSession,
        (el) => fillSession?.element === el,
      );
      return;
    }

    commitFillSession();
    if (target instanceof Element && target.closest("select")) return;
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
      const values = Array.from(target.selectedOptions).map((opt) => opt.value);
      const labels = Array.from(target.selectedOptions).map((opt) =>
        (opt.label || opt.textContent || opt.value).trim(),
      );
      const desc = describeTarget(target);
      markNavigationAction();
      emitStep({
        op: "select",
        target: desc,
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
      commitFillSession();
    }
    const desc = describeEventTarget(target);
    if (!desc && !event.key) return;
    emitStep({
      op: "press",
      key: event.key,
      ...(desc ? { target: desc } : {}),
      ...(modifiers.length ? { modifiers } : {}),
      expects_navigation: event.key === "Enter",
    });
  };

  document.addEventListener("click", onClick, true);
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
  window.addEventListener("hashchange", onUrlEvent);
  window.addEventListener("popstate", onUrlEvent);
  window.addEventListener("pagehide", commitFillSession);

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
      window.removeEventListener("pagehide", commitFillSession);
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
    onStart(requestId: string): void;
    onStop(): void;
  },
  sendResponse?: (response: RecordStartAck | RecordStopAck) => void,
): boolean {
  if (isRecordStartMessage(message)) {
    if (!knownRecordRequests.has(message.requestId)) {
      knownRecordRequests.add(message.requestId);
      failedStepDeliveries.delete(message.requestId);
    }
    state.capture?.dispose();
    state.setCapture(
      startRecordCapture(message.requestId, (step) => {
        sendRecordStep(message.requestId, step);
      }),
    );
    state.setActiveRequestId(message.requestId);
    state.onStart(message.requestId);
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
      const pending = [...(pendingStepSends.get(message.requestId) ?? [])];
      void Promise.all(pending).then((delivered) => {
        finishStop();
        const succeeded = delivered.every(Boolean) && !failedStepDeliveries.has(message.requestId);
        if (succeeded) {
          failedStepDeliveries.delete(message.requestId);
          knownRecordRequests.delete(message.requestId);
        }
        sendResponse(
          succeeded
            ? { ok: true }
            : {
                ok: false,
                error: "failed to deliver one or more recorded steps",
              },
        );
      });
      return true;
    }
    if (isRecordCancelMessage(message)) {
      failedStepDeliveries.delete(message.requestId);
      knownRecordRequests.delete(message.requestId);
    }
    finishStop();
    return false;
  }

  return false;
}

export { RECORD_CANCEL, RECORD_START, RECORD_STEP, RECORD_STOP };
