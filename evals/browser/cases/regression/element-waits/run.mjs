import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { withChrome } from "../snapshot-coordinates/chrome.mjs";

const executable = process.env.BSK_WAIT_CHROME;
const cli = resolve(process.env.BSK_WAIT_CLI ?? "target/debug/bsk");
const extensionPath = resolve(process.env.BSK_WAIT_EXTENSION ?? "apps/extension/dist/chrome-mv3");
const port = Number(process.env.BSK_WAIT_PORT ?? 52907);
const repeats = Number(process.env.BSK_WAIT_REPEATS ?? 10);
assert(executable, "Set BSK_WAIT_CHROME to a Chromium/Chrome for Testing executable");
assert(Number.isInteger(port) && port > 0 && port < 65536 && port !== 52800);
assert(Number.isInteger(repeats) && repeats > 0 && repeats <= 100);
assert(
  (await readFile(join(extensionPath, "background.js"), "utf8")).includes(`ws://127.0.0.1:${port}`),
  `Build the extension with BSK_DAEMON_WS_URL=ws://127.0.0.1:${port} first`,
);
const directory = await mkdtemp(join(tmpdir(), "bsk-element-waits-"));
const env = { ...process.env, BSK_HOME: directory, BSK_AUTO_START: "0", BSK_AUTO_UPDATE: "off" };
const exec = promisify(execFile);
const bsk = async (args) => {
  const { stdout } = await exec(cli, [...args, "--json"], {
    env,
    timeout: 20_000,
    maxBuffer: 2 ** 20,
  });
  return JSON.parse(stdout);
};
const poll = async (read) => {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Fixture setup timed out");
};
const html = await readFile(new URL("fixture.html", import.meta.url));
const server = createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(html);
});
let daemon;
const rows = [];
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  daemon = spawn(cli, ["daemon", "start", "--foreground", "--port", String(port)], {
    env,
    stdio: "ignore",
  });
  await poll(async () => {
    try {
      return await bsk(["status"]);
    } catch {
      return false;
    }
  });
  await withChrome(
    { executable, extensionPath, deviceScale: 1, zoom: 1, startupTimeout: 30_000 },
    async (send) => {
      const version = await send("Browser.getVersion");
      await poll(async () => (await bsk(["browsers"])).length);
      const session = await bsk(["session", "start"]);
      const sessionId = session.session_id;
      assert(sessionId, JSON.stringify(session));
      const sessionArgs = ["--session", sessionId];
      try {
        // Read the fixture before choosing the fixed, local test selectors.
        await bsk(["navigate", url, ...sessionArgs]);
        await bsk(["observe", ...sessionArgs]);
        const tabs = await bsk(["tab", "list", ...sessionArgs, "--scope", "agent"]);
        const target = tabs.tabs.find((t) => t.url === url);
        assert(target, JSON.stringify(tabs));
        const tabArgs = [...sessionArgs, "--tab-id", String(target.tab_id)];
        // execFile rejects nonzero exits; this also verifies the CLI timeout contract.
        const timeout = await bsk([
          "wait-for-element",
          "#absent",
          "--timeout",
          "100ms",
          ...tabArgs,
        ]);
        assert.equal(timeout.satisfied, false);
        assert.equal(timeout.attached, false);
        const idle = await bsk(["tab", "create", ...sessionArgs, "--url", "about:blank"]);
        const evaluate = async (expression) => {
          const result = await bsk(["evaluate", expression, ...tabArgs]);
          assert.equal(result.ok, true, JSON.stringify(result));
          return result.value;
        };
        const visibility = () => evaluate("document.visibilityState");
        const proof = () => evaluate("({startedAt, readyAt, visibility:document.visibilityState})");
        for (const background of [false, true]) {
          await bsk([
            "tab",
            "select",
            String(background ? idle.tab_id : target.tab_id),
            ...sessionArgs,
          ]);
          // Dispatcher background execution may override document.visibilityState.
          // Check actual active-tab state separately before and after every run.
          for (const state of ["visible", "detached"]) {
            const selector = state === "visible" ? "#result" : "#mask";
            for (let iteration = 0; iteration < repeats; iteration++) {
              // Alternate method order to reduce warmup/order bias.
              const methods =
                iteration % 2
                  ? ["wait-for-element", "caller-poll"]
                  : ["caller-poll", "wait-for-element"];
              for (const method of methods) {
                const selected = async () =>
                  (await bsk(["tab", "list", ...sessionArgs, "--scope", "agent"])).tabs.find(
                    (t) => t.tab_id === target.tab_id,
                  ).active;
                assert.equal(await selected(), !background);
                const reportedVisibility = await visibility();
                const triggered = performance.now();
                await bsk(["click", "#start", ...tabArgs]);
                let calls = 0;
                const started = performance.now();
                let satisfied = false;
                let reportedElapsed = null;
                if (method === "wait-for-element") {
                  calls++;
                  const result = await bsk([
                    method,
                    selector,
                    "--state",
                    state,
                    "--timeout",
                    "3s",
                    "--poll-ms",
                    "100",
                    ...tabArgs,
                  ]);
                  satisfied = result.satisfied;
                  reportedElapsed = result.elapsed_ms;
                } else {
                  const deadline = started + 3000;
                  while (performance.now() < deadline) {
                    calls++;
                    const matched = await evaluate(
                      state === "detached"
                        ? `document.querySelector(${JSON.stringify(selector)}) === null`
                        : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el?.isConnected || !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true,contentVisibilityAuto:true})) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
                    );
                    if (performance.now() >= deadline) break;
                    if (matched) {
                      satisfied = true;
                      break;
                    }
                    calls++;
                    await bsk([
                      "wait-ms",
                      `${Math.min(100, Math.ceil(deadline - performance.now()))}ms`,
                    ]);
                  }
                }
                const ended = performance.now();
                const elapsed = ended - started;
                const evidence = await proof();
                assert.equal(await selected(), !background);
                const success = satisfied && evidence.readyAt !== null;
                rows.push({
                  background,
                  state,
                  method,
                  iteration,
                  success,
                  elapsed_ms: Math.round(elapsed * 10) / 10,
                  trigger_wait_ms: Math.round((ended - triggered) * 10) / 10,
                  cli_calls: calls,
                  reported_elapsed_ms: reportedElapsed,
                  fixture_delay_ms:
                    evidence.readyAt === null
                      ? null
                      : Math.round(evidence.readyAt - evidence.startedAt),
                  document_visibility: reportedVisibility,
                });
              }
            }
          }
        }
        const summary = [];
        for (const background of [false, true])
          for (const state of ["visible", "detached"])
            for (const method of ["caller-poll", "wait-for-element"]) {
              const group = rows.filter(
                (row) =>
                  row.background === background && row.state === state && row.method === method,
              );
              const times = group.map((row) => row.elapsed_ms).sort((a, b) => a - b);
              const avg = (key) =>
                Math.round((group.reduce((n, row) => n + row[key], 0) / group.length) * 10) / 10;
              summary.push({
                background,
                state,
                method,
                successes: group.filter((row) => row.success).length,
                runs: group.length,
                median_ms: times[Math.floor(times.length / 2)],
                p95_ms: times[Math.ceil(times.length * 0.95) - 1],
                mean_cli_calls: avg("cli_calls"),
                mean_trigger_wait_ms: avg("trigger_wait_ms"),
              });
            }
        console.log(
          JSON.stringify(
            {
              browser: version.product,
              repeats,
              fixture_delay_ms: 350,
              timeout_ms: 3000,
              poll_ms: 100,
              summary,
              rows,
            },
            null,
            2,
          ),
        );
        assert(
          rows.every((row) => row.success),
          "Some waits did not observe the expected fixture transition",
        );
      } finally {
        await bsk(["session", "stop", sessionId]);
      }
    },
  );
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const closed = once(daemon, "close");
    const deadline = setTimeout(() => daemon.kill("SIGKILL"), 5000);
    daemon.kill();
    await closed;
    clearTimeout(deadline);
  }
  await new Promise((r) => server.close(r));
  await rm(directory, { recursive: true, force: true });
}
