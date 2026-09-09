// Snapshot ref resolution — normalise `@eN` / `eN`, look up
// compound CDP node identity via the session RefStore, and build stable
// `ref_not_found` errors for hard-failure tool paths.

import type { SessionContext } from "@/session-manager/manager";
import { normaliseRef, type RefEntry } from "@/session-manager/ref-store";
import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";

export interface SnapshotRefLookup {
  backendNodeId: number;
  refKey: string;
  frameId?: string;
  cdpSessionId?: string;
}

/** Typed lookup never turns a visual anchor into a DOM operation target. */
export function lookupRefTarget(
  ctx: SessionContext,
  refKey: string,
  tabId: number,
): RefEntry | null {
  const entry = ctx.refStore.resolveEntry(refKey);
  if (!entry) return null;
  const ownerTabId =
    entry.kind === "visual-region" ? entry.candidate.document.target.tabId : entry.tabId;
  return ownerTabId === tabId ? entry : null;
}

/**
 * Soft lookup: returns `null` when the ref is unknown or bound to a
 * different tab, or is a visual region. Used by paths that report `matched: false` instead of
 * emitting an RPC error (e.g. `tool.request_help`).
 */
export function lookupSnapshotRef(
  ctx: SessionContext,
  ref: string,
  tabId: number,
): SnapshotRefLookup | null {
  const refKey = normaliseRef(ref);
  const entry = lookupRefTarget(ctx, refKey, tabId);
  if (!entry || entry.kind !== "dom") return null;
  return {
    backendNodeId: entry.backendNodeId,
    refKey,
    ...(entry.frameId ? { frameId: entry.frameId } : {}),
    ...(entry.cdpSessionId ? { cdpSessionId: entry.cdpSessionId } : {}),
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
): SnapshotRefLookup | RpcError {
  const entry = lookupRefTarget(ctx, ref, tabId);
  if (entry?.kind === "visual-region")
    return rpcError(
      "unsupported",
      "ref_kind_unsupported",
      `ref ${ref} is a visual region, not a DOM operation target`,
    );
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
