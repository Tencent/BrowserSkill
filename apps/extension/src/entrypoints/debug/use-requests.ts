import { useEffect, useRef, useState } from "react";
import { recordingRequest } from "@/debug/client";
import type { DebugRequest, DebugRun } from "@/debug/types";

interface RequestCache {
  key: string;
  since: number;
  dropped: number;
  entries: Map<string, DebugRequest>;
  busy: boolean;
  resync?: boolean;
  refresh?: () => Promise<void>;
}

/** Keep one selected run, serialize reads, and reuse successfully read pages across refreshes. */
export function useRequests(run: DebugRun | undefined, enabled: boolean) {
  const cache = useRef<RequestCache | undefined>(undefined);
  const [view, setView] = useState({ key: "", requests: [] as DebugRequest[], error: "" });
  const session = run?.session_id ?? "";
  const id = run?.id ?? "";
  const key = `${session}/${id}`;
  const pulse = run?.next_since ?? 0;
  const dropped = run?.dropped_requests ?? 0;

  useEffect(() => {
    if (cache.current?.key !== key)
      cache.current = { key, since: 0, dropped, entries: new Map(), busy: false };
    const state = cache.current;
    if (!id || !enabled) return;
    let cancelled = false;
    const publish = (error = "") => {
      if (!cancelled)
        setView({
          key,
          requests: [...state.entries.values()].sort(
            (a, b) => a.started_at - b.started_at || a.sequence - b.sequence,
          ),
          error,
        });
    };
    const reset = (removed: number) => {
      state.entries.clear();
      state.since = 0;
      state.dropped = removed;
      state.resync = false;
      publish();
    };
    const update = async () => {
      if (cancelled) return;
      // The protocol has no deletion cursor: resync when retention removed requests.
      if (state.resync || dropped > state.dropped) reset(Math.max(dropped, state.dropped));
      for (let page = 0; page < 21; page++) {
        if (cancelled) return;
        const since = state.since;
        const batch = await recordingRequest({
          session_id: session,
          run_id: id,
          action: "requests",
          since,
          limit: 100,
        });
        if (cache.current !== state) return;
        const removed = batch.run?.dropped_requests ?? state.dropped;
        if (removed > state.dropped) {
          reset(removed);
          if (since > 0) continue;
        }
        // A fallback read may omit older stored rows; never advance past them permanently.
        if (batch.run?.coverage.includes("evidence_read_failed")) state.resync = true;
        const entries = batch.requests ?? [];
        for (const entry of entries) state.entries.set(entry.id, entry);
        state.since = Math.max(since, batch.next_since ?? since);
        // Commit progress even when a newer pulse queued another read.
        if (entries.length < 100 || state.since === since) break;
      }
      publish();
    };
    state.refresh = () =>
      update().catch((reason) =>
        publish(reason instanceof Error ? reason.message : String(reason)),
      );
    // Coalesce pulses to one pending refresh even if a browser read stalls.
    if (!state.busy) {
      state.busy = true;
      void (async () => {
        try {
          while (state.refresh) {
            const refresh = state.refresh;
            state.refresh = undefined;
            await refresh();
          }
        } finally {
          state.busy = false;
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [key, session, id, pulse, dropped, enabled]);

  return view.key === key ? view : { requests: [], error: "" };
}
