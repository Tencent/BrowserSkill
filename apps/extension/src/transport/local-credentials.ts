import { openCredentialDatabase } from "./credential-db";
import { decodeBytes } from "./local-auth-crypto";
import type { Rotation } from "./local-auth-protocol";

export const PAIRING_VERSION = "0.4.0";
export const LEGACY_COMPAT_EXIT_VERSION = "0.4.1";
const STAGED_TTL_MS = 10 * 60_000;
export interface LocalCredential {
  daemonId: string;
  deviceId: string;
  key: string;
  gen: number;
  role: "active" | "staged";
  endpoint: string;
  createdAt: number;
  pending?: Rotation & { key: string };
}
export interface LocalPolicy {
  skip: boolean;
  everPaired: boolean;
  legacyCompat: boolean;
}
export interface LocalState {
  credentials: LocalCredential[];
  policy: LocalPolicy;
}
const defaultPolicy = (): LocalPolicy => ({ skip: false, everPaired: false, legacyCompat: false });

/** No asynchronous work inside an IDB transaction. Resolve only on complete,
 * including strict persistence of candidates, promotion, and migration state. */
async function access<T>(write: boolean, action: (state: LocalState) => T): Promise<T> {
  const database = await openCredentialDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(
        ["local", "migration"],
        write ? "readwrite" : "readonly",
        write ? { durability: "strict" } : undefined,
      );
      const local = tx.objectStore("local");
      const migration = tx.objectStore("migration");
      const records = local.get("credentials");
      const policy = migration.get("policy");
      let remaining = 2;
      let result: T;
      let failure: unknown;
      const loaded = () => {
        if (--remaining) return;
        try {
          const state: LocalState = {
            credentials: records.result ?? [],
            policy: policy.result ?? defaultPolicy(),
          };
          // Expired staged records never displace the still-valid active entry.
          state.credentials = state.credentials.filter(
            (c) => c.role === "active" || c.createdAt + STAGED_TTL_MS > Date.now(),
          );
          result = action(state);
          if (write) {
            local.put(state.credentials, "credentials");
            migration.put(state.policy, "policy");
          }
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      records.onsuccess = loaded;
      policy.onsuccess = loaded;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? new Error("Credential transaction failed"));
      tx.onerror = () => {
        /* onabort settles the transaction */
      };
    });
  } finally {
    database.close();
  }
}

export function parseLocalPairing(input: string): LocalCredential {
  try {
    const raw = input.trim();
    const authority = /^ws:\/\/127\.0\.0\.1:(\d{1,5})\/#/.exec(raw);
    if (!authority || Number(authority[1]) < 1 || Number(authority[1]) > 65535) throw new Error();
    const url = new URL(raw);
    if (
      url.protocol !== "ws:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.search ||
      url.pathname !== "/"
    )
      throw new Error();
    const parts = url.hash.slice(1).split(".");
    if (parts.length !== 5 || parts[0] !== "bsk-local" || parts[1] !== "v1") throw new Error();
    const [, , daemonId, deviceId, key] = parts;
    decodeBytes(daemonId, 16);
    decodeBytes(deviceId, 16);
    decodeBytes(key, 32);
    url.hash = "";
    return {
      daemonId,
      deviceId,
      key,
      gen: 0,
      role: "staged",
      endpoint: `ws://127.0.0.1:${Number(authority[1])}/`,
      createdAt: Date.now(),
    };
  } catch {
    throw new Error("Invalid local pairing link");
  }
}
export const readLocalState = (): Promise<LocalState> => access(false, (state) => state);
export function stageCredential(credential: LocalCredential): Promise<LocalCredential> {
  return access(true, (state) => {
    const same = state.credentials.filter((c) => c.daemonId === credential.daemonId);
    const existing = same.find((c) => c.deviceId === credential.deviceId);
    if (existing?.role === "active") throw new Error("Pairing link already stored");
    if (existing) return existing;
    if (same.some((c) => c.role === "staged" && c.pending))
      throw new Error("Previous pairing needs recovery");
    if (!same.length && new Set(state.credentials.map((c) => c.daemonId)).size >= 8)
      throw new Error("Local pairing limit reached");
    state.credentials = state.credentials.filter(
      (c) => c.daemonId !== credential.daemonId || c.role !== "staged",
    );
    state.credentials.push(credential);
    return credential;
  });
}
function current(state: LocalState, expected: LocalCredential): LocalCredential {
  const record = state.credentials.find(
    (c) =>
      c.daemonId === expected.daemonId &&
      c.deviceId === expected.deviceId &&
      c.role === expected.role,
  );
  if (!record || record.gen !== expected.gen || record.pending?.txn !== expected.pending?.txn)
    throw new Error("Local credential changed");
  return record;
}
export function saveCandidate(
  expected: LocalCredential,
  pending: Rotation & { key: string },
): Promise<LocalCredential> {
  return access(true, (state) => {
    const record = current(state, expected);
    if (pending.gen !== record.gen + 1) throw new Error("Invalid key generation");
    record.pending = pending;
    return record;
  });
}
export function promoteCandidate(
  expected: LocalCredential,
  rotation: Rotation,
): Promise<LocalCredential> {
  return access(true, (state) => {
    const record = current(state, expected);
    if (
      !record.pending ||
      record.pending.txn !== rotation.txn ||
      record.pending.gen !== rotation.gen
    )
      throw new Error("Local candidate changed");
    record.gen = record.pending.gen;
    record.key = record.pending.key;
    delete record.pending;
    record.role = "active";
    state.credentials = state.credentials.filter(
      (c) => c.daemonId !== record.daemonId || c === record,
    );
    state.policy.everPaired = true;
    state.policy.legacyCompat = false;
    return record;
  });
}
export function discardStaged(expected: LocalCredential): Promise<void> {
  return access(true, (state) => {
    state.credentials = state.credentials.filter(
      (c) =>
        !(
          c.daemonId === expected.daemonId &&
          c.deviceId === expected.deviceId &&
          c.role === "staged"
        ),
    );
  });
}
export function setSkipLocalVerification(skip: boolean): Promise<void> {
  return access(true, (state) => {
    state.policy.skip = skip;
  });
}
function before(version: string, bound: string): boolean {
  const a = version.split(".").map(Number);
  const b = bound.split(".").map(Number);
  if (a.length !== 3 || a.some((part) => !Number.isSafeInteger(part) || part < 0)) return false;
  return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
}
export function initializeLocalMigration(
  details?: { reason: string; previousVersion?: string },
  version = __BSK_EXT_VERSION__,
): Promise<void> {
  return access(true, ({ policy }) => {
    if (!before(version, LEGACY_COMPAT_EXIT_VERSION) || policy.everPaired)
      policy.legacyCompat = false;
    else if (details?.reason === "install") policy.legacyCompat = false;
    else if (
      details?.reason === "update" &&
      details.previousVersion &&
      before(details.previousVersion, PAIRING_VERSION)
    )
      policy.legacyCompat = true;
  });
}
