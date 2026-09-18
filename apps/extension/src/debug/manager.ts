import {
  type CdpDebuggee,
  parseConsoleApiCalled,
  parseExceptionThrown,
  parseLogEntry,
} from "@/browser-driver/chromium-cdp";
import { isAgentControlledTab, type SessionManager } from "@/session-manager/manager";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import type { RequestFrame } from "@/transport/types";
import type { DebugArchive } from "./archive";
import { DebugNetworkStore, requestProjection } from "./network-store";
import { readRecording } from "./recording";
import { redactText, redactUrl } from "./redact";
import type {
  DebugConsole,
  DebugOperation,
  DebugPage,
  DebugParams,
  DebugRecording,
  DebugResult,
  DebugRun,
  DebugTask,
} from "./types";

const MAX_RUNS = 4;
const MAX_OPERATIONS = 64;
const MAX_CONSOLE = 100;
const WINDOW_MS = 1500;
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
  network: DebugNetworkStore;
  operations: DebugOperation[];
  console: DebugConsole[];
  timer?: ReturnType<typeof setTimeout>;
  current?: DebugOperation;
  nextOperation: number;
  nextConsole: number;
  targets: Set<string>;
  pages: DebugPage[];
  pagePending?: boolean;
  released?: boolean;
  archiveTimer?: ReturnType<typeof setTimeout>;
  dirty?: boolean;
  saving?: Promise<void>;
}
export interface DebugTicket {
  run: RunState;
  operation: DebugOperation;
}

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("debug observation timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded live capture with browser-local checkpoints, independent of audit. */
export class DebugManager {
  private readonly runs = new Map<string, RunState>();
  private subscription?: { dispose(): void };
  private readonly starting = new Set<string>();

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
      ({ run }) =>
        run.session_id === sessionId &&
        run.state === "capturing" &&
        (tabId === undefined || run.tab_id === tabId),
    );
  }
  private change(state: RunState): number {
    const sequence = ++state.run.next_since;
    if (state.current && this.now() <= (state.current.window_end ?? this.now()))
      state.current.sequence = sequence;
    this.scheduleSave(state);
    return sequence;
  }

  async start(sessionId: string, tabId: number, name = ""): Promise<DebugRun> {
    this.sync();
    if (!this.owned(sessionId, tabId)) throw new Error("tab is not owned by this task");
    const key = `${sessionId}:${tabId}`;
    if (this.starting.has(key)) throw new Error("debug capture is already starting");
    const existing = this.active(sessionId, tabId);
    if (existing) return this.summary(existing);
    if (!this.cdp.onEvent) throw new Error("debug event capture is unavailable");
    if (this.active(sessionId))
      throw new Error("stop the task's current capture before selecting another tab");
    while (this.runs.size >= MAX_RUNS) {
      const stopped = [...this.runs.values()].find(({ run }) => run.state === "stopped");
      if (!stopped) throw new Error("debug capture limit reached; stop another capture first");
      await this.persist(stopped);
      if (stopped.run.storage_error)
        throw new Error(
          "debug history save failed; export the stopped capture before starting another",
        );
      this.runs.delete(stopped.run.id);
    }
    this.starting.add(key);
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
      ],
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
    );
    const state: RunState = {
      run,
      network,
      operations: [],
      console: [],
      nextOperation: 0,
      nextConsole: 0,
      targets: new Set(),
      pages: [],
    };
    this.runs.set(id, state);
    this.subscription ??= this.cdp.onEvent?.((source, method, params) =>
      this.onEvent(source, method, params),
    );
    try {
      const tab = await this.tabs.get(tabId);
      if (tab.windowId !== this.sessions.get(sessionId)?.agentWindowId)
        throw new Error("debug tab must remain in its Agent Window");
      if (!this.runs.has(id) || state.run.state !== "capturing")
        throw new Error("capture stopped during debug start");
      this.cdp.trackSessionTab?.(sessionId, tabId);
      await this.cdp.ensureNetworkCapture(tabId);
      if (!this.owned(sessionId, tabId) || !this.runs.has(id))
        throw new Error("task ended during debug start");
      if (state.run.state !== "capturing") return this.summary(state);
      await this.enableTarget(state, { tabId });
      if (state.run.state !== "capturing") return this.summary(state);
      const graph = await this.cdp.getFrameGraph?.(tabId).catch(() => {
        this.coverage(state, "child_capture_partial");
        return undefined;
      });
      if (graph) {
        // Frame graph discovery already belongs to the driver. Debug adds only
        // bounded Network/Runtime listeners on its existing child attachments.
        const targets = new Map<string, CdpDebuggee & { tabId: number }>();
        for (const frame of graph.frames)
          if (frame.target.sessionId) targets.set(frame.target.sessionId, frame.target);
        await Promise.all(
          [...targets.values()]
            .slice(0, 16)
            .map((target) =>
              this.enableTarget(state, target).catch(() =>
                this.coverage(state, "child_capture_partial"),
              ),
            ),
        );
      }
      run.url = redactUrl((await this.tabs.get(tabId)).url ?? "");
      if (!this.owned(sessionId, tabId) || !this.runs.has(id))
        throw new Error("task ended during debug start");
      await this.capturePage(state);
      await this.persist(state);
      return this.summary(state);
    } catch (error) {
      this.stopState(state, "start_failed");
      clearTimeout(state.archiveTimer);
      this.runs.delete(id);
      this.pruneListener();
      throw error;
    } finally {
      this.starting.delete(key);
    }
  }

  private async enableTarget(
    state: RunState,
    target: CdpDebuggee & { tabId: number },
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
      await this.cdp.sendAttached(target, "Network.enable", {
        maxTotalBufferSize: 2 * 1024 * 1024,
        maxResourceBufferSize: 256 * 1024,
        maxPostDataSize: 64 * 1024,
      });
      if (
        target.sessionId &&
        state.run.state === "capturing" &&
        this.owned(state.run.session_id, target.tabId)
      )
        await this.cdp.sendAttached(target, "Runtime.enable");
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
      if (state.run.tab_id !== source.tabId || state.run.state !== "capturing") continue;
      if (!this.owned(state.run.session_id, source.tabId)) {
        this.stopState(state, "tab_released");
        continue;
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
        }
      }
      if (!source.sessionId && method === "Page.loadEventFired") void this.capturePage(state);
      state.network.onEvent({ ...source, tabId: source.tabId }, method, params);
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

  async before(req: RequestFrame): Promise<DebugTicket | undefined> {
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
      (await this.tabs.query({ windowId: context.agentWindowId, active: true }))[0]?.id;
    if (tabId === undefined || !this.owned(params.session_id, tabId)) return;
    const state = this.active(params.session_id, tabId);
    if (!state) return;
    clearTimeout(state.timer);
    const now = this.now();
    const previous = state.current;
    if (previous) previous.window_end = Math.min(previous.window_end ?? now, now);
    const ref = params.ref ? context.refStore.resolveEntry(params.ref) : undefined;
    const target = ref?.kind === "dom" ? ref.name : params.selector;
    const operation: DebugOperation = {
      id: `${state.run.id}:a${++state.nextOperation}`,
      run_id: state.run.id,
      sequence: this.change(state),
      method: req.method,
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
    operation.before = await this.page(state);
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
    operation.finished_at = this.now();
    operation.window_end = operation.finished_at + WINDOW_MS;
    operation.state = error ? "error" : "completed";
    if (error) operation.error = redactText(error, 1024);
    operation.sequence = this.change(state);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (state.current !== operation || state.run.state !== "capturing") return;
      void this.page(state).then((page) => {
        if (state.current === operation && state.run.state === "capturing") {
          operation.after = page;
          operation.sequence = this.change(state);
        }
      });
    }, WINDOW_MS);
  }

  private async page(state: RunState): Promise<DebugPage> {
    const at = this.now();
    if (!this.owned(state.run.session_id, state.run.tab_id) || state.run.state !== "capturing")
      return { at, state: "unavailable" };
    try {
      const [tree, tab] = await deadline(
        Promise.all([
          this.cdp.sendAttached<{
            nodes: { ignored?: boolean; role?: { value?: string }; name?: { value?: string } }[];
          }>({ tabId: state.run.tab_id }, "Accessibility.getFullAXTree"),
          this.tabs.get(state.run.tab_id),
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
      };
    } catch {
      return { at, state: "unavailable" };
    }
  }

  private summary(state: RunState): DebugRun {
    return {
      ...state.run,
      requests: state.network.entries.size,
      operations: state.operations.length,
      errors: state.console
        .filter((entry) => entry.level === "error")
        .reduce((sum, entry) => sum + entry.count, 0),
      dropped_requests: state.network.dropped,
      coverage: [...state.run.coverage],
    };
  }

  private stopState(state: RunState, reason: string): void {
    if (state.run.state === "stopped") return;
    state.run.state = "stopped";
    state.run.stopped_at = this.now();
    state.run.stop_reason = reason;
    clearTimeout(state.timer);
    if (state.current) {
      state.current.window_end = Math.min(state.current.window_end ?? this.now(), this.now());
      if (state.current.state === "running") state.current.state = "interrupted";
    }
    if (state.current) state.current.sequence = this.change(state);
    state.network.stop(reason);
    this.change(state);
    void this.persist(state);
    this.pruneListener();
  }
  private pruneListener(): void {
    if (![...this.runs.values()].some(({ run }) => run.state === "capturing")) {
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
    void this.persist(state).then(() => {
      if (this.archive && !state.run.storage_error && !state.dirty && !state.saving)
        this.runs.delete(state.run.id);
    });
  }
  releaseTab(tabId: number): void {
    for (const state of this.runs.values())
      if (state.run.tab_id === tabId) this.release(state, "tab_released");
  }
  releaseSession(sessionId: string): void {
    for (const state of this.runs.values())
      if (state.run.session_id === sessionId) this.release(state, "session_ended");
  }
  sync(): void {
    for (const state of this.runs.values()) {
      if (state.released) continue;
      if (!this.sessions.has(state.run.session_id)) {
        this.release(state, "session_ended");
      } else if (!this.owned(state.run.session_id, state.run.tab_id)) {
        this.release(state, "tab_released");
      }
    }
  }
  dispose(): void {
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

  private operation(state: RunState, operation: DebugOperation, details = true): DebugOperation {
    const end = Math.min(operation.window_end ?? this.now(), this.now());
    const requests = state.network
      .list()
      .filter((entry) => entry.started_at >= operation.started_at && entry.started_at <= end);
    const messages = state.console.filter(
      (entry) => entry.at >= operation.started_at && entry.at <= end,
    );
    const { before, after, ...rest } = operation;
    return {
      ...rest,
      ...(details ? { before, after } : {}),
      request_ids: requests.map((entry) => entry.id),
      console_ids: messages.map((entry) => entry.id),
      truncated: state.network.dropped > 0 || state.run.dropped_console > 0,
    };
  }

  private async capturePage(state: RunState): Promise<void> {
    if (state.pagePending || state.run.state !== "capturing") return;
    state.pagePending = true;
    try {
      const page = await this.page(state);
      if (state.run.state !== "capturing" || state.released) return;
      state.pages.push(page);
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

  private recording(state: RunState): DebugRecording {
    return {
      version: 1,
      saved_at: this.now(),
      run: this.summary(state),
      requests: state.network.list(),
      operations: state.operations.map((operation) => this.operation(state, operation)),
      console: state.console,
      pages: state.pages,
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
    clearTimeout(state.archiveTimer);
    state.archiveTimer = undefined;
    while (state.saving) await state.saving;
    if (!state.dirty && state.run.saved_at !== undefined && !state.run.storage_error) return;
    const recording = structuredClone(this.recording(state));
    recording.run.saved_at = recording.saved_at;
    delete recording.run.storage_error;
    state.dirty = false;
    const save = this.archive.put(recording).then(
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

  /** Extension UI only. Task RPCs cannot use this browser-wide history reader. */
  async readHistory(params: DebugParams): Promise<DebugResult> {
    this.sync();
    if (!params.run_id) throw new Error("recording ID is required");
    const live = this.runs.get(params.run_id);
    const recording = live ? this.recording(live) : await this.archive?.get(params.run_id);
    if (!recording) throw new Error("debug recording not found or expired");
    return readRecording(recording, params);
  }

  async deleteHistory(id: string): Promise<void> {
    const state = this.runs.get(id);
    if (state?.run.state === "capturing")
      throw new Error("stop capture before deleting its record");
    if (state) {
      await this.persist(state);
      clearTimeout(state.archiveTimer);
    }
    await this.archive?.delete(id);
    this.runs.delete(id);
  }

  async read(params: DebugParams): Promise<DebugResult> {
    this.sync();
    if (!this.sessions.has(params.session_id)) throw new Error("session not found");
    const result: DebugResult = { session_id: params.session_id };
    const states = [...this.runs.values()].filter(
      ({ run, released }) =>
        !released &&
        run.session_id === params.session_id &&
        (params.tab_id === undefined || run.tab_id === params.tab_id),
    );
    if (params.action === "status")
      return { ...result, runs: states.map((state) => this.summary(state)) };
    const state = params.run_id
      ? states.find(({ run }) => run.id === params.run_id)
      : params.id
        ? states.find(
            (entry) =>
              entry.network.get(params.id!) ||
              entry.operations.some((operation) => operation.id === params.id),
          )
        : states.at(-1);
    if (!state)
      throw new Error("debug capture not found; start capture before reproducing the issue");
    if (params.action === "stop") {
      this.stopState(state, "requested");
      await this.persist(state);
      return { ...result, run: this.summary(state) };
    }
    if (["export", "console", "pages"].includes(params.action))
      return readRecording(this.recording(state), params);
    result.run = this.summary(state);
    const limit = params.limit ?? 30;
    const since = params.since ?? 0;
    if (params.action === "requests") {
      const entries = state.network
        .list()
        .filter((entry) => entry.sequence > since)
        .sort((a, b) => a.sequence - b.sequence);
      const page = entries.slice(0, limit);
      return {
        ...result,
        requests: page.map((entry) => requestProjection(entry)),
        next_since: page.at(-1)?.sequence ?? state.run.next_since,
        truncated: entries.length > limit || state.network.dropped > 0,
      };
    }
    if (params.action === "request") {
      const entry = state.network.get(params.id ?? "");
      if (!entry) throw new Error("request not found or evicted");
      return {
        ...result,
        request: requestProjection(
          entry,
          params.part,
          params.offset,
          params.max_chars,
          params.pointer,
        ),
      };
    }
    if (params.action === "operations") {
      const entries = state.operations
        .filter((entry) => entry.sequence > since)
        .sort((a, b) => a.sequence - b.sequence);
      const page = entries.slice(0, limit);
      return {
        ...result,
        operations: page.map((operation) => this.operation(state, operation, false)),
        next_since: page.at(-1)?.sequence ?? state.run.next_since,
        truncated: entries.length > limit || state.run.dropped_operations > 0,
      };
    }
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
    const projected = this.operation(state, operation);
    return {
      ...result,
      operation: projected,
      requests: projected.request_ids.map((id) => requestProjection(state.network.get(id)!)),
      console: state.console.filter((entry) => projected.console_ids.includes(entry.id)),
    };
  }
}
