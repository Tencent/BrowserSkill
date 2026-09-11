import { normalizeDaemonPort, resolveDaemonWsUrl } from "@/transport/daemon-endpoint";
import {
  REMOTE_ENDPOINT_KEY,
  type RemoteEndpoint,
  readRemoteEndpoint,
} from "@/transport/remote-endpoint";
import { STORAGE_KEYS } from "./instance-id";

/** Keep the port and remote credential in one snapshot. Invalid remote state never falls back locally. */
export function watchDaemonConnection(
  onChange: (url: string, remote: RemoteEndpoint | null) => void,
) {
  let disposed = false;
  let revision = 0;
  const read = async () => {
    const current = ++revision;
    const values = await chrome.storage.local.get([STORAGE_KEYS.DAEMON_PORT, REMOTE_ENDPOINT_KEY]);
    if (disposed || revision !== current) return;
    const remote = readRemoteEndpoint(values[REMOTE_ENDPOINT_KEY]);
    onChange(
      remote?.url ?? resolveDaemonWsUrl(normalizeDaemonPort(values[STORAGE_KEYS.DAEMON_PORT])),
      remote,
    );
  };
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && (changes[STORAGE_KEYS.DAEMON_PORT] || changes[REMOTE_ENDPOINT_KEY])) {
      // Invalid writes are not supported; do not redirect the active connection to localhost.
      void read().catch(() => console.error("[connection] invalid connection preference"));
    }
  };
  chrome.storage.onChanged.addListener(changed);
  return {
    ready: read(),
    dispose: () => {
      disposed = true;
      chrome.storage.onChanged.removeListener(changed);
    },
  };
}
