import { useCallback, useEffect, useRef, useState } from "react";
import { getDaemonPort, STORAGE_KEYS, setDaemonPort } from "@/lib/instance-id";
import { parseDaemonPortInput } from "@/transport/daemon-endpoint";

/**
 * Popup-side daemon port preference stored in `chrome.storage.local`.
 * Commits on blur, Enter (via blur), and pagehide.
 */
export function useDaemonPort(): {
  draft: string;
  setDraft: (value: string) => void;
  commit: () => void;
  invalid: boolean;
} {
  const [draft, setDraftState] = useState("");
  const [invalid, setInvalid] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return undefined;
    let cancelled = false;
    getDaemonPort()
      .then((port) => {
        if (!cancelled) setDraftState(String(port));
      })
      .catch((err) => {
        console.debug("[browser-skill] daemon port read failed", err);
      });
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local") return;
      const change = changes[STORAGE_KEYS.DAEMON_PORT];
      if (change && typeof change.newValue === "number") {
        setDraftState(String(change.newValue));
        setInvalid(false);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  const commit = useCallback(() => {
    const parsed = parseDaemonPortInput(draftRef.current);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraftState(String(parsed));
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    setDaemonPort(parsed).catch((err) => {
      console.debug("[browser-skill] daemon port write failed", err);
    });
  }, []);

  useEffect(() => {
    const onPageHide = () => commit();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [commit]);

  const setDraft = useCallback((value: string) => {
    setDraftState(value);
    setInvalid(false);
  }, []);

  return { draft, setDraft, commit, invalid };
}
