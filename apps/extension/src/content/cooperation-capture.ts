import { describeFrameOwners } from "@/cooperation/hidden-frames";
import { playbackProgressMedia } from "@/cooperation/media-progress";
import {
  COOPERATION_ARM,
  COOPERATION_ARM_FRAME,
  COOPERATION_DISABLE,
  COOPERATION_MESSAGE,
  COOPERATION_OWNERS,
  COOPERATION_READ,
  COOPERATION_RESUME,
  COOPERATION_SUBFRAME_READY,
  type FieldChange,
  type FrameState,
  type HumanActivity,
  type InputExpectation,
  type TextChange,
} from "@/cooperation/types";
import { createRandomUuid } from "@/lib/random-uuid";
import {
  isExtensionOverlayElement,
  isExtensionOverlayEvent,
  isExtensionOverlayNode,
  isInternalBskAttribute,
  isInternalBskMutation,
  isPasswordTypeMutation,
  isSensitiveFormField,
  openOrClosedShadowRoot,
  primaryEventTarget,
  rememberFormerPassword,
  resolveDeepActiveElement,
  SUBFRAME_OWNER_TAGS,
  uncheckedElementShadowRoot,
} from "./dom-primitives";

const MAX_CHANGES = 64;
// CDP's native clock conversion and the DOM clock round independently.
// This bound is fixed; renderer/dispatch delays never extend input attribution.
const INPUT_CLOCK_PRECISION_MS = 1.5;
const MAX_TEXT = 500;
/** `data-*` attributes the observation reads; changing one can change what the model sees. */
const OBSERVED_DATA_ATTRIBUTES = new Set([
  "data-testid",
  "data-test-id",
  "data-state",
  "data-selected",
  "data-index",
  "data-section",
]);
/**
 * Text here names or configures something else, or is not rendered as plain prose.
 * Rows and list items identify the refs inside them by their text (row anchors).
 */
const NOT_PLAIN_TEXT =
  "tr,li,[role=row],[role=listitem],label,legend,caption,th,summary,figcaption,h1,h2,h3,h4,h5,h6,[role=heading],option,optgroup,title,style,script,noscript,template,textarea,svg,math";
/** Declarations that restyle an element without showing or hiding content. */
const COSMETIC =
  /^(outline|box-shadow|cursor|transition|text-decoration|border|caret-color|accent-color)/;
// ponytail: a focused element may also recolour itself. A control that hides its own
// label while focused is not detected; compare computed colours if that ever matters.
const SELF_COSMETIC =
  /^(color|background|outline|box-shadow|cursor|transition|text-decoration|border|caret-color|accent-color)/;
const cleanText = (value: string) => value.replace(/\s+/g, " ").trim();
const isText = (node: Node | undefined): node is Text => node?.nodeType === 3;

