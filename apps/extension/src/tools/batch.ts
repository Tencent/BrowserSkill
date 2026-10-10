import type { SessionContext, SessionManager } from "@/session-manager/manager";
import type { DomRefEntry } from "@/session-manager/ref-store";
import type { ObserveResult, RequestFrame, RpcError } from "@/transport/types";
import { cdpError } from "./errors";
import { parseKeySpec, resolveKeyDescriptor } from "./interaction";
import {
  type CdpRunner,
  type ChromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
  sendToCdpTarget,
} from "./shared";

export type BatchStep =
  | { action: "fill"; target: string; value: string; clear_before?: boolean }
  | { action: "select"; target: string; values: string[] }
  | {
      action: "click";
      target: string;
      button?: "left" | "middle" | "right";
      click_count?: number;
      modifiers?: string[];
    }
  | { action: "press"; target: string; key: string; modifiers?: string[]; hold_ms?: number }
  | { action: "focus" | "blur" | "hover" | "scroll_to"; target: string };

export interface BatchParams {
  session_id: string;
  request_id: string;
  observation_id: string;
  steps: BatchStep[];
  tab_id?: number;
  timeout_ms?: number;
}

export interface BatchStepResult {
  index: number;
  action: string;
  status: "not_run" | "running" | "completed" | "failed";
  effect_state: "none" | "committed" | "unknown";
  result?: unknown;
  error?: RpcError;
}

export interface BatchResult {
  request_id: string;
  status: "running" | "completed" | "stopped";
  steps: BatchStepResult[];
  elapsed_ms: number;
  tab_id?: number;
  error?: RpcError;
  observation?: ObserveResult;
  observation_error?: RpcError;
}

export interface BatchDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  /** Complete single-action path, including popup ownership and hover handling. */
  invoke(request: RequestFrame, signal: AbortSignal): Promise<unknown>;
}

interface Receipt {
  fingerprint: string;
  started: number;
  result: BatchResult;
}

// Session-scoped receipts are separate from optional operation history. Never
// evict and replay an old id: once full, single actions remain available.
const receipts = new WeakMap<SessionContext, Map<string, Receipt>>();
const MAX_RECEIPTS = 64;
const MAX_STEPS = 20;
const MAX_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

function invalid(message: string): RpcError {
  return { code: "invalid_params", message, data: { effect_state: "none" } };
}

function stopped(message: string): RpcError {
  return {
    code: "not_found",
    message: `${message}; observe again and continue with single actions`,
    data: { reason: "ref_not_found", effect_state: "none" },
  };
}

const fields: Record<BatchStep["action"], readonly string[]> = {
  fill: ["value", "clear_before"],
  select: ["values"],
  click: ["button", "click_count", "modifiers"],
  press: ["key", "modifiers", "hold_ms"],
  focus: [],
  blur: [],
  hover: [],
  scroll_to: [],
};

/** Validate the entire plan before dispatching any page input. */
export function validateBatch(params: BatchParams): RpcError | undefined {
  if (!params || typeof params !== "object") return invalid("batch requires a plan");
  if (typeof params.request_id !== "string" || !/^[\w-]{1,64}$/.test(params.request_id))
    return invalid("request_id must contain 1..64 letters, digits, underscores or hyphens");
  if (
    typeof params.observation_id !== "string" ||
    !params.observation_id.length ||
    params.observation_id.length > 128
  )
    return invalid(
      "observation_id must come from observe or snapshot; use single actions on older versions",
    );
  if (!Array.isArray(params.steps) || !params.steps.length || params.steps.length > MAX_STEPS)
    return invalid(`batch requires 1..${MAX_STEPS} steps`);
  if (new TextEncoder().encode(JSON.stringify(params)).length > MAX_BYTES)
    return invalid("batch exceeds the 64 KiB input limit");
  const timeout = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS)
    return invalid(`timeout_ms must be in 1..${MAX_TIMEOUT_MS}`);
  if (params.tab_id !== undefined && (!Number.isSafeInteger(params.tab_id) || params.tab_id <= 0))
    return invalid("tab_id must be a positive integer");
  for (const [index, step] of params.steps.entries()) {
    const fail = (message: string) => invalid(`step ${index}: ${message}`);
    if (!step || typeof step !== "object" || !Object.hasOwn(fields, step.action))
      return fail("unsupported batch action; use a single action instead");
    if (typeof step.target !== "string" || !/^@?e\d+$/.test(step.target))
      return fail("target must be an observed DOM ref; selectors and Canvas use single actions");
    const allowed = new Set(["action", "target", ...fields[step.action]]);
    if (Object.keys(step).some((key) => !allowed.has(key))) return fail("unknown action parameter");
    if (
      step.action === "fill" &&
      (typeof step.value !== "string" ||
        (step.clear_before !== undefined && typeof step.clear_before !== "boolean"))
    )
      return fail("fill requires a string value and optional boolean clear_before");
    if (
      step.action === "select" &&
      (!Array.isArray(step.values) ||
        !step.values.length ||
        step.values.some((value) => typeof value !== "string"))
    )
      return fail("select requires a nonempty array of option values");
    if (step.action === "click") {
      if (step.button !== undefined && !["left", "middle", "right"].includes(step.button))
        return fail("invalid mouse button");
      if (
        step.click_count !== undefined &&
        (!Number.isInteger(step.click_count) || step.click_count < 1 || step.click_count > 3)
      )
        return fail("click_count must be in 1..3");
    }
    if (step.action === "press") {
      if (typeof step.key !== "string" || !resolveKeyDescriptor(parseKeySpec(step.key).key))
        return fail("unknown key specification");
      if (
        step.hold_ms !== undefined &&
        (!Number.isInteger(step.hold_ms) || step.hold_ms < 0 || step.hold_ms > 5000)
      )
        return fail("hold_ms must be in 0..5000");
    }
    if (
      (step.action === "click" || step.action === "press") &&
      step.modifiers !== undefined &&
      (!Array.isArray(step.modifiers) ||
        step.modifiers.some((value) => !["alt", "ctrl", "meta", "shift"].includes(value)))
    )
      return fail("invalid modifiers");
  }
}

