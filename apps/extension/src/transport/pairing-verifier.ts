import { authenticateLocal, LocalAuthError, type LocalAuthStatus } from "./local-auth";
import {
  discardStaged,
  parseLocalPairing,
  readLocalState,
  stageCredential,
} from "./local-credentials";

let running = false;
/** A verifier owns no business transport and cannot disturb an active session. */
export async function verifyLocalPairing(
  link: string,
  instanceId: string,
  origin: string,
  factory: (url: string) => WebSocket = (url) => new WebSocket(url),
): Promise<LocalAuthStatus & { endpoint: string }> {
  if (running) throw new LocalAuthError({ state: "busy" });
  let credential = parseLocalPairing(link);
  running = true;
  let socket: WebSocket | undefined;
  let staged = false;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  try {
    credential = await stageCredential(credential);
    staged = true;
    for (let attempt = 0; ; attempt++) {
      if (abort.signal.aborted) throw new LocalAuthError({ state: "server_unverified" });
      socket = factory(credential.endpoint);
      const connection = socket;
      await new Promise<void>((resolve, reject) => {
        const dispose = () => {
          connection.removeEventListener("open", opened);
          connection.removeEventListener("close", failed);
          abort.signal.removeEventListener("abort", failed);
        };
        const opened = () => {
          dispose();
          resolve();
        };
        const failed = () => {
          dispose();
          reject(new LocalAuthError({ state: "server_unverified" }));
        };
        connection.addEventListener("open", opened);
        connection.addEventListener("close", failed);
        abort.signal.addEventListener("abort", failed, { once: true });
      });
      try {
        const status = await authenticateLocal(
          connection,
          abort.signal,
          [credential],
          instanceId,
          origin,
        );
        return { ...status, endpoint: credential.endpoint };
      } catch (error) {
        const latest = (await readLocalState()).credentials.find(
          (c) => c.deviceId === credential.deviceId && c.daemonId === credential.daemonId,
        );
        // The main connection may activate or recover this same staged record
        // while the verifier opens. Verify its advanced key on a fresh socket;
        // a concurrent commit is never accepted without another server proof.
        if (
          attempt === 0 &&
          latest &&
          (latest.gen > credential.gen ||
            (latest.pending && latest.pending.txn !== credential.pending?.txn))
        ) {
          credential = latest;
          socket.close();
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    // Once confirmation may have reached the daemon, retain the candidate for
    // recovery. Deleting it on a lost commit reply would strand a replacement.
    const stored = (await readLocalState()).credentials.find(
      (c) => c.deviceId === credential.deviceId && c.daemonId === credential.daemonId,
    );
    if (staged && !stored?.pending) await discardStaged(credential);
    throw error;
  } finally {
    clearTimeout(timer);
    abort.abort();
    socket?.close();
    running = false;
  }
}
