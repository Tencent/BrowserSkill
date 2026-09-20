import type { DebugCdp } from "./manager";
import { installPerformance } from "./performance-observer";
import { redactText } from "./redact";
import type { DebugField } from "./types";

export const OBSERVATION_TIMEOUT_MS = 600;

// This function runs only in a named CDP isolated world of the captured main frame.
// Keep it self-contained: its compiled source is also installed on future documents.
function installObserver(
  binding: string,
  slot: string,
  observePerformance: typeof installPerformance,
  early: boolean,
) {
  if (window !== window.top) return;
  const host = globalThis as unknown as Record<string, unknown>;
  (host[slot] as { dispose?: () => void } | undefined)?.dispose?.();
  const abort = new AbortController();
  let agent = false;
  let agentRevision = 0;
  let pending: { target: Element; before: ReturnType<typeof snapshot>; at: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changedTimer: ReturnType<typeof setTimeout> | undefined;
  let original: { target: Element; snapshot: ReturnType<typeof snapshot> } | undefined;
  const secret =
    /password|passwd|pwd|secret|token|credential|api.?key|session|credit|card.?number|cc-|one-time-code/i;
  const controls = "input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select";
  function snapshot() {
    const fields: DebugField[] = [];
    const nodes = document.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >(controls);
    let partial = nodes.length > 80;
    for (const node of Array.from(nodes).slice(0, 80)) {
      if (!node.id && !node.name) {
        partial = true;
        continue;
      }
      if (fields.length >= 16) {
        partial = true;
        break;
      }
      const name = node.name || node.id;
      const label = (node.labels?.[0]?.textContent || node.getAttribute("aria-label") || name)
        .trim()
        .slice(0, 120);
      const key = `${location.origin}${location.pathname}|${node.form?.id || node.form?.name || ""}|${node.name ? "name" : "id"}:${name}`;
      if (key.length > 256 || name.length > 120) {
        partial = true;
        continue;
      }
      const sensitive =
        secret.test(`${node.type} ${node.name} ${node.id} ${node.autocomplete} ${label}`) ||
        node.type === "file";
      const value = sensitive
        ? undefined
        : node instanceof HTMLInputElement && ["checkbox", "radio"].includes(node.type)
          ? String(node.checked)
          : node.value;
      fields.push({
        key,
        name: name.slice(0, 120),
        label,
        state: sensitive ? "redacted" : (value?.length ?? 0) > 256 ? "truncated" : "available",
        ...(value !== undefined ? { value: value.slice(0, 256) } : {}),
      });
    }
    // Bound traversal rather than reading the entire document's innerText in an
    // input handler. Only visible text is retained; form values are separate.
    const lines: string[] = [];
    let chars = 0;
    let visited = 0;
    let textPartial = false;
    if (document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (++visited > 600 || lines.length === 100 || chars >= 6000) {
          textPartial = true;
          break;
        }
        const parent = node.parentElement;
        const line = node.textContent?.trim();
        if (
          line &&
          parent &&
          !parent.closest(
            "script,style,noscript,template,textarea,select,[hidden],[aria-hidden=true]",
          ) &&
          parent.getClientRects().length
        ) {
          const retained = line.slice(0, Math.min(500, 6000 - chars));
          textPartial ||= retained.length < line.length;
          lines.push(retained);
          chars += retained.length;
        }
        node = walker.nextNode();
      }
    }
    const text = lines.join("\n");
    return {
      text: text.slice(0, 6000),
      truncated: textPartial,
      fields,
      fields_partial: partial,
      navigation: (
        performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
      )?.type,
    };
  }
  const emit = (data: object) => {
    try {
      (host[binding] as (payload: string) => void)(JSON.stringify(data));
    } catch {
      /* detached */
    }
  };
  const label = (node: Element) =>
    (
      node.getAttribute("aria-label") ||
      (node as HTMLInputElement).labels?.[0]?.textContent ||
      node.textContent?.trim() ||
      node.getAttribute("name") ||
      node.id ||
      node.tagName
    )
      .trim()
      .slice(0, 120);
  function flush() {
    clearTimeout(timer);
    if (!pending) return;
    const value = pending;
    pending = undefined;
    emit({
      kind: "input",
      at: value.at,
      target: label(value.target),
      before: value.before,
      after: snapshot(),
    });
    original = { target: value.target, snapshot: snapshot() };
  }
  const on = (type: string, fn: (event: Event) => void) =>
    document.addEventListener(type, fn, { capture: true, signal: abort.signal });
  on("focusin", (event) => {
    if (event.target instanceof Element && event.target.matches(controls))
      original = { target: event.target, snapshot: snapshot() };
  });
  on("beforeinput", (event) => {
    if (!agent && event.target instanceof Element && event.target.matches(controls) && !pending)
      original = { target: event.target, snapshot: snapshot() };
  });
  on("input", (event) => {
    if (
      !event.isTrusted ||
      agent ||
      !(event.target instanceof Element) ||
      !event.target.matches(controls)
    )
      return;
    if (pending?.target !== event.target) flush();
    const starting = !pending;
    pending ??= {
      target: event.target,
      at: Date.now(),
      before: original?.target === event.target ? original.snapshot : snapshot(),
    };
    clearTimeout(timer);
    if (starting)
      emit({
        kind: "input_start",
        at: pending.at,
        target: label(event.target),
        before: pending.before,
      });
    timer = setTimeout(flush, 350);
  });
  on("focusout", () => {
    if (!agent) flush();
  });
  on("click", (event) => {
    if (!event.isTrusted || agent || !(event.target instanceof Element)) return;
    const target = event.target.closest(
      "button,a,[role=button],input[type=submit],input[type=checkbox],input[type=radio]",
    );
    if (!target) return;
    flush();
    emit({ kind: "click", at: Date.now(), target: label(target), before: snapshot() });
  });
  on("submit", (event) => {
    if (!event.isTrusted || agent || !(event.target instanceof Element)) return;
    flush();
    emit({ kind: "submit", at: Date.now(), target: label(event.target), before: snapshot() });
  });
  window.addEventListener(
    "pagehide",
    () => {
      if (agent) return;
      flush();
      emit({ kind: "navigate", at: Date.now(), target: "", before: snapshot() });
    },
    { signal: abort.signal },
  );
  const mutations = new MutationObserver(() => {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = undefined;
      emit({ kind: "changed" });
    }, 700);
  });
  mutations.observe(document, { subtree: true, childList: true, characterData: true });
  let performanceCapture: ReturnType<typeof observePerformance> | undefined;
  try {
    performanceCapture = observePerformance((data) => emit({ kind: "performance", data }), early);
  } catch {
    emit({ kind: "performance_error" });
  }
  host[slot] = {
    performance: () => performanceCapture?.snapshot(),
    finishPerformance: () => performanceCapture?.finish(),
    snapshot,
    flush,
    agent(value: boolean, revision: number, expiresAt: number) {
      // A queued pre-read may execute after its command finished or was cancelled.
      if (revision <= agentRevision) return;
      agentRevision = revision;
      if (value && Date.now() >= expiresAt) return;
      if (value) flush();
      agent = value;
    },
    dispose() {
      abort.abort();
      mutations.disconnect();
      performanceCapture?.dispose();
      clearTimeout(timer);
      clearTimeout(changedTimer);
      delete host[slot];
    },
  };
  emit({ kind: "ready" });
}

