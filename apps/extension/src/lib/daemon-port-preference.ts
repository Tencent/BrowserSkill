import { normalizeDaemonPort } from "@/transport/daemon-endpoint";
import { getDaemonPort, STORAGE_KEYS } from "./instance-id";

/** Observe before reading so a late initial read cannot replace a newer change. */
export function watchDaemonPort(onPort: (port: number) => void): {
  ready: Promise<void>;
  dispose: () => void;
} {
  let disposed = false;
  let changed = false;
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (disposed || areaName !== "local" || !changes[STORAGE_KEYS.DAEMON_PORT]) return;
    changed = true;
    onPort(normalizeDaemonPort(changes[STORAGE_KEYS.DAEMON_PORT].newValue));
  };
  chrome.storage.onChanged.addListener(onChanged);
  const ready = getDaemonPort().then(
    (port) => {
      if (!disposed && !changed) onPort(port);
    },
    (err) => {
      if (!disposed && !changed) throw err;
    },
  );
  return {
    ready,
    dispose: () => {
      disposed = true;
      chrome.storage.onChanged.removeListener(onChanged);
    },
  };
}
