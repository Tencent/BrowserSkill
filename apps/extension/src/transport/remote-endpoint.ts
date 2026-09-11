/** A gateway issues a pairing URL; the fragment never becomes part of the request URL. */
export interface RemoteEndpoint {
  url: string;
  token: string;
  deviceId?: string;
  serviceName?: string;
  expiresAt?: string;
  renewAfter?: string;
  pendingToken?: string;
}

export const REMOTE_ENDPOINT_KEY = "bsk_remote_endpoint";
export const REMOTE_AUTH_PROTOCOL_PREFIX = "bsk-auth.";

export function parseRemoteEndpoint(input: string): RemoteEndpoint {
  const url = new URL(input.trim());
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new Error("Remote connections require WSS (WS is allowed only on loopback)");
  }
  if (url.username || url.password || url.search) {
    throw new Error("Credentials and query parameters are not allowed in the server URL");
  }
  const token = url.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error("A pairing credential of 32–256 base64url characters is required");
  }
  url.hash = "";
  return { url: url.toString(), token };
}

export function readRemoteEndpoint(value: unknown): RemoteEndpoint | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") throw new Error("Invalid stored remote connection");
  const { url, token } = value as Partial<RemoteEndpoint>;
  if (typeof url !== "string" || typeof token !== "string") {
    throw new Error("Invalid stored remote connection");
  }
  const endpoint = parseRemoteEndpoint(`${url}#${token}`);
  const extra = value as Partial<RemoteEndpoint>;
  if (extra.deviceId !== undefined) {
    if (
      typeof extra.deviceId !== "string" ||
      !/^[a-f0-9]{32}$/.test(extra.deviceId) ||
      typeof extra.expiresAt !== "string" ||
      typeof extra.renewAfter !== "string" ||
      !Number.isFinite(Date.parse(extra.expiresAt)) ||
      !Number.isFinite(Date.parse(extra.renewAfter))
    )
      throw new Error("Invalid stored device authorization");
    endpoint.deviceId = extra.deviceId;
    endpoint.expiresAt = extra.expiresAt;
    endpoint.renewAfter = extra.renewAfter;
  }
  if (typeof extra.serviceName === "string") endpoint.serviceName = extra.serviceName.slice(0, 48);
  if (extra.pendingToken !== undefined) {
    if (typeof extra.pendingToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(extra.pendingToken))
      throw new Error("Invalid pending device credential");
    endpoint.pendingToken = extra.pendingToken;
  }
  return endpoint;
}

export function remoteSocket(
  url: string,
  endpoint: RemoteEndpoint | null,
  focusWindow?: (sessionId: string) => Promise<void>,
  preview?: (sessionId: string) => Promise<unknown>,
): WebSocket {
  // Never attach a remote credential to a different endpoint, including a local fallback.
  if (endpoint && endpoint.url !== url) throw new Error("Remote endpoint changed");
  const socket = endpoint
    ? new WebSocket(url, [REMOTE_AUTH_PROTOCOL_PREFIX + endpoint.token])
    : new WebSocket(url);
  if (endpoint && focusWindow)
    socket.addEventListener("message", (event) => {
      let request: { id?: string; method?: string; params?: { session_id?: string } };
      try {
        request = JSON.parse(event.data);
      } catch {
        return;
      }
      if (request.method !== "gateway.task_focus" && request.method !== "gateway.task_preview")
        return;
      event.stopImmediatePropagation();
      if (!request.id || !request.params?.session_id) return;
      const work =
        request.method === "gateway.task_preview"
          ? preview
            ? preview(request.params.session_id)
            : Promise.reject(new Error("Preview unavailable"))
          : focusWindow(request.params.session_id).then(() => ({ focused: true }));
      void work.then(
        (result) => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ id: request.id, result }));
        },
        () => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ id: request.id, error: { code: "window_unavailable" } }));
        },
      );
    });
  return socket;
}
