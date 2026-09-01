const STORAGE_KEY = "bsk_instance_id";
const LABEL_STORAGE_KEY = "bh_label";
const CONNECTION_ENABLED_KEY = "bh_connection_enabled";
const CONTROL_HINTS_HIDDEN_KEY = "bsk_control_hints_hidden";
const DAEMON_WS_URL_STORAGE_KEY = "BSK_DAEMON_WS_URL";

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

export function isDaemonWsUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return false;
    if (!parsed.host) return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

export function normalizeDaemonWsUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return isDaemonWsUrl(trimmed) ? trimmed : fallback;
}

export async function getDaemonWsUrl(
  storage: StorageBackend = defaultStorage(),
  fallback: string = __BSK_DAEMON_WS_URL__,
): Promise<string> {
  const items = await storage.get(DAEMON_WS_URL_STORAGE_KEY);
  return normalizeDaemonWsUrl(items[DAEMON_WS_URL_STORAGE_KEY], fallback);
}

export async function setDaemonWsUrl(
  url: string,
  storage: StorageBackend = defaultStorage(),
): Promise<string> {
  const trimmed = url.trim();
  if (!isDaemonWsUrl(trimmed)) {
    throw new Error("daemon WebSocket URL must start with ws:// or wss:// and include a host");
  }
  await storage.set({ [DAEMON_WS_URL_STORAGE_KEY]: trimmed });
  return trimmed;
}

/**
 * User preference for the in-page control hints (status pill + orange glow
 * shown while the Agent controls a tab). Defaults to shown when unset or
 * non-boolean; when hidden the whole control overlay — including its input
 * blocker — is skipped so the page looks and behaves normally.
 */
export async function getControlHintsHidden(
  storage: StorageBackend = defaultStorage(),
): Promise<boolean> {
  const items = await storage.get(CONTROL_HINTS_HIDDEN_KEY);
  const raw = items[CONTROL_HINTS_HIDDEN_KEY];
  return typeof raw === "boolean" ? raw : false;
}

export async function setControlHintsHidden(
  hidden: boolean,
  storage: StorageBackend = defaultStorage(),
): Promise<void> {
  await storage.set({ [CONTROL_HINTS_HIDDEN_KEY]: hidden });
}

export const STORAGE_KEYS = {
  INSTANCE_ID: STORAGE_KEY,
  LABEL: LABEL_STORAGE_KEY,
  CONNECTION_ENABLED: CONNECTION_ENABLED_KEY,
  CONTROL_HINTS_HIDDEN: CONTROL_HINTS_HIDDEN_KEY,
  DAEMON_WS_URL: DAEMON_WS_URL_STORAGE_KEY,
} as const;
