// Snapshot ref resolution — normalise `@eN` / `eN`, look up
// `backendNodeId` via the session RefStore, and build stable
// `ref_not_found` errors for hard-failure tool paths.

import type { SessionContext } from "@/session-manager/manager";
import { normaliseRef } from "@/session-manager/ref-store";
import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";

export interface SnapshotRefLookup {
  backendNodeId: number;
  refKey: string;
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
  const backendNodeId = ctx.refStore.resolve(refKey, { tabId });
  if (backendNodeId === null) return null;
  return { backendNodeId, refKey };
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
): { backendNodeId: number; refKey: string } | RpcError {
  const looked = lookupSnapshotRef(ctx, ref, tabId);
  if (looked === null) {
    return rpcError(
      "not_found",
      "ref_not_found",
      `ref ${ref} unknown for tab ${tabId} in session ${ctx.sessionId}`,
    );
  }
  return looked;
}
