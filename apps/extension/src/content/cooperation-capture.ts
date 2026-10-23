import {
  COOPERATION_ARM,
  COOPERATION_DISABLE,
  COOPERATION_MESSAGE,
  COOPERATION_READ,
  COOPERATION_READY,
  COOPERATION_RESUME,
  type FieldChange,
  type FrameState,
  type HumanActivity,
  type InputExpectation,
} from "@/cooperation/types";
import { OVERLAY_HOST_SELECTOR } from "@/lib/overlay-bridge";

const MAX_CHANGES = 64;
// CDP's native clock conversion and the DOM clock round independently.
// This bound is fixed; renderer/dispatch delays never extend input attribution.
const INPUT_CLOCK_PRECISION_MS = 1.5;

/** Isolated-world collection also covers frames; no page-world control API is exposed. */
export function attachCooperationCapture() {
  let enabled = false;
  let lease: string | undefined;
  const retired = new Set<string>();
  const state: FrameState = {
    document: crypto.randomUUID(),
    revision: 0,
    structure: 0,
    human: 0,
    busy: false,
    editing: false,
    lastInput: 0,
    fields: [],
    events: [],
  };
  let expectation: InputExpectation | undefined;
  let nativeTime: { earliest: number; latest: number } | undefined;
  let originTime: number | undefined;
  let attribution: HumanActivity["attribution"];
  let composing = false;
  let pointer = false;
  const keys = new Set<string>();
  const fields = new Map<Element, FieldChange>();
  const sampledValues = new WeakMap<Element, string>();
  const ids = new WeakMap<Element, string>();
  let nextId = 0;
  const id = (element: Element) => {
    let value = ids.get(element);
    if (!value) ids.set(element, (value = String(++nextId)));
    return value;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const overlay = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest(OVERLAY_HOST_SELECTOR);
  const label = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return "page";
    return (
      target.getAttribute("aria-label") ||
      target.getAttribute("name") ||
      target.getAttribute("placeholder") ||
      target.textContent ||
      target.tagName
    )
      .trim()
      .slice(0, 160);
  };
  const editable = (target: EventTarget | null) =>
    target instanceof Element &&
    (target instanceof HTMLInputElement
      ? !target.readOnly &&
        !target.disabled &&
        ["text", "search", "email", "url", "tel", "password", "number"].includes(target.type)
      : target instanceof HTMLTextAreaElement
        ? !target.readOnly && !target.disabled
        : target instanceof HTMLElement && target.isContentEditable);
  const publish = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!enabled) return;
    state.busy = composing || pointer || keys.size > 0;
    state.fields = [...fields.values()];
    void chrome.runtime
      .sendMessage({ kind: COOPERATION_MESSAGE, lease, state: { ...state } })
      .catch(() => {});
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(publish, 60);
  };
  const mutations = (records: MutationRecord[]) => {
    if (
      !enabled ||
      !records.some(
        (r) => !overlay(r.target instanceof Element ? r.target : r.target.parentElement),
      )
    )
      return;
    state.revision++;
    state.structure++;
    schedule();
  };
  const observer = new MutationObserver(mutations);
  const roots = new Set<Document | ShadowRoot>();
  const controls = function* (root: Document | ShadowRoot): Generator<Element> {
    if (!roots.has(root)) {
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      roots.add(root);
    }
    for (const element of root.querySelectorAll("*")) {
      if (overlay(element)) continue;
      if (element.matches("input,textarea,select,[contenteditable=true]")) yield element;
      if (element.shadowRoot) yield* controls(element.shadowRoot);
    }
  };
  const read = () => {
    mutations(observer.takeRecords());
    if ([...roots].some((root) => root instanceof ShadowRoot && !root.host.isConnected)) {
      observer.disconnect();
      roots.clear();
    }
    for (const element of fields.keys()) if (!element.isConnected) fields.delete(element);
    let fieldCount = 0;
    state.fieldsComplete = true;
    for (const target of controls(document)) {
      if (
        overlay(target) ||
        (target instanceof HTMLInputElement && ["password", "file", "hidden"].includes(target.type))
      )
        continue;
      const fullValue =
        target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type)
          ? String(target.checked)
          : "value" in target
            ? String(target.value)
            : (target.textContent ?? "");
      const value = fullValue.slice(0, 500);
      const name = label(target);
      fieldCount++;
      if (fieldCount > MAX_CHANGES || fullValue.length > 500) state.fieldsComplete = false;
      const sampled = sampledValues.get(target);
      if (sampled !== undefined && sampled !== fullValue) state.revision++;
      sampledValues.set(target, fullValue);
      const old = fields.get(target);
      if (fields.size < MAX_CHANGES || old)
        fields.set(target, { id: id(target), label: name, value });
    }
    for (const element of fields.keys()) if (!element.isConnected) fields.delete(element);
    state.busy = composing || pointer || keys.size > 0;
    state.fields = [...fields.values()];
    return { ...state };
  };
  const matches = (event: Event): boolean => {
    attribution = undefined;
    if (!expectation || expectation.type !== event.type) return false;
    const expected = expectation;
    // Compare in this frame's monotonic clock. The epoch origin can drift from
    // the current wall clock used by native dispatch in a long-running browser.
    const match =
      nativeTime !== undefined &&
      ((event.timeStamp >= nativeTime.earliest && event.timeStamp <= nativeTime.latest) ||
        (originTime !== undefined &&
          Math.abs(event.timeStamp - originTime) <= INPUT_CLOCK_PRECISION_MS)) &&
      (event instanceof KeyboardEvent
        ? event.key === expected.key
        : event instanceof MouseEvent &&
          (window !== window.top ||
            (Math.abs(event.clientX - (expected.x ?? -1)) <= 2 &&
              Math.abs(event.clientY - (expected.y ?? -1)) <= 2)));
    attribution = match
      ? undefined
      : {
          expected_time: expected.timestamp,
          event_time: event.timeStamp + performance.timeOrigin,
          expected_type: expected.type,
          expected_event_time: nativeTime,
          event_timestamp: event.timeStamp,
        };
    if (match) expectation = undefined;
    return match;
  };
  const onEvent = (event: Event) => {
    if (!enabled || event.composedPath().some(overlay)) return;
    const target = event.composedPath()[0] ?? event.target;
    if (event.type === "input" || event.type === "change") {
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        // Passwords and file selections never enter the change stream.
        if (
          !(target instanceof HTMLInputElement) ||
          !["password", "file", "hidden"].includes(target.type)
        ) {
          fields.set(target, {
            id: id(target),
            label: label(target),
            value: target.value.slice(0, 500),
          });
          if (fields.size > MAX_CHANGES) {
            fields.clear();
            state.structure++;
          }
        }
      }
      state.revision++;
      schedule();
      return;
    }
    if (!event.isTrusted) return;
    if (event.type === "focusout") {
      // Focusout precedes focusin and retargets shadow controls to their host.
      // Resolve the final deep focus after the transition; never create a lease.
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        if (!enabled) return;
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        if (state.editing) state.revision++;
        state.editing = state.editing && editable(active);
        composing = false;
        publish();
      }, 0);
      return;
    }
    if (event.type === "pointerup" || event.type === "pointercancel") {
      if (pointer) state.revision++;
      pointer = false;
      publish();
      return;
    }
    if (event.type === "keyup") {
      if (keys.delete((event as KeyboardEvent).key)) state.revision++;
      publish();
      return;
    }
    if (event.type === "compositionend") {
      composing = false;
      state.revision++;
      state.lastInput = Date.now();
      publish();
      return;
    }
    if (event.type === "pointerdown" || event.type === "keydown" || event.type === "wheel") {
      if (matches(event)) return;
      if (event.type === "pointerdown") pointer = true;
      if (event.type === "keydown") keys.add((event as KeyboardEvent).key);
      // Scrolling over a text field does not start editing it.
      if (event.type !== "wheel") state.editing = editable(target);
    } else if (event.type === "compositionstart") {
      composing = true;
      state.editing = true;
    } else return;
    state.human++;
    state.revision++;
    state.lastInput = Date.now();
    state.events.push({
      sequence: state.human,
      type: event.type,
      label: label(target),
      at: state.lastInput,
      ...(attribution ? { attribution } : {}),
      ...(target instanceof Element
        ? {
            target_id: id(target),
            context: label(target.closest("fieldset,form,dialog,[role=dialog],[role=group]")).slice(
              0,
              160,
            ),
          }
        : {}),
    });
    if (state.events.length > MAX_CHANGES) state.events.shift();
    // Ownership notification is immediate, not part of the mutation debounce.
    publish();
  };
  const events = [
    "pointerdown",
    "pointerup",
    "pointercancel",
    "keydown",
    "keyup",
    "wheel",
    "compositionstart",
    "compositionend",
    "focusout",
    "input",
    "change",
  ];
  for (const event of events)
    document.addEventListener(event, onEvent, { capture: true, passive: true });
  const onWindowBlur = () => {
    if (!enabled || (!pointer && !composing && keys.size === 0)) return;
    pointer = false;
    composing = false;
    keys.clear();
    state.revision++;
    state.lastInput = Date.now();
    publish();
  };
  window.addEventListener("blur", onWindowBlur);
  const onMessage = (
    message: { kind?: string; input?: InputExpectation; lease?: string },
    _sender: chrome.runtime.MessageSender,
    reply: (value: unknown) => void,
  ) => {
    if (typeof message.lease !== "string") return false;
    if (message.kind === COOPERATION_READ) {
      if (retired.has(message.lease)) {
        reply(undefined);
        return false;
      }
      if (lease && lease !== message.lease) retired.add(lease);
      lease = message.lease;
    } else if (message.kind === COOPERATION_DISABLE) {
      retired.add(message.lease);
      if (lease !== message.lease) {
        reply({ ...state });
        return false;
      }
    } else if (!enabled || lease !== message.lease) {
      return false;
    }
    if (message.kind === COOPERATION_DISABLE) {
      enabled = false;
      clearTimeout(focusTimer);
      observer.disconnect();
      roots.clear();
      fields.clear();
      state.events = [];
      expectation = undefined;
      keys.clear();
      composing = false;
      pointer = false;
      state.editing = false;
      reply({ ...state, busy: false, fields: [] });
    } else if (message.kind === COOPERATION_READ) {
      enabled = true;
      reply(read());
    } else if (message.kind === COOPERATION_ARM) {
      if (enabled && message.input) {
        expectation = message.input;
        nativeTime = undefined;
        originTime = undefined;
        if (expectation.timestamp !== undefined) {
          for (let attempt = 0; attempt < 3 && !nativeTime; attempt++) {
            const before = performance.now();
            const wallTime = Date.now();
            const after = performance.now();
            // Date.now() truncates to milliseconds; native CDP conversion and
            // DOM timestamps add independent precision loss in either direction.
            if (after - before <= 0.5) {
              const offset = expectation.timestamp - wallTime;
              nativeTime = {
                earliest: before + offset - 1 - INPUT_CLOCK_PRECISION_MS,
                latest: after + offset + INPUT_CLOCK_PRECISION_MS,
              };
              // Native and renderer wall clocks are sampled in different processes.
              // Apply the same clock precision to the epoch projection: native wall-clock
              // conversion adds rounding beyond the DOM timestamp resolution. Use it
              // only within this calibration's precision budget. A stale origin
              // or delayed delivery must never create a second, distant window.
              const projected = expectation.timestamp - performance.timeOrigin;
              if (
                projected >= nativeTime.earliest - INPUT_CLOCK_PRECISION_MS &&
                projected <= nativeTime.latest + INPUT_CLOCK_PRECISION_MS
              )
                originTime = projected;
            }
          }
          if (!nativeTime) {
            // The bridge can retry this read; native dispatch must wait for a
            // usable clock sample rather than create false human activity.
            expectation = undefined;
            reply(undefined);
            return false;
          }
        }
      }
      reply(read());
    } else if (message.kind === COOPERATION_RESUME) {
      // An explicit hand-back ends an editing lease, never a drag or IME composition.
      state.editing = false;
      state.revision++;
      publish();
      reply(read());
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(onMessage);
  void chrome.runtime.sendMessage({ kind: COOPERATION_READY }).catch(() => {});
  return () => {
    clearTimeout(timer);
    clearTimeout(focusTimer);
    observer.disconnect();
    chrome.runtime.onMessage.removeListener(onMessage);
    window.removeEventListener("blur", onWindowBlur);
    for (const event of events) document.removeEventListener(event, onEvent, true);
  };
}
