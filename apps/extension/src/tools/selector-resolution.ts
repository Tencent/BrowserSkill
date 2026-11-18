import type { FrameDocumentInfo, FrameNodeHandle } from "@/browser-driver/frame-handles";
import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import { type CdpRunner, lookupPinnedSelectorTarget } from "./shared";
import { isAbortError } from "./vom/capture-abort";

const CHILD_SELECTOR_TIMEOUT_MS = 1_500;
const CHILD_SELECTOR_CONCURRENCY = 8;
const CHILD_SELECTOR_RELEASE_TIMEOUT_MS = 200;

const LOCAL_TIMEOUT = Symbol("childFrameTimeout");
const LOCAL_STOP = Symbol("childFrameStop");

const SELECTOR_SERIALIZATION = {
  serialization: "deep",
  additionalParameters: { maxNodeDepth: 0, includeShadowTree: "none" },
} as const;

interface DeepSelectorReply {
  result?: {
    objectId?: string;
    value?: unknown;
    deepSerializedValue?: { type?: string; value?: unknown };
  };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; objectId?: string };
  };
}

export interface ResolvedMainDocumentSelector {
  handle: FrameNodeHandle;
  backendNodeId: number;
  frameId?: string;
  usedSelector: string;
}

export interface ResolveMainDocumentSelectorOptions {
  toolName: string;
  multiMatch?: "first" | "reject";
  /** `"all"` (default) searches child frames after checking the main document; `"main"` restricts to the top document. */
  scope?: "main" | "all";
  signal?: AbortSignal;
  childTimeoutMs?: number;
  stopSignal?: AbortSignal;
}

async function listChildFrames(
  cdp: CdpRunner,
  tabId: number,
  childTimeoutMs: number,
  signal?: AbortSignal,
): Promise<FrameDocumentInfo[]> {
  try {
    const graph = await cdp.getFrameDocuments(tabId, signal, {
      includeOwners: false,
      childReadTimeoutMs: childTimeoutMs,
      skipQuietWaitWhenIdle: true,
    });
    return graph.frames.filter((frame) => frame.frameId !== graph.rootFrameId);
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (
      isAbortError(error) ||
      name === "TimeoutError" ||
      name === "CdpAttachmentChangedError" ||
      name === "CdpReadTimeoutError" ||
      error?.constructor?.name === "ElementWaitTimeout"
    ) {
      throw error;
    }
    return [];
  }
}

