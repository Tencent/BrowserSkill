import type { ErrorCode, RpcError, RpcErrorReason } from "@/transport/types";
import {
  isAgentControlledTab,
  type SessionContext,
  type SessionManager,
  sessionWindowId,
} from "./manager";

export class UiTaskError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly reason: RpcErrorReason,
  ) {
    super(message);
  }
}
export function uiError(error: unknown): RpcError {
  if (error instanceof UiTaskError)
    return { code: error.code, message: error.message, data: { reason: error.reason } };
  return { code: "cdp_failed", message: error instanceof Error ? error.message : String(error) };
}
interface Activity {
  stopping: number;
  returning: Map<number, number>;
  operations: Set<UiOperation>;
  mutations: Map<Promise<unknown>, number>;
  graced: WeakSet<Promise<unknown>>;
}
const activities = new WeakMap<SessionContext, Activity>();
function activity(task: SessionContext): Activity {
  let state = activities.get(task);
  if (!state) {
    state = {
      stopping: 0,
      returning: new Map(),
      operations: new Set(),
      mutations: new Map(),
      graced: new WeakSet(),
    };
    activities.set(task, state);
  }
  return state;
}
export interface UiOperation {
  signal: AbortSignal;
  tabId?: number;
  check(): void;
  abort(): void;
  mutate<T>(tabId: number, run: () => Promise<T>): Promise<T>;
}

/** A budget for the whole UI request, including target lookup and image encoding. */
export function runTaskUi<T>(
  manager: SessionManager,
  sessionId: string,
  run: (op: UiOperation, task: SessionContext) => Promise<T>,
): Promise<T> {
  const task = manager.get(sessionId);
  if (!task?.remote)
    return Promise.reject(new UiTaskError("not_found", "Task unavailable", "task_unavailable"));
  const state = activity(task);
  const controller = new AbortController();
  const op: UiOperation = {
    signal: controller.signal,
    check() {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (manager.get(sessionId) !== task)
        throw new UiTaskError("not_found", "Task ended during capture", "task_unavailable");
      if (state.stopping || (op.tabId !== undefined && state.returning.has(op.tabId)))
        throw new UiTaskError("cancelled", "Task is stopping or tab is returning", "task_stopping");
    },
    abort() {
      controller.abort(
        new UiTaskError("cancelled", "Task is stopping or tab is returning", "task_stopping"),
      );
    },
    mutate(tabId, action) {
      op.check();
      // Register before starting the Chrome side effect. Teardown gives
      // issued focus mutations a bounded grace period, then continues cleanup.
      const pending = Promise.resolve().then(() => {
        op.check();
        return action();
      });
      state.mutations.set(pending, tabId);
      void pending.then(
        () => state.mutations.delete(pending),
        () => state.mutations.delete(pending),
      );
      return pending;
    },
  };
  try {
    op.check();
  } catch (error) {
    return Promise.reject(error);
  }
  state.operations.add(op);
  let aborted!: () => void;
  const stop = new Promise<never>((_, reject) => {
    aborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", aborted, { once: true });
  });
  const timer = setTimeout(
    () =>
      controller.abort(
        new UiTaskError("timeout", "Preview or focus timed out after 3000ms", "ui_deadline"),
      ),
    3000,
  );
  const work = Promise.resolve().then(() => {
    op.check();
    return run(op, task);
  });
  return Promise.race([work, stop]).finally(() => {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", aborted);
    state.operations.delete(op);
  });
}

/** Used at the actual return boundary, including automatic return and rollback.
 * Never wait for unbounded image/CDP work. Late work is invalidated first. */
export async function withUiTeardown<T>(
  task: SessionContext,
  tabId: number | undefined,
  run: () => Promise<T>,
): Promise<T | RpcError> {
  if (!task.remote) return run();
  const state = activity(task);
  if (tabId === undefined) state.stopping++;
  else state.returning.set(tabId, (state.returning.get(tabId) ?? 0) + 1);
  for (const op of state.operations)
    if (tabId === undefined || op.tabId === undefined || op.tabId === tabId) op.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = [...state.mutations]
      .filter(([p, id]) => !state.graced.has(p) && (tabId === undefined || id === tabId))
      .map(([p]) => p);
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
    for (const p of pending) state.graced.add(p);
    clearTimeout(timer);
    // UI focus is best effort: it must never veto resource cleanup or reconnect.
    // Already-issued Chrome calls cannot be recalled; op.check blocks later steps.
    return await run();
  } catch (error) {
    if (error instanceof UiTaskError) return uiError(error);
    throw error;
  } finally {
    clearTimeout(timer);
    if (tabId === undefined) state.stopping--;
    else {
      const remaining = (state.returning.get(tabId) ?? 1) - 1;
      if (remaining) state.returning.set(tabId, remaining);
      else state.returning.delete(tabId);
    }
  }
}

export async function checkedUiTab(task: SessionContext, op: UiOperation, tabId: number) {
  op.tabId = tabId;
  op.check();
  if (!isAgentControlledTab(task, tabId))
    throw new UiTaskError("not_found", "Task ended during capture", "target_unavailable");
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    op.check();
    throw new UiTaskError(
      "cdp_failed",
      error instanceof Error ? error.message : "Task tab lookup failed",
      "ui_lookup_failed",
    );
  }
  op.check();
  if (
    tab.id !== tabId ||
    tab.windowId !== sessionWindowId(task) ||
    !isAgentControlledTab(task, tabId)
  )
    throw new UiTaskError("not_found", "Task ended during capture", "target_unavailable");
  return tab;
}
