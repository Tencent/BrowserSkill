/**
 * HTTP/SSE exposure of the ObservationService for the client half. The Typert
 * Remote pipeline and the forwarded-event allowlist are both closed to
 * out-of-tree packages in dsh 0.1 (generation runs over dsh's own ts.Program;
 * the event allowlist lives in dsh-api-remotes), so the plugin serves its
 * observation channel through the documented `webServer` route seam instead:
 *
 *   GET  /bsk-observation/state      → { sessions: SessionObservation[] }
 *   GET  /bsk-observation/events     → SSE stream of ObservationEvent
 *   POST /bsk-observation/interrupt  → body {sessionId?} → {interrupted: boolean}
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
        sendJson(res, 200, { sessions: observation.getState() });
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
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const unsubscribe = observation.subscribe((event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), SSE_HEARTBEAT_MS);
        req.on("close", () => {
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
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
