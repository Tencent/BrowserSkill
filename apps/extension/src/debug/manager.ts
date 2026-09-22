import {
  type CdpDebuggee,
  parseConsoleApiCalled,
  parseExceptionThrown,
  parseLogEntry,
} from "@/browser-driver/chromium-cdp";
import {
  isAgentControlledTab,
  type SessionContext,
  type SessionManager,
} from "@/session-manager/manager";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import type { RequestFrame } from "@/transport/types";
import { type DebugArchive, HISTORY_LIMIT } from "./archive";
import { debugCapabilities } from "./capabilities";
import { consoleSource } from "./evidence-model";
import { DebugJournal, mergeRequest } from "./journal";
import { DebugNetworkControl } from "./network-control";
import { DebugNetworkStore, requestProjection } from "./network-store";
import { DebugObserver, OBSERVATION_TIMEOUT_MS, sanitizeFields } from "./observer";
import { interruptPerformance, PERFORMANCE_LIMIT, performanceSnapshot } from "./performance";
import { readRecording } from "./recording";
import { redactText, redactUrl } from "./redact";
import type {
  DebugConsole,
  DebugOperation,
  DebugPage,
  DebugParams,
  DebugPerformance,
  DebugRecording,
  DebugResult,
  DebugRun,
  DebugTask,
} from "./types";

export const DEBUG_START_TIMEOUT_MS = 10000;
const MAX_RUNS = 4;
const MAX_OPERATIONS = 64;
const MAX_CONSOLE = 100;
const WINDOW_MS = 1500;
const OBSERVE_MS = 15000;
const ACTIONS = new Set([
  "tool.navigate",
  "tool.navigate_back",
  "tool.navigate_forward",
  "tool.reload",
  "tool.click",
  "tool.fill",
  "tool.press",
  "tool.select",
  "tool.hover",
  "tool.evaluate",
  "tool.wheel",
  "tool.scroll_to",
  "tool.focus",
  "tool.blur",
]);

export interface DebugCdp extends CdpRunner {
  ensureNetworkCapture(tabId: number): Promise<void>;
  sendAttached<T = unknown>(
    target: CdpDebuggee & { tabId: number },
    method: string,
    params?: object,
  ): Promise<T>;
  getFrameGraph?: CdpRunner["getFrameGraph"];
}
interface RunState {
  run: DebugRun;
  owner: SessionContext;
  network: DebugNetworkStore;
  controls?: DebugNetworkControl;
  journal?: DebugJournal;
  controlCleanup?: Promise<void>;
  operations: DebugOperation[];
  console: DebugConsole[];
  timer?: ReturnType<typeof setTimeout>;
  current?: DebugOperation;
  nextOperation: number;
  nextConsole: number;
  targets: Set<string>;
  pages: DebugPage[];
  performance: DebugPerformance[];
  nextPerformance: number;
  pagePending?: boolean;
  released?: boolean;
  archiveTimer?: ReturnType<typeof setTimeout>;
  dirty?: boolean;
  saving?: Promise<void>;
  observer?: DebugObserver;
  observing?: boolean;
  agentBusy?: boolean;
  checkpoints?: ReturnType<typeof setTimeout>[];
}
export interface DebugTicket {
  run: RunState;
  operation: DebugOperation;
}

async function deadline<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("debug observation timeout")), ms);
        abort = () =>
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new Error("debug observation cancelled"),
          );
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

/** Bounded live capture with browser-local checkpoints, independent of audit. */
export class DebugManager {
  private readonly runs = new Map<string, RunState>();
  // Only lightweight ownership outlives the live cache. Object identity prevents
  // a reused short session ID from inheriting another task's saved evidence.
  private readonly ownedRuns = new WeakMap<SessionContext, Map<string, number>>();
  private subscription?: { dispose(): void };
  private readonly starting = new Set<SessionContext>();
  // Starts awaiting cleanup still occupy a slot before their RunState is registered.
  private reservedStarts = 0;

  constructor(
    private readonly sessions: SessionManager,
    private readonly cdp: DebugCdp,
    private readonly tabs: ChromeTabsApi,
    private readonly now: () => number = Date.now,
    private readonly archive?: DebugArchive,
  ) {}

  private owned(sessionId: string, tabId: number): boolean {
    const context = this.sessions.get(sessionId);
    return context !== null && isAgentControlledTab(context, tabId);
  }
  private active(sessionId: string, tabId?: number): RunState | undefined {
    return [...this.runs.values()].find(
      ({ run, owner }) =>
        run.session_id === sessionId &&
        owner === this.sessions.get(sessionId) &&
        run.state === "capturing" &&
        (tabId === undefined || run.tab_id === tabId),
    );
  }
  private change(state: RunState): number {
    const sequence = ++state.run.next_since;
    if (
      state.current &&
      this.now() <= (state.current.observation_end ?? state.current.window_end ?? this.now())
    )
      state.current.sequence = sequence;
    this.scheduleSave(state);
    return sequence;
  }

