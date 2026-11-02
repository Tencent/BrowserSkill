import { parseRemoteEndpoint, type RemoteEndpoint, readRemoteEndpoint } from "./remote-endpoint";
import {
  initializeRemoteStorage,
  REMOTE_CONNECTION_MODE,
  REMOTE_CONNECTION_REVISION,
  readRemoteConnection,
  writeRemoteConnection,
} from "./remote-storage";

class AuthorizationRejected extends Error {}
const RENEWAL_RETRY_MS = 60_000;
const AUTHORIZATION_ALARM = "bsk-remote-authorization";

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function authorize(
  endpoint: RemoteEndpoint,
  action: "pair" | "renew",
  nextToken: string,
): Promise<RemoteEndpoint> {
  const url = new URL(endpoint.url);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.replace(/\/$/, "") + "/authorize";
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, next_token: nextToken, label: "Chrome · BrowserSkill" }),
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401 || response.status === 403)
    throw new AuthorizationRejected("The server rejected browser authorization");
  if (!response.ok) throw new Error("Browser authorization is temporarily unavailable");
  const data = (await response.json()) as {
    device_id: string;
    expires_at: string;
    renew_after: string;
  };
  if (
    typeof data.device_id !== "string" ||
    !data.device_id ||
    !Number.isFinite(Date.parse(data.expires_at)) ||
    !Number.isFinite(Date.parse(data.renew_after))
  ) {
    throw new Error("Invalid browser authorization response");
  }
  const updated = readRemoteEndpoint({
    url: endpoint.url,
    token: nextToken,
    deviceId: data.device_id,
    expiresAt: data.expires_at,
    renewAfter: data.renew_after,
  });
  if (!updated || (action === "renew" && updated.deviceId !== endpoint.deviceId)) {
    throw new Error("Authorization device changed");
  }
  return updated;
}

export async function activateRemoteEndpoint(endpoint: RemoteEndpoint): Promise<RemoteEndpoint> {
  return authorize(endpoint, "pair", newToken());
}

let writes: Promise<unknown> = Promise.resolve();
function serialized<T>(action: () => Promise<T>): Promise<T> {
  const result = writes.then(action, action);
  writes = result.catch(() => undefined);
  return result;
}
export function updateRemoteConnection(pairing: string | null): Promise<string | null> {
  return serialized(async () => {
    if (pairing !== null) await initializeRemoteStorage();
    const endpoint =
      pairing === null ? null : await activateRemoteEndpoint(parseRemoteEndpoint(pairing));
    await writeRemoteConnection(endpoint);
    return endpoint?.url ?? null;
  });
}
let renewing = false;
/** Persist the candidate before rotating. A lost HTTP response can be retried
 * using the same old/new pair after service-worker or server restart. */
export async function renewRemoteAuthorization(): Promise<void> {
  if (renewing) return;
  renewing = true;
  try {
    await serialized(renewRemote);
  } finally {
    renewing = false;
  }
}
async function renewRemote(): Promise<void> {
  const endpoint = await readRemoteConnection();
  if (
    !endpoint?.deviceId ||
    !endpoint.renewAfter ||
    (!endpoint.pendingToken && Date.now() < Date.parse(endpoint.renewAfter))
  )
    return;
  // A pending rotation may already have succeeded remotely. Retry that exact
  // candidate even after the old local expiry, but never start a new expired grant.
  if (!endpoint.pendingToken && endpoint.expiresAt && Date.now() >= Date.parse(endpoint.expiresAt))
    return;
  if (
    endpoint.renewalAttemptAt &&
    Date.now() < Date.parse(endpoint.renewalAttemptAt) + RENEWAL_RETRY_MS
  )
    return;
  const nextToken = endpoint.pendingToken ?? newToken();
  const pending = {
    ...endpoint,
    pendingToken: nextToken,
    renewalAttemptAt: new Date(Date.now()).toISOString(),
  };
  await writeRemoteConnection(pending);
  let updated: RemoteEndpoint;
  try {
    updated = await authorize(endpoint, "renew", nextToken);
  } catch (error) {
    await writeRemoteConnection({
      ...pending,
      renewalFailure: error instanceof AuthorizationRejected ? "rejected" : "unavailable",
    });
    throw error;
  }
  const latest = await readRemoteConnection();
  // A settings change during the request must not resurrect an old connection.
  if (
    latest?.url === endpoint.url &&
    latest.token === endpoint.token &&
    latest.deviceId === endpoint.deviceId &&
    latest.pendingToken === nextToken
  ) {
    await writeRemoteConnection(updated);
  }
}

export function watchRemoteAuthorization() {
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.kind !== "bsk-remote-authorization") return false;
    if (
      sender.url !== chrome.runtime.getURL("popup.html") ||
      sender.id !== chrome.runtime.id ||
      (message.pairing !== null && typeof message.pairing !== "string")
    ) {
      reply({ error: "Invalid authorization request" });
      return false;
    }
    void updateRemoteConnection(message.pairing).then(
      (url) => reply({ url }),
      () => reply({ error: "Unable to pair; copy a new pairing link and try again" }),
    );
    return true;
  });
  let disposed = false;
  let running: Promise<void> | undefined;
  let dirty = false;
  const run = () => {
    dirty = true;
    if (running || disposed) return;
    running = (async () => {
      while (dirty && !disposed) {
        dirty = false;
        try {
          const endpoint = await readRemoteConnection();
          if (disposed) return;
          if (!endpoint) {
            await chrome.alarms.clear(AUTHORIZATION_ALARM);
          } else {
            if (!(await chrome.alarms.get(AUTHORIZATION_ALARM)))
              await chrome.alarms.create(AUTHORIZATION_ALARM, { periodInMinutes: 1 });
            await renewRemoteAuthorization();
          }
        } catch {
          // Renewal failures are persisted without secrets for the popup.
          // Storage failures stay fail-closed and are reported by its reader.
        }
      }
    })().finally(() => {
      running = undefined;
      if (dirty && !disposed) run();
    });
  };
  const listener = (alarm: chrome.alarms.Alarm) => {
    if (alarm.name === AUTHORIZATION_ALARM) run();
  };
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (
      area === "local" &&
      (changes[REMOTE_CONNECTION_REVISION] || changes[REMOTE_CONNECTION_MODE])
    )
      run();
  };
  chrome.alarms.onAlarm.addListener(listener);
  chrome.storage.onChanged.addListener(changed);
  run();
  return {
    dispose: () => {
      disposed = true;
      chrome.alarms.onAlarm.removeListener(listener);
      chrome.storage.onChanged.removeListener(changed);
    },
  };
}
