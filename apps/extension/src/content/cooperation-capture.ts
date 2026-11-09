import { playbackProgressMedia } from "@/cooperation/media-progress";
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
import { createRandomUuid } from "@/lib/random-uuid";
import { sensitiveAutocomplete } from "@/lib/sensitive-autocomplete";

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
    document: createRandomUuid(),
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
  let dragging = false;
  let dragAgent: boolean | undefined;
  let pointer: { agent: boolean; released: boolean; confirmed: boolean } | undefined;
  const keys = new Map<string, boolean>();
  let eventAgent: boolean | undefined;
  let editingTarget: Element | undefined;
  let inputSource: { target: EventTarget | null; agent: boolean; before?: string } | undefined;
  let insertTarget: Element | null | undefined;
  const fields = new Map<Element, FieldChange>();
  const sampledValues = new WeakMap<Element, string>();
  const ids = new WeakMap<object, string>();
  let nextId = 0;
  const id = (element: object) => {
    let value = ids.get(element);
    if (!value) ids.set(element, (value = String(++nextId)));
    return value;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  let pointerTimer: ReturnType<typeof setTimeout> | undefined;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  const overlay = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest(OVERLAY_HOST_SELECTOR);
  const formerPasswords = new WeakSet<Node>();
  const markFormerPasswords = (records: MutationRecord[]) => {
    for (const r of records) {
      if (r.oldValue?.toLowerCase() === "password") formerPasswords.add(r.target);
    }
  };
  // Passwords, codes, card details and file selections never enter field state.
  const secret = (target: Element) => {
    if (target instanceof HTMLInputElement && target.type === "password") {
      formerPasswords.add(target);
      return true;
    }
    return (
      (target instanceof HTMLInputElement && ["file", "hidden"].includes(target.type)) ||
      formerPasswords.has(target) ||
      sensitiveAutocomplete(target.getAttribute("autocomplete"))
    );
  };
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
  const inputValue = (target: EventTarget | null): string | undefined => {
    // File selection is coordinated by its click/drag, not by an editable value.
    // DOM.setFileInputFiles also emits trusted input/change events.
    if (target instanceof HTMLInputElement && target.type === "file") return;
    if (target instanceof HTMLInputElement)
      return ["checkbox", "radio"].includes(target.type) ? String(target.checked) : target.value;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)
      return target.value;
    if (target instanceof HTMLElement && target.isContentEditable) return target.innerHTML;
  };
  const updateInteraction = () => {
    state.busy =
      dragging ||
      (composing && state.editing) ||
      !!(pointer?.confirmed && !pointer.released) ||
      (state.editing && [...keys.values()].some((agent) => !agent));
    state.pending =
      !!(pointer && !pointer.agent && !pointer.confirmed) ||
      (composing && !state.editing) ||
      !!(inputSource && !inputSource.agent);
  };
  const publish = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!enabled) return;
    updateInteraction();
    state.fields = [...fields.values()];
    void chrome.runtime
      .sendMessage({ kind: COOPERATION_MESSAGE, lease, state: { ...state } })
      .catch(() => {});
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(publish, 60);
  };
  const mutations = (records: MutationRecord[]) => {
    markFormerPasswords(records);
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
  // Page JS cannot see closed roots, but the extension can. Observation also
  // traverses these roots, so source and focus guards must cover the same DOM.
  const shadowRoot = (element: Element): ShadowRoot | null =>
    element.shadowRoot ??
    (element instanceof HTMLElement ? (chrome.dom?.openOrClosedShadowRoot(element) ?? null) : null);
  const activeElement = () => {
    let active = document.activeElement;
    while (active) {
      const nested = shadowRoot(active)?.activeElement;
      if (!nested) break;
      active = nested;
    }
    return active;
  };
  const controls = function* (root: Document | ShadowRoot): Generator<Element> {
    if (!roots.has(root)) {
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeOldValue: true,
        characterData: true,
      });
      roots.add(root);
    }
    for (const element of root.querySelectorAll("*")) {
      if (overlay(element)) continue;
      if (element.matches("input,textarea,select,[contenteditable=true]")) yield element;
      const nested = shadowRoot(element);
      if (nested) yield* controls(nested);
    }
  };
  let documentUrl = location.href;
  const read = () => {
    // SPA routes retain the DOM document, but cannot retain its action authority.
    // This also covers child frames; root CDP route events catch away-and-back.
    if (documentUrl !== location.href) {
      documentUrl = location.href;
      state.document = createRandomUuid();
      state.revision++;
    }
    mutations(observer.takeRecords());
    const active = activeElement();
    if (editingTarget && (active !== editingTarget || !editable(editingTarget))) {
      editingTarget = undefined;
      state.editing = false;
      composing = false;
      state.revision++;
    }
    state.focus = active ? id(active) : undefined;
    state.focusIsDocument =
      (active === document.body || active === document.documentElement) &&
      !active?.matches('[tabindex],[role],[contenteditable]:not([contenteditable="false"])');
    if ([...roots].some((root) => root instanceof ShadowRoot && !root.host.isConnected)) {
      observer.disconnect();
      roots.clear();
    }
    for (const element of fields.keys()) if (!element.isConnected) fields.delete(element);
    let fieldCount = 0;
    const mediaByRoot = new Map<Document | ShadowRoot, { id: string }[]>();
    state.fieldsComplete = true;
    for (const target of controls(document)) {
      if (overlay(target)) continue;
      const fullValue =
        target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type)
          ? String(target.checked)
          : "value" in target
            ? String(target.value)
            : (target.textContent ?? "");
      if (secret(target)) {
        fields.delete(target);
        if (target instanceof HTMLInputElement && target.type === "file")
          sampledValues.delete(target);
        else sampledValues.set(target, fullValue);
        continue;
      }
      const value = fullValue.slice(0, 500);
      const name = label(target);
      let mediaProgress = false;
      if (target instanceof HTMLInputElement && target.type === "range") {
        const root = target.getRootNode() as Document | ShadowRoot;
        let media = mediaByRoot.get(root);
        if (!media) {
          media = [...root.querySelectorAll("video,audio")].map((element) => ({ id: element.id }));
          mediaByRoot.set(root, media);
        }
        const labelledBy = (target.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => root.getElementById(id)?.textContent ?? "")
          .join(" ");
        const labels = [...new Set(target.labels ?? [])]
          .map((label) => label.textContent)
          .join(" ");
        mediaProgress = !!playbackProgressMedia(
          {
            tag: "input",
            name: target.getAttribute("aria-label") || labelledBy || labels,
            attrs: Object.fromEntries(
              [...target.attributes].map((attr) => [attr.name, attr.value]),
            ),
            inForm: target.form !== null,
          },
          media,
        );
      }
      fieldCount++;
      if (fieldCount > MAX_CHANGES || fullValue.length > 500) state.fieldsComplete = false;
      const sampled = sampledValues.get(target);
      if (sampled !== undefined && sampled !== fullValue) state.revision++;
      sampledValues.set(target, fullValue);
      const old = fields.get(target);
      if (fields.size < MAX_CHANGES || old)
        fields.set(target, {
          id: id(target),
          label: name,
          value,
          ...(mediaProgress ? { kind: "media_progress" as const } : {}),
        });
    }
    for (const element of fields.keys()) if (!element.isConnected) fields.delete(element);
    const media = [...roots].flatMap((root) =>
      [...root.querySelectorAll<HTMLMediaElement>("video,audio")].map((element) => {
        const stream = element.srcObject;
        return {
          id: id(element),
          src: element.getAttribute("src"),
          currentSrc: element.currentSrc,
          srcObject: stream ? id(stream) : null,
          tracks:
            typeof MediaStream !== "undefined" && stream instanceof MediaStream
              ? stream
                  .getTracks()
                  .map((track) => track.id)
                  .sort()
              : [],
          sources: [...element.children]
            .filter((child): child is HTMLSourceElement => child instanceof HTMLSourceElement)
            .map((source) => ({
              id: id(source),
              src: source.src,
              type: source.type,
              media: source.media,
            })),
        };
      }),
    );
    // currentSrc/srcObject may change without a DOM mutation. Keep the source
    // evidence fresh even when the page's mutation counter did not advance.
    if (state.media && JSON.stringify(state.media) !== JSON.stringify(media)) state.revision++;
    state.media = media;
    updateInteraction();
    state.fields = [...fields.values()];
    return { ...state };
  };
  const matches = (event: Event): boolean => {
    attribution = undefined;
    if (!expectation || expectation.type !== event.type) return false;
    const expected = expectation;
    // CDP uses the visual viewport. DOM client coordinates use the layout viewport,
    // which can have a different origin after pinch zoom and pan.
    const viewport = window.visualViewport;
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
            (Math.abs(event.clientX - (viewport?.offsetLeft ?? 0) - (expected.x ?? -1)) <= 2 &&
              Math.abs(event.clientY - (viewport?.offsetTop ?? 0) - (expected.y ?? -1)) <= 2)));
    attribution = match
      ? undefined
      : {
          expected_time: expected.timestamp,
          event_time: event.timeStamp + performance.timeOrigin,
          expected_type: expected.type,
          expected_event_time: nativeTime,
          event_timestamp: event.timeStamp,
        };
    if (match)
      expectation =
        expected.type === "keydown" && expected.keypress
          ? { ...expected, type: "keypress" }
          : undefined;
    return match;
  };
  const humanInput = (event: Event, target: EventTarget | null) => {
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
    // Publish confirmed activity immediately. Native dispatch also pulls frame state.
    publish();
  };
  const onEvent = (event: Event) => {
    if (!enabled) return;
    const release =
      (dragging && ["dragend", "drop"].includes(event.type)) ||
      (pointer && !pointer.released && ["pointerup", "pointercancel"].includes(event.type)) ||
      (event.type === "keyup" && keys.has((event as KeyboardEvent).key));
    if (!release && event.composedPath().some(overlay)) return;
    let target = event.composedPath()[0] ?? event.target;
    // Closed shadow roots retarget editing events to their host. Resolve the
    // same deep focus used by collection and native text attribution.
    if (
      ["beforeinput", "input", "change"].includes(event.type) &&
      target instanceof Element &&
      shadowRoot(target)
    )
      target = activeElement() ?? target;
    if (event.type === "input" || event.type === "change") {
      mutations(observer.takeRecords());
      const value = inputValue(target);
      let previous = target instanceof Element ? sampledValues.get(target) : undefined;
      // Rich editors compare their local markup during beforeinput, while the
      // observation's sampled value remains plain text.
      if (target instanceof HTMLElement && target.isContentEditable) previous = undefined;
      if (inputSource?.target === target) previous = inputSource.before;
      const source =
        inputSource?.target === target ? inputSource.agent : (eventAgent ?? pointer?.agent);
      const agent = eventAgent !== false && source === true;
      if (target instanceof Element && value !== undefined) {
        const fieldValue =
          target instanceof HTMLElement && target.isContentEditable
            ? (target.textContent ?? "")
            : value;
        sampledValues.set(target, fieldValue);
        if (secret(target)) {
          fields.delete(target);
        } else {
          fields.set(target, {
            id: id(target),
            label: label(target),
            value: fieldValue.slice(0, 500),
          });
          if (fields.size > MAX_CHANGES) {
            fields.clear();
            state.structure++;
          }
        }
      }
      state.revision++;
      if (event.isTrusted && !agent && value !== undefined && value !== previous) {
        editingTarget = editable(target) ? (target as Element) : undefined;
        state.editing = !!editingTarget;
        if (pointer && !pointer.agent) {
          pointer.confirmed = true;
          if (target instanceof HTMLSelectElement) {
            pointer.released = true;
            clearTimeout(pointerTimer);
            pointerTimer = setTimeout(() => {
              pointer = undefined;
              state.revision++;
              publish();
            }, 0);
          }
        }
        // An input/change pair describes one edit, including native select controls.
        if (inputSource?.target === target) inputSource.before = value;
        humanInput(event, target);
      } else schedule();
      return;
    }
    if (!event.isTrusted) return;
    if (event.type === "dragend" || event.type === "drop") {
      if (event.type === "drop") {
        eventAgent = dragAgent;
        clearTimeout(eventTimer);
        eventTimer = setTimeout(() => {
          eventAgent = undefined;
        }, 0);
      }
      dragging = false;
      dragAgent = undefined;
      state.revision++;
      publish();
      return;
    }
    if (event.type === "beforeinput") {
      const input = event as InputEvent;
      const expected = expectation;
      // insertText has no CDP timestamp. Match this one command's literal text
      // and focused recipient, then retire it on input or native completion.
      const insert =
        expected?.type === "beforeinput" &&
        target === insertTarget &&
        editable(target) &&
        input.inputType === "insertText" &&
        input.data === expected.text;
      const human = eventAgent === false || pointer?.agent === false;
      const agent = !human && (insert || (eventAgent ?? pointer?.agent ?? false));
      if (insert && agent) expectation = undefined;
      inputSource = { target, agent, before: inputValue(target) };
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        inputSource = undefined;
        publish();
      }, 0);
      state.revision++;
      publish();
      return;
    }
    if (event.type === "focusout") {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        if (!enabled) return;
        if (editingTarget !== activeElement()) {
          editingTarget = undefined;
          state.editing = false;
          composing = false;
        }
        state.revision++;
        publish();
      }, 0);
      return;
    }
    if (event.type === "pointerdown") {
      pointer = { agent: matches(event), released: false, confirmed: false };
      clearTimeout(pointerTimer);
      state.revision++;
      publish();
      return;
    }
    if (event.type === "pointerup" || event.type === "pointercancel") {
      if (pointer) pointer.released = true;
      clearTimeout(pointerTimer);
      // The default click follows pointerup in the same browser task.
      pointerTimer = setTimeout(() => {
        pointer = undefined;
        state.revision++;
        publish();
      }, 0);
      if (event.type === "pointercancel") pointer = undefined;
      state.revision++;
      publish();
      return;
    }
    if (event.type === "wheel") {
      // Browsing never transfers control. Retain only the source for a native
      // control whose wheel handler actually changes its value in this task.
      eventAgent = matches(event);
      clearTimeout(eventTimer);
      eventTimer = setTimeout(() => {
        eventAgent = undefined;
      }, 0);
      return;
    }
    if (event.type === "keydown" || event.type === "keypress" || event.type === "keyup") {
      const key = (event as KeyboardEvent).key;
      eventAgent = event.type === "keyup" ? keys.get(key) : matches(event);
      if (event.type === "keydown") keys.set(key, eventAgent ?? false);
      else if (event.type === "keyup") keys.delete(key);
      let releasedPending = false;
      if (
        event.type === "keydown" &&
        key === "Escape" &&
        pointer &&
        !pointer.agent &&
        !pointer.confirmed
      ) {
        pointer = undefined;
        clearTimeout(pointerTimer);
        state.revision++;
        releasedPending = true;
      }
      clearTimeout(eventTimer);
      const keypress = expectation?.keypress ? expectation : undefined;
      // beforeinput, input and keyboard activation inherit only this event task.
      eventTimer = setTimeout(() => {
        eventAgent = undefined;
        // A cancelled keydown may produce no keypress. Its expectation cannot
        // outlive the native task or authorize a later person's submission.
        if (keypress && expectation === keypress) expectation = undefined;
      }, 0);
      if (state.editing || releasedPending) publish();
      return;
    }
    if (event.type === "compositionstart" || event.type === "compositionend") {
      composing = event.type === "compositionstart";
      state.revision++;
      publish();
      return;
    }
    if (event.type === "submit" && eventAgent !== false && pointer?.agent !== false) return;
    if (
      event.type === "click" ||
      event.type === "auxclick" ||
      event.type === "dragstart" ||
      event.type === "submit"
    ) {
      const agent =
        (event as MouseEvent).detail === 0
          ? (eventAgent ?? pointer?.agent ?? false)
          : (pointer?.agent ?? false);
      if (event.type === "dragstart") dragAgent = agent;
      if (agent) return;
      if (event.type === "dragstart") dragging = true;
      if (pointer) pointer.confirmed = true;
      if (
        editingTarget !== target &&
        !(target instanceof Node && editingTarget?.contains(target) && editable(target))
      ) {
        editingTarget = undefined;
        state.editing = false;
        composing = false;
      }
      humanInput(event, target);
    }
  };
  const events = [
    "pointerdown",
    "pointerup",
    "pointercancel",
    "click",
    "auxclick",
    "dragstart",
    "dragend",
    "drop",
    "submit",
    "keydown",
    "keypress",
    "keyup",
    "beforeinput",
    "compositionstart",
    "compositionend",
    "focusout",
    "input",
    "change",
  ];
  for (const event of events)
    document.addEventListener(event, onEvent, { capture: true, passive: true });
  // Chromium skips a node's legacy `mousewheel` listeners whenever that node has a
  // `wheel` listener, even a passive one. Listen only while collecting so pages
  // without a session keep their mousewheel handlers. Window capture runs before
  // any document listener, so a page that stops propagation there cannot hide an
  // Agent wheel from attribution even though this listener is registered late.
  const listenWheel = (on: boolean) =>
    on
      ? window.addEventListener("wheel", onEvent, { capture: true, passive: true })
      : window.removeEventListener("wheel", onEvent, true);
  const onScroll = () => {
    if (!enabled) return;
    const started = !state.scrolling;
    state.scrolling = true;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      state.scrolling = false;
      publish();
    }, 120);
    if (started) publish();
  };
  document.addEventListener("scroll", onScroll, true);
  const onWindowBlur = () => {
    if (
      !enabled ||
      (!pointer &&
        !composing &&
        !dragging &&
        !state.editing &&
        keys.size === 0 &&
        !eventAgent &&
        !inputSource)
    )
      return;
    clearTimeout(focusTimer);
    clearTimeout(pointerTimer);
    clearTimeout(eventTimer);
    clearTimeout(inputTimer);
    pointer = undefined;
    composing = false;
    dragging = false;
    dragAgent = undefined;
    state.editing = false;
    editingTarget = undefined;
    keys.clear();
    eventAgent = undefined;
    inputSource = undefined;
    state.revision++;
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
      if (lease && lease !== message.lease) {
        retired.add(lease);
        expectation = undefined;
        insertTarget = undefined;
        inputSource = undefined;
      }
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
      listenWheel(false);
      clearTimeout(focusTimer);
      clearTimeout(pointerTimer);
      clearTimeout(eventTimer);
      clearTimeout(inputTimer);
      clearTimeout(scrollTimer);
      observer.disconnect();
      roots.clear();
      fields.clear();
      state.events = [];
      expectation = undefined;
      keys.clear();
      composing = false;
      dragging = false;
      dragAgent = undefined;
      pointer = undefined;
      state.editing = false;
      editingTarget = undefined;
      inputSource = undefined;
      eventAgent = undefined;
      insertTarget = undefined;
      state.pending = false;
      state.scrolling = false;
      reply({ ...state, busy: false, fields: [] });
    } else if (message.kind === COOPERATION_READ) {
      enabled = true;
      listenWheel(true);
      reply(read());
    } else if (message.kind === COOPERATION_ARM) {
      if (enabled && message.input?.type === "clear") {
        if (expectation?.id === message.input.id) expectation = undefined;
      } else if (enabled && message.input) {
        expectation = message.input;
        insertTarget = expectation.type === "beforeinput" ? activeElement() : undefined;
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
      editingTarget = undefined;
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
    clearTimeout(pointerTimer);
    clearTimeout(eventTimer);
    clearTimeout(inputTimer);
    clearTimeout(scrollTimer);
    observer.disconnect();
    chrome.runtime.onMessage.removeListener(onMessage);
    window.removeEventListener("blur", onWindowBlur);
    document.removeEventListener("scroll", onScroll, true);
    for (const event of events) document.removeEventListener(event, onEvent, true);
    listenWheel(false);
  };
}