function snapshot(receipt: Receipt): BatchResult {
  return structuredClone({
    ...receipt.result,
    elapsed_ms:
      receipt.result.status === "running"
        ? Date.now() - receipt.started
        : receipt.result.elapsed_ms,
  });
}

export function handleBatchStatus(
  manager: SessionManager,
  params: { session_id: string; request_id: string },
): BatchResult | RpcError {
  const ctx = lookupSession(manager, params, "batch-status");
  if (isRpcError(ctx)) return ctx;
  const receipt = receipts.get(ctx)?.get(params.request_id);
  return receipt
    ? snapshot(receipt)
    : {
        code: "not_found",
        message:
          "Batch receipt unavailable. Execution is not confirmed; inspect the page before taking further actions.",
        data: { effect_state: "unknown" },
      };
}

/** Only for reads: input handlers must settle before the session can be released. */
async function read<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
      run(),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function attached(
  cdp: CdpRunner,
  tabId: number,
  entry: DomRefEntry,
  signal: AbortSignal,
): Promise<boolean> {
  const target = { tabId, ...(entry.cdpSessionId ? { sessionId: entry.cdpSessionId } : {}) };
  const objectGroup = `batch-probe-${crypto.randomUUID()}`;
  try {
    const resolved = await read(signal, () =>
      sendToCdpTarget<{ object?: { objectId?: string } }>(cdp, target, "DOM.resolveNode", {
        backendNodeId: entry.backendNodeId,
        objectGroup,
      }),
    );
    const objectId = resolved.object?.objectId;
    if (!objectId) return false;
    const reply = await read(signal, () =>
      sendToCdpTarget<{
        result?: { value?: boolean };
        exceptionDetails?: unknown;
      }>(cdp, target, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function() { return this.isConnected === true; }",
        returnByValue: true,
      }),
    );
    if (reply.exceptionDetails || typeof reply.result?.value !== "boolean")
      throw new Error("Could not verify batch target attachment");
    return reply.result.value;
  } finally {
    // Releasing probe handles sends no input and must not prolong a cancelled read.
    void sendToCdpTarget(cdp, target, "Runtime.releaseObjectGroup", { objectGroup }).catch(
      () => {},
    );
  }
}

