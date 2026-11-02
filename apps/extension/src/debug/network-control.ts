import type { CdpDebuggee } from "@/browser-driver/chromium-cdp";
import {
  editRequest,
  type LiveRequest,
  MAX_REPLAYS,
  MAX_RULES,
  publicRule,
  replayRequest,
  urlMatcher,
  validateReplay,
  validateRule,
} from "./control-model";
import type { DebugCdp } from "./manager";
import type { DebugNetworkStore } from "./network-store";
import { redactText } from "./redact";
import type {
  DebugIntervention,
  DebugReplay,
  DebugReplaySpec,
  DebugRequest,
  DebugRule,
  DebugRuleSpec,
} from "./types";

type Target = CdpDebuggee & { tabId: number };
interface Rule {
  spec?: DebugRuleSpec;
  public: DebugRule;
  matcher: RegExp;
}
interface Paused {
  requestId: string;
  networkId?: string;
  resourceType: string;
  request: LiveRequest;
}
interface Pending {
  target: Target;
  id: string;
  rule: Rule;
  abort: AbortController;
  done: Promise<void>;
}
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
async function bounded<T>(promise: Promise<T>, ms = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("browser command timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Serialized into a dedicated isolated world; keep this function closure-free. */
async function replayInPage(input: {
  origin: string;
  id: string;
  url: string;
  options: RequestInit;
}): Promise<number> {
  if (location.origin !== input.origin) throw new Error("page changed");
  const controller = new AbortController();
  const scope = globalThis as unknown as Record<string, unknown>;
  scope[input.id] = controller;
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(input.url, { ...input.options, signal: controller.signal });
    const reader = response.body?.getReader();
    let size = 0;
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 262144) {
          await reader.cancel();
          throw new Error("response size limit");
        }
      }
    }
    return response.status;
  } finally {
    clearTimeout(timer);
    delete scope[input.id];
  }
}

