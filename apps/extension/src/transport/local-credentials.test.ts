import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import v from "../../../../crates/bsk-protocol/tests/fixtures/local-auth-v1.json";
import { openCredentialDatabase } from "./credential-db";
import {
  discardStaged,
  parseLocalPairing,
  promoteCandidate,
  readLocalState,
  saveCandidate,
  setSkipLocalVerification,
  stageCredential,
} from "./local-credentials";

export const link = `ws://127.0.0.1:52800/#bsk-local.v1.${v.daemon_id}.${v.device_id}.${v.key}`;
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("L16: rejects remote credentials and non-loopback local endpoints without exposing secrets", () => {
  expect(parseLocalPairing(link).endpoint).toBe("ws://127.0.0.1:52800/");
  for (const bad of [
    link.replace("127.0.0.1", "example.com"),
    link.replace("ws:", "wss:"),
    link.replace("/#", "/extension#"),
    link.replace("/#", "/?key=1#"),
    link.replace("127.0.0.1", "user@127.0.0.1"),
    link.replace("#bsk-local.v1.", "#"),
    `${link}=`,
    link.replace(".v1.", ".v2."),
  ])
    expect(() => parseLocalPairing(bad)).toThrow("Invalid local pairing link");
});
it("L08c: key writes use strict durability, compare candidates, and promote atomically", async () => {
  const transactions = vi.spyOn(IDBDatabase.prototype, "transaction");
  const credential = parseLocalPairing(link);
  await stageCredential(credential);
  const candidate = { txn: v.txn, gen: 1, key: v.candidate };
  const saved = await saveCandidate(credential, candidate);
  await expect(saveCandidate(credential, candidate)).rejects.toThrow("changed");
  expect((await readLocalState()).credentials[0].gen).toBe(0);
  await promoteCandidate(saved, candidate);
  const state = await readLocalState();
  expect(state.credentials[0]).toMatchObject({ role: "active", gen: 1, key: v.candidate });
  expect(state.credentials[0].pending).toBeUndefined();
  const writes = transactions.mock.calls.filter((call) => call[1] === "readwrite");
  expect(writes.length).toBeGreaterThan(2);
  for (const call of writes) expect(call[2]).toEqual({ durability: "strict" });
});
it("L14c/L21: staged writes and expiry preserve active credentials", async () => {
  let active = parseLocalPairing(link);
  await stageCredential(active);
  active = await saveCandidate(active, { txn: v.txn, gen: 1, key: v.candidate });
  await promoteCandidate(active, { txn: v.txn, gen: 1 });
  const staged = {
    ...parseLocalPairing(link),
    deviceId: v.txn,
    createdAt: Date.now() - 11 * 60_000,
  };
  await stageCredential(staged);
  expect((await readLocalState()).credentials).toHaveLength(1);
  await discardStaged(staged);
  expect((await readLocalState()).credentials[0].key).toBe(v.candidate);
});
it("L08c/L14c: startup retains an expired replacement candidate until recovery commits", async () => {
  let active = await stageCredential(parseLocalPairing(link));
  active = await saveCandidate(active, { txn: v.txn, gen: 1, key: v.candidate });
  active = await promoteCandidate(active, { txn: v.txn, gen: 1 });
  const replacement = await stageCredential({ ...parseLocalPairing(link), deviceId: v.txn });
  const pending = { txn: v.device_id, gen: 1, key: v.key };
  const saved = await saveCandidate(replacement, pending);
  vi.spyOn(Date, "now").mockReturnValue(saved.createdAt + 24 * 60 * 60_000);

  expect((await readLocalState()).credentials).toEqual([active, saved]);
  await setSkipLocalVerification(true);
  expect((await readLocalState()).credentials).toEqual([active, saved]);
  await expect(
    stageCredential({ ...parseLocalPairing(link), deviceId: v.daemon_id }),
  ).rejects.toThrow("Previous pairing needs recovery");

  await promoteCandidate(saved, pending);
  const recovered = (await readLocalState()).credentials;
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({
    deviceId: replacement.deviceId,
    role: "active",
    gen: 1,
    key: pending.key,
  });
  expect(recovered[0].pending).toBeUndefined();
});
it("ignores obsolete migration fields while retaining the explicit skip preference", async () => {
  const db = await openCredentialDatabase();
  const tx = db.transaction("migration", "readwrite");
  tx.objectStore("migration").put({ skip: true, everPaired: true, legacyCompat: true }, "policy");
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
  });
  db.close();
  expect((await readLocalState()).policy).toEqual({ skip: true });
  await setSkipLocalVerification(false);
  expect((await readLocalState()).policy).toEqual({ skip: false });
});
it("upgrades the shared database while keeping the existing remote grant", async () => {
  await new Promise<void>((resolve) => {
    const old = indexedDB.open("bsk-remote-authorization", 1);
    old.onupgradeneeded = () =>
      old.result.createObjectStore("connection").put({ token: "private" }, "endpoint");
    old.onsuccess = () => {
      old.result.close();
      resolve();
    };
  });
  const db = await openCredentialDatabase();
  expect([...db.objectStoreNames]).toEqual(["connection", "local", "migration"]);
  const request = db.transaction("connection").objectStore("connection").get("endpoint");
  await new Promise<void>((resolve) => {
    request.onsuccess = () => resolve();
  });
  expect(request.result).toEqual({ token: "private" });
  db.close();
});

it("L21: eight daemon limit never evicts an existing active pairing", async () => {
  const { encodeBytes } = await import("./local-auth-crypto");
  const record = parseLocalPairing(link);
  for (let index = 0; index < 8; index++)
    await stageCredential({ ...record, daemonId: encodeBytes(new Uint8Array(16).fill(index)) });
  await expect(
    stageCredential({ ...record, daemonId: encodeBytes(new Uint8Array(16).fill(8)) }),
  ).rejects.toThrow("limit");
  expect((await readLocalState()).credentials).toHaveLength(8);
});