  async start(
    sessionId: string,
    tabId: number,
    name = "",
    signal?: AbortSignal,
  ): Promise<DebugRun> {
    if (signal?.aborted) throw new Error("debug start cancelled");
    this.sync();
    if (!this.owned(sessionId, tabId)) throw new Error("tab is not owned by this task");
    const owner = this.sessions.get(sessionId)!;
    if (this.starting.has(owner)) throw new Error("debug capture is already starting");
    const existing = this.active(sessionId, tabId);
    if (existing) return this.summary(existing);
    if (!this.cdp.onEvent) throw new Error("debug event capture is unavailable");
    if (this.active(sessionId))
      throw new Error("stop the task's current capture before selecting another tab");
    this.starting.add(owner);
    this.reservedStarts += 1;
    let reserved = true;
    const startup = new AbortController();
    let rollback = (_reason: string) => {};
    const cancel = (reason: string) => {
      // Stop retaining events synchronously, even if Chrome never resolves its command.
      rollback(reason);
      startup.abort(
        new Error(reason === "cancelled" ? "debug start cancelled" : "debug start timeout"),
      );
    };
    const abort = () => cancel("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => cancel("start_timeout"), DEBUG_START_TIMEOUT_MS);
    const wait = <T>(promise: Promise<T>) =>
      deadline(promise, DEBUG_START_TIMEOUT_MS, startup.signal);
    try {
      while (this.runs.size + this.reservedStarts > MAX_RUNS) {
        const stopped = [...this.runs.values()].find(({ run }) => run.state === "stopped");
        if (!stopped) throw new Error("debug capture limit reached; stop another capture first");
        await wait(Promise.resolve(stopped.controlCleanup));
        await wait(this.persist(stopped));
        if (stopped.run.storage_error)
          throw new Error(
            "debug history save failed; export the stopped capture before starting another",
          );
        this.runs.delete(stopped.run.id);
      }
      await wait(
        Promise.all(
          [...this.runs.values()]
            .filter((item) => item.run.tab_id === tabId)
            .map((item) => item.controlCleanup),
        ),
      );
      const id = `d${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const run: DebugRun = {
        id,
        session_id: sessionId,
        tab_id: tabId,
        name: redactText(name, 120),
        url: "",
        started_at: this.now(),
        state: "capturing",
        requests: 0,
        operations: 0,
        errors: 0,
        dropped_requests: 0,
        dropped_operations: 0,
        dropped_console: 0,
        next_since: 0,
        coverage: [
          "from_start",
          "task_tab",
          "text_bodies_bounded",
          "time_window_not_causality",
          "page_main_frame",
          "worker_targets_not_captured",
          "manual_main_frame_only",
        ],
        environment: {
          ...(typeof __BSK_EXT_VERSION__ === "string"
            ? { extension_version: __BSK_EXT_VERSION__ }
            : {}),
          ...(typeof navigator !== "undefined"
            ? { user_agent: redactText(navigator.userAgent, 300) }
            : {}),
        },
      };
      const network = new DebugNetworkStore(
        id,
        {
          send: async <T>(targetTab: number, method: string, params?: object) => {
            if (!this.owned(sessionId, targetTab) || state.run.state !== "capturing")
              throw new Error("capture stopped");
            return deadline(this.cdp.sendAttached<T>({ tabId: targetTab }, method, params), 2500);
          },
          sendToTarget: async <T>(
            target: CdpDebuggee & { tabId: number },
            method: string,
            params?: object,
          ) => {
            if (!this.owned(sessionId, target.tabId) || state.run.state !== "capturing")
              throw new Error("capture stopped");
            return deadline(this.cdp.sendAttached<T>(target, method, params), 2500);
          },
        },
        () => this.change(state),
        this.now,
        (entry) => state.journal?.retain(entry),
      );
      const state: RunState = {
        run,
        owner,
        network,
        operations: [],
        console: [],
        nextOperation: 0,
        nextConsole: 0,
        targets: new Set(),
        pages: [],
        performance: [],
        nextPerformance: 0,
      };
      if (this.archive?.retain)
        state.journal = new DebugJournal(
          this.archive,
          () => this.summary(state),
          (reason) => this.coverage(state, reason),
        );
      state.controls = new DebugNetworkControl(
        id,
        tabId,
        this.cdp,
        network,
        () => {
          this.change(state);
        },
        () => state.run.state === "capturing" && this.owned(sessionId, tabId),
        this.now,
      );
      rollback = (reason) => this.stopState(state, reason);
      this.reservedStarts -= 1;
      reserved = false;
      this.runs.set(id, state);
      let ownedRuns = this.ownedRuns.get(state.owner);
      if (!ownedRuns) this.ownedRuns.set(state.owner, (ownedRuns = new Map()));
      ownedRuns.set(id, tabId);
      while (ownedRuns.size > HISTORY_LIMIT + MAX_RUNS)
        ownedRuns.delete(ownedRuns.keys().next().value!);
      this.subscription ??= this.cdp.onEvent?.((source, method, params) =>
        this.onEvent(source, method, params),
      );
      try {
        if (this.sessions.get(sessionId) !== owner)
          throw new Error("task ended during debug start");
        const tab = await wait(this.tabs.get(tabId));
        if (tab.windowId !== this.sessions.get(sessionId)?.agentWindowId)
          throw new Error("debug tab must remain in its Agent Window");
        if (!this.runs.has(id) || state.run.state !== "capturing")
          throw new Error("capture stopped during debug start");
        this.cdp.trackSessionTab?.(sessionId, tabId);
        await wait(this.cdp.ensureNetworkCapture(tabId));
        if (!this.owned(sessionId, tabId) || !this.runs.has(id))
          throw new Error("task ended during debug start");
        if (state.run.state !== "capturing") return this.summary(state);
        await wait(this.enableTarget(state, { tabId }, startup.signal));
        if (state.run.state !== "capturing") return this.summary(state);
        const graph = await wait(
          Promise.resolve(
            this.cdp.getFrameGraph?.(tabId).catch(() => {
              this.coverage(state, "child_capture_partial");
              return undefined;
            }),
          ),
        );
        if (graph) {
          // Frame graph discovery already belongs to the driver. Debug adds only
          // bounded Network/Runtime listeners on its existing child attachments.
          const targets = new Map<string, CdpDebuggee & { tabId: number }>();
          for (const frame of graph.frames)
            if (frame.target.sessionId) targets.set(frame.target.sessionId, frame.target);
          await wait(
            Promise.all(
              [...targets.values()]
                .slice(0, 16)
                .map((target) =>
                  this.enableTarget(state, target, startup.signal).catch(() =>
                    this.coverage(state, "child_capture_partial"),
                  ),
                ),
            ),
          );
        }
        run.url = redactUrl((await wait(this.tabs.get(tabId))).url ?? "");
        if (!this.owned(sessionId, tabId) || !this.runs.has(id))
          throw new Error("task ended during debug start");
        if (/^https?:/.test(run.url)) this.coverage(state, "initial_load_not_recorded");
        state.observer = new DebugObserver(this.cdp, tabId, id);
        await wait(
          deadline(state.observer.start(), 2500, startup.signal).catch((error) => {
            if (startup.signal.aborted) throw error;
            this.coverage(state, "manual_capture_unavailable");
            this.coverage(state, "performance_capture_unavailable");
            void state.observer?.dispose();
          }),
        );
        await wait(this.capturePage(state));
        await wait(this.persist(state));
        return this.summary(state);
      } catch (error) {
        this.stopState(state, "start_failed");
        clearTimeout(state.archiveTimer);
        this.runs.delete(id);
        ownedRuns.delete(id);
        this.pruneListener();
        throw error;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (reserved) this.reservedStarts -= 1;
      this.starting.delete(owner);
    }
  }

  private async enableTarget(
    state: RunState,
    target: CdpDebuggee & { tabId: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const key = target.sessionId ?? "root";
    if (
      state.targets.has(key) ||
      state.run.state !== "capturing" ||
      !this.owned(state.run.session_id, target.tabId)
    )
      return;
    if (state.targets.size >= 17) {
      this.coverage(state, "child_capture_limit");
      return;
    }
    state.targets.add(key);
    try {
      await deadline(
        this.cdp.sendAttached(target, "Network.enable", {
          maxTotalBufferSize: 2 * 1024 * 1024,
          maxResourceBufferSize: 256 * 1024,
          maxPostDataSize: 64 * 1024,
        }),
        2500,
        signal,
      );
      if (
        target.sessionId &&
        state.run.state === "capturing" &&
        this.owned(state.run.session_id, target.tabId)
      )
        await deadline(this.cdp.sendAttached(target, "Runtime.enable"), 2500, signal);
      if (state.run.state === "capturing" && !signal?.aborted)
        await deadline(Promise.resolve(state.controls?.target(target)), 2500, signal);
    } catch (error) {
      state.targets.delete(key);
      throw error;
    }
  }

  private coverage(state: RunState, reason: string): void {
    if (!state.run.coverage.includes(reason)) {
      state.run.coverage.push(reason);
      this.change(state);
    }
  }

  private onEvent(source: CdpDebuggee, method: string, params: unknown): void {
    if (typeof source.tabId !== "number") return;
    for (const state of this.runs.values()) {
      if (state.run.tab_id !== source.tabId) continue;
      if (state.run.state !== "capturing") {
        if (state.controlCleanup)
          state.controls?.onEvent({ ...source, tabId: source.tabId }, method, params);
        continue;
      }
      if (!this.owned(state.run.session_id, source.tabId)) {
        this.stopState(state, "tab_released");
        continue;
      }
      if (!source.sessionId) {
        state.observer?.contextEvent(method, params);
        if (
          method === "Page.frameStartedLoading" &&
          state.observer?.isRoot((params as { frameId?: string }).frameId) &&
          !state.agentBusy
        )
          this.manualEvent(state, JSON.stringify({ kind: "navigate", at: this.now() }));
        if (method === "Runtime.bindingCalled") {
          const event = params as { name?: string; executionContextId?: number; payload?: string };
          if (
            state.observer?.accepts(event) &&
            typeof event.payload === "string" &&
            event.payload.length < 65536
          )
            this.manualEvent(state, event.payload);
          continue;
        }
      }
      if (method === "Target.attachedToTarget") {
        const child = params as { sessionId?: string; targetInfo?: { type?: string } };
        if (child.sessionId && child.targetInfo?.type === "iframe")
          void this.enableTarget(state, { tabId: source.tabId, sessionId: child.sessionId }).catch(
            () => this.coverage(state, "child_capture_partial"),
          );
      }
      if (method === "Target.detachedFromTarget") {
        const child = params as { sessionId?: string };
        if (child.sessionId) {
          state.targets.delete(child.sessionId);
          state.network.detachTarget(child.sessionId);
          state.controls?.detach(child.sessionId);
        }
      }
      if (!source.sessionId && method === "Page.loadEventFired") void this.capturePage(state, true);
      state.network.onEvent({ ...source, tabId: source.tabId }, method, params);
      state.controls?.onEvent({ ...source, tabId: source.tabId }, method, params);
      if (method === "Network.loadingFinished") this.scheduleObservation(state);
      const parsed =
        method === "Runtime.consoleAPICalled"
          ? parseConsoleApiCalled(params)
          : method === "Runtime.exceptionThrown"
            ? parseExceptionThrown(params)
            : method === "Log.entryAdded"
              ? parseLogEntry(params)
              : null;
      if (!parsed || (parsed.timestamp !== undefined && parsed.timestamp < state.run.started_at))
        continue;
      const at = this.now();
      const text = redactText(parsed.text, 2048);
      const sourceUrl = parsed.url || parsed.stack_trace?.find((frame) => frame.url)?.url;
      const origin = consoleSource(
        sourceUrl,
        (params as { entry?: { source?: string } })?.entry?.source,
      );
      const stack = parsed.stack_trace
        ?.map(
          (frame) =>
            `${frame.function_name ?? ""} ${redactUrl(frame.url ?? "")}:${frame.line ?? ""}:${frame.column ?? ""}`,
        )
        .join("\n")
        .slice(0, 4096);
      // Coalesce only adjacent repeats within one action window.
      const last = state.console.at(-1);
      if (
        last &&
        last.text === text &&
        last.stack === stack &&
        last.level === parsed.level &&
        last.source === origin &&
        last.source_url === sourceUrl &&
        at - last.last_at < 1000 &&
        (!state.current || last.at >= state.current.started_at)
      ) {
        last.count += 1;
        last.last_at = at;
      } else {
        state.console.push({
          id: `${state.run.id}:c${++state.nextConsole}`,
          at,
          last_at: at,
          level: parsed.level,
          text,
          count: 1,
          source: origin,
          ...(sourceUrl ? { source_url: redactUrl(sourceUrl) } : {}),
          ...(stack ? { stack } : {}),
        });
        if (state.console.length > MAX_CONSOLE) {
          state.console.shift();
          state.run.dropped_console += 1;
        }
      }
      this.change(state);
    }
  }

  async before(req: RequestFrame, signal?: AbortSignal): Promise<DebugTicket | undefined> {
    if (signal?.aborted) return;
    if (!ACTIONS.has(req.method)) return;
    const params = req.params as {
      session_id?: string;
      tab_id?: number;
      ref?: string;
      selector?: string;
    };
    if (!params?.session_id || !this.active(params.session_id)) return;
    const context = this.sessions.get(params.session_id);
    if (!context) return;
    const tabId =
      params.tab_id ??
      (
        await deadline(
          this.tabs.query({ windowId: context.agentWindowId, active: true }),
          OBSERVATION_TIMEOUT_MS,
          signal,
        )
      )[0]?.id;
    if (tabId === undefined || !this.owned(params.session_id, tabId)) return;
    const state = this.active(params.session_id, tabId);
    if (!state) return;
    await deadline(
      state.observer?.call("agent", true) ?? Promise.resolve(),
      OBSERVATION_TIMEOUT_MS,
      signal,
    ).catch(() => {
      this.coverage(state, "manual_capture_unavailable");
      void state.observer?.call("agent", false).catch(() => {});
    });
    if (
      signal?.aborted ||
      state.run.state !== "capturing" ||
      this.sessions.get(params.session_id) !== context
    ) {
      void state.observer?.call("agent", false).catch(() => {});
      return;
    }
    state.agentBusy = true;
    clearTimeout(state.timer);
    state.timer = undefined;
    state.checkpoints?.forEach(clearTimeout);
    const now = this.now();
    const previous = state.current;
    if (previous) {
      previous.window_end = Math.min(previous.window_end ?? now, now);
      previous.observation_end = Math.min(previous.observation_end ?? now, now);
    }
    const ref = params.ref ? context.refStore.resolveEntry(params.ref) : undefined;
    const target = ref?.kind === "dom" ? ref.name : params.selector;
    const operation: DebugOperation = {
      id: `${state.run.id}:a${++state.nextOperation}`,
      run_id: state.run.id,
      sequence: this.change(state),
      method: req.method,
      source: "agent",
      ...(target ? { target: redactText(target, 160) } : {}),
      started_at: now,
      state: "running",
      request_ids: [],
      console_ids: [],
      truncated: false,
    };
    state.operations.push(operation);
    state.current = operation;
    if (state.operations.length > MAX_OPERATIONS) {
      state.operations.shift();
      state.run.dropped_operations += 1;
    }
    try {
      operation.before = await deadline(this.page(state), OBSERVATION_TIMEOUT_MS, signal);
    } catch {
      this.coverage(state, "page_snapshot_unavailable");
    }
    if (signal?.aborted) {
      this.after({ run: state, operation }, "debug observation cancelled");
      return;
    }
    if (
      previous &&
      !previous.after &&
      previous.finished_at !== undefined &&
      now - previous.finished_at <= WINDOW_MS
    ) {
      previous.after = operation.before;
      previous.sequence = this.change(state);
    }
    // Clock starts immediately before page input, after the passive pre-read.
    operation.started_at = this.now();
    return { run: state, operation };
  }

  after(ticket: DebugTicket | undefined, error?: string): void {
    if (!ticket) return;
    const { run: state, operation } = ticket;
    if (state.run.state !== "capturing") return;
    state.agentBusy = false;
    void state.observer?.call("agent", false).catch(() => {});
    operation.finished_at = this.now();
    operation.window_end = operation.finished_at + WINDOW_MS;
    operation.observation_end = operation.finished_at + OBSERVE_MS;
    operation.state = error ? "error" : "completed";
    if (error) operation.error = redactText(error, 1024);
    operation.sequence = this.change(state);
    this.startObservation(state);
  }

  private manualEvent(state: RunState, payload: string): void {
    let event: {
      kind?: string;
      at?: number;
      target?: string;
      before?: unknown;
      after?: unknown;
      data?: unknown;
    };
    try {
      event = JSON.parse(payload);
      if (event?.kind === "performance") {
        this.capturePerformance(state, event.data);
        return;
      }
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    if (event.kind === "performance_error") {
      this.coverage(state, "performance_capture_unavailable");
      return;
    }
    if (event.kind === "changed") {
      this.scheduleObservation(state);
      return;
    }
    if (
      state.agentBusy ||
      !["input_start", "input", "click", "submit", "navigate"].includes(event.kind ?? "")
    )
      return;
    const now = this.now();
    const at =
      typeof event.at === "number" && Number.isFinite(event.at)
        ? Math.min(now, Math.max(state.run.started_at, event.at))
        : now;
    const previous = state.current;
    if (
      event.kind === "input" &&
      previous?.source === "human" &&
      previous.method === "tool.fill" &&
      previous.started_at === at &&
      previous.state === "running"
    ) {
      previous.after = { ...previous.before!, at: now, ...sanitizeFields(event.after) };
      previous.state = "completed";
      previous.finished_at = now;
      previous.window_end = now + WINDOW_MS;
      previous.observation_end = now + OBSERVE_MS;
      previous.sequence = this.change(state);
      this.startObservation(state);
      return;
    }
    if (
      event.kind === "navigate" &&
      previous?.source === "human" &&
      at - previous.started_at < 1000
    ) {
      if (previous.method === "tool.navigate") {
        if (event.before) {
          previous.before = {
            at,
            state: "available",
            url: state.run.url,
            ...sanitizeFields(event.before),
          };
          previous.sequence = this.change(state);
        }
        return;
      }
      if (previous.method === "tool.click" && at - previous.started_at < 250) return;
    }
    // A submit caused by the same click is one user operation, not two steps.
    if (
      event.kind === "submit" &&
      previous?.source === "human" &&
      previous.method === "tool.click" &&
      at - previous.started_at < 250
    )
      return;
    if (previous) {
      previous.window_end = Math.min(previous.window_end ?? at, at);
      previous.observation_end = Math.min(previous.observation_end ?? at, at);
    }
    const baseline = previous?.after ?? state.pages.at(-1);
    const before: DebugPage = {
      at,
      state: event.before ? "available" : "unavailable",
      url: baseline?.url ?? state.run.url,
      title: baseline?.title,
      text: baseline?.text,
      ...sanitizeFields(event.before),
    };
    const operation: DebugOperation = {
      id: `${state.run.id}:a${++state.nextOperation}`,
      run_id: state.run.id,
      sequence: this.change(state),
      method: `tool.${event.kind?.startsWith("input") ? "fill" : event.kind === "submit" ? "press" : event.kind}`,
      source: "human",
      target: redactText(typeof event.target === "string" ? event.target : "", 120),
      started_at: at,
      finished_at: now,
      window_end: now + WINDOW_MS,
      observation_end: now + OBSERVE_MS,
      state: event.kind === "input_start" ? "running" : "completed",
      before,
      ...(event.after ? { after: { ...before, at: now, ...sanitizeFields(event.after) } } : {}),
      request_ids: [],
      console_ids: [],
      truncated: false,
    };
    state.operations.push(operation);
    state.current = operation;
    if (state.operations.length > MAX_OPERATIONS) {
      state.operations.shift();
      state.run.dropped_operations += 1;
    }
    clearTimeout(state.timer);
    state.timer = undefined;
    this.startObservation(state);
  }

  private startObservation(state: RunState): void {
    state.checkpoints?.forEach(clearTimeout);
    this.scheduleObservation(state);
    state.checkpoints = [2500, 7500, 14000].map((delay) =>
      setTimeout(() => this.scheduleObservation(state), delay),
    );
  }

  private scheduleObservation(state: RunState): void {
    const operation = state.current;
    if (
      !operation ||
      state.timer ||
      state.observing ||
      state.run.state !== "capturing" ||
      operation.state === "running" ||
      this.now() > (operation.observation_end ?? 0)
    )
      return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (state.current !== operation || state.run.state !== "capturing") return;
      state.observing = true;
      void this.page(state)
        .then((page) => {
          if (state.current !== operation || state.run.state !== "capturing") return;
          const previous = operation.observations?.at(-1);
          if (
            previous?.text === page.text &&
            JSON.stringify(previous?.fields) === JSON.stringify(page.fields)
          )
            return;
          operation.after = page;
          operation.observations ??= [];
          if (operation.observations.length === 4) {
            operation.observations.shift();
            operation.observation_limited = true;
          }
          operation.observations.push(page);
          operation.sequence = this.change(state);
        })
        .finally(() => {
          state.observing = false;
        });
    }, 700);
  }

  private async page(state: RunState): Promise<DebugPage> {
    const at = this.now();
    if (!this.owned(state.run.session_id, state.run.tab_id) || state.run.state !== "capturing")
      return { at, state: "unavailable" };
    try {
      const [tree, tab, fieldValues] = await deadline(
        Promise.all([
          this.cdp.sendAttached<{
            nodes: { ignored?: boolean; role?: { value?: string }; name?: { value?: string } }[];
          }>({ tabId: state.run.tab_id }, "Accessibility.getFullAXTree"),
          this.tabs.get(state.run.tab_id),
          state.observer?.call("snapshot").catch(() => undefined),
        ]),
        600,
      );
      if (!this.owned(state.run.session_id, state.run.tab_id) || state.run.state !== "capturing")
        return { at, state: "unavailable" };
      if (tab.windowId !== this.sessions.get(state.run.session_id)?.agentWindowId)
        return { at, state: "unavailable" };
      const lines: string[] = [];
      let chars = 0;
      let truncated = false;
      for (const node of tree.nodes ?? []) {
        if (
          node.ignored ||
          !["StaticText", "heading", "alert", "status"].includes(node.role?.value ?? "") ||
          !node.name?.value
        )
          continue;
        const line = redactText(node.name.value, 500);
        if (chars + line.length > 6000 || lines.length >= 100) {
          truncated = true;
          break;
        }
        lines.push(line);
        chars += line.length;
      }
      return {
        at,
        state: "available",
        url: redactUrl(tab.url ?? ""),
        title: redactText(tab.title ?? "", 200),
        text: lines.join("\n"),
        truncated,
        ...sanitizeFields(fieldValues),
      };
    } catch {
      return { at, state: "unavailable" };
    }
  }

  private summary(state: RunState): DebugRun {
    return {
      ...state.run,
      active_rules: state.controls?.activeCount ?? 0,
      requests: Math.max(state.network.size, state.run.storage?.requests ?? 0),
      operations: state.operations.length,
      errors: state.console
        .filter((entry) => entry.level === "error")
        .reduce((sum, entry) => sum + entry.count, 0),
      dropped_requests: state.run.storage?.dropped ?? (state.journal ? 0 : state.network.dropped),
      coverage: [
        ...new Set([
          ...state.run.coverage,
          ...(state.run.storage?.dropped ? ["evidence_storage_limit"] : []),
        ]),
      ],
    };
  }

  private stopState(state: RunState, reason: string): void {
    if (state.run.state === "stopped") return;
    state.run.state = "stopped";
    state.run.stopped_at = this.now();
    state.run.stop_reason = reason;
    clearTimeout(state.timer);
    void state.observer?.dispose();
    for (const entry of state.performance) interruptPerformance(entry, "capture_interrupted");
    state.checkpoints?.forEach(clearTimeout);
    if (state.current) {
      state.current.window_end = Math.min(state.current.window_end ?? this.now(), this.now());
      if (state.current.state === "running") state.current.state = "interrupted";
    }
    if (state.current) state.current.sequence = this.change(state);
    state.controlCleanup = state.controls?.hasWork
      ? state.controls
          .stop()
          .catch(() => {
            this.coverage(state, "control_cleanup_failed");
          })
          .finally(() => {
            state.controlCleanup = undefined;
            this.pruneListener();
            state.network.checkpoint();
            void this.persist(state);
          })
      : undefined;
    state.network.stop(reason);
    this.change(state);
    void this.persist(state);
    this.pruneListener();
  }
  private pruneListener(): void {
    if (
      ![...this.runs.values()].some(
        ({ run, controlCleanup }) => run.state === "capturing" || controlCleanup,
      )
    ) {
      this.subscription?.dispose();
      this.subscription = undefined;
    }
  }
  stopTab(tabId: number, reason = "tab_released"): void {
    for (const state of this.runs.values())
      if (state.run.tab_id === tabId) this.stopState(state, reason);
  }
  private release(state: RunState, reason: string): void {
    this.stopState(state, reason);
    state.released = true;
    this.ownedRuns.get(state.owner)?.delete(state.run.id);
    void this.persist(state).then(() => {
      if (
        this.archive &&
        !state.controlCleanup &&
        !state.run.storage_error &&
        !state.dirty &&
        !state.saving
      )
        this.runs.delete(state.run.id);
    });
  }
  releaseTab(tabId: number): void {
    for (const context of this.sessions.list())
      for (const [id, tab] of this.ownedRuns.get(context) ?? [])
        if (tab === tabId) this.ownedRuns.get(context)!.delete(id);
    for (const state of this.runs.values())
      if (state.run.tab_id === tabId) this.release(state, "tab_released");
  }
  releaseSession(sessionId: string): void {
    const context = this.sessions.get(sessionId);
    if (context) this.ownedRuns.delete(context);
    for (const state of this.runs.values())
      if (state.run.session_id === sessionId) this.release(state, "session_ended");
  }
  sync(): void {
    for (const state of this.runs.values()) {
      if (state.released) continue;
      if (this.sessions.get(state.run.session_id) !== state.owner) {
        this.release(state, "session_ended");
      } else if (!this.owned(state.run.session_id, state.run.tab_id)) {
        this.release(state, "tab_released");
      }
    }
  }
  dispose(): void {
    for (const context of this.sessions.list()) this.ownedRuns.delete(context);
    for (const state of this.runs.values()) this.release(state, "disconnected");
    this.pruneListener();
  }

  async tasks(): Promise<DebugTask[]> {
    this.sync();
    return Promise.all(
      this.sessions.list().map(async (context) => {
        const tab = (await this.tabs.query({ windowId: context.agentWindowId, active: true }))[0];
        const latest = [...this.runs.values()]
          .filter(({ run, released }) => !released && run.session_id === context.sessionId)
          .at(-1);
        return {
          session_id: context.sessionId,
          created_at: context.createdAtMs,
          ...(tab?.id !== undefined && isAgentControlledTab(context, tab.id)
            ? {
                tab_id: tab.id,
                title: redactText(tab.title ?? "", 160),
                url: redactUrl(tab.url ?? ""),
              }
            : {}),
          ...(latest ? { run: this.summary(latest) } : {}),
        };
      }),
    );
  }

  private async capturePage(state: RunState, loaded = false): Promise<void> {
    if (state.pagePending || state.run.state !== "capturing") return;
    state.pagePending = true;
    try {
      const page = await this.page(state);
      if (state.run.state !== "capturing" || state.released) return;
      if (!loaded) delete page.navigation;
      state.pages.push(page);
      if (loaded && state.current?.source === "human" && state.current.method === "tool.navigate") {
        if (page.navigation === "reload") state.current.method = "tool.reload";
        state.current.after = page;
        state.current.sequence = this.change(state);
      }
      if (page.url) state.run.url = page.url;
      if (state.pages.length > 20) {
        state.pages.shift();
        this.coverage(state, "page_context_limit");
      }
      this.change(state);
    } finally {
      state.pagePending = false;
    }
  }

  private capturePerformance(state: RunState, value: unknown): void {
    if (state.run.state !== "capturing") return;
    const data = performanceSnapshot(value);
    if (!data) return;
    const index = state.performance.findIndex((item) => item.document_key === data.document_key);
    if (index >= 0 && state.performance[index].observed_at > data.observed_at) return;
    const entry = {
      ...data,
      id: index >= 0 ? state.performance[index].id : `${state.run.id}:p${++state.nextPerformance}`,
      sequence: this.change(state),
    };
    if (index >= 0) state.performance[index] = entry;
    else {
      for (const previous of state.performance)
        interruptPerformance(previous, "navigation_checkpoint_missing");
      state.performance.push(entry);
      if (state.performance.length > PERFORMANCE_LIMIT) {
        state.performance.shift();
        this.coverage(state, "performance_record_limit");
      }
    }
  }
  private async refreshPerformance(state: RunState, finish = false): Promise<void> {
    if (state.run.state !== "capturing" || !state.observer) return;
    try {
      const data = await deadline(
        state.observer.call(finish ? "finishPerformance" : "performance"),
        600,
      );
      if (data) this.capturePerformance(state, data);
    } catch {
      this.coverage(state, "performance_read_failed");
    }
  }

  private recording(state: RunState): DebugRecording {
    return {
      version: 1,
      saved_at: this.now(),
      run: this.summary(state),
      requests: state.network.list(),
      operations: state.operations,
      console: state.console,
      pages: state.pages,
      performance: state.performance,
      rules: state.controls?.list(),
      replays: state.controls?.replays(),
    };
  }

  private scheduleSave(state: RunState): void {
    if (!this.archive) return;
    state.dirty = true;
    if (state.archiveTimer || state.saving) return;
    state.archiveTimer = setTimeout(() => {
      state.archiveTimer = undefined;
      void this.persist(state);
    }, 2000);
  }

  private async persist(state: RunState): Promise<void> {
    if (!this.archive) return;
    await state.journal?.flush();
    clearTimeout(state.archiveTimer);
    state.archiveTimer = undefined;
    while (state.saving) await state.saving;
    if (!state.dirty && state.run.saved_at !== undefined && !state.run.storage_error) return;
    const recording = structuredClone(this.recording(state));
    recording.run.saved_at = recording.saved_at;
    delete recording.run.storage_error;
    state.dirty = false;
    const save = this.archive.put(state.journal ? { ...recording, requests: [] } : recording).then(
      () => {
        state.run.saved_at = recording.saved_at;
        delete state.run.storage_error;
      },
      (error: unknown) => {
        state.run.storage_error =
          error instanceof Error ? error.message : "debug history unavailable";
      },
    );
    state.saving = save;
    await save;
    if (state.saving === save) state.saving = undefined;
    // Changes that arrived during an IndexedDB transaction need another checkpoint.
    if (state.dirty && !state.archiveTimer) this.scheduleSave(state);
  }

  async history(): Promise<{ runs: DebugRun[]; error?: string }> {
    this.sync();
    let history: DebugRun[] = [];
    let error: string | undefined;
    try {
      history = (await this.archive?.list()) ?? [];
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "debug history unavailable";
    }
    const combined = new Map(history.map((run) => [run.id, run]));
    for (const state of this.runs.values()) combined.set(state.run.id, this.summary(state));
    return {
      runs: [...combined.values()].sort((a, b) => b.started_at - a.started_at),
      ...(error ? { error } : {}),
    };
  }

  private async evidenceRecording(state: RunState, bodies = true): Promise<DebugRecording> {
    await state.journal?.flush();
    const live = this.recording(state);
    if (!state.journal) return live;
    try {
      const saved = await this.archive?.get(state.run.id, bodies);
      if (!saved) return live;
      const entries = new Map(saved.requests.map((entry) => [entry.id, entry]));
      for (const entry of live.requests)
        entries.set(entry.id, mergeRequest(entries.get(entry.id), entry));
      live.requests = [...entries.values()].sort(
        (a, b) => a.started_at - b.started_at || a.sequence - b.sequence,
      );
      live.run.requests = live.requests.length;
      state.run.storage = saved.run.storage;
      live.run.storage = saved.run.storage;
      live.run.dropped_requests = saved.run.storage?.dropped ?? live.run.dropped_requests;
      if (saved.run.storage?.dropped)
        live.run.coverage = [...new Set([...live.run.coverage, "evidence_storage_limit"])];
      return live;
    } catch {
      this.coverage(state, "evidence_read_failed");
      live.run.coverage = [...state.run.coverage];
      return live;
    }
  }

  /** Browser-wide reader. Task RPC fallbacks must authorize the run before calling. */
  async readHistory(params: DebugParams): Promise<DebugResult> {
    this.sync();
    if (!params.run_id) throw new Error("recording ID is required");
    return this.readEvidence(params, this.runs.get(params.run_id));
  }

  /** Internal reader; callers retain their own task or extension-page authorization. */
  private async readEvidence(params: DebugParams, live?: RunState): Promise<DebugResult> {
    const runId = params.run_id!;
    if (params.action === "requests" && (!live || live.journal)) {
      await live?.journal?.flush();
      const sequence = live?.run.next_since;
      const indexed = await this.archive?.query?.(runId, params).catch((error) => {
        if (!live) throw error;
        this.coverage(live, "evidence_read_failed");
        return undefined;
      });
      // A readable index can still be stale after a failed write or a CDP event
      // arriving during this read. Merge retained and in-memory evidence below.
      if (
        indexed &&
        (!live ||
          (live.run.next_since === sequence &&
            !live.run.coverage.some(
              (reason) => reason === "evidence_write_failed" || reason === "evidence_write_backlog",
            )))
      ) {
        if (live) live.run.storage = indexed.run?.storage;
        return live
          ? {
              ...indexed,
              run: {
                ...this.summary(live),
                storage: indexed.run?.storage,
                requests: indexed.run!.requests,
                dropped_requests: indexed.run!.dropped_requests,
              },
            }
          : indexed;
      }
    }
    if (live && params.action === "performance") {
      await this.refreshPerformance(live);
      return readRecording(this.recording(live), params);
    }
    const bodies = ["operation", "export", "duplicates"].includes(params.action);
    const recording = live
      ? await this.evidenceRecording(live, bodies)
      : await this.archive?.get(runId, bodies);
    if (recording && params.action === "request" && params.id) {
      const stored = await this.archive?.request?.(runId, params.id).catch((error) => {
        if (!live) throw error;
        this.coverage(live, "evidence_read_failed");
        recording.run.coverage = [...new Set([...recording.run.coverage, ...live.run.coverage])];
        return undefined;
      });
      const current =
        live?.network.get(params.id) ?? recording.requests.find((entry) => entry.id === params.id);
      if (stored || current)
        recording.requests = [current ? mergeRequest(stored, current) : stored!];
    }
    if (!recording) throw new Error("debug recording not found or expired");
    return readRecording(recording, params);
  }

  async deleteHistory(id: string): Promise<void> {
    const state = this.runs.get(id);
    if (state?.run.state === "capturing")
      throw new Error("stop capture before deleting its record");
    if (state) {
      await state.controlCleanup;
      await this.persist(state);
      clearTimeout(state.archiveTimer);
    }
    await this.archive?.delete(id);
    this.runs.delete(id);
  }

  async read(params: DebugParams, signal?: AbortSignal): Promise<DebugResult> {
    this.sync();
    const context = this.sessions.get(params.session_id);
    if (!context) throw new Error("session not found");
    const result: DebugResult = { session_id: params.session_id };
    if (params.action === "capabilities")
      return { ...result, capabilities: debugCapabilities(!!this.archive?.retain) };
    const states = [...this.runs.values()].filter(
      ({ run, owner, released }) =>
        !released &&
        owner === context &&
        (params.tab_id === undefined || run.tab_id === params.tab_id),
    );
    const owned = this.ownedRuns.get(context);
    const savedRuns = async () => {
      const runs = (await this.archive?.list()) ?? [];
      if (this.sessions.get(params.session_id) !== context) throw new Error("session not found");
      return runs
        .filter(
          (run) =>
            this.ownedRuns.get(context)?.has(run.id) &&
            isAgentControlledTab(context, run.tab_id) &&
            (params.tab_id === undefined || run.tab_id === params.tab_id),
        )
        .sort((a, b) => b.started_at - a.started_at);
    };
    if (params.action === "status") {
      const runs = new Map<string, DebugRun>();
      if (owned && [...owned.keys()].some((id) => !this.runs.has(id)))
        for (const run of await savedRuns()) runs.set(run.id, run);
      for (const state of states) runs.set(state.run.id, this.summary(state));
      return { ...result, runs: [...runs.values()].sort((a, b) => a.started_at - b.started_at) };
    }
    const state = params.run_id
      ? states.find(({ run }) => run.id === params.run_id)
      : params.id
        ? states.find(
            (entry) =>
              params.id!.startsWith(`${entry.run.id}:n`) ||
              entry.network.get(params.id!) ||
              entry.controls?.has(params.id!) ||
              entry.operations.some((operation) => operation.id === params.id),
          )
        : states.at(-1);
    if (!state) {
      const id = params.run_id ?? (params.id ? params.id.split(":")[0] : undefined);
      const runId =
        id &&
        owned?.has(id) &&
        isAgentControlledTab(context, owned.get(id)!) &&
        (params.tab_id === undefined || owned.get(id) === params.tab_id)
          ? id
          : !id
            ? (await savedRuns()).at(0)?.id
            : undefined;
      if (!runId)
        throw new Error("debug capture not found; start capture before reproducing the issue");
      if (params.action.startsWith("rule_") || params.action === "replay")
        throw new Error("network controls require an active capture");
      if (["pin", "unpin"].includes(params.action)) {
        if (!this.archive?.pin) throw new Error("persistent evidence unavailable");
        await this.archive.pin(runId, params.id!, params.action === "pin");
      }
      const saved = await this.readEvidence(
        {
          ...params,
          run_id: runId,
          action:
            params.action === "stop"
              ? "rules"
              : ["pin", "unpin"].includes(params.action)
                ? "request"
                : params.action,
        },
        this.runs.get(runId),
      );
      if (
        this.sessions.get(params.session_id) !== context ||
        !this.ownedRuns.get(context)?.has(runId) ||
        !isAgentControlledTab(context, owned?.get(runId) ?? -1)
      )
        throw new Error("session not found");
      return params.action === "stop" ? { ...result, run: saved.run } : saved;
    }
    if (params.action === "stop") {
      await deadline(state.observer?.call("flush") ?? Promise.resolve(), 600).catch(() => {});
      await this.refreshPerformance(state, true);
      this.stopState(state, "requested");
      await state.controlCleanup;
      await this.persist(state);
      return { ...result, run: this.summary(state) };
    }
    if (["pin", "unpin"].includes(params.action)) {
      if (!state.journal || !this.archive?.pin) throw new Error("persistent evidence unavailable");
      await state.journal.flush();
      await this.archive.pin(state.run.id, params.id!, params.action === "pin", this.change(state));
      const request = await this.archive.request?.(state.run.id, params.id!);
      return {
        ...result,
        run: this.summary(state),
        request: request && requestProjection(request),
      };
    }
    if (params.action.startsWith("rule_") || params.action === "replay") {
      if (this.starting.has(state.owner))
        throw new Error("capture is still starting; wait until it is ready");
      if (state.run.state !== "capturing" || !state.controls)
        throw new Error("network controls require an active capture");
      const tab = await this.tabs.get(state.run.tab_id);
      if (
        !this.owned(params.session_id, state.run.tab_id) ||
        tab.windowId !== this.sessions.get(params.session_id)?.agentWindowId
      )
        throw new Error("debug tab must remain in its Agent Window");
      if (signal?.aborted) throw new Error("debug action cancelled");
      if (params.action === "rule_add") await state.controls.add(params.rule!, signal);
      else if (params.action === "replay") {
        await state.journal?.flush();
        const saved = await this.archive?.request?.(state.run.id, params.id!);
        const current = state.network.get(params.id!);
        const source = current ? mergeRequest(saved, current) : saved;
        if (!source) throw new Error("request not found or evicted");
        const replay = await state.controls.replay(source, params.replay!, tab.url ?? "", signal);
        return { ...result, run: this.summary(state), replay };
      } else
        await state.controls.update(
          params.id!,
          params.action as "rule_enable" | "rule_disable" | "rule_remove",
          signal,
        );
      return { ...result, run: this.summary(state), rules: state.controls.list() };
    }
    if (params.action === "operation") {
      const operation = state.operations.find((entry) => entry.id === params.id);
      if (!operation) throw new Error("operation not found or evicted");
      // During the observation window a caller may request an early post-state.
      if (
        state.current === operation &&
        state.run.state === "capturing" &&
        operation.state !== "running" &&
        this.now() <= (operation.window_end ?? 0)
      ) {
        operation.after = await this.page(state);
        operation.sequence = this.change(state);
      }
    }
    const evidence = await this.readEvidence({ ...params, run_id: state.run.id }, state);
    if (
      this.sessions.get(params.session_id) !== context ||
      state.released ||
      !isAgentControlledTab(context, state.run.tab_id)
    )
      throw new Error("session not found");
    return evidence;
  }
}
