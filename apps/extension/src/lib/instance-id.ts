const STORAGE_KEY = "bsk_instance_id";
const LABEL_STORAGE_KEY = "bh_label";
const CONNECTION_ENABLED_KEY = "bh_connection_enabled";
const CONTROL_OVERLAY_VISIBLE_KEY = "bh_control_overlay_visible";

export interface StorageBackend {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function defaultStorage(): StorageBackend {
  return {
    get: (keys) =>
      new Promise((resolve, reject) => {
        try {
          chrome.storage.local.get(keys, (items) => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else resolve(items as Record<string, unknown>);
          });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }),
    set: (items) =>
      new Promise((resolve, reject) => {
        try {
          chrome.storage.local.set(items, () => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else resolve();
          });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }),
  };
}

/** Length of newly generated browser instance ids (8 hex chars → 32 bits). */
export const INSTANCE_ID_LENGTH = 8;

/** Matches ids produced by {@link generateShortInstanceId}. */
export const SHORT_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}$/;

function generateShortInstanceId(): string {
  const buf = new Uint8Array(INSTANCE_ID_LENGTH / 2);
  if (typeof crypto !== "undefined") {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i += 1) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isPersistedInstanceId(value: unknown): value is string {
  return typeof value === "string" && SHORT_INSTANCE_ID_PATTERN.test(value);
}

/**
 * Read the persistent extension instance_id from `chrome.storage.local`,
 * generating + persisting a fresh 8-char hex id on first use.
 *
 * The id is opaque to the daemon — it just needs to be stable across SW
 * restarts so the daemon can correlate reconnects to the same browser.
 * Legacy UUID values in storage are replaced on read so agents can use
 * short `--browser` arguments.
 */
export async function getOrCreateInstanceId(
  storage: StorageBackend = defaultStorage(),
): Promise<string> {
  const items = await storage.get(STORAGE_KEY);
  const existing = items[STORAGE_KEY];
  if (isPersistedInstanceId(existing)) return existing;
  const fresh = generateShortInstanceId();
  await storage.set({ [STORAGE_KEY]: fresh });
  return fresh;
}

export async function getLabel(storage: StorageBackend = defaultStorage()): Promise<string> {
  const items = await storage.get(LABEL_STORAGE_KEY);
  const raw = items[LABEL_STORAGE_KEY];
  return typeof raw === "string" ? raw : "";
}

export async function setLabel(
  label: string,
  storage: StorageBackend = defaultStorage(),
): Promise<void> {
  await storage.set({ [LABEL_STORAGE_KEY]: label });
}

/** Defaults to enabled when unset or non-boolean. */
export async function getConnectionEnabled(
  storage: StorageBackend = defaultStorage(),
): Promise<boolean> {
  const items = await storage.get(CONNECTION_ENABLED_KEY);
  const raw = items[CONNECTION_ENABLED_KEY];
  return typeof raw === "boolean" ? raw : true;
}

export async function setConnectionEnabled(
  enabled: boolean,
  storage: StorageBackend = defaultStorage(),
): Promise<void> {
  await storage.set({ [CONNECTION_ENABLED_KEY]: enabled });
}

/** Defaults to visible when unset or non-boolean. */
export async function getControlOverlayVisible(
  storage: StorageBackend = defaultStorage(),
): Promise<boolean> {
  const items = await storage.get(CONTROL_OVERLAY_VISIBLE_KEY);
  const raw = items[CONTROL_OVERLAY_VISIBLE_KEY];
  return typeof raw === "boolean" ? raw : true;
}

export async function setControlOverlayVisible(
  visible: boolean,
  storage: StorageBackend = defaultStorage(),
): Promise<void> {
  await storage.set({ [CONTROL_OVERLAY_VISIBLE_KEY]: visible });
}

export const STORAGE_KEYS = {
  INSTANCE_ID: STORAGE_KEY,
  LABEL: LABEL_STORAGE_KEY,
  CONNECTION_ENABLED: CONNECTION_ENABLED_KEY,
  CONTROL_OVERLAY_VISIBLE: CONTROL_OVERLAY_VISIBLE_KEY,
} as const;
