// Full CLI -> isolated daemon -> built extension -> real Chrome benchmark.
// No production website or user profile is accessed.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { withChrome } from "../snapshot-coordinates/chrome.mjs";
import { rangeMarkup, rangeScript } from "./range-selection.fixture.mjs";

const executable = process.env.BSK_DRAG_CHROME;
assert(executable, "Set BSK_DRAG_CHROME");
const cli = resolve(process.env.BSK_RANGE_CLI ?? "target/debug/bsk");
const extensionPath = resolve(process.env.BSK_RANGE_EXTENSION ?? "apps/extension/dist/chrome-mv3");
const port = Number(process.env.BSK_RANGE_PORT ?? 52943);
assert(port !== 52800 && Number.isInteger(port));
const dir = await mkdtemp(join(tmpdir(), "bsk-range-bench-"));
const env = { ...process.env, BSK_HOME: dir, BSK_AUTO_START: "0", BSK_AUTO_UPDATE: "off" };
const exec = promisify(execFile);
const calls = [];
const bsk = async (args, quiet = false) => {
  const start = performance.now();
  try {
    const { stdout } = await exec(cli, [...args, "--json"], {
      env,
      timeout: 35000,
      maxBuffer: 2 ** 22,
    });
    const result = JSON.parse(stdout);
    calls.push({ command: args[0], ms: performance.now() - start });
    return result;
  } catch (e) {
    if (!quiet) console.error("command failed", args, e.stdout || e.message);
    throw e;
  }
};
const poll = async (f) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const value = await f();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("setup timeout");
};
const server = createServer((_q, res) => {
  res.setHeader("content-type", "text/html;charset=utf-8");
  res.end(
    `<!doctype html><html><head><title>Range benchmark</title></head><body>${rangeMarkup}<script>${rangeScript}</script></body></html>`,
  );
});
let daemon,
  daemonOutput = "",
  session;
const trials = [];
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  daemon = spawn(cli, ["daemon", "start", "--foreground", "--port", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr])
    stream.on("data", (d) => (daemonOutput += d));
  await poll(async () => {
    try {
      return await bsk(["status"], true);
    } catch {
      return false;
    }
  });
  await withChrome(
    {
      executable,
      extensionPath,
      extensionViaCdp: true,
      deviceScale: 1,
      zoom: 1,
      softwareRendering: true,
      startupTimeout: 30000,
    },
    async (send) => {
      try {
        const browsers = await poll(async () => {
          const b = await bsk(["browsers"]);
          return b.length ? b : false;
        });
        const status = await bsk(["status"]);
        assert.equal(status.protocol_version, "1.7");
        assert.equal(status.browsers[0].extension_protocol_version, "1.7");
        const start = await bsk(["session", "start", "--browser", browsers[0].instance_id]);
        session = start.session_id;
        const scope = ["--session", session];
        let navigated = false;
        const prepare = async (suffix) => {
          const navContext = navigated ? await bsk(["cooperate", "sync", ...scope]) : undefined;
          await bsk([
            "navigate",
            `${base}?${suffix}`,
            ...scope,
            ...(navContext ? ["--context", navContext.context_id] : []),
          ]);
          navigated = true;
          const targets = await send("Target.getTargets");
          const target = targets.targetInfos.find((t) => t.url === `${base}?${suffix}`);
          assert(target);
          const { sessionId } = await send("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
          });
          const read = async (expression) => {
            const r = await send(
              "Runtime.evaluate",
              { expression, returnByValue: true },
              sessionId,
            );
            assert(!r.exceptionDetails);
            return r.result.value;
          };
          await poll(() => read("document.readyState==='complete'&&!!window.rangeState"));
          await bsk(["cooperate", "sync", ...scope]);
          return read;
        };
        const synced = async () => {
          const s = await bsk(["cooperate", "sync", ...scope]);
          assert(s.context_id, JSON.stringify(s));
          return s;
        };
        const act = async (args, s) => bsk([...args, ...scope, "--context", s.context_id]);
        // Show that successful delivery of the old held gesture does not select this widget.
        let read = await prepare("held");
        let s = await synced();
        await act(["drag", "#slot-14", "--to", "#slot-16"], s);
        await synced();
        assert.equal(await read("rangeState.completed"), false);
        for (let n = 0; n < 5; n++)
          for (const mode of n % 2 ? ["combined", "separate"] : ["separate", "combined"]) {
            read = await prepare(`${mode}-${n}`);
            const before = calls.length,
              t0 = performance.now();
            s = await synced();
            if (mode === "separate") {
              await act(["click", "#slot-14"], s);
              s = await synced();
              assert(s.observation.text.includes('"item 14" [selected:class]'), JSON.stringify(s));
              await act(["hover", "#slot-16"], s);
              s = await synced();
              for (const i of [14, 15, 16])
                assert(
                  s.observation.text.includes(`"item ${i}" [selected:class]`),
                  JSON.stringify(s),
                );
              await act(["click", "#slot-16"], s);
            } else
              await act(["drag", "#slot-14", "--to", "#slot-16", "--mode", "click-move-click"], s);
            s = await synced();
            const ms = performance.now() - t0;
            const state = await read("rangeState");
            assert.equal(state.completed, true);
            assert.deepEqual(state.preview, [14, 15, 16]);
            assert(s.observation.text.includes("Selected 14,15,16"), JSON.stringify(s));
            trials.push({
              mode,
              ms,
              commands: calls.slice(before),
              state,
              observation: s.observation.text,
            });
            console.error(mode, n, Math.round(ms) + "ms");
          }
        const stopped = await bsk(["session", "stop", session]);
        assert(stopped.stopped.includes(session));
        session = undefined;
        const stats = Object.fromEntries(
          ["separate", "combined"].map((mode) => {
            const values = trials
              .filter((t) => t.mode === mode)
              .map((t) => t.ms)
              .sort((a, b) => a - b);
            return [
              mode,
              {
                runs: values.length,
                median_ms: values[Math.floor(values.length / 2)],
                min_ms: values[0],
                max_ms: values.at(-1),
                cli_commands: trials.find((t) => t.mode === mode).commands.length,
              },
            ];
          }),
        );
        const report = {
          base_pr: "8465b04b880e428e1445a25fb9ae48115b8dcd0e",
          browser: (await send("Browser.getVersion")).product,
          protocol: status.protocol_version,
          scope:
            "Synthetic range fixture; actual CLI, daemon, extension, cooperation sync and real trusted input. Default movement/hover timing. Includes initial/final sync and process/RPC overhead; excludes navigation/setup, model reasoning and human waits. No live meeting reservation.",
          held_gesture_completed: false,
          session_stopped: true,
          stats,
          trials,
        };
        if (process.env.BSK_RANGE_REPORT)
          await writeFile(process.env.BSK_RANGE_REPORT, JSON.stringify(report, null, 2));
        console.log(JSON.stringify(stats, null, 2));
      } finally {
        if (session) {
          await bsk(["session", "stop", session]).catch(() => {});
          session = undefined;
        }
      }
    },
  );
} finally {
  if (session) await bsk(["session", "stop", session]).catch(() => {});
  if (daemon && daemon.exitCode === null) {
    const done = once(daemon, "exit");
    daemon.kill("SIGTERM");
    await done;
  }
  server.close();
  await rm(dir, { recursive: true, force: true });
  if (process.env.BSK_RANGE_DAEMON_LOG)
    await writeFile(process.env.BSK_RANGE_DAEMON_LOG, daemonOutput);
}