/** Isolated-world collection also covers frames; no page-world control API is exposed. */
export function attachCooperationCapture() {
  let enabled = false;
  let listenersAttached = false;
  let subframeNotifyScheduled = false;
  let lease: string | undefined;
  const retired = new Set<string>();
  const isTopFrame = window === window.top;
  const state: FrameState = {
    document: createRandomUuid(),
    ...(isTopFrame ? { url: location.href } : {}),
    revision: 0,
    structure: 0,
    textual: 0,
    texts: [],
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
  let scriptedClick = false;
  let scriptedEditTarget: EventTarget | null | undefined;
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
  let scriptedTimer: ReturnType<typeof setTimeout> | undefined;
  const clearScripted = () => {
    clearTimeout(scriptedTimer);
    scriptedTimer = undefined;
    scriptedClick = false;
    scriptedEditTarget = undefined;
  };
  const scheduleScriptedClear = () => {
    clearTimeout(scriptedTimer);
    scriptedTimer = setTimeout(clearScripted, 0);
  };
  const formerPasswords = new WeakSet<Element>();
  const markFormerPasswords = (records: MutationRecord[]) => {
    for (const r of records) {
      if (isPasswordTypeMutation(r)) {
        formerPasswords.add(r.target);
        rememberFormerPassword(r.target);
      }
    }
  };
  // Passwords, codes, card details and file selections never enter field state.
  const secret = (target: Element) => {
    if (target instanceof HTMLInputElement && target.type === "password") {
      formerPasswords.add(target);
      rememberFormerPassword(target);
      return true;
    }
    if (isSensitiveFormField(target, formerPasswords)) {
      formerPasswords.add(target);
      return true;
    }
    return target instanceof HTMLInputElement && ["file", "hidden"].includes(target.type);
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
    if (!enabled || !lease) return;
    if (isTopFrame) state.url = location.href;
    updateInteraction();
    state.fields = [...fields.values()];
    void chrome.runtime
      .sendMessage({ kind: COOPERATION_MESSAGE, lease, state: { ...state } })
      .catch(() => {});
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(publish, 60);
  };
  const DATA_ATTR_RE = /data-[-\w]+/gi;
  const collectDataAttrs = (source: string | null | undefined, into: Set<string>) => {
    if (!source || !/data-/i.test(source)) return;
    for (const match of source.matchAll(DATA_ATTR_RE)) into.add(match[0].toLowerCase());
  };
  const nonOverlayElements: NodeFilter = {
    acceptNode: (node) =>
      isExtensionOverlayElement(node as Element)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  };
  const nonOverlayTextAndElements: NodeFilter = {
    acceptNode: (node) =>
      node.nodeType === 1 && isExtensionOverlayElement(node as Element)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  };
  const roots = new Set<Document | ShadowRoot>();
  let styles:
    | { key: string; readable: boolean; dataAttrs: Set<string>; focus: string[] }
    | undefined;
  /** What the page's style sheets say about attributes and focus. Unreadable sheets say nothing. */
  const styleFacts = () => {
    const sheets = [...roots].flatMap((root) => [
      ...(root.styleSheets ?? []),
      ...(root.adoptedStyleSheets ?? []),
    ]);
    const top = sheets.map((sheet) => {
      try {
        return sheet.cssRules;
      } catch {
        return undefined;
      }
    });
    // ponytail: keyed by rule counts. A CSSOM rewrite that keeps every count is
    // missed until a count changes; hash the rule text if that ever matters.
    const key = top.map((rules) => rules?.length ?? -1).join();
    if (styles?.key === key) return styles;
    const readable = top.every(Boolean);
    const facts = { key, readable, dataAttrs: new Set<string>(), focus: [] as string[] };
    if (!readable) {
      styles = facts;
      return facts;
    }
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (!facts.readable) return;
        // Skip @font-face (5) and @keyframes (7), which cannot select DOM attributes or :focus.
        if (rule.type === 5 || rule.type === 7) continue;
        const { selectorText, style } = rule as CSSStyleRule;
        collectDataAttrs(selectorText, facts.dataAttrs);
        if ("conditionText" in rule) {
          collectDataAttrs((rule as CSSConditionRule).conditionText, facts.dataAttrs);
        }
        if ("start" in rule) {
          collectDataAttrs((rule as { start?: string | null }).start, facts.dataAttrs);
        }
        if ("end" in rule) {
          collectDataAttrs((rule as { end?: string | null }).end, facts.dataAttrs);
        }
        if (style) {
          collectDataAttrs(style.getPropertyValue?.("content"), facts.dataAttrs);
        }
        if (selectorText?.includes(":focus")) {
          // Without nesting or functions, each comma-separated selector stands alone.
          const plain = !/[(&]/.test(selectorText);
          for (const selector of plain ? selectorText.split(",") : [selectorText]) {
            if (!selector.includes(":focus")) continue;
            // The focused element styles only itself when no combinator follows.
            const self = plain && /:focus(-visible)?(?![-\w])[^\s>+~]*$/.test(selector.trim());
            const cosmetic = self ? SELF_COSMETIC : COSMETIC;
            for (let index = 0; index < style.length; index++)
              if (!cosmetic.test(style.item(index))) {
                facts.focus.push(selector);
                break;
              }
          }
        }
        try {
          if ("styleSheet" in rule) {
            const imported = (rule as CSSImportRule).styleSheet;
            if (imported) walk(imported.cssRules);
            else {
              facts.readable = false;
              return;
            }
          }
          const nested = (rule as CSSGroupingRule).cssRules;
          if (nested && facts.readable) walk(nested);
        } catch {
          facts.readable = false;
          return;
        }
      }
    };
    for (const rules of top) {
      if (!facts.readable) break;
      if (rules) walk(rules);
    }
    styles = facts;
    return facts;
  };
  /** No style that applies because of the current focus may show or hide content. */
  const focusNeutral = () => {
    const facts = styleFacts();
    if (!facts.readable) return false;
    if (!facts.focus.length) return true;
    if (
      facts.focus.every((selector) => !selector.includes("&")) &&
      [...roots].every((root) => !root.querySelector(":focus"))
    ) {
      return true;
    }
    return !facts.focus.some((selector) => {
      try {
        return selector.includes("&") || [...roots].some((root) => root.querySelector(selector));
      } catch {
        return true;
      }
    });
  };
  /** An attribute write the observation cannot see: unchanged, or page-private data no style reads. */
  const invisibleAttribute = (r: MutationRecord) => {
    const name = r.attributeName?.toLowerCase() ?? "";
    if (isInternalBskAttribute(name)) return true;
    if (r.target instanceof Element && r.target.getAttribute(name) === r.oldValue) return true;
    if (!/^data-[-\w]+$/.test(name) || OBSERVED_DATA_ATTRIBUTES.has(name)) return false;
    const facts = styleFacts();
    return facts.readable && !facts.dataAttrs.has(name);
  };
  /** Prose whose replacement changes its own line and the names derived from it, nothing else. */
  const plainText = (
    parent: Element,
    referencedByRoot: Map<Document | ShadowRoot, Set<string>>,
  ) => {
    if (
      parent.closest(NOT_PLAIN_TEXT) ||
      (parent instanceof HTMLElement && parent.isContentEditable)
    )
      return false;
    const transform = getComputedStyle(parent).textTransform;
    if (transform && transform !== "none") return false;
    const root = parent.getRootNode() as Document | ShadowRoot;
    let referenced = referencedByRoot.get(root);
    if (!referenced) {
      referenced = new Set(
        [...root.querySelectorAll("[aria-labelledby],[aria-describedby]")].flatMap((element) =>
          `${element.getAttribute("aria-labelledby") ?? ""} ${element.getAttribute("aria-describedby") ?? ""}`.split(
            /\s+/,
          ),
        ),
      );
      referencedByRoot.set(root, referenced);
    }
    for (let element: Element | null = parent; element; element = element.parentElement)
      if (element.id && referenced.has(element.id)) return false;
    return true;
  };
  /**
   * The replacements a batch made when it changed nothing but visible text.
   * Undefined for every other batch: those keep requiring a fresh observation.
   */
  const textChanges = (records: MutationRecord[]): Omit<TextChange, "sequence">[] | undefined => {
    const replaced = new Map<Text, string>();
    const removals = new Map<Node, MutationRecord>();
    const attributeRecords: MutationRecord[] = [];
    for (const r of records) {
      if (r.type === "attributes") {
        attributeRecords.push(r);
        continue;
      }
      let node: Node | undefined = r.target;
      let before = r.oldValue;
      if (r.type === "childList") {
        // One text node swapped for another in the same place: `textContent = value`
        // on an element holding one text node, or a removal and then an insertion.
        if (r.addedNodes.length > 1 || r.removedNodes.length > 1) return;
        let removed = r.removedNodes[0];
        node = r.addedNodes[0];
        if (!node) {
          if (removals.has(r.target)) return;
          removals.set(r.target, r);
          continue;
        }
        if (!removed) {
          const removal = removals.get(r.target);
          if (
            removal?.previousSibling !== r.previousSibling ||
            removal.nextSibling !== r.nextSibling
          )
            return;
          removals.delete(r.target);
          removed = removal.removedNodes[0];
        }
        if (!isText(removed)) return;
        before = replaced.get(removed) ?? removed.data;
        replaced.delete(removed);
      }
      if (!isText(node) || before === null) return;
      if (!replaced.has(node)) replaced.set(node, before);
    }
    if (removals.size) return;
    for (const r of attributeRecords) {
      if (!invisibleAttribute(r)) return;
    }
    const changes: Omit<TextChange, "sequence">[] = [];
    const referencedByRoot = new Map<Document | ShadowRoot, Set<string>>();
    for (const [node, before] of replaced) {
      const parent = node.parentElement;
      const previous = cleanText(before);
      const value = cleanText(node.data);
      if (previous === value) continue;
      if (
        !parent ||
        !previous ||
        !value ||
        previous.length > MAX_TEXT ||
        value.length > MAX_TEXT ||
        !plainText(parent, referencedByRoot)
      )
        return;
      changes.push({
        id: id(parent),
        label: `${parent.localName}${parent.id ? `#${parent.id}` : ""}`.slice(0, 160),
        previous_value: previous,
        value,
      });
    }
    if (changes.length && !unseenElsewhere(new Set(changes.map((c) => c.previous_value)))) return;
    return changes;
  };
  let burstStart = 0;
  let burst = 0;
  /**
   * A replaced text is located in the observation by its old value alone, so
   * nothing else in this document may still read the same.
   */
  const unseenElsewhere = (texts: Set<string>) => {
    // ponytail: one walk of the document's text per text-only batch, at most ten
    // a second. Faster tickers re-capture; index text nodes if they need deltas.
    const now = Date.now();
    if (now - burstStart > 1000) {
      burstStart = now;
      burst = 0;
    }
    if (++burst > 10) return false;
    for (const root of roots) {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        nonOverlayTextAndElements,
      );
      for (let current = walker.nextNode(); current; current = walker.nextNode()) {
        if (isText(current)) {
          if (texts.has(cleanText(current.data))) return false;
          continue;
        }
        const element = current as Element;
        for (const name of ["aria-label", "title", "alt", "placeholder", "value"]) {
          const value = element.getAttribute(name);
          if (value && texts.has(cleanText(value))) return false;
        }
      }
    }
    return true;
  };
  const scheduleSubframeNotify = () => {
    if (!enabled || subframeNotifyScheduled) return;
    subframeNotifyScheduled = true;
    queueMicrotask(() => {
      subframeNotifyScheduled = false;
      if (!enabled) return;
      void chrome.runtime.sendMessage({ kind: COOPERATION_SUBFRAME_READY }).catch(() => {});
    });
  };
  // Page JS cannot see closed roots, but the extension can. Observation also
  // traverses these roots, so source and focus guards must cover the same DOM.
  const shadowRoot = (element: Element): ShadowRoot | null => openOrClosedShadowRoot(element);
  const scanAddedSubtree = (target: Element | ShadowRoot, visited: Set<Node>): boolean => {
    if (visited.has(target)) return false;
    visited.add(target);
    let foundSubframe = false;
    if (target instanceof ShadowRoot) {
      observeRoot(target);
    } else {
      if (isExtensionOverlayElement(target)) return false;
      if (SUBFRAME_OWNER_TAGS.has(target.localName)) foundSubframe = true;
      const nested = uncheckedElementShadowRoot(target);
      if (nested && scanAddedSubtree(nested, visited)) foundSubframe = true;
    }
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_ELEMENT, nonOverlayElements);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (visited.has(current)) continue;
      visited.add(current);
      const element = current as Element;
      if (SUBFRAME_OWNER_TAGS.has(element.localName)) foundSubframe = true;
      const nested = uncheckedElementShadowRoot(element);
      if (nested && scanAddedSubtree(nested, visited)) foundSubframe = true;
    }
    return foundSubframe;
  };
  const mutations = (records: MutationRecord[]) => {
    markFormerPasswords(records);
    if (enabled) {
      const visited = new Set<Node>();
      let addedSubframe = false;
      for (const r of records) {
        if (r.type !== "childList" || isExtensionOverlayNode(r.target)) continue;
        for (const node of r.addedNodes) {
          if (!(node instanceof Element) || isExtensionOverlayNode(node)) continue;
          if (scanAddedSubtree(node, visited)) addedSubframe = true;
        }
      }
      if (addedSubframe) scheduleSubframeNotify();
    }
    if (!enabled || !lease) return;
    const seen = records.filter((r) => !isInternalBskMutation(r));
    if (!seen.length) return;
    state.revision++;
    state.structure++;
    const texts = textChanges(seen);
    if (texts) {
      const sequence = (state.textual ?? 0) + 1;
      state.textual = sequence;
      const log = [...(state.texts ?? []), ...texts.map((text) => ({ ...text, sequence }))];
      const dropped = log.splice(0, Math.max(0, log.length - MAX_CHANGES));
      if (dropped.length) state.textFloor = dropped[dropped.length - 1]!.sequence;
      state.texts = log;
    }
    schedule();
  };
  const observer = new MutationObserver(mutations);
  const observeRoot = (root: Document | ShadowRoot) => {
    if (roots.has(root)) return;
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    });
    roots.add(root);
  };
  const observeShadowSubtree = (target: Document | Element | ShadowRoot) => {
    if (target.nodeType === Node.DOCUMENT_NODE || target instanceof ShadowRoot) {
      observeRoot(target as Document | ShadowRoot);
    } else if (target instanceof Element) {
      if (isExtensionOverlayNode(target)) return;
      const nested = uncheckedElementShadowRoot(target);
      if (nested) observeShadowSubtree(nested);
    }
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_ELEMENT, nonOverlayElements);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const nested = uncheckedElementShadowRoot(current as Element);
      if (nested) observeShadowSubtree(nested);
    }
  };
  const activeElement = () => resolveDeepActiveElement(document, shadowRoot);
  const controls = function* (root: Document | ShadowRoot): Generator<Element> {
    observeRoot(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, nonOverlayElements);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const element = current as Element;
      const tag = element.localName;
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        element.getAttribute("contenteditable") === "true"
      ) {
        yield element;
      }
      const nested = uncheckedElementShadowRoot(element);
      if (nested) yield* controls(nested);
    }
  };
  let documentUrl = location.href;
  const read = () => {
    // Child SPA routes rotate `document` so `frameEpoch` invalidates iframe-bound
    // observations; root SPA routes report `url` so `CooperationController` can
    // separate out-of-band route changes from in-flight targeted query/hash updates.
    if (documentUrl !== location.href) {
      documentUrl = location.href;
      if (isTopFrame) state.url = documentUrl;
      else state.document = createRandomUuid();
      state.revision++;
    } else if (isTopFrame) {
      state.url = documentUrl;
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
      if (isExtensionOverlayNode(target)) continue;
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
      [...root.querySelectorAll<HTMLMediaElement>("video,audio")]
        .filter((element) => !isExtensionOverlayNode(element))
        .map((element) => {
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
    // Every root is observed by now, so every style sheet is in view.
    state.focusNeutral = focusNeutral();
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
    if (!release && isExtensionOverlayEvent(event)) return;
    let target = primaryEventTarget(event);
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
      const scriptedActivation =
        scriptedClick &&
        !inputSource &&
        eventAgent !== false &&
        pointer?.agent !== false &&
        target instanceof HTMLInputElement &&
        (target.type === "checkbox" || target.type === "radio");
      // Programmatic `document.execCommand(...)` on editable fields dispatches a
      // trusted `InputEvent("input")` with no preceding `beforeinput`, key, pointer,
      // wheel, drop, or IME composition. Real user edits in Chromium always emit at
      // least one of those originating events first.
      const scriptedExecCommand =
        event.isTrusted &&
        event.type === "input" &&
        typeof InputEvent !== "undefined" &&
        event instanceof InputEvent &&
        editable(target) &&
        !inputSource &&
        eventAgent === undefined &&
        pointer === undefined &&
        !composing;
      if (scriptedExecCommand) {
        scriptedEditTarget = target;
        scheduleScriptedClear();
      }
      const scriptedEditCommit =
        event.type === "change" &&
        scriptedEditTarget === target &&
        !inputSource &&
        eventAgent !== false &&
        pointer?.agent !== false;
      if (
        event.isTrusted &&
        !agent &&
        !scriptedActivation &&
        !scriptedExecCommand &&
        !scriptedEditCommit &&
        value !== undefined &&
        value !== previous
      ) {
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
    if (!event.isTrusted) {
      // Programmatic `checkbox.click()` / `radio.click()` / `label.click()` fires
      // an untrusted click whose default activation synchronously emits trusted
      // `input`/`change` events without any human gesture.
      if (event.type === "click" && eventAgent !== false && pointer?.agent !== false) {
        scriptedClick = true;
        scheduleScriptedClear();
      }
      return;
    }
    if (
      event.type === "pointerdown" ||
      event.type === "keydown" ||
      event.type === "beforeinput" ||
      event.type === "wheel" ||
      event.type === "drop" ||
      event.type === "compositionstart" ||
      event.type === "click"
    )
      clearScripted();
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
  // Chromium skips a node's legacy `mousewheel` listeners whenever that node has a
  // `wheel` listener, even a passive one. Tier B stays completely inert (zero DOM,
  // scroll, blur or wheel listeners and zero startup IPC) until Background arms or
  // reads a controlled frame.
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
  const onWindowBlur = () => {
    if (!enabled) return;
    clearScripted();
    if (
      !pointer &&
      !composing &&
      !dragging &&
      !state.editing &&
      keys.size === 0 &&
      !eventAgent &&
      !inputSource
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
  const setListenersAttached = (active: boolean) => {
    if (listenersAttached === active) return;
    listenersAttached = active;
    if (active) {
      for (const event of events) {
        document.addEventListener(event, onEvent, { capture: true, passive: true });
      }
      document.addEventListener("scroll", onScroll, true);
      window.addEventListener("blur", onWindowBlur);
      window.addEventListener("wheel", onEvent, { capture: true, passive: true });
    } else {
      for (const event of events) {
        document.removeEventListener(event, onEvent, true);
      }
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("wheel", onEvent, true);
    }
  };
  const onMessage = (
    message: {
      kind?: string;
      input?: InputExpectation;
      lease?: string;
      includeDeclaredSrc?: boolean;
    },
    _sender: chrome.runtime.MessageSender,
    reply: (value: unknown) => void,
  ) => {
    if (message.kind === COOPERATION_OWNERS) {
      // Layout facts for proving a child frame hidden. It grants nothing, so it
      // needs no lease and leaves collection state untouched.
      reply(
        describeFrameOwners(
          document,
          shadowRoot,
          message.includeDeclaredSrc ? { includeDeclaredSrc: true } : undefined,
        ),
      );
      return false;
    }
    if (message.kind === COOPERATION_ARM_FRAME) {
      enabled = true;
      setListenersAttached(true);
      observeShadowSubtree(document);
      reply({ ok: true });
      return false;
    }
    if (typeof message.lease !== "string") return false;
    if (
      message.kind === COOPERATION_READ ||
      (message.kind === COOPERATION_ARM && message.input?.type !== "clear") ||
      (!lease && (message.kind === COOPERATION_ARM || message.kind === COOPERATION_RESUME))
    ) {
      if (retired.has(message.lease)) {
        reply(undefined);
        return false;
      }
      if (lease && lease !== message.lease) {
        retired.add(lease);
        expectation = undefined;
        insertTarget = undefined;
        inputSource = undefined;
        clearScripted();
      }
      lease = message.lease;
      enabled = true;
      setListenersAttached(true);
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
      setListenersAttached(false);
      clearTimeout(focusTimer);
      clearTimeout(pointerTimer);
      clearTimeout(eventTimer);
      clearTimeout(inputTimer);
      clearTimeout(scrollTimer);
      clearScripted();
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
      setListenersAttached(true);
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
  return () => {
    enabled = false;
    clearTimeout(timer);
    clearTimeout(focusTimer);
    clearTimeout(pointerTimer);
    clearTimeout(eventTimer);
    clearTimeout(inputTimer);
    clearTimeout(scrollTimer);
    clearScripted();
    observer.disconnect();
    roots.clear();
    chrome.runtime?.onMessage?.removeListener(onMessage);
    setListenersAttached(false);
  };
}
