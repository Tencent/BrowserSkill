import type { Transport } from "./transport";
import type {
  HandshakeParams,
  HandshakeResult,
  ProtocolFrame,
  RequestFrame,
  ResponseFrame,
} from "./types";

export const PROTOCOL_VERSION = "1.0";
/**
 * Extension semver, injected at build time from `package.json` via
 * Vite's `define` (see `wxt.config.ts` and `vitest.config.ts`).
 */
export const EXTENSION_VERSION: string =
  typeof __BSK_EXT_VERSION__ === "string" ? __BSK_EXT_VERSION__ : "0.0.0-unset";
/**
 * Lowest **protocol** version this extension accepts (e.g. `"1.0"`).
 * Must stay in sync with daemon `MIN_COMPATIBLE_PROTOCOL`.
 */
export const MIN_COMPATIBLE_PROTOCOL = "1.0";
/**
 * **Deprecated** — legacy app-semver floor for wire compat with old
 * daemons. New code sends `"0.0.0"`; compat decisions ignore this.
 */
export const MIN_COMPATIBLE_PEER = "0.0.0";
export const CLIENT_ID = "browser-skill-extension";

export interface BrowserMeta {
  name: string;
  version: string;
}

export interface HandshakeInput {
  instanceId: string;
  browser: BrowserMeta;
  label: string;
  /**
   * Used to make the handshake's RPC id stable in tests. Defaults to a
   * random short string.
   */
  rpcId?: string;
}

export interface HandshakeOutcome {
  params: HandshakeParams;
  result: HandshakeResult;
}

function ridToString(): string {
  return `hs-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Send the mandatory first frame on a fresh connection: `system.handshake`.
 */
export function performHandshake(
  transport: Transport,
  input: HandshakeInput,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<HandshakeOutcome> {
  const id = input.rpcId ?? ridToString();
  const params: HandshakeParams = {
    client: CLIENT_ID,
    version: EXTENSION_VERSION,
    protocol_version: PROTOCOL_VERSION,
    instance_id: input.instanceId,
    browser: input.browser,
    label: input.label,
    min_compatible_peer: MIN_COMPATIBLE_PEER,
    min_compatible_protocol: MIN_COMPATIBLE_PROTOCOL,
  };

  const req: RequestFrame = { id, method: "system.handshake", params };
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<HandshakeOutcome>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      const err = new Error("[handshake] aborted because the connection changed");
      err.name = "AbortError";
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("[handshake] timed out waiting for daemon response"));
    }, timeoutMs);

    const sub = transport.onMessage((msg: ProtocolFrame) => {
      if (!isResponseFor(msg, id)) return;
      cleanup();
      const r = msg as ResponseFrame;
      if ("error" in r) {
        reject(
          new Error(`[handshake] daemon rejected handshake: ${r.error.code} — ${r.error.message}`),
        );
        return;
      }
      const result = r.result as HandshakeResult;
      resolve({ params, result });
    });

    function cleanup() {
      clearTimeout(timer);
      sub.dispose();
      options.signal?.removeEventListener("abort", onAbort);
    }

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      transport.send(req);
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function isResponseFor(msg: ProtocolFrame, id: string): boolean {
  return (
    typeof (msg as ResponseFrame).id === "string" &&
    (msg as ResponseFrame).id === id &&
    ("result" in (msg as object) || "error" in (msg as object))
  );
}

/**
 * Best-effort browser meta detection from `navigator.userAgent`.
 */
export function detectBrowserMeta(ua: string = navigator.userAgent): BrowserMeta {
  const probes: Array<[RegExp, string]> = [
    [/Edg\/([0-9.]+)/, "edge"],
    [/OPR\/([0-9.]+)/, "opera"],
    [/Brave\/([0-9.]+)/, "brave"],
    [/Arc\/([0-9.]+)/, "arc"],
    [/Chrome\/([0-9.]+)/, "chrome"],
  ];
  for (const [re, name] of probes) {
    const m = re.exec(ua);
    if (m) return { name, version: m[1] };
  }
  return { name: "chromium", version: "unknown" };
}