async function queryChildFrame(
  cdp: CdpRunner,
  frame: FrameDocumentInfo,
  selectorJson: string,
  strict: boolean,
  childTimeoutMs: number,
  signal: AbortSignal | undefined,
  isStopped: () => boolean,
  registerCancel: (cancel: () => void) => () => void,
): Promise<{ count: number; backendNodeId?: number }> {
  if (isStopped()) return { count: 0 };
  const objectGroup = `bsk-selector-${crypto.randomUUID()}`;
  const expression = strict
    ? `(() => { const list = document.querySelectorAll(${selectorJson}); return list.length === 1 ? list[0] : list.length; })()`
    : `document.querySelector(${selectorJson})`;

  let timedOut = false;
  let stopped = false;
  let allocatedObject = false;

  const raceLocal = <T>(work: Promise<T>): Promise<T> => {
    if (isStopped()) return Promise.reject(LOCAL_STOP);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        unregister();
        reject(LOCAL_TIMEOUT);
      }, childTimeoutMs);
      const unregister = registerCancel(() => {
        clearTimeout(timer);
        reject(LOCAL_STOP);
      });
      work.then(
        (value) => {
          clearTimeout(timer);
          unregister();
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          unregister();
          reject(error);
        },
      );
    });
  };

  const dispatch = <T>(method: string, params: object): Promise<T> => {
    // Only pass `readTimeoutMs` into `CdpReadGate` for OOPIF targets so a slow
    // same-origin child frame never blocks `"root"` for subsequent main-doc commands.
    const guard = frame.isOutOfProcess
      ? { ...(signal ? { signal } : {}), readTimeoutMs: childTimeoutMs }
      : signal
        ? { signal }
        : undefined;
    return raceLocal(cdp.sendToFrame<T>(frame.handle, method, params, guard));
  };

  try {
    const world = await dispatch<{ executionContextId?: number }>("Page.createIsolatedWorld", {
      frameId: frame.frameId,
      worldName: "bsk-selector",
    });
    if (typeof world.executionContextId !== "number" || isStopped()) return { count: 0 };
    const reply = await dispatch<DeepSelectorReply>("Runtime.evaluate", {
      expression,
      contextId: world.executionContextId,
      objectGroup,
      serializationOptions: SELECTOR_SERIALIZATION,
    });
    const dsv = reply.result?.deepSerializedValue;
    allocatedObject =
      reply.result?.objectId !== undefined ||
      dsv?.type === "node" ||
      reply.exceptionDetails?.exception?.objectId !== undefined;
    if (reply.exceptionDetails) return { count: 0 };
    if (dsv?.type === "node") {
      const backendNodeId = (dsv.value as { backendNodeId?: unknown } | undefined)?.backendNodeId;
      return typeof backendNodeId === "number" ? { count: 1, backendNodeId } : { count: 0 };
    }
    if (strict) {
      const count =
        typeof dsv?.value === "number"
          ? dsv.value
          : typeof reply.result?.value === "number"
            ? reply.result.value
            : 0;
      return { count };
    }
    return { count: 0 };
  } catch (error) {
    if (error === LOCAL_STOP) {
      stopped = true;
      return { count: 0 };
    }
    if (error === LOCAL_TIMEOUT) {
      timedOut = true;
      return { count: 0 };
    }
    const errObj = error as { name?: string; processKey?: string } | null;
    if (
      isAbortError(error) ||
      errObj?.name === "TimeoutError" ||
      errObj?.name === "CdpAttachmentChangedError" ||
      error?.constructor?.name === "ElementWaitTimeout"
    ) {
      throw error;
    }
    if (errObj?.name === "CdpReadTimeoutError") {
      if (frame.isOutOfProcess && errObj.processKey !== "root") {
        timedOut = true;
        return { count: 0 };
      }
      throw error;
    }
    return { count: 0 };
  } finally {
    if (allocatedObject && !timedOut && !stopped && !isStopped()) {
      const cleanup = cdp.resourceCleanup ?? cdp;
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        cleanup
          .sendToFrame(
            frame.handle,
            "Runtime.releaseObjectGroup",
            { objectGroup },
            { allowReattach: false, readTimeoutMs: CHILD_SELECTOR_RELEASE_TIMEOUT_MS },
          )
          .catch(() => {}),
        new Promise<void>((resolve) => {
          releaseTimer = setTimeout(resolve, CHILD_SELECTOR_RELEASE_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(releaseTimer));
    }
  }
}

async function scanChildFrames(
  cdp: CdpRunner,
  tabId: number,
  frames: readonly FrameDocumentInfo[],
  selector: string,
  strict: boolean,
  mainDocMatches: number,
  childTimeoutMs: number,
  signal?: AbortSignal,
  stopSignal?: AbortSignal,
): Promise<{ totalMatches: number; childMatch?: ResolvedMainDocumentSelector }> {
  if (frames.length === 0 || stopSignal?.aborted) return { totalMatches: mainDocMatches };
  const selectorJson = JSON.stringify(selector);
  return new Promise((resolve, reject) => {
    let totalMatches = mainDocMatches;
    let childMatch: ResolvedMainDocumentSelector | undefined;
    let nextIndex = 0;
    let completed = 0;
    let nextOrdered = 0;
    let settled = false;
    const ordered: Array<{ done: boolean; match?: ResolvedMainDocumentSelector }> = strict
      ? []
      : Array.from({ length: frames.length }, () => ({ done: false }));
    const cancelCallbacks = new Set<() => void>();

    const registerCancel = (cancel: () => void) => {
      cancelCallbacks.add(cancel);
      return () => cancelCallbacks.delete(cancel);
    };
    const stopAll = () => {
      stopSignal?.removeEventListener("abort", onExternalStop);
      for (const cancel of [...cancelCallbacks]) cancel();
      cancelCallbacks.clear();
    };
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      stopAll();
      resolve({ totalMatches, childMatch });
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      stopAll();
      reject(error);
    };
    const onExternalStop = () => finishResolve();
    stopSignal?.addEventListener("abort", onExternalStop, { once: true });

    const toResolved = (
      frame: FrameDocumentInfo,
      backendNodeId: number,
    ): ResolvedMainDocumentSelector => ({
      handle: {
        tabId,
        frameId: frame.frameId,
        loaderId: frame.loaderId,
        backendNodeId,
      },
      backendNodeId,
      frameId: frame.frameId,
      usedSelector: selector,
    });

    const runWorker = async () => {
      while (!settled) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= frames.length) return;
        const frame = frames[index];
        const res = await queryChildFrame(
          cdp,
          frame,
          selectorJson,
          strict,
          childTimeoutMs,
          signal,
          () => settled,
          registerCancel,
        );
        if (settled) return;
        if (strict) {
          totalMatches += res.count;
          if (res.count === 1 && res.backendNodeId !== undefined && !childMatch) {
            childMatch = toResolved(frame, res.backendNodeId);
          }
          completed += 1;
          if (totalMatches > 1 || completed === frames.length) {
            finishResolve();
            return;
          }
        } else {
          ordered[index] = {
            done: true,
            match:
              res.backendNodeId !== undefined ? toResolved(frame, res.backendNodeId) : undefined,
          };
          while (nextOrdered < frames.length && ordered[nextOrdered].done) {
            if (ordered[nextOrdered].match) {
              childMatch = ordered[nextOrdered].match;
              finishResolve();
              return;
            }
            nextOrdered += 1;
          }
          if (nextOrdered === frames.length) {
            finishResolve();
            return;
          }
        }
      }
    };

    const workerCount = Math.min(CHILD_SELECTOR_CONCURRENCY, frames.length);
    for (let i = 0; i < workerCount; i += 1) {
      void runWorker().catch(finishReject);
    }
  });
}

