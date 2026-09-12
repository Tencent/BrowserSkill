import { createServer } from "node:http";

import { loadFixtureRegistry } from "./fixture-registry.mjs";

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

function validRunId(value) {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

function json(response, status, value) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function html(response, status, value) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(value);
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      throw new Error("request body exceeds 64 KiB");
    }
  }
  return raw ? JSON.parse(raw) : {};
}

export function createEvalServer({ host = "127.0.0.1", port = 0, fixtureRegistry } = {}) {
  const runs = new Map();
  let sequence = 0;
  let server;
  let registry = fixtureRegistry;

  function eventsFor(runId) {
    if (!runs.has(runId)) runs.set(runId, []);
    return runs.get(runId);
  }

  function record(runId, type, data = {}, metadata = {}) {
    if (!validRunId(runId)) return null;
    const event = {
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      type,
      data,
      ...metadata,
    };
    eventsFor(runId).push(event);
    return event;
  }

  function snapshot(runId) {
    return { runId, events: [...(runs.get(runId) ?? [])] };
  }

  function reset(runId) {
    runs.set(runId, []);
  }

  async function handle(request, response) {
    const origin = `http://${request.headers.host ?? `${host}:${port}`}`;
    const url = new URL(request.url ?? "/", origin);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json(response, 200, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/events") {
      const body = await readJson(request);
      if (!validRunId(body.runId) || typeof body.type !== "string") {
        return json(response, 400, { error: "runId and type are required" });
      }
      const event = record(body.runId, body.type, body.data ?? {}, {
        path: typeof body.path === "string" ? body.path : undefined,
      });
      return json(response, 202, { accepted: true, sequence: event.sequence });
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]);
      if (!validRunId(runId)) return json(response, 400, { error: "invalid run id" });
      if (request.method === "GET") return json(response, 200, snapshot(runId));
      if (request.method === "DELETE") {
        reset(runId);
        return json(response, 200, { runId, reset: true });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/ping") {
      const runId = url.searchParams.get("run");
      if (!validRunId(runId)) return json(response, 400, { error: "invalid run id" });
      record(runId, "network.ping", { token: "NETWORK-73" }, { path: url.pathname });
      return json(response, 200, { ok: true, token: "NETWORK-73" });
    }

    if (request.method !== "GET") return json(response, 405, { error: "method not allowed" });

    const runId = url.searchParams.get("run") ?? "manual";
    if (!validRunId(runId)) return json(response, 400, { error: "invalid run id" });

    const fixture = registry.render(url.pathname, {
      runId,
      query: url.searchParams,
      record: (type, data, metadata) => record(runId, type, data, metadata),
    });
    if (!fixture) return html(response, 404, "<!doctype html><h1>Not found</h1>");
    record(runId, "page.request", { path: url.pathname }, { path: url.pathname });
    return html(response, 200, fixture);
  }

  return {
    record,
    reset,
    snapshot,
    async start() {
      if (server) throw new Error("eval server is already running");
      registry ??= await loadFixtureRegistry();
      server = createServer((request, response) => {
        handle(request, response).catch((error) => {
          json(response, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("unexpected server address");
      return { host, port: address.port, baseUrl: `http://${host}:${address.port}` };
    },
    async stop() {
      if (!server) return;
      const active = server;
      server = undefined;
      await new Promise((resolve, reject) => {
        active.close((error) => (error ? reject(error) : resolve()));
        active.closeAllConnections?.();
      });
    },
  };
}
