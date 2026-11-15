import type { FrameNodeHandle } from "@/browser-driver/frame-handles";
import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import { type CdpRunner, lookupPinnedSelectorTarget } from "./shared";

export interface ResolvedMainDocumentSelector {
  handle: FrameNodeHandle;
  backendNodeId: number;
  frameId?: string;
  usedSelector: string;
}

export interface ResolveMainDocumentSelectorOptions {
  toolName: string;
  multiMatch?: "first" | "reject";
  signal?: AbortSignal;
}

/**
 * Resolve a CSS selector in the tab's main document to a concrete `FrameNodeHandle`
 * (`backendNodeId`). Honors request-scoped pinned selector targets established by
 * `CooperationController` without mutating `SessionContext.refStore`.
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
      if (found.nodeIds.length > 1) {
        return {
          code: "invalid_params",
          message: `${options.toolName}: selector matched ${found.nodeIds.length} elements; use a VOM ref or a narrower selector`,
        };
      }
      nodeId = found.nodeIds[0];
    } else {
      nodeId = (
        await cdp.send<{ nodeId?: number }>(tabId, "DOM.querySelector", query, options.signal)
      ).nodeId;
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
