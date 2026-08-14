/**
 * HTTP/SSE exposure of the ObservationService for the client half. The Typert
 * Remote pipeline and the forwarded-event allowlist are both closed to
 * out-of-tree packages in dsh 0.1 (generation runs over dsh's own ts.Program;
 * the event allowlist lives in dsh-api-remotes), so the plugin serves its
 * observation channel through the documented `webServer` route seam instead:
 *
 *   GET  /bsk-observation/state      → { sessions, available }
 *   GET  /bsk-observation/events     → SSE stream of ObservationEvent
 *   POST /bsk-observation/interrupt  → body {sessionId?} → {interrupted: boolean}
 *   GET  /bsk-observation/thumbnail/<attachmentId> → image bytes
 *
 * Routes exist only when a webServer service is mounted (web composition);
 * headless deployments skip registration entirely.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { ObservationService } from "./observation";

/** Structural view of the dsh-host-webserver route seam. */
interface WebServerLike {
  register(route: {
    kind: "exact" | "prefix";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}

const ROUTE_BASE = "/bsk-observation";
const SSE_HEARTBEAT_MS = 15_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Browser-trust fence, mirroring the one dsh applies to its /api routes (ours
 * live outside that prefix, so the checks are replicated here):
 * - Host must be a loopback authority (localhost / 127.0.0.0/8 / [::1]) — the
 *   observation channel exposes live screenshots and must never answer a LAN
 *   or DNS-rebound name;
 * - a present Origin must be same-host with the Host header (blocks cross-site
 *   reads), and `sec-fetch-site: cross-site` is refused outright;
 * - POST must be `application/json` — anything a cross-site *simple request*
 *   can send (form/plain) never reaches the handler, which kills CSRF.
 */
function fenceViolation(req: IncomingMessage): string | undefined {
  const host = req.headers.host ?? "";
  const hostname = /^\[.*\](?::\d+)?$/.test(host)
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0];
  const isLoopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  if (!isLoopback) return "host is not a loopback authority";
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== "null") {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      return "unparseable Origin header";
    }
    if (originHost !== host) return "Origin does not match Host";
  }
  if (req.headers["sec-fetch-site"] === "cross-site") return "sec-fetch-site: cross-site";
  if (req.method === "POST") {
    const contentType = req.headers["content-type"] ?? "";
    if (!/^\s*application\/json\s*(;|$)/.test(contentType)) {
      return "POST requires an application/json body";
    }
  }
  return undefined;
}

/** Run the fence; returns true when the request was rejected (handled). */
function fenceRejected(req: IncomingMessage, res: ServerResponse): boolean {
  const violation = fenceViolation(req);
  if (violation === undefined) return false;
  sendJson(res, 403, { error: `forbidden: ${violation}` });
  return true;
}

/**
 * Register the observation routes. No-op (with a console note) when the
 * composition has no web server.
 * @returns disposer removing the routes.
 */
export function registerObservationRoutes(
  ctx: Context,
  observation: ObservationService,
): () => void {
  const webServer = ctx.get("webServer") as WebServerLike | undefined;
  if (webServer === undefined) {
    return () => {};
  }
  const disposers = [
    webServer.register({
      kind: "exact",
      path: `${ROUTE_BASE}/state`,
      handler: (req, res) => {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        if (fenceRejected(req, res)) return;
        sendJson(res, 200, {
          sessions: observation.getState(),
          available: observation.isAvailable(),
        });
      },
    }),
    webServer.register({
      kind: "exact",
      path: `${ROUTE_BASE}/events`,
      handler: (req, res) => {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        if (fenceRejected(req, res)) return;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const unsubscribe = observation.subscribe((event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), SSE_HEARTBEAT_MS);
        res.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
      },
    }),
    webServer.register({
      kind: "exact",
      path: `${ROUTE_BASE}/interrupt`,
      handler: (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        if (fenceRejected(req, res)) return;
        let body = "";
        req.on("data", (chunk: Buffer | string) => {
          body += chunk;
        });
        req.on("end", () => {
          let sessionId: string | undefined;
          try {
            const parsed = JSON.parse(body || "{}") as { sessionId?: unknown };
            if (typeof parsed.sessionId === "string" && parsed.sessionId !== "") {
              sessionId = parsed.sessionId;
            }
          } catch {
            sendJson(res, 400, { error: "invalid JSON body" });
            return;
          }
          sendJson(res, 200, { interrupted: observation.interrupt(sessionId) });
        });
      },
    }),
    webServer.register({
      kind: "prefix",
      path: `${ROUTE_BASE}/thumbnail`,
      handler: async (req, res) => {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        if (fenceRejected(req, res)) return;
        const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
        const attachmentId = pathname.slice(`${ROUTE_BASE}/thumbnail/`.length);
        const frame = await observation.readThumbnail(attachmentId);
        if (frame === undefined) {
          sendJson(res, 404, { error: "unknown thumbnail" });
          return;
        }
        res.writeHead(200, {
          "content-type": frame.mediaType,
          "cache-control": "no-cache",
        });
        res.end(Buffer.from(frame.data));
      },
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
