import { prove, randomBytes, transcript, verify } from "./local-auth-crypto";
import { parseAuthJson, parseAuthMessage, parseChallenge } from "./local-auth-protocol";
import {
  type LocalCredential,
  promoteCandidate,
  readLocalState,
  saveCandidate,
} from "./local-credentials";

export type LocalAuthCode =
  | "verifying"
  | "verified"
  | "pairing_required"
  | "already_paired"
  | "replace_mismatch"
  | "server_unverified"
  | "daemon_too_old"
  | "unverified_local"
  | "busy";
export interface LocalAuthStatus {
  state: LocalAuthCode;
  daemonId?: string;
  deviceId?: string;
  browserId?: string;
  reason?: "skip";
}
export class LocalAuthError extends Error {
  constructor(readonly status: LocalAuthStatus) {
    super(status.state);
  }
}

class AuthChannel {
  private queue: string[] = [];
  private waiting?: { resolve: (value: string) => void; reject: (error: Error) => void };
  private failure?: Error;
  constructor(
    private socket: WebSocket,
    private signal: AbortSignal,
  ) {
    socket.addEventListener("message", this.message);
    socket.addEventListener("close", this.closed);
    signal.addEventListener("abort", this.aborted, { once: true });
    if (signal.aborted) this.aborted();
  }
  private fail(error: Error) {
    this.failure ??= error;
    this.waiting?.reject(this.failure);
    this.waiting = undefined;
  }
  private message = (event: MessageEvent) => {
    if (
      typeof event.data !== "string" ||
      new TextEncoder().encode(event.data).length > 4096 ||
      this.queue.length >= 4
    ) {
      this.fail(new LocalAuthError({ state: "server_unverified" }));
      return;
    }
    if (this.waiting) {
      this.waiting.resolve(event.data);
      this.waiting = undefined;
    } else this.queue.push(event.data);
  };
  private closed = () => this.fail(new LocalAuthError({ state: "server_unverified" }));
  private aborted = () => this.fail(new LocalAuthError({ state: "server_unverified" }));
  next(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }
  send(value: unknown) {
    if (this.failure) throw this.failure;
    if (this.signal.aborted || this.socket.readyState !== 1 /* OPEN */)
      throw new LocalAuthError({ state: "server_unverified" });
    this.socket.send(JSON.stringify(value));
  }
  finish() {
    if (this.failure) throw this.failure;
    if (this.queue.length) throw new LocalAuthError({ state: "server_unverified" });
  }
  dispose() {
    this.socket.removeEventListener("message", this.message);
    this.socket.removeEventListener("close", this.closed);
    this.signal.removeEventListener("abort", this.aborted);
  }
}

