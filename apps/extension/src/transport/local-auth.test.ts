import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import v from "../../../../crates/bsk-protocol/tests/fixtures/local-auth-v1.json";
import { authenticateLocal, createLocalAuthenticator, LegacyReconnect } from "./local-auth";
import { prove, transcript } from "./local-auth-crypto";
import type { LocalCredential } from "./local-credentials";
import * as credentials from "./local-credentials";
import { verifyLocalPairing } from "./pairing-verifier";

const link = `ws://127.0.0.1:52800/#bsk-local.v1.${v.daemon_id}.${v.device_id}.${v.key}`;
const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const instanceId = "a1b2c3d4";
class Socket extends EventTarget {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  handler: (frame: any) => void | Promise<void> = () => {};
  send(raw: string) {
    const value = JSON.parse(raw);
    this.sent.push(value);
    void Promise.resolve(this.handler(value)).catch(() => this.close());
  }
  receive(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  ws() {
    return this as unknown as WebSocket;
  }
}
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function auth(socket: Socket, records: LocalCredential[]) {
  return authenticateLocal(socket.ws(), new AbortController().signal, records, instanceId, origin);
}
function server(
  socket: Socket,
  record: LocalCredential,
  mode: "rotate" | "recover" | "normal" | "reject" | "bad" = "rotate",
) {
  let t: Uint8Array;
  let candidate: string;
  socket.handler = async (message) => {
    if (message.method === "system.ping") {
      const gen = mode === "recover" ? record.pending!.gen : record.gen;
      const key = mode === "recover" ? record.pending!.key : record.key;
      t = transcript({
        daemon_id: record.daemonId,
        device_id: record.deviceId,
        gen,
        client_nonce: message.params.local_auth.client_nonce,
        instance_id: instanceId,
        origin,
        server_nonce: v.server_nonce,
      });
      candidate = mode === "recover" ? record.pending!.key : await prove(key, "rotate", t, v.txn);
      socket.receive({
        id: message.id,
        result: {
          local_auth: {
            type: "challenge",
            daemon_id: record.daemonId,
            device_id: record.deviceId,
            gen,
            server_nonce: v.server_nonce,
            server_proof: mode === "bad" ? v.client : await prove(key, "server", t),
          },
        },
      });
    } else if (message.type === "local.auth.prove") {
      if (mode === "reject")
        socket.receive({
          type: "local.auth.rejected",
          v: 1,
          reason: "already_paired",
          browser_id: instanceId,
        });
      else
        socket.receive({
          type: "local.auth.ready",
          v: 1,
          commit:
            mode === "recover"
              ? {
                  txn: v.txn,
                  gen: record.pending!.gen,
                  proof: await prove(candidate, "committed", t, v.txn),
                }
              : null,
          rotation: mode === "rotate" ? { txn: v.txn, gen: record.gen + 1 } : null,
        });
    } else if (message.type === "local.auth.rotate_confirm") {
      socket.receive({
        type: "local.auth.committed",
        v: 1,
        gen: record.gen + 1,
        proof: await prove(candidate, "committed", t, v.txn),
      });
    }
  };
}
it("L03: never proves or sends a business handshake to an unverified server", async () => {
  const record = credentials.parseLocalPairing(link);
  const socket = new Socket();
  server(socket, record, "bad");
  await expect(auth(socket, [record])).rejects.toThrow("server_unverified");
  expect(socket.sent).toHaveLength(1);
});
it.each([
  "old",
  "hint",
  "unknown",
  "close",
])("L04: fresh profiles cannot downgrade on %s", async (kind) => {
  const socket = new Socket();
  socket.handler = (request) => {
    if (kind === "close") {
      socket.close();
      return;
    }
    socket.receive(
      kind === "old"
        ? { id: request.id, error: { message: "first frame must be system.handshake" } }
        : {
            id: request.id,
            result: {
              local_auth: {
                type: "pairing_required",
                daemon_id: kind === "unknown" ? v.txn : v.daemon_id,
                legacy_accepted: true,
              },
            },
          },
    );
  };
  const authenticate = createLocalAuthenticator({
    instanceId: async () => instanceId,
    origin,
    status: vi.fn(),
  });
  await expect(authenticate(socket.ws(), new AbortController().signal)).rejects.not.toBeInstanceOf(
    LegacyReconnect,
  );
  expect(socket.sent).toHaveLength(1);
});
it("L17/L18: only persisted migration can request one legacy reconnect; skip sends no hello", async () => {
  await credentials.initializeLocalMigration(
    { reason: "update", previousVersion: "0.3.2" },
    "0.4.0",
  );
  const authenticate = createLocalAuthenticator({
    instanceId: async () => instanceId,
    origin,
    status: vi.fn(),
  });
  const socket = new Socket();
  socket.handler = () => socket.close();
  await expect(authenticate(socket.ws(), new AbortController().signal)).rejects.toBeInstanceOf(
    LegacyReconnect,
  );
  const fallback = new Socket();
  await authenticate(fallback.ws(), new AbortController().signal);
  expect(fallback.sent).toHaveLength(0);
  await credentials.setSkipLocalVerification(true);
  const skipped = new Socket();
  await authenticate(skipped.ws(), new AbortController().signal);
  expect(skipped.sent).toHaveLength(0);
});
it("L08: activation durably saves and promotes the candidate before returning", async () => {
  const record = credentials.parseLocalPairing(link);
  await credentials.stageCredential(record);
  const socket = new Socket();
  server(socket, record);
  expect(await auth(socket, [record])).toMatchObject({ state: "verified" });
  expect((await credentials.readLocalState()).credentials[0]).toMatchObject({
    role: "active",
    gen: 1,
  });
  expect(socket.sent.map((frame) => frame.type ?? frame.method)).toEqual([
    "system.ping",
    "local.auth.prove",
    "local.auth.rotate_confirm",
  ]);
});
it("L08a/L08b: recovery verifies the saved key against the new transcript before promotion", async () => {
  let record = credentials.parseLocalPairing(link);
  await credentials.stageCredential(record);
  record = await credentials.saveCandidate(record, { txn: v.txn, gen: 1, key: v.candidate });
  const socket = new Socket();
  server(socket, record, "recover");
  await auth(socket, [record]);
  expect((await credentials.readLocalState()).credentials[0].key).toBe(v.candidate);
  expect(socket.sent).toHaveLength(2);
});
it("L08c: confirmation waits for the strict transaction completion", async () => {
  const record = credentials.parseLocalPairing(link);
  await credentials.stageCredential(record);
  const original = credentials.saveCandidate;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = vi.spyOn(credentials, "saveCandidate").mockImplementation(async (...args) => {
    const value = await original(...args);
    await gate;
    return value;
  });
  const socket = new Socket();
  server(socket, record);
  const result = auth(socket, [record]);
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(socket.sent.some((frame) => frame.type === "local.auth.rotate_confirm")).toBe(false);
  release();
  await result;
});
it("L13: rejected staged verification preserves an active pairing and never sends business frames", async () => {
  let record = credentials.parseLocalPairing(link);
  await credentials.stageCredential(record);
  record = await credentials.saveCandidate(record, { txn: v.txn, gen: 1, key: v.candidate });
  record = await credentials.promoteCandidate(record, { txn: v.txn, gen: 1 });
  const replacementLink = link.replace(v.device_id, v.txn);
  const socket = new Socket();
  server(socket, credentials.parseLocalPairing(replacementLink), "reject");
  const result = verifyLocalPairing(replacementLink, instanceId, origin, () => {
    queueMicrotask(() => socket.dispatchEvent(new Event("open")));
    return socket.ws();
  });
  await expect(result).rejects.toThrow("already_paired");
  expect((await credentials.readLocalState()).credentials).toEqual([record]);
  expect(socket.sent.some((frame) => frame.method === "system.handshake")).toBe(false);
});

it.each([
  false,
  true,
])("a concurrent activation still requires a fresh server proof (bad=%s)", async (bad) => {
  const first = new Socket();
  const next = new Socket();
  let active: LocalCredential;
  first.handler = async (request) => {
    // The main socket commits after the verifier captured generation zero.
    let record = (await credentials.readLocalState()).credentials[0];
    record = await credentials.saveCandidate(record, { txn: v.txn, gen: 1, key: v.candidate });
    active = await credentials.promoteCandidate(record, { txn: v.txn, gen: 1 });
    server(next, active, bad ? "bad" : "normal");
    first.receive({
      id: request.id,
      result: {
        local_auth: {
          type: "pairing_required",
          daemon_id: v.daemon_id,
          legacy_accepted: false,
        },
      },
    });
  };
  const sockets = [first, next];
  const result = verifyLocalPairing(link, instanceId, origin, () => {
    const socket = sockets.shift()!;
    queueMicrotask(() => socket.dispatchEvent(new Event("open")));
    return socket.ws();
  });
  if (bad) await expect(result).rejects.toThrow("server_unverified");
  else expect(await result).toMatchObject({ state: "verified" });
  expect(sockets).toHaveLength(0);
  expect((await credentials.readLocalState()).credentials).toEqual([active!]);
  expect(next.sent[0].params).toMatchObject({ local_auth: { credentials: [{ gen: 1 }] } });
  if (bad) expect(next.sent).toHaveLength(1);
  expect([...first.sent, ...next.sent].some((frame) => frame.method === "system.handshake")).toBe(
    false,
  );
});
