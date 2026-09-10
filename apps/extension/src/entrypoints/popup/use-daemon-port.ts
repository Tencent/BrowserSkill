import { useCallback, useEffect, useRef, useState } from "react";
import { watchDaemonPort } from "@/lib/daemon-port-preference";
import { setDaemonPort } from "@/lib/instance-id";
import { parseDaemonPortInput } from "@/transport/daemon-endpoint";

type PortState = {
  savedPort: number | null;
  // null means no local edit: show the latest persisted value.
  draft: string | null;
  saving: boolean;
  invalid: boolean;
  error: "read" | "write" | null;
};

/** Explicitly save a draft; opening or closing the popup never writes a preference. */
export function useDaemonPort() {
  const [state, setState] = useState<PortState>({
    savedPort: null,
    draft: null,
    saving: false,
    invalid: false,
    error: null,
  });
  const savingRef = useRef(false);
  const mounted = useRef(false);
  const storageRevision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      setState((s) => ({ ...s, error: "read" }));
      return () => {
        mounted.current = false;
      };
    }
    const preference = watchDaemonPort((port) => {
      storageRevision.current += 1;
      setState((s) => ({
        ...s,
        savedPort: port,
        draft:
          !s.saving && (s.draft === String(s.savedPort) || s.draft === String(port))
            ? null
            : s.draft,
        error: s.error === "read" ? null : s.error,
      }));
    });
    void preference.ready.catch(() => {
      if (mounted.current) setState((s) => ({ ...s, error: "read" }));
    });
    return () => {
      mounted.current = false;
      preference.dispose();
    };
  }, []);

  const draft = state.draft ?? String(state.savedPort ?? "");
  const dirty = state.savedPort !== null && draft !== String(state.savedPort);
  const commit = useCallback(async () => {
    if (state.savedPort === null || savingRef.current) return;
    const parsed = parseDaemonPortInput(draft);
    if (parsed === null) {
      setState((s) => ({ ...s, invalid: true }));
      return;
    }
    if (parsed === state.savedPort) {
      setState((s) => ({ ...s, draft: null, invalid: false, error: null }));
      return;
    }
    savingRef.current = true;
    const revision = storageRevision.current;
    setState((s) => ({ ...s, saving: true, invalid: false, error: null }));
    try {
      await setDaemonPort(parsed);
      if (mounted.current) {
        setState((s) => ({
          ...s,
          // A storage event is newer than the snapshot at submission time.
          savedPort: storageRevision.current === revision ? parsed : s.savedPort,
          draft: null,
          saving: false,
        }));
      }
    } catch {
      if (mounted.current) setState((s) => ({ ...s, saving: false, error: "write" }));
    } finally {
      savingRef.current = false;
    }
  }, [draft, state.savedPort]);

  const setDraft = useCallback((value: string) => {
    if (savingRef.current) return;
    setState((s) =>
      s.savedPort === null
        ? s
        : {
            ...s,
            draft: value === String(s.savedPort) ? null : value,
            invalid: false,
            error: null,
          },
    );
  }, []);

  return {
    draft,
    setDraft,
    commit,
    dirty,
    loaded: state.savedPort !== null,
    saving: state.saving,
    invalid: state.invalid,
    error: state.error,
  };
}