export interface FieldSnapshot {
  fields: DebugField[];
  fields_partial: boolean;
  navigation?: string;
  text?: string;
  truncated?: boolean;
}
export function sanitizeFields(value: unknown): FieldSnapshot {
  const data = value as Partial<FieldSnapshot> | undefined;
  const fields = Array.isArray(data?.fields)
    ? data.fields.slice(0, 16).flatMap((field) => {
        if (!field || typeof field.key !== "string" || typeof field.label !== "string") return [];
        const sensitive =
          /password|passwd|pwd|secret|token|credential|api.?key|session|credit|card.?number|cc-|one-time-code/i.test(
            `${field.key} ${field.name} ${field.label}`,
          );
        const state =
          sensitive || field.state === "redacted"
            ? "redacted"
            : field.state === "truncated" ||
                (typeof field.value === "string" && field.value.length > 256)
              ? "truncated"
              : "available";
        return [
          {
            key: redactText(field.key, 256),
            label: redactText(field.label, 120),
            ...(typeof field.name === "string" ? { name: redactText(field.name, 120) } : {}),
            state,
            ...(state !== "redacted" && typeof field.value === "string"
              ? { value: redactText(field.value, 256) }
              : {}),
          } satisfies DebugField,
        ];
      })
    : [];
  return {
    fields,
    fields_partial: !Array.isArray(data?.fields) || !!data?.fields_partial,
    ...(typeof data?.text === "string"
      ? {
          text: redactText(data.text, 6000),
          truncated: !!data.truncated || data.text.length > 6000,
        }
      : {}),
    ...(typeof data?.navigation === "string" ? { navigation: data.navigation.slice(0, 30) } : {}),
  };
}

