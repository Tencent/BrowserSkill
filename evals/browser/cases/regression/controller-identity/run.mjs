// Exercise the built CLI, daemon and extension in an isolated browser profile.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { withChrome } from "../snapshot-coordinates/chrome.mjs";

const defaultCli = process.platform === "win32" ? "target/debug/bsk.exe" : "target/debug/bsk";
const cli = resolve(process.env.BSK_TEST_CLI ?? defaultCli);
const executable = process.env.BSK_TEST_CHROME;
const extensionPath = resolve(
  process.env.BSK_IDENTITY_EXTENSION ?? "apps/extension/dist/chrome-mv3",
);
const port = Number(process.env.BSK_IDENTITY_PORT ?? 52836);
const output = resolve(
  process.env.BSK_IDENTITY_OUTPUT ?? "evals/browser/results/controller-identity",
);
assert(executable, "Set BSK_TEST_CHROME to a browser executable");
const home = await mkdtemp(join(tmpdir(), "bsk-controller-identity-"));
const env = { ...process.env, BSK_HOME: home, BSK_AUTO_START: "0", BSK_BROWSER_WAIT_MS: "0" };
for (const key of [
  "BSK_SESSION",
  "BSK_SCOPE",
  "CLAUDE_CODE_AGENT_ID",
  "CODEX_THREAD_ID",
  "ANTIGRAVITY_CONVERSATION_ID",
  "CURSOR_TRACE_ID",
  "DSH_SESSION_ID",
]) {
  delete env[key];
}
const execute = promisify(execFile);
const bsk = async (...args) => {
  const { stdout } = await execute(cli, [...args, "--json"], {
    env,
    windowsHide: true,
    timeout: 30000,
  });
  return JSON.parse(stdout);
};
const until = async (probe, label) => {
  const deadline = Date.now() + 15000;
  do {
    const result = await probe();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
};
let daemon;
let daemonLog = "";
const sessions = new Set();
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    "<!doctype html><title>Controller identity regression</title><style>body{font:16px system-ui;margin:64px;color:#302820;background:#faf9f6}h1{font-size:28px}</style><h1>BrowserSkill controller identity</h1><p>Isolated regression using the production CLI, daemon and extension.</p><input aria-label='Draft' value='User draft'>",
  );
});
try {
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "result.json"),
    `${JSON.stringify({ passed: false, state: "running", startedAt: new Date().toISOString() })}\n`,
  );
  daemon = spawn(cli, ["daemon", "start", "--foreground", "--port", String(port)], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", (data) => {
    daemonLog += data;
  });
  daemon.stderr.on("data", (data) => {
    daemonLog += data;
  });
  await until(
    () =>
      access(join(home, "daemon.json")).then(
        () => true,
        () => false,
      ),
    "isolated daemon",
  );
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const { attachPairingBackground } = await import(
    new URL("../../../local-pairing.mjs", import.meta.url).href
  );
  await withChrome(
    { executable, extensionPath, extensionViaCdp: true, deviceScale: 1, zoom: 1 },
    async (send) => {
      await attachPairingBackground(send, extensionPath);
      const browsers = await until(async () => {
        const status = await bsk("status");
        return status.browsers.length ? status.browsers : null;
      }, "extension connection");
      assert.equal(browsers.length, 1);
      const start = async (labels) => {
        const token = `${Date.now() + 120000}:${randomUUID()}`;
        await bsk("session", "request", token, "--prepare");
        const session = await bsk(
          "session",
          "start",
          "--browser",
          browsers[0].instance_id,
          "--request-id",
          token,
          ...labels,
        );
        sessions.add(session.session_id);
        await bsk("session", "request", token, "--claim");
        await bsk("navigate", `${url}/${session.session_id}`, "--session", session.session_id);
        const { targetInfos } = await send("Target.getTargets");
        const target = targetInfos.find((entry) => entry.url === `${url}/${session.session_id}`);
        assert(target, "session page target");
        const attached = await send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        });
        const evaluate = async (expression) => {
          const result = await send(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            attached.sessionId,
          );
          assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
          return result.result.value;
        };
        const overlay = () =>
          evaluate(`(() => {
        const root = document.querySelector('[data-bsk-overlay]')?.shadowRoot;
        const card = root?.querySelector('[role=toolbar]');
        if (!card) return null;
        const marker = card.querySelector('.bsk-controller-color');
        const badge = card.querySelector('.bsk-cooperation-badge');
        const primary = card.querySelector('.bsk-cooperation-primary');
        const rect = card.getBoundingClientRect();
        return {text: card.textContent, color: marker && getComputedStyle(marker).backgroundColor,
          fits: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && card.scrollWidth <= card.clientWidth,
          compact: badge.clientHeight <= 24 && (!primary || primary.clientHeight <= 44)};
      })()`);
        await until(overlay, "control overlay");
        return { ...session, attached: attached.sessionId, evaluate, overlay };
      };
      const first = await start([
        "--agent-name",
        "Codex",
        "--project",
        "Search service",
        "--controller-color",
        "#2563eb",
      ]);
      const second = await start(["--agent-name", "Claude", "--project", "Payments"]);
      const legacy = await start([]);
      const snapshots = [];
      for (const [page, name, project] of [
        [first, "Codex", "Search service"],
        [second, "Claude", "Payments"],
        [legacy, "BrowserSkill", ""],
      ]) {
        const overlay = await page.overlay();
        assert(overlay.text.includes(name));
        assert(overlay.text.includes(project));
        assert(overlay.text.includes(page.session_id));
        assert(overlay.fits, "toolbar must fit the viewport");
        const { data } = await send("Page.captureScreenshot", { format: "png" }, page.attached);
        await writeFile(join(output, `${name}.png`), Buffer.from(data, "base64"));
        snapshots.push({ sessionId: page.session_id, ...overlay });
      }
      assert.equal(snapshots[0].color, "rgb(37, 99, 235)");
      assert.notEqual(snapshots[0].color, snapshots[1].color);
      assert(!snapshots[0].text.includes("Claude"));
      assert(!snapshots[1].text.includes("Codex"));
      const status = await bsk("status");
      assert.equal(
        status.sessions.find((s) => s.session_id === first.session_id).controller.project,
        "Search service",
      );
      assert.equal(
        status.sessions.find((s) => s.session_id === second.session_id).controller.name,
        "Claude",
      );
      assert.equal(
        status.sessions.find((s) => s.session_id === legacy.session_id).controller,
        undefined,
      );
      // A fresh content script must recover identity after navigation.
      const context = await bsk("cooperate", "sync", "--session", first.session_id);
      assert.equal(typeof context.context_id, "string");
      assert.equal(typeof context.observation_id, "string");
      await bsk(
        "navigate",
        `${url}/${first.session_id}?reload`,
        "--session",
        first.session_id,
        "--context",
        context.context_id,
        "--observation",
        context.observation_id,
      );
      await until(
        async () => (await first.overlay())?.text.includes("Search service"),
        "identity after navigation",
      );
      // Check the constrained viewport with the actual extension stylesheet.
      await send(
        "Emulation.setDeviceMetricsOverride",
        { width: 320, height: 568, deviceScaleFactor: 1, mobile: false },
        first.attached,
      );
      assert((await first.overlay()).fits, "toolbar must fit a 320px viewport");
      const narrow = await send("Page.captureScreenshot", { format: "png" }, first.attached);
      await writeFile(join(output, "Codex-narrow.png"), Buffer.from(narrow.data, "base64"));
      const long = await start([
        "--agent-name",
        "Agent ".repeat(13),
        "--project",
        "项目".repeat(60),
      ]);
      await send(
        "Emulation.setDeviceMetricsOverride",
        { width: 320, height: 568, deviceScaleFactor: 1, mobile: false },
        long.attached,
      );
      assert((await long.overlay()).fits, "long labels must fit a 320px viewport");
      assert((await long.overlay()).compact, "long names must keep the badge and controls compact");
      const longScreenshot = await send("Page.captureScreenshot", { format: "png" }, long.attached);
      await writeFile(
        join(output, "Long-labels-narrow.png"),
        Buffer.from(longScreenshot.data, "base64"),
      );
      for (const id of [...sessions]) {
        await bsk("session", "stop", id);
        sessions.delete(id);
      }
      assert.equal((await bsk("status")).sessions.length, 0);
      await writeFile(
        join(output, "result.json"),
        `${JSON.stringify({ passed: true, snapshots }, null, 2)}\n`,
      );
      console.log(JSON.stringify({ passed: true, output, sessions: snapshots.length }));
    },
  );
} catch (error) {
  await writeFile(
    join(output, "result.json"),
    `${JSON.stringify({ passed: false, error: String(error), finishedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  throw error;
} finally {
  for (const id of sessions) await bsk("session", "stop", id).catch(() => {});
  if (daemon && daemon.exitCode === null) {
    await bsk("daemon", "stop").catch(() => daemon.kill());
    await until(() => daemon.exitCode !== null || daemon.signalCode !== null, "daemon exit").catch(
      () => daemon.kill(),
    );
  }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await writeFile(join(output, "daemon.log"), daemonLog);
  assert(home.startsWith(join(tmpdir(), "bsk-controller-identity-")));
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