export async function handleBatch(
  manager: SessionManager,
  params: BatchParams,
  deps: BatchDeps,
  parentSignal: AbortSignal,
): Promise<BatchResult | RpcError> {
  const invalidPlan = validateBatch(params);
  if (invalidPlan) return invalidPlan;
  const ctx = lookupSession(manager, params, "batch");
  if (isRpcError(ctx)) return ctx;
  let history = receipts.get(ctx);
  if (!history) receipts.set(ctx, (history = new Map()));
  const fingerprint = JSON.stringify({
    observation_id: params.observation_id,
    steps: params.steps,
    tab_id: params.tab_id,
  });
  const previous = history.get(params.request_id);
  if (previous)
    return previous.fingerprint === fingerprint
      ? snapshot(previous)
      : invalid("request_id already belongs to a different batch");
  if (history.size >= MAX_RECEIPTS)
    return invalid("Batch receipt limit reached for this session; continue with single actions");
  const started = Date.now();
  const deadline = started + (params.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  const result: BatchResult = {
    request_id: params.request_id,
    status: "running",
    elapsed_ms: 0,
    steps: params.steps.map((step, index) => ({
      index,
      action: step.action,
      status: "not_run",
      effect_state: "none",
    })),
  };
  const receipt: Receipt = { fingerprint, started, result };
  history.set(params.request_id, receipt);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  parentSignal.addEventListener("abort", cancel, { once: true });
  if (parentSignal.aborted) cancel();
  const timer = setTimeout(cancel, Math.max(0, deadline - Date.now()));
  const interruption = (): RpcError | undefined => {
    if (parentSignal.aborted)
      return {
        code: "cancelled",
        message: "Batch cancelled; completed actions were not rolled back",
      };
    if (Date.now() >= deadline || controller.signal.aborted)
      return {
        code: "timeout",
        message: "Batch deadline reached; inspect the receipt before continuing",
      };
  };
  let running: BatchStepResult | undefined;
  try {
    result.error = interruption();
    if (result.error) return result;
    const target = await read(controller.signal, () =>
      resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi),
    );
    if (isRpcError(target)) {
      result.error = target;
      return result;
    }
    result.tab_id = target.tabId;
    const denied = enforceAgentWindow(ctx, target, "batch");
    if (denied) {
      result.error = denied;
      return result;
    }
    if (ctx.refStore.observationId !== params.observation_id) {
      result.error = stopped("The observation has been replaced");
      return result;
    }
    const documentRevision = ctx.refStore.documentRevision(target.tabId);
    // Resolve every ref before input; never reinterpret a reused @eN halfway through.
    const targets: DomRefEntry[] = [];
    for (const step of params.steps) {
      const entry = ctx.refStore.resolveEntry(step.target);
      if (!entry || entry.kind !== "dom" || entry.tabId !== target.tabId) {
        result.error = stopped(`Invalid DOM ref ${step.target} for this tab`);
        return result;
      }
      targets.push(entry);
    }
    for (const [index, step] of params.steps.entries()) {
      result.error = interruption();
      if (result.error) break;
      const tab = await read(controller.signal, () => deps.tabsApi.get(target.tabId));
      if (
        ctx.refStore.observationId !== params.observation_id ||
        ctx.refStore.documentRevision(target.tabId) !== documentRevision ||
        ctx.refStore.resolveEntry(step.target) !== targets[index] ||
        tab.url !== target.url ||
        tab.pendingUrl !== target.pendingUrl ||
        tab.windowId !== target.windowId ||
        (target.active && !tab.active)
      ) {
        result.error = stopped("Page, active tab or observation changed during batch");
        break;
      }
      if (!(await attached(deps.cdp, target.tabId, targets[index], controller.signal))) {
        result.error = stopped(`Target ${step.target} was replaced or removed`);
        break;
      }
      result.error = interruption();
      if (result.error) break;
      // An asynchronous probe may outlive a navigation or ref update.
      if (
        ctx.refStore.observationId !== params.observation_id ||
        ctx.refStore.documentRevision(target.tabId) !== documentRevision ||
        ctx.refStore.resolveEntry(step.target) !== targets[index]
      ) {
        result.error = stopped("The target identity changed during its check");
        break;
      }
      running = result.steps[index];
      running.status = "running";
      running.effect_state = "unknown";
      const { action, target: ref, ...args } = step;
      const value = await deps.invoke(
        {
          id: `${params.request_id}:${index}`,
          method: `tool.${action}`,
          params: {
            ...args,
            session_id: params.session_id,
            tab_id: target.tabId,
            ref,
            timeout_ms: Math.max(1, deadline - Date.now()),
          },
        },
        controller.signal,
      );
      if (isRpcError(value)) {
        running.status = "failed";
        running.error = value;
        running.effect_state = value.data?.effect_state ?? "unknown";
        result.error = value;
        break;
      }
      running.status = "completed";
      running.effect_state = "committed";
      running.result = value;
      running = undefined;
    }
  } catch (error) {
    result.error = interruption() ?? cdpError(error);
    if (running) {
      running.status = "failed";
      running.error = result.error;
    }
  } finally {
    result.error ??= interruption();
    // A final read is useful after an ordinary failure, but must not prolong cancellation.
    if (result.tab_id !== undefined && !controller.signal.aborted && Date.now() < deadline) {
      try {
        const observation = await deps.invoke(
          {
            id: `${params.request_id}:observe`,
            method: "tool.observe",
            params: {
              session_id: params.session_id,
              tab_id: result.tab_id,
              max_tokens: 2000,
              probe_hover: false,
            },
          },
          controller.signal,
        );
        if (isRpcError(observation)) result.observation_error = observation;
        else result.observation = observation as ObserveResult;
      } catch (error) {
        result.observation_error = interruption() ?? cdpError(error);
      }
    } else {
      result.observation_error = interruption() ?? {
        code: "not_found",
        message: "No page observation available",
      };
    }
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", cancel);
    result.elapsed_ms = Date.now() - started;
    result.status = result.error ? "stopped" : "completed";
  }
  return snapshot(receipt);
}
