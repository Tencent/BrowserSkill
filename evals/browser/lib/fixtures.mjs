const stylesheet = `
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; background: #f4f7fb; color: #182033; }
main { width: min(760px, calc(100% - 40px)); margin: 48px auto; }
.card { background: white; border: 1px solid #d9e1ef; border-radius: 14px; padding: 24px; box-shadow: 0 8px 28px #20304a12; }
h1 { margin-top: 0; }
a, button { font: inherit; }
button, .button { display: inline-block; border: 0; border-radius: 8px; padding: 10px 16px; background: #3157d5; color: white; cursor: pointer; text-decoration: none; }
label { display: block; margin: 16px 0; font-weight: 600; }
input, textarea, select { display: block; box-sizing: border-box; width: 100%; margin-top: 6px; border: 1px solid #9caac2; border-radius: 7px; padding: 9px; font: inherit; }
textarea { min-height: 90px; }
.marker { border-left: 4px solid #3157d5; padding: 8px 12px; background: #eef2ff; font-family: ui-monospace, monospace; }
.muted { color: #5c667a; }
#account-menu { position: relative; display: inline-block; padding-bottom: 12px; }
#hover-panel { display: none; position: absolute; z-index: 2; top: 34px; left: 0; width: 190px; padding: 10px; background: white; border: 1px solid #9caac2; border-radius: 8px; box-shadow: 0 8px 24px #20304a22; }
#account-menu:hover #hover-panel, #account-menu.open #hover-panel { display: block; }
#hover-panel button { width: 100%; }
#inspect-card { margin-top: 80px; }
code { font-family: ui-monospace, monospace; }
`;

const clientScript = `
(() => {
  const runId = new URLSearchParams(location.search).get("run");
  const navigation = performance.getEntriesByType("navigation")[0];
  const send = (type, data = {}) => {
    if (!runId) return Promise.resolve();
    return fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, type, path: location.pathname, data }),
      keepalive: true,
    }).catch(() => undefined);
  };
  window.browserEval = { runId, send };
  window.addEventListener("pageshow", (event) => {
    send("page.shown", {
      path: location.pathname,
      persisted: event.persisted,
      navigationType: navigation?.type ?? "unknown",
    });
  });
})();
`;

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function withRun(path, runId, extra = {}) {
  const url = new URL(path, "http://browser-eval.local");
  url.searchParams.set("run", runId);
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  return `${url.pathname}${url.search}`;
}

export function page({ title, body, script = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${stylesheet}</style>
</head>
<body>
  <main>${body}</main>
  <script>${clientScript}</script>
  ${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}