/**
 * Resolve a CSS selector in the tab's main document (and accessible child frames
 * unless `options.scope === "main"`) to a concrete `FrameNodeHandle` (`backendNodeId`).
 * Honors request-scoped pinned selector targets established by `CooperationController`
 * without mutating `SessionContext.refStore`.
 */
export async function resolveMainDocumentSelector(
  cdp: CdpRunner,
  tabId: number,
  selector: string,
  options: ResolveMainDocumentSelectorOptions,
): Promise<ResolvedMainDocumentSelector | RpcError> {
  const pinned = lookupPinnedSelectorTarget(cdp, tabId, selector);
  if (pinned) {
    return {
      handle: pinned.handle,
      backendNodeId: pinned.backendNodeId,
      ...(pinned.frameId ? { frameId: pinned.frameId } : {}),
      usedSelector: pinned.usedSelector,
    };
  }

  const searchChildFrames = options.scope !== "main";
  const childTimeoutMs =
    options.childTimeoutMs !== undefined && options.childTimeoutMs > 0
      ? Math.min(CHILD_SELECTOR_TIMEOUT_MS, options.childTimeoutMs)
      : CHILD_SELECTOR_TIMEOUT_MS;

  try {
    const doc = await cdp.send<{ root?: { nodeId?: number } }>(
      tabId,
      "DOM.getDocument",
      { depth: 0 },
      options.signal,
    );
    const rootNodeId = doc.root?.nodeId;
    if (typeof rootNodeId !== "number") {
      return {
        code: "cdp_failed",
        message: "DOM.getDocument returned no root nodeId",
      };
    }

    const query = { nodeId: rootNodeId, selector };
    let nodeId: number | undefined;
    if (options.multiMatch === "reject") {
      const found = await cdp.send<{ nodeIds: number[] }>(
        tabId,
        "DOM.querySelectorAll",
        query,
        options.signal,
      );
      let totalMatches = found.nodeIds.length;
      let childMatch: ResolvedMainDocumentSelector | undefined;
      if (searchChildFrames && totalMatches <= 1) {
        const frames = await listChildFrames(cdp, tabId, childTimeoutMs, options.signal);
        const childResult = await scanChildFrames(
          cdp,
          tabId,
          frames,
          selector,
          true,
          totalMatches,
          childTimeoutMs,
          options.signal,
          options.stopSignal,
        );
        totalMatches = childResult.totalMatches;
        childMatch = childResult.childMatch;
      }
      if (totalMatches > 1) {
        return {
          code: "invalid_params",
          message: `${options.toolName}: selector matched ${totalMatches} elements; use a VOM ref or a narrower selector`,
        };
      }
      if (totalMatches === 0) {
        return rpcError(
          "not_found",
          "selector_not_found",
          `selector ${selector} did not match any element`,
        );
      }
      if (childMatch) return childMatch;
      nodeId = found.nodeIds[0];
    } else {
      nodeId = (
        await cdp.send<{ nodeId?: number }>(tabId, "DOM.querySelector", query, options.signal)
      ).nodeId;
      if ((typeof nodeId !== "number" || nodeId === 0) && searchChildFrames) {
        const frames = await listChildFrames(cdp, tabId, childTimeoutMs, options.signal);
        const childResult = await scanChildFrames(
          cdp,
          tabId,
          frames,
          selector,
          false,
          0,
          childTimeoutMs,
          options.signal,
          options.stopSignal,
        );
        if (childResult.childMatch) return childResult.childMatch;
      }
    }

    if (typeof nodeId !== "number" || nodeId === 0) {
      return rpcError(
        "not_found",
        "selector_not_found",
        `selector ${selector} did not match any element`,
      );
    }

    const described = await cdp.send<{ node?: { backendNodeId?: number } }>(
      tabId,
      "DOM.describeNode",
      { nodeId },
      options.signal,
    );
    const backendNodeId = described.node?.backendNodeId;
    if (typeof backendNodeId !== "number") {
      return {
        code: "cdp_failed",
        message: "DOM.describeNode returned no backendNodeId",
      };
    }

    return {
      handle: {
        tabId,
        frameId: "",
        loaderId: "",
        backendNodeId,
      },
      backendNodeId,
      usedSelector: selector,
    };
  } catch (err) {
    if (isAbortError(err)) {
      return { code: "cancelled", message: `${options.toolName} aborted` };
    }
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Probe whether a CSS selector currently matches at least one element in the tab's
 * main document (reusing an already-fetched `rootNodeId` when available).
 */
export async function selectorExistsInMainDocument(
  cdp: CdpRunner,
  tabId: number,
  selector: string,
  rootNodeId?: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (lookupPinnedSelectorTarget(cdp, tabId, selector)) return true;
  try {
    let resolvedRootId = rootNodeId;
    if (typeof resolvedRootId !== "number") {
      const doc = await cdp.send<{ root?: { nodeId?: number } }>(
        tabId,
        "DOM.getDocument",
        { depth: 0 },
        signal,
      );
      resolvedRootId = doc.root?.nodeId;
      if (typeof resolvedRootId !== "number") return false;
    }
    const res = await cdp.send<{ nodeId?: number }>(
      tabId,
      "DOM.querySelector",
      { nodeId: resolvedRootId, selector },
      signal,
    );
    return typeof res.nodeId === "number" && res.nodeId !== 0;
  } catch {
    return false;
  }
}
