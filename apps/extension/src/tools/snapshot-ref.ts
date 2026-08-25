// Snapshot ref resolution — normalise `@eN` / `eN`, look up
// compound CDP node identity via the session RefStore, and build stable
// `ref_not_found` errors for hard-failure tool paths.

import type { SessionContext } from "@/session-manager/manager";
import { normaliseRef, type RefCapability, type RefTargetKind } from "@/session-manager/ref-store";
import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";

export interface SnapshotRefLookup {
  backendNodeId: number;
  refKey: string;
  frameId?: string;
  cdpSessionId?: string;
  kind: RefTargetKind;
  capabilities: RefCapability[];
}

function refEntryForTab(ctx: SessionContext, refKey: string, tabId: number) {
  const entry = ctx.refStore.resolveEntry(refKey);
  return entry?.tabId === tabId ? entry : null;
}

/**
 * Soft lookup: returns `null` when the ref is unknown or bound to a
 * different tab. Used by paths that report `matched: false` instead of
 * emitting an RPC error (e.g. `tool.request_help`).
 */
export function lookupSnapshotRef(
  ctx: SessionContext,
  ref: string,
  tabId: number,
): SnapshotRefLookup | null {
  const refKey = normaliseRef(ref);
  const entry = refEntryForTab(ctx, refKey, tabId);
  if (!entry) return null;
  return {
    backendNodeId: entry.backendNodeId,
    refKey,
    ...(entry.frameId ? { frameId: entry.frameId } : {}),
    ...(entry.cdpSessionId ? { cdpSessionId: entry.cdpSessionId } : {}),
    kind: entry.kind,
    capabilities: entry.capabilities,
  };
}

/**
 * Hard resolve: returns `not_found` / `ref_not_found` when the ref is
 * unknown or bound to a different tab. Used by observation and
 * interaction tools.
 */
export function resolveSnapshotRef(
  ctx: SessionContext,
  ref: string,
  tabId: number,
  requiredCapability?: RefCapability,
): SnapshotRefLookup | RpcError {
  const looked = lookupSnapshotRef(ctx, ref, tabId);
  if (looked === null) {
    return rpcError(
      "not_found",
      "ref_not_found",
      `ref ${ref} unknown for tab ${tabId} in session ${ctx.sessionId}`,
    );
  }
  if (requiredCapability && !looked.capabilities.includes(requiredCapability)) {
    return rpcError(
      "permission_denied",
      "ref_capability_denied",
      `ref ${ref} does not support ${requiredCapability}`,
      { ref: looked.refKey, required_capability: requiredCapability, kind: looked.kind },
    );
  }
  return looked;
}