/** Executes predeclared rules locally. Paused requests never wait on the agent/tool queue. */
export class DebugNetworkControl {
  private alive = true;
  private targets = new Map<string, Target>();
  private configured = new Set<string>();
  private rules = new Map<string, Rule>();
  private pending = new Map<string, Pending>();
  private configuration: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private replayRuns = new Map<
    string,
    { result: DebugReplay; promise: Promise<DebugReplay>; context?: number }
  >();
  constructor(
    private readonly runId: string,
    private readonly tabId: number,
    private readonly cdp: DebugCdp,
    private readonly network: DebugNetworkStore,
    private readonly changed: () => void,
    private readonly allowed: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}
  private assertActive(): void {
    if (!this.alive || !this.allowed())
      throw new Error("network controls require an active, task-owned capture");
  }
  get activeCount(): number {
    return [...this.rules.values()].filter((rule) => rule.public.state === "enabled").length;
  }
  get hasWork(): boolean {
    return this.rules.size > 0 || this.replayRuns.size > 0;
  }
  list(): DebugRule[] {
    return [...this.rules.values()].map((rule) => ({ ...rule.public }));
  }
  replays(): DebugReplay[] {
    return [...this.replayRuns.values()].map(({ result }) => ({ ...result }));
  }
  has(id: string): boolean {
    return this.rules.has(id);
  }
  async target(target: Target): Promise<void> {
    if (!this.alive) return;
    this.targets.set(target.sessionId ?? "root", target);
    if (this.rules.size) await this.refresh();
  }
  detach(sessionId: string): void {
    this.targets.delete(sessionId);
    this.configured.delete(sessionId);
    for (const item of this.pending.values())
      if (item.target.sessionId === sessionId) item.abort.abort();
  }
  async add(input: DebugRuleSpec, signal?: AbortSignal): Promise<void> {
    this.assertActive();
    if (signal?.aborted) throw new Error("debug action cancelled");
    const spec = validateRule(input);
    if (this.rules.size >= MAX_RULES)
      throw new Error("capture rule limit reached (32); start a new capture");
    const id = `${this.runId}:r${this.rules.size + 1}`;
    const rule: Rule = {
      spec,
      matcher: urlMatcher(spec.match.url),
      public: {
        ...publicRule(spec),
        id,
        times: spec.times ?? 1,
        state: "enabled",
        hits: 0,
        failures: 0,
        created_at: this.now(),
      },
    };
    this.rules.set(id, rule);
    this.changed();
    const cancel = () => {
      rule.public.state = "disabled";
      for (const item of this.pending.values()) if (item.rule === rule) item.abort.abort();
      this.changed();
      void this.refresh().catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await this.refresh();
      this.assertActive();
      if (signal?.aborted) throw new Error("debug action cancelled");
    } catch (error) {
      rule.public.state = this.alive ? "disabled" : "stopped";
      rule.public.last_error = "could not enable request interception";
      this.changed();
      await this.refresh().catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  async update(
    id: string,
    action: "rule_enable" | "rule_disable" | "rule_remove",
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertActive();
    if (signal?.aborted) throw new Error("debug action cancelled");
    const rule = this.rules.get(id);
    if (!rule?.spec || rule.public.state === "removed")
      throw new Error("rule not found or removed");
    if (action === "rule_enable") {
      if (rule.public.times && rule.public.hits >= rule.public.times)
        throw new Error("rule is exhausted; create a new rule to apply it again");
      rule.public.state = "enabled";
    } else {
      rule.public.state = action === "rule_remove" ? "removed" : "disabled";
      if (action === "rule_remove") rule.spec = undefined;
      for (const pending of this.pending.values()) if (pending.rule === rule) pending.abort.abort();
      await Promise.allSettled(
        [...this.pending.values()].filter((item) => item.rule === rule).map((item) => item.done),
      );
    }
    this.changed();
    const cancel = () => {
      if (action !== "rule_enable") return;
      if (rule.public.state === "enabled") rule.public.state = "disabled";
      for (const item of this.pending.values()) if (item.rule === rule) item.abort.abort();
      this.changed();
      void this.refresh().catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await this.refresh();
      if (action === "rule_enable") {
        this.assertActive();
        if (signal?.aborted) throw new Error("debug action cancelled");
      }
    } catch (error) {
      if (rule.public.state === "enabled") rule.public.state = "disabled";
      this.changed();
      await this.refresh().catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  private refresh(): Promise<void> {
    const work = this.configuration
      .catch(() => {})
      .then(async () => {
        const active = this.alive
          ? [...this.rules.values()].filter((rule) => rule.public.state === "enabled" && rule.spec)
          : [];
        const patterns = active.flatMap(({ spec }) =>
          (spec!.match.resource_type ? [spec!.match.resource_type] : ["Fetch", "XHR"]).map(
            (resourceType) => ({
              urlPattern: spec!.match.url.replace(/\?/g, "\\?"),
              resourceType,
              requestStage: "Request",
            }),
          ),
        );
        const errors: unknown[] = [];
        await Promise.all(
          [...this.targets].map(async ([key, target]) => {
            try {
              if (patterns.length && this.alive && this.allowed()) {
                this.configured.add(key);
                await bounded(
                  this.cdp.sendAttached(target, "Fetch.enable", {
                    patterns,
                    handleAuthRequests: false,
                  }),
                );
              } else if (this.configured.has(key)) {
                // Drain already-paused requests before disabling the domain.
                await Promise.allSettled(
                  [...this.pending.values()]
                    .filter((item) => (item.target.sessionId ?? "root") === key)
                    .map((item) => item.done),
                );
                await bounded(this.cdp.sendAttached(target, "Fetch.disable"));
                this.configured.delete(key);
              }
            } catch (error) {
              errors.push(error);
            }
          }),
        );
        if (errors.length)
          throw new Error("request control configuration failed; inspect the rule state");
      });
    this.configuration = work;
    return work;
  }
  onEvent(source: Target, method: string, raw: unknown): void {
    if (source.tabId !== this.tabId || !this.targets.has(source.sessionId ?? "root")) return;
    if (method === "Network.requestWillBeSent") {
      const event = raw as {
        requestId?: string;
        initiator?: {
          stack?: { callFrames?: { url?: string }[]; parent?: { callFrames?: { url?: string }[] } };
        };
      };
      const frames = [
        ...(event.initiator?.stack?.callFrames ?? []),
        ...(event.initiator?.stack?.parent?.callFrames ?? []),
      ];
      for (const { result } of this.replayRuns.values()) {
        if (event.requestId && frames.some((frame) => frame.url === `bsk-replay://${result.id}`)) {
          this.network.annotate(source, event.requestId, {
            replay_from: result.source_request_id,
            replay_id: result.id,
          });
          result.request_id = this.network.list().find((item) => item.replay_id === result.id)?.id;
          this.changed();
        }
      }
    }
    if (method !== "Fetch.requestPaused") return;
    const event = raw as Paused;
    if (!event?.requestId || !event.request) return;
    const key = `${source.sessionId ?? "root"}:${event.requestId}`;
    if (this.pending.has(key)) return;
    if (!this.alive || !this.allowed()) {
      void bounded(
        this.cdp.sendAttached(source, "Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "Aborted",
        }),
      ).catch(() => {});
      return;
    }
    const rule = [...this.rules.values()].find(
      ({ spec, public: meta, matcher }) =>
        spec &&
        meta.state === "enabled" &&
        matcher.test(event.request.url) &&
        (!spec.match.method || spec.match.method === event.request.method) &&
        (spec.match.resource_type
          ? spec.match.resource_type === event.resourceType
          : ["Fetch", "XHR"].includes(event.resourceType)),
    );
    if (!rule?.spec) {
      void bounded(
        this.cdp.sendAttached(source, "Fetch.continueRequest", { requestId: event.requestId }),
      ).catch(() =>
        bounded(
          this.cdp.sendAttached(source, "Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "Aborted",
          }),
        ).catch(() => {}),
      );
      return;
    }
    rule.public.hits += 1;
    if (rule.public.times && rule.public.hits >= rule.public.times) rule.public.state = "exhausted";
    this.changed();
    const abort = new AbortController();
    const done = this.apply(source, event, rule, rule.spec, abort.signal).finally(() => {
      this.pending.delete(key);
      // The last one-shot rule stops interception after its request settles.
      if (
        !this.pending.size &&
        ![...this.rules.values()].some((item) => item.public.state === "enabled")
      )
        void this.refresh().catch(() => {});
    });
    this.pending.set(key, { target: source, id: event.requestId, rule, abort, done });
    if (this.pending.size > 32) abort.abort();
  }
  private async apply(
    target: Target,
    event: Paused,
    rule: Rule,
    spec: DebugRuleSpec,
    signal: AbortSignal,
  ): Promise<void> {
    const mark: DebugIntervention = {
      rule_id: rule.public.id,
      type: spec.effect.type,
      state: "pending",
    };
    const annotate = (extra: Parameters<DebugNetworkStore["annotate"]>[2] = {}) => {
      if (event.networkId)
        this.network.annotate(target, event.networkId, { intervention: mark, ...extra });
    };
    annotate();
    // Yield so the pending record exists before cancellation/configuration can drain it.
    await Promise.resolve();
    try {
      if (signal.aborted) throw new Error("cancelled");
      const effect = spec.effect;
      if (effect.type === "block") {
        annotate();
        await bounded(
          this.cdp.sendAttached(target, "Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "BlockedByClient",
          }),
        );
      } else if (effect.type === "modify") {
        const effective = editRequest(event.request, effect);
        mark.changes = [
          effect.url !== undefined ? "url" : "",
          effect.method !== undefined ? "method" : "",
          ...Object.keys(effect.headers ?? {}).map((key) => `header:${key}`),
          effect.body !== undefined ? "body" : "",
          ...Object.keys(effect.json?.set ?? {}).map((key) => `json:${key}`),
          ...(effect.json?.remove ?? []).map((key) => `remove:${key}`),
          ...Object.entries(effect.json?.rename ?? {}).map(([from, to]) => `${from} → ${to}`),
        ]
          .filter(Boolean)
          .map((value) => redactText(value, 160));
        annotate({ effective });
        await bounded(
          this.cdp.sendAttached(target, "Fetch.continueRequest", {
            requestId: event.requestId,
            ...(effect.url === undefined ? {} : { url: effective.url }),
            ...(effect.method === undefined ? {} : { method: effective.method }),
            ...(effect.headers === undefined
              ? {}
              : {
                  headers: Object.entries(effective.headers)
                    .filter(([key]) => !/^(content-length|host)$/i.test(key))
                    .map(([name, value]) => ({ name, value })),
                }),
            ...(effect.body === undefined && effect.json === undefined
              ? {}
              : { postData: base64(effective.postData ?? "") }),
          }),
        );
      } else {
        if (effect.delay_ms) await wait(effect.delay_ms, signal);
        if (signal.aborted || !this.alive || !this.allowed()) throw new Error("cancelled");
        const headers = Object.fromEntries(
          Object.entries(effect.headers ?? { "content-type": "application/json" }).map(
            ([key, value]) => [key.toLowerCase(), value],
          ),
        );
        const responseBody = event.request.method === "HEAD" ? "" : effect.body;
        annotate({ mock: { status: effect.status, headers, body: responseBody } });
        await bounded(
          this.cdp.sendAttached(target, "Fetch.fulfillRequest", {
            requestId: event.requestId,
            responseCode: effect.status,
            responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
            body: base64(responseBody),
          }),
        );
      }
      mark.state = "applied";
    } catch {
      mark.state = signal.aborted || !this.alive ? "cancelled" : "failed";
      mark.error =
        mark.state === "cancelled"
          ? "rule disabled or capture stopped"
          : "request control failed; request aborted";
      rule.public.failures += 1;
      rule.public.last_error = mark.error;
      annotate();
      await bounded(
        this.cdp.sendAttached(target, "Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "Aborted",
        }),
      ).catch(() => {});
    } finally {
      annotate();
      this.changed();
    }
  }
  async replay(
    source: DebugRequest,
    input: DebugReplaySpec,
    pageUrl: string,
    signal?: AbortSignal,
  ): Promise<DebugReplay> {
    this.assertActive();
    if (signal?.aborted) throw new Error("debug action cancelled");
    const spec = validateReplay(input);
    const existing = this.replayRuns.get(spec.key);
    if (existing) {
      if (existing.result.source_request_id !== source.id)
        throw new Error("replay key already belongs to another request");
      return { ...(await existing.promise) };
    }
    if (this.replayRuns.size >= MAX_REPLAYS) throw new Error("capture replay limit reached (20)");
    const request = replayRequest(source, spec, pageUrl);
    const result: DebugReplay = {
      id: `${this.runId}-replay-${this.replayRuns.size + 1}`,
      key: spec.key,
      source_request_id: source.id,
      state: "running",
    };
    const record: { result: DebugReplay; promise: Promise<DebugReplay>; context?: number } = {
      result,
      promise: Promise.resolve(result),
    };
    this.replayRuns.set(spec.key, record);
    this.changed();
    const cancel = () => {
      if (result.state !== "running") return;
      result.state = "interrupted";
      result.error = "replay cancelled; the request may have been sent";
      if (record.context !== undefined)
        void bounded(
          this.cdp.sendAttached({ tabId: this.tabId }, "Runtime.evaluate", {
            contextId: record.context,
            expression: `globalThis[${JSON.stringify(result.id)}]?.abort()`,
          }),
        ).catch(() => {});
      this.changed();
    };
    const check = () => {
      this.assertActive();
      if (signal?.aborted || result.state !== "running") throw new Error("replay cancelled");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    record.promise = (async () => {
      try {
        const { frameTree } = await bounded(
          this.cdp.sendAttached<{ frameTree: { frame: { id: string } } }>(
            { tabId: this.tabId },
            "Page.getFrameTree",
          ),
        );
        check();
        const { executionContextId } = await bounded(
          this.cdp.sendAttached<{ executionContextId: number }>(
            { tabId: this.tabId },
            "Page.createIsolatedWorld",
            { frameId: frameTree.frame.id, worldName: `bsk-network-${this.runId}` },
          ),
        );
        record.context = executionContextId;
        check();
        const options = {
          method: request.method,
          headers: request.headers,
          ...(request.postData ? { body: request.postData } : {}),
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
        };
        // Isolated globals avoid replacing or invoking a site's patched fetch. The
        // origin check executes in that same context, closing a navigation race.
        const expression = `(${replayInPage.toString()})(${JSON.stringify({ origin: new URL(pageUrl).origin, id: result.id, url: request.url, options })})\n//# sourceURL=bsk-replay://${result.id}`;
        const response = await bounded(
          this.cdp.sendAttached<{ exceptionDetails?: unknown }>(
            { tabId: this.tabId },
            "Runtime.evaluate",
            { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true },
          ),
          17000,
        );
        if (result.state === "running") {
          result.state = response.exceptionDetails ? "failed" : "complete";
          if (response.exceptionDetails)
            result.error = "replay failed or timed out; inspect the linked request";
        }
      } catch {
        if (result.state === "running") {
          result.state = this.alive ? "failed" : "interrupted";
          result.error = "replay failed or page changed; the request may have been sent";
        }
      } finally {
        signal?.removeEventListener("abort", cancel);
        this.changed();
      }
      return { ...result };
    })();
    return record.promise;
  }
  stop(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.alive = false;
    for (const rule of this.rules.values()) {
      if (["enabled", "disabled"].includes(rule.public.state)) rule.public.state = "stopped";
      rule.spec = undefined;
    }
    for (const item of this.pending.values()) item.abort.abort();
    const aborts: Promise<unknown>[] = [];
    for (const { result, context } of this.replayRuns.values()) {
      if (result.state !== "running") continue;
      result.state = "interrupted";
      result.error = "capture stopped";
      if (context !== undefined)
        aborts.push(
          bounded(
            this.cdp.sendAttached({ tabId: this.tabId }, "Runtime.evaluate", {
              contextId: context,
              expression: `globalThis[${JSON.stringify(result.id)}]?.abort()`,
            }),
          ).catch(() => {}),
        );
    }
    this.changed();
    this.closePromise = (async () => {
      await Promise.allSettled([...aborts, ...[...this.pending.values()].map((item) => item.done)]);
      try {
        await this.refresh();
      } catch (error) {
        // A broken Fetch domain must not outlive the capture and freeze the tab.
        // Detach only as a cleanup fallback; normal stop preserves shared domains.
        if (this.cdp.detach) await bounded(this.cdp.detach(this.tabId)).catch(() => {});
        throw error;
      }
    })();
    return this.closePromise;
  }
}
