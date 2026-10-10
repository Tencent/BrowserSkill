import { channel } from "node:diagnostics_channel";
import { appendFileSync } from "node:fs";

// Loaded with Node --import. Observes HTTP timing without wrapping DSH or
// modifying requests; headers, bodies, credentials and response text are never read.
const path = process.env.BSK_MODEL_TRACE;
if (!path) throw new Error("BSK_MODEL_TRACE is required");
const record = (event) =>
  appendFileSync(
    path,
    `${JSON.stringify({ atMs: performance.now(), time: Date.now(), ...event })}\n`,
    {
      mode: 0o600,
    },
  );
let sequence = 0;
const requests = new WeakMap();
channel("undici:request:create").subscribe(({ request }) => {
  const id = ++sequence;
  requests.set(request, id);
  record({ type: "http_start", id, method: request.method, path: request.path.split("?")[0] });
});
channel("undici:request:trailers").subscribe(({ request }) => {
  record({ type: "http_end", id: requests.get(request) });
});
channel("undici:request:headers").subscribe(({ request, response }) => {
  record({ type: "http_headers", id: requests.get(request), status: response.statusCode });
});
channel("undici:request:error").subscribe(({ request, error }) => {
  record({ type: "http_error", id: requests.get(request), code: error.code });
});
