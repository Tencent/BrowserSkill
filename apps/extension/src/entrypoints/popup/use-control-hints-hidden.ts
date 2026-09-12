import { useEffect, useState } from "react";
import { getControlHintsHidden, STORAGE_KEYS, setControlHintsHidden } from "@/lib/instance-id";

/**
 * Popup-side view of the "hide control hints" preference in
 * `chrome.storage.local`. Defaults to shown when storage is unavailable
 * (e.g. unit tests) so the popup still renders; writes go straight to
 * storage and content scripts pick them up via `storage.onChanged`.
 */
export function useControlHintsHidden(): [boolean, (hidden: boolean) => void] {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return undefined;
    let cancelled = false;
    getControlHintsHidden()
      .then((value) => {
        if (!cancelled) setHidden(value);
      })
      .catch((err) => {
        console.debug("[browser-skill] control-hints preference read failed", err);
      });
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local") return;
      const change = changes[STORAGE_KEYS.CONTROL_HINTS_HIDDEN];
      if (change) setHidden(change.newValue === true);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  const update = (value: boolean) => {
    setHidden(value);
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    setControlHintsHidden(value).catch((err) => {
      console.debug("[browser-skill] control-hints preference write failed", err);
    });
  };

  return [hidden, update];
}
