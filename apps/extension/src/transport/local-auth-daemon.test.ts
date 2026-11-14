// @vitest-environment node
/// <reference types="node" />
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { DEFAULT_DAEMON_WS_URL, EXTENSION_CLIENT_ID, PROTOCOL_VERSION } from "./generated/methods";
import { EXTENSION_VERSION } from "./handshake";
import { authenticateLocal, createLocalAuthenticator, LocalAuthError } from "./local-auth";
import * as localCredentials from "./local-credentials";
import { readLocalState } from "./local-credentials";
import { verifyLocalPairing } from "./pairing-verifier";

// Opt-in process tests: BSK_TEST_BINARY is a current build; BSK_TEST_OLD_BINARY
// is a released/pre-pairing executable. Each owns an isolated home and port.
const current = process.env.BSK_TEST_BINARY;
const old = process.env.BSK_TEST_OLD_BINARY;
const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const instance = "a1b2c3d4";
let home: string;
let daemon: ChildProcess | undefined;
const sockets: WebSocket[] = [];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bsk-auth-"));
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  if (daemon && daemon.exitCode === null) {
    const exited = once(daemon, "exit");
    daemon.kill();
    await exited;
  }
  daemon = undefined;
  await rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function environment() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BSK_HOME: home,
    BSK_AUTO_UPDATE: "off",
    BSK_BROWSER_WAIT_MS: "0",
  };
  delete env.BSK_DAEMONIZED;
  delete env.BSK_DAEMON_REPLACES_PID;
  for (const key of [
    "BSK_SESSION",
    "BSK_SCOPE",
    "CLAUDE_CODE_AGENT_ID",
    "CODEX_THREAD_ID",
    "ANTIGRAVITY_CONVERSATION_ID",
    "CURSOR_TRACE_ID",
    "DSH_SESSION_ID",
  ]) {
    delete env[key];
  }
  return env;
}
async function cli(binary: string, ...args: string[]) {
  return (
    await promisify(execFile)(binary, args, { env: environment(), timeout: 10_000 })
  ).stdout.trim();
}
async function start(binary: string, listenPort = 0, args: string[] = []) {
  daemon = spawn(
    binary,
    ["daemon", "start", "--foreground", "--port", String(listenPort), ...args],
    {
      env: environment(),
      stdio: "ignore",
    },
  );
  let port = 0;
  await vi.waitFor(
    async () => {
      const info = JSON.parse(await readFile(join(home, "daemon.json"), "utf8"));
      expect(info.pid).toBe(daemon!.pid);
      port = info.ws_port;
      expect(port).toBeGreaterThan(0);
    },
    { timeout: 10_000 },
  );
  return `ws://127.0.0.1:${port}/`;
}
function socket(url: string): WebSocket {
  const ws = new WebSocket(url, { origin });
  sockets.push(ws);
  return ws;
}
async function opened(url: string) {
  const ws = socket(url);
  await once(ws, "open");
  return ws;
}
function browserSocket(ws: WebSocket) {
  return ws as unknown as globalThis.WebSocket;
}
async function handshake(ws: WebSocket) {
  const response = once(ws, "message");
  ws.send(
    JSON.stringify({
      id: "handshake",
      method: "system.handshake",
      params: {
        client: EXTENSION_CLIENT_ID,
        version: EXTENSION_VERSION,
        protocol_version: PROTOCOL_VERSION,
        instance_id: instance,
        browser: { name: "Chrome", version: "130" },
        label: "integration",
      },
    }),
  );
  return JSON.parse(String((await response)[0]));
}
it.skipIf(!current)(
  "real daemon: verifier activation, reconnect, rotation, business handshake, revoke",
  async () => {
    await cli(current!, "daemon", "trust-local", "off");
    const url = await start(current!);
    const link = await cli(current!, "daemon", "pair");
    await verifyLocalPairing(link, instance, origin, (address) => browserSocket(socket(address)));
    let ws = await opened(url);
    await authenticateLocal(
      browserSocket(ws),
      AbortSignal.timeout(5000),
      (await readLocalState()).credentials,
      instance,
      origin,
    );
    expect((await handshake(ws)).result).toBeDefined();
    await cli(current!, "daemon", "rotate", instance);
    const closed = once(ws, "close");
    ws.close();
    await closed;
    ws = await opened(url);
    await authenticateLocal(
      browserSocket(ws),
      AbortSignal.timeout(5000),
      (await readLocalState()).credentials,
      instance,
      origin,
    );
    expect((await readLocalState()).credentials[0].gen).toBe(2);
    expect((await handshake(ws)).result).toBeDefined();
    const revoked = once(ws, "close");
    await cli(current!, "daemon", "revoke", instance);
    await revoked;
    const devices = JSON.parse(await cli(current!, "daemon", "devices"));
    expect(devices[0].status).toBe("revoked");
  },
  20_000,
);
it.skipIf(!current)(
  "real daemon: committed activation and replacement recover after candidate expiry",
  async () => {
    const url = await start(current!);
    for (const replace of [false, true]) {
      const link = await cli(
        current!,
        "daemon",
        "pair",
        ...(replace ? ["--replace", instance] : []),
      );
      // The daemon commits, but extension persistence fails for both the
      // initial attempt and the verifier's immediate recovery attempt.
      const promotion = vi
        .spyOn(localCredentials, "promoteCandidate")
        .mockRejectedValue(new Error("Interrupted credential promotion"));
      try {
        await expect(
          verifyLocalPairing(link, instance, origin, (address) => browserSocket(socket(address))),
        ).rejects.toBeInstanceOf(LocalAuthError);
      } finally {
        promotion.mockRestore();
      }
      const before = (await readLocalState()).credentials;
      const staged = before.find((credential) => credential.role === "staged");
      expect(staged?.pending).toBeDefined();
      const devices = JSON.parse(await cli(current!, "daemon", "devices"));
      expect(
        devices.find((device: { device_id: string }) => device.device_id === staged?.deviceId),
      ).toMatchObject({ status: "active" });
      expect(before.filter((credential) => credential.role === "active")).toHaveLength(
        replace ? 1 : 0,
      );

      // A later service-worker startup performs a write, so recovery must
      // survive durable cleanup as well as an ordinary credential read.
      const clock = vi.spyOn(Date, "now").mockReturnValue(staged!.createdAt + 24 * 60 * 60_000);
      try {
        await localCredentials.setSkipLocalVerification(false);
        const credentials = (await readLocalState()).credentials;
        expect(credentials).toEqual(before);
        const ws = await opened(url);
        await authenticateLocal(
          browserSocket(ws),
          AbortSignal.timeout(5000),
          credentials,
          instance,
          origin,
        );
        const recovered = (await readLocalState()).credentials;
        expect(recovered).toHaveLength(1);
        expect(recovered[0]).toMatchObject({ deviceId: staged!.deviceId, role: "active", gen: 1 });
        expect(recovered[0].pending).toBeUndefined();
        expect((await handshake(ws)).result).toBeDefined();
        const closed = once(ws, "close");
        ws.close();
        await closed;
      } finally {
        clock.mockRestore();
      }
    }
  },
  30_000,
);
it.skipIf(!old)(
  "unpaired profiles connect to a real pre-pairing daemon without migration authorization",
  async () => {
    const url = await start(old!);
    const authenticate = createLocalAuthenticator({
      instanceId: async () => instance,
      origin,
      status: vi.fn(),
    });
    const ws = await opened(url);
    await authenticate(browserSocket(ws), AbortSignal.timeout(5000));
    expect((await handshake(ws)).result).toBeDefined();
  },
  20_000,
);