export async function authenticateLocal(
  socket: WebSocket,
  signal: AbortSignal,
  credentials: LocalCredential[],
  instanceId: string,
  origin: string,
): Promise<LocalAuthStatus> {
  const channel = new AuthChannel(socket, signal);
  try {
    const nonce = randomBytes(32);
    const id = crypto.randomUUID();
    channel.send({
      id,
      method: "system.ping",
      params: {
        local_auth: {
          v: 1,
          client_nonce: nonce,
          instance_id: instanceId,
          credentials: credentials.map((c) => ({
            role: c.role,
            device_id: c.deviceId,
            gen: c.gen,
            pending: c.pending ? { txn: c.pending.txn, gen: c.pending.gen } : null,
          })),
        },
      },
    });
    const reply = parseAuthJson(await channel.next()) as {
      id?: unknown;
      result?: { local_auth?: unknown };
    };
    if (!reply || reply.id !== id || !reply.result?.local_auth)
      throw new LocalAuthError({ state: "daemon_too_old" });
    if (
      Object.keys(reply).some((key) => key !== "id" && key !== "result") ||
      Object.keys(reply.result).some((key) => key !== "local_auth")
    )
      throw new LocalAuthError({ state: "server_unverified" });
    const challenge = parseChallenge(reply.result.local_auth);
    if (challenge.type === "pairing_required")
      throw new LocalAuthError({ state: "pairing_required", daemonId: challenge.daemon_id });
    if (challenge.type === "busy") throw new LocalAuthError({ state: "busy" });
    let credential = credentials.find(
      (c) =>
        c.daemonId === challenge.daemon_id &&
        c.deviceId === challenge.device_id &&
        (c.gen === challenge.gen || c.pending?.gen === challenge.gen),
    );
    if (!credential) throw new LocalAuthError({ state: "server_unverified" });
    const key = credential.pending?.gen === challenge.gen ? credential.pending.key : credential.key;
    const t = transcript({ ...challenge, instance_id: instanceId, origin, client_nonce: nonce });
    if (!(await verify(key, "server", t, challenge.server_proof)))
      throw new LocalAuthError({ state: "server_unverified" });
    channel.send({ type: "local.auth.prove", v: 1, client_proof: await prove(key, "client", t) });
    const ready = parseAuthMessage(await channel.next());
    if (ready.type === "local.auth.rejected")
      throw new LocalAuthError({ state: ready.reason, browserId: ready.browser_id });
    if (ready.type !== "local.auth.ready") throw new LocalAuthError({ state: "server_unverified" });
    if (ready.commit) {
      const pending = credential.pending;
      if (
        !pending ||
        challenge.gen !== pending.gen ||
        ready.commit.gen !== pending.gen ||
        ready.commit.txn !== pending.txn ||
        !(await verify(pending.key, "committed", t, ready.commit.proof, pending.txn))
      )
        throw new LocalAuthError({ state: "server_unverified" });
      // Recovery uses the saved candidate and this connection's transcript.
      credential = await promoteCandidate(credential, pending);
    } else if (ready.rotation) {
      if (challenge.gen !== credential.gen || ready.rotation.gen !== credential.gen + 1)
        throw new LocalAuthError({ state: "server_unverified" });
      const rotation = ready.rotation;
      const candidate = await prove(key, "rotate", t, rotation.txn);
      credential = await saveCandidate(credential, { ...rotation, key: candidate });
      channel.send({
        type: "local.auth.rotate_confirm",
        v: 1,
        txn: rotation.txn,
        proof: await prove(candidate, "confirm", t, rotation.txn),
      });
      const committed = parseAuthMessage(await channel.next());
      if (
        committed.type !== "local.auth.committed" ||
        committed.gen !== rotation.gen ||
        !(await verify(candidate, "committed", t, committed.proof, rotation.txn))
      )
        throw new LocalAuthError({ state: "server_unverified" });
      credential = await promoteCandidate(credential, rotation);
    } else if (credential.role !== "active" || challenge.gen !== credential.gen) {
      throw new LocalAuthError({ state: "server_unverified" });
    }
    channel.finish();
    return { state: "verified", daemonId: credential.daemonId, deviceId: credential.deviceId };
  } catch (error) {
    if (error instanceof LocalAuthError) throw error;
    throw new LocalAuthError({ state: "server_unverified" });
  } finally {
    channel.dispose();
  }
}

export function createLocalAuthenticator(options: {
  instanceId: () => Promise<string>;
  origin: string;
  status: (status: LocalAuthStatus) => void;
}) {
  return async (socket: WebSocket, signal: AbortSignal): Promise<void> => {
    const { credentials, policy } = await readLocalState();
    if (signal.aborted) throw new LocalAuthError({ state: "server_unverified" });
    // Migration ended in 0.4.1. Even a stale persisted flag cannot authorize
    // downgrade; only the user's separate explicit skip setting may do so.
    if (policy.skip) {
      options.status({ state: "unverified_local", reason: "skip" });
      return;
    }
    options.status({ state: "verifying" });
    try {
      const status = await authenticateLocal(
        socket,
        signal,
        credentials,
        await options.instanceId(),
        options.origin,
      );
      options.status(status);
    } catch (error) {
      if (signal.aborted) throw error;
      options.status(
        error instanceof LocalAuthError ? error.status : { state: "server_unverified" },
      );
      throw error;
    }
  };
}