export class DebugObserver {
  readonly world: string;
  readonly binding: string;
  private context?: number;
  private rootFrame?: string;
  private script?: string;
  private stopped = false;
  private agentRevision = 0;
  private readonly contexts = new Set<number>();
  constructor(
    private readonly cdp: DebugCdp,
    private readonly tabId: number,
    id: string,
  ) {
    this.world = `bsk-debug-${id}`;
    this.binding = `__bsk_debug_${id}`;
  }
  contextEvent(method: string, params: unknown): void {
    const event = params as {
      context?: { id: number; name: string; auxData?: { frameId?: string } };
      executionContextId?: number;
    };
    if (method === "Runtime.executionContextsCleared") {
      this.contexts.clear();
      this.context = undefined;
    }
    if (method === "Runtime.executionContextDestroyed" && event.executionContextId !== undefined) {
      this.contexts.delete(event.executionContextId);
      if (this.context === event.executionContextId) this.context = undefined;
    }
    if (
      method === "Runtime.executionContextCreated" &&
      event.context?.name === this.world &&
      event.context.auxData?.frameId === this.rootFrame
    ) {
      this.contexts.add(event.context.id);
    }
  }
  accepts(params: { name?: string; executionContextId?: number }): boolean {
    const accepted =
      !this.stopped &&
      params.name === this.binding &&
      this.contexts.has(params.executionContextId ?? -1);
    // Chrome can create more than one context with the same world name. Select
    // the context that actually installed our observer, not the last created one.
    if (accepted) this.context = params.executionContextId;
    return accepted;
  }
  isRoot(frameId?: string): boolean {
    return !!frameId && frameId === this.rootFrame;
  }
  private send<T>(method: string, params?: object): Promise<T> {
    return this.cdp.sendAttached<T>({ tabId: this.tabId }, method, params);
  }
  async start(): Promise<void> {
    const tree = await this.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    this.rootFrame = tree.frameTree.frame.id;
    const source = (early: boolean) =>
      `(${installObserver.toString()})(${JSON.stringify(this.binding)},${JSON.stringify(this.world)},(${installPerformance.toString()}),${early})`;
    await this.send("Runtime.addBinding", { name: this.binding, executionContextName: this.world });
    if (this.stopped) {
      await this.dispose();
      return;
    }
    const script = await this.send<{ identifier: string }>(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: source(true), worldName: this.world },
    );
    this.script = script.identifier;
    if (this.stopped) {
      await this.dispose();
      return;
    }
    const created = await this.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: this.world,
    });
    this.context = created.executionContextId;
    this.contexts.add(created.executionContextId);
    if (!this.stopped)
      await this.send("Runtime.evaluate", { expression: source(false), contextId: this.context });
    else await this.dispose();
  }
  async call<T>(
    method: "snapshot" | "agent" | "flush" | "performance" | "finishPerformance",
    value?: boolean,
  ): Promise<T | undefined> {
    if (this.context === undefined || this.stopped) return undefined;
    const args =
      method === "agent"
        ? `${value},${++this.agentRevision},${Date.now() + OBSERVATION_TIMEOUT_MS}`
        : value === undefined
          ? ""
          : String(value);
    const result = await this.send<{ result?: { value?: T } }>("Runtime.evaluate", {
      expression: `globalThis[${JSON.stringify(this.world)}]?.${method}(${args})`,
      contextId: this.context,
      returnByValue: true,
    });
    return result.result?.value;
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    const work: Promise<unknown>[] = [];
    if (this.script) {
      work.push(this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.script }));
      this.script = undefined;
    }
    for (const contextId of this.contexts)
      work.push(
        this.send("Runtime.evaluate", {
          expression: `globalThis[${JSON.stringify(this.world)}]?.dispose()`,
          contextId,
        }),
      );
    work.push(this.send("Runtime.removeBinding", { name: this.binding }));
    await Promise.allSettled(work);
    this.contexts.clear();
  }
}
