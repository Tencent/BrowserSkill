import { REMOTE_ENDPOINT_KEY, type RemoteEndpoint, readRemoteEndpoint } from "./remote-endpoint";

/** Only this non-secret revision is exposed through chrome.storage.local. */
export const REMOTE_CONNECTION_REVISION = "bsk_remote_connection_revision";
export const REMOTE_CONNECTION_MODE = "bsk_connection_mode";
const DATABASE = "bsk-remote-authorization";
const STORE = "connection";
const MIGRATING = "bsk_remote_storage_migrating";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Remote authorization storage is blocked"));
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
  });
}

async function storedEndpoint(write?: { value: RemoteEndpoint | null }): Promise<unknown> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, write ? "readwrite" : "readonly");
      const store = transaction.objectStore(STORE);
      const request = write ? store.put(write.value, "endpoint") : store.get("endpoint");
      transaction.oncomplete = () => resolve(write ? write.value : request.result);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Authorization storage failed"));
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function readRemoteConnection(): Promise<RemoteEndpoint | null> {
  await initializeRemoteStorage();
  const values = await chrome.storage.local.get([
    REMOTE_CONNECTION_MODE,
    REMOTE_CONNECTION_REVISION,
  ]);
  const mode = values[REMOTE_CONNECTION_MODE];
  // Fresh local profiles never open the credential database. A legacy revision
  // without a mode may contain a remote grant and must still fail closed.
  if (mode === "local" || (mode === undefined && values[REMOTE_CONNECTION_REVISION] === undefined))
    return null;
  if (mode !== undefined && mode !== "remote") throw new Error("Invalid connection mode");
  const endpoint = readRemoteEndpoint(await storedEndpoint());
  if (mode === "remote" && !endpoint) throw new Error("Remote authorization is missing");
  return endpoint;
}

export async function writeRemoteConnection(endpoint: RemoteEndpoint | null): Promise<void> {
  const validated = readRemoteEndpoint(endpoint);
  if (validated) {
    // Publish a switch only after its credential is durable. A failed write
    // leaves the previous mode selected, including a healthy local connection.
    await storedEndpoint({ value: validated });
    await chrome.storage.local.set({
      [REMOTE_CONNECTION_MODE]: "remote",
      [REMOTE_CONNECTION_REVISION]: crypto.randomUUID(),
    });
  } else {
    // Explicitly selecting local must work even when IndexedDB is unavailable.
    // Remove any legacy secret before restoring ordinary preference access.
    const legacy = await chrome.storage.local.get([REMOTE_ENDPOINT_KEY, MIGRATING]);
    if (legacy[REMOTE_ENDPOINT_KEY] !== undefined || legacy[MIGRATING]) {
      await chrome.storage.local.remove(REMOTE_ENDPOINT_KEY);
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
      await chrome.storage.local.remove(MIGRATING);
    }
    await chrome.storage.local.set({
      [REMOTE_CONNECTION_MODE]: "local",
      [REMOTE_CONNECTION_REVISION]: crypto.randomUUID(),
    });
    // A stale private record cannot become active while local mode is selected.
    await storedEndpoint({ value: null }).catch(() => {});
  }
}

let initialization: Promise<void> | undefined;
/** Migrate the previous gateway client's credential before restoring ordinary
 * preference access. Extension-origin IndexedDB is not available to page content scripts. */
export function initializeRemoteStorage(): Promise<void> {
  initialization ??= (async () => {
    const values = await chrome.storage.local.get([REMOTE_ENDPOINT_KEY, MIGRATING]);
    if (values[REMOTE_ENDPOINT_KEY] === undefined && !values[MIGRATING]) return;
    await chrome.storage.local.set({ [MIGRATING]: true });
    if (values[REMOTE_ENDPOINT_KEY] !== undefined && (await storedEndpoint()) === undefined) {
      await storedEndpoint({ value: readRemoteEndpoint(values[REMOTE_ENDPOINT_KEY]) });
    }
    await chrome.storage.local.remove(REMOTE_ENDPOINT_KEY);
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
    await chrome.storage.local.set({ [REMOTE_CONNECTION_REVISION]: crypto.randomUUID() });
    await chrome.storage.local.remove(MIGRATING);
  })().catch((error) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}
