/**
 * Archive-triggered bsk session cleanup. DSH conversation archival writes
 * the workspace registry's durable global state, which the storage domain
 * broadcasts as `domain/changed` ({domain: 'workspace', table: ''}) with
 * the new `archivedSessionIds`. The watcher diffs that set and stops every
 * bsk session owned by a freshly archived conversation — archived sessions
 * are hidden from every surface, so their Agent Windows would otherwise
 * linger with no way back to them.
 *
 * Ownership lineage: browser_session_start records the calling agent's
 * session id PLUS every ancestor along `header.parentSession` (a subagent's
 * browsers are reaped when any ancestor is archived, the root conversation
 * included). Lineage is resolved through the host session store; an
 * unloaded ancestor simply ends the walk.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ObservationService } from "./observation";
import type { SessionRegistry } from "./sessions";

/** The wire shape of a `domain/changed` frame (see dsh-storage-domain). */
interface DomainChange {
  domain?: string;
  table?: string;
  value?: unknown;
}

/** The workspace registry's durable global singleton slice we read. */
interface WorkspaceGlobal {
  archivedSessionIds?: unknown;
}

/** Structural host session store face: only the lineage read is needed. */
interface SessionStoreLike {
  get(id: string): { header: { parentSession?: string } } | undefined;
}

/** Cap on lineage walks — defensive against a malformed parent chain. */
const MAX_LINEAGE_DEPTH = 16;

/**
 * The DSH session ids that own a tool call's browser sessions: the calling
 * agent's own session plus every ancestor along the seed lineage. Empty
 * when the call carried no agent identity (those sessions outlive any
 * archive cleanup by design — nothing can name their owner).
 */
export function ownerSessionIds(ctx: Context, agentId: string | undefined): string[] {
  if (agentId === undefined) return [];
  const store = ctx.get("sessions") as SessionStoreLike | undefined;
  const ids: string[] = [];
  let current: string | undefined = agentId;
  for (let depth = 0; current !== undefined && depth < MAX_LINEAGE_DEPTH; depth += 1) {
    if (ids.includes(current)) break; // a cycle in stored headers must not loop
    ids.push(current);
    current = store?.get(current)?.header.parentSession;
  }
  return ids;
}

/**
 * Watch conversation archival and stop the bsk sessions it opened. Returns
 * the disposer (plugin unload). In compositions without the workspace
 * domain (headless), the event simply never fires — and a context without
 * the events mixin degrades to a no-op like the other optional seams.
 */
export function armArchiveCleanup(
  ctx: Context,
  registry: SessionRegistry,
  observation: ObservationService,
): () => void {
  // 'domain/changed' lives outside the vendored Events type map, so the
  // listener goes through a structural view of the events mixin.
  const on = (
    ctx as { on?: (event: string, listener: (change: DomainChange) => void) => () => void }
  ).on;
  if (typeof on !== "function") return () => {};

  /** Archived ids already accounted for; lazily seeded from the registry. */
  let seen: Set<string> | undefined;
  const initialize = (): Set<string> => {
    if (seen === undefined) {
      const registryService = ctx.get("workspaceRegistry") as
        | { archivedSessionIds?: readonly string[] }
        | undefined;
      seen = new Set(registryService?.archivedSessionIds ?? []);
    }
    return seen;
  };

  return on.call(ctx, "domain/changed", (change: DomainChange) => {
    if (change?.domain !== "workspace" || change?.table !== "") return;
    const archived = (change.value as WorkspaceGlobal | undefined)?.archivedSessionIds;
    if (!Array.isArray(archived)) return;
    const previous = initialize();
    const fresh = archived.filter(
      (id): id is string => typeof id === "string" && !previous.has(id),
    );
    seen = new Set(archived.filter((id): id is string => typeof id === "string"));
    for (const dshSessionId of fresh) {
      for (const sessionId of registry.ownedByDsh(dshSessionId)) {
        // stopSession owns the full teardown (kill in-flight tools, queue
        // the daemon stop, drop registry + observation entries); a failure
        // just leaves the session for idle timeout or unload cleanup.
        void observation.stopSession(sessionId).catch(() => {});
      }
    }
  });
}