it.skipIf(!current || !old)(
  "current CLI can issue, list and revoke remote grants on the released daemon",
  async () => {
    const serverArgs = ["--mode", "server", "--public-url", `${DEFAULT_DAEMON_WS_URL}/extension`];
    const url = await start(old!, 0, serverArgs);
    const link = new URL(await cli(current!, "daemon", "pair"));
    expect(link.pathname).toBe("/extension");
    const exchanged = await fetch(new URL("/extension/authorize", url.replace("ws:", "http:")), {
      method: "POST",
      headers: {
        authorization: `Bearer ${link.hash.slice(1)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "pair", next_token: "g".repeat(43), label: "legacy remote" }),
    });
    expect(exchanged.status).toBe(200);
    const grant = await exchanged.json();
    const devices = JSON.parse(await cli(current!, "daemon", "devices"));
    expect(devices).toEqual([
      expect.objectContaining({ kind: "remote", device_id: grant.device_id }),
    ]);
    await cli(current!, "daemon", "revoke", grant.device_id);
    expect(JSON.parse(await cli(old!, "daemon", "devices"))).toEqual([]);
    await cli(current!, "daemon", "revoke", "--all");

    // A CLI must not report a complete revocation if the legacy server
    // cannot revoke local credentials that a newer daemon would accept.
    const oldStopped = once(daemon!, "exit");
    daemon!.kill();
    await oldStopped;
    await start(current!);
    await cli(current!, "daemon", "pair");
    const currentStopped = once(daemon!, "exit");
    daemon!.kill();
    await currentStopped;
    await start(old!, 0, serverArgs);
    await expect(cli(current!, "daemon", "revoke", "--all")).rejects.toHaveProperty(
      "stderr",
      expect.stringContaining("local pairings also exist"),
    );
  },
  20_000,
);

it.skipIf(!current)(
  "optional pairing: a fresh link recovers an interrupted first activation after its link expires",
  async () => {
    const url = await start(current!);
    const original = await cli(current!, "daemon", "pair");
    // Interrupt after the candidate is saved and before the daemon sees confirmation.
    let interrupted = false;
    const interruptedSocket = (address: string) => {
      if (interrupted) throw new LocalAuthError({ state: "server_unverified" });
      const ws = socket(address);
      const send = ws.send.bind(ws);
      vi.spyOn(ws, "send").mockImplementation((message) => {
        if (JSON.parse(String(message)).type === "local.auth.rotate_confirm") {
          interrupted = true;
          ws.terminate();
        } else send(message);
      });
      return browserSocket(ws);
    };
    await expect(
      verifyLocalPairing(original, instance, origin, interruptedSocket),
    ).rejects.toBeInstanceOf(LocalAuthError);
    const [staged] = (await readLocalState()).credentials;
    expect(staged.pending).toBeDefined();

    // Set the daemon-side expiry in its isolated store and reload on the same port.
    const stopped = once(daemon!, "exit");
    daemon!.kill();
    await stopped;
    const storePath = join(home, "local-pairings.json");
    const store = JSON.parse(await readFile(storePath, "utf8"));
    expect(store.devices[staged.deviceId].status).toBe("unactivated");
    store.devices[staged.deviceId].expires_at = "2000-01-01T00:00:00Z";
    await writeFile(storePath, JSON.stringify(store));
    await start(current!, Number(new URL(url).port));

    const authenticate = createLocalAuthenticator({
      instanceId: async () => instance,
      origin,
      status: vi.fn(),
    });
    await expect(
      authenticate(browserSocket(await opened(url)), AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({
      status: { state: "pairing_required" },
    });
    const fresh = await cli(current!, "daemon", "pair");
    await expect(
      verifyLocalPairing(fresh, instance, origin, (address) => browserSocket(socket(address))),
    ).resolves.toMatchObject({ state: "verified" });
    const [credential, ...obsolete] = (await readLocalState()).credentials;
    expect(credential).toMatchObject({ role: "active", gen: 1 });
    expect(credential.deviceId).not.toBe(staged.deviceId);
    expect(obsolete).toHaveLength(0);
    const verified = await opened(url);
    await authenticate(browserSocket(verified), AbortSignal.timeout(5000));
    expect((await handshake(verified)).result).toBeDefined();
  },
  20_000,
);

it.skipIf(!current)(
  "optional pairing: a rejected link preserves unpaired use and successful pairing verifies reconnects",
  async () => {
    const url = await start(current!);
    const status = vi.fn();
    const authenticate = createLocalAuthenticator({
      instanceId: async () => instance,
      origin,
      status,
    });
    const unpaired = await opened(url);
    await authenticate(browserSocket(unpaired), AbortSignal.timeout(5000));
    expect(status).toHaveBeenLastCalledWith({ state: "unverified_local", reason: "unpaired" });
    expect((await handshake(unpaired)).result).toBeDefined();
    const link = await cli(current!, "daemon", "pair");
    const badLink = link.replace(/[^.]+$/, "A".repeat(43));
    await expect(
      verifyLocalPairing(badLink, instance, origin, (address) => browserSocket(socket(address))),
    ).rejects.toBeInstanceOf(LocalAuthError);
    expect(unpaired.readyState).toBe(WebSocket.OPEN);
    expect((await readLocalState()).credentials).toHaveLength(0);
    const report = JSON.parse(await cli(current!, "--json", "status"));
    expect(report.browsers).toHaveLength(1);

    await verifyLocalPairing(link, instance, origin, (address) => browserSocket(socket(address)));
    const paired = await opened(url);
    await authenticate(browserSocket(paired), AbortSignal.timeout(5000));
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: "verified" }));
    expect((await handshake(paired)).result).toBeDefined();
  },
  20_000,
);
it.skipIf(!current || !old)(
  "paired profiles refuse a pre-pairing daemon after an independent CLI downgrade",
  async () => {
    await start(current!);
    const link = await cli(current!, "daemon", "pair");
    await verifyLocalPairing(link, instance, origin, (address) => browserSocket(socket(address)));
    const stopped = once(daemon!, "exit");
    daemon!.kill();
    await stopped;
    const url = await start(old!);
    const status = vi.fn();
    const authenticate = createLocalAuthenticator({
      instanceId: async () => instance,
      origin,
      status,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const ws = await opened(url);
      await expect(
        authenticate(browserSocket(ws), AbortSignal.timeout(5000)),
      ).rejects.toBeInstanceOf(LocalAuthError);
    }
    expect(status.mock.calls.some(([value]) => value.state === "unverified_local")).toBe(false);
    expect((await readLocalState()).credentials[0].role).toBe("active");
    expect(JSON.parse(await cli(old!, "--json", "status")).browsers).toHaveLength(0);
  },
  20_000,
);
