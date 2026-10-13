import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import v from "../../../../crates/bsk-protocol/tests/fixtures/local-auth-v1.json";
import { openCredentialDatabase } from "./credential-db";
import {
  discardStaged,
  initializeLocalMigration,
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
  expect(state.policy).toMatchObject({ everPaired: true, legacyCompat: false });
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
it("L18: only eligible updates get migration compatibility; pairing never resurrects it", async () => {
  await initializeLocalMigration({ reason: "install" }, "0.4.0");
  expect((await readLocalState()).policy.legacyCompat).toBe(false);
  await initializeLocalMigration({ reason: "update", previousVersion: "0.3.2" }, "0.4.0");
  expect((await readLocalState()).policy.legacyCompat).toBe(true);
  let credential = parseLocalPairing(link);
  await stageCredential(credential);
  credential = await saveCandidate(credential, { txn: v.txn, gen: 1, key: v.candidate });
  await promoteCandidate(credential, { txn: v.txn, gen: 1 });
  await initializeLocalMigration({ reason: "update", previousVersion: "0.3.2" }, "0.4.0");
  expect((await readLocalState()).policy.legacyCompat).toBe(false);
  await setSkipLocalVerification(true);
  expect((await readLocalState()).credentials).toHaveLength(1);
});
it("L18: the exit version clears compatibility and never clears explicit skipping", async () => {
  await initializeLocalMigration({ reason: "update", previousVersion: "0.3.2" }, "0.4.0");
  await setSkipLocalVerification(true);
  expect((await readLocalState()).policy.legacyCompat).toBe(true);
  // Use the bundled version to catch a release accidentally leaving migration enabled.
  await initializeLocalMigration();
  expect((await readLocalState()).policy).toEqual({
    skip: true,
    everPaired: false,
    legacyCompat: false,
  });
  await initializeLocalMigration({ reason: "update", previousVersion: "0.3.2" });
  expect((await readLocalState()).policy.legacyCompat).toBe(false);
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
