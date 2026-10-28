// Full CLI -> daemon -> installed MV3 extension, in an isolated browser/profile.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { withChrome } from "../snapshot-coordinates/chrome.mjs";
import { dragMarkup, dragScript } from "./drag-interactions.fixture.mjs";

const exec = promisify(execFile);
const chrome = process.env.BSK_DRAG_CHROME;
assert(chrome, "Set BSK_DRAG_CHROME to a Chrome executable with extension debugging support");
const bsk = resolve(process.env.BSK_DRAG_BSK ?? "target/debug/bsk");
const extension = resolve(process.env.BSK_DRAG_EXTENSION ?? "apps/extension/dist/chrome-mv3");
const port = Number(process.env.BSK_DRAG_PORT ?? 52839);
const home = await mkdtemp(join(tmpdir(), "bsk-drag-home-"));
const env = { ...process.env, BSK_HOME: home, BSK_AUTO_UPDATE: "off", BSK_AUTO_START: "0" };
const output = resolve(process.env.BSK_DRAG_OUTPUT ?? "evals/browser/results/drag-interactions");
const transcript = [];
const browserLog = [];
async function cli(args) {
  try {
    const { stdout } = await exec(bsk, [...args, "--json"], {
      env,
      timeout: 45000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    transcript.push({ args, result });
    return result;
  } catch (error) {
    transcript.push({ args, error: error.stdout || error.message });
    throw error;
  }
}
async function eventually(fn) {
  let error;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await fn();
    } catch (e) {
      error = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw error;
}
const server = createServer((req, res) => {
  if (req.url === "/frames") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<title>Frame drag</title><iframe style="width:600px;height:300px;border:0" src="http://localhost:${server.address().port}/child"></iframe><script>onmessage=e=>{window.frameMove=e.data}</script>`,
    );
    return;
  }
  if (req.url === "/child") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<div id="inside" aria-label="Frame handle" style="width:100px;height:80px;background:#def;cursor:grab;touch-action:none">Frame handle</div><script>
      let start;inside.onpointerdown=e=>{start=[e.clientX,e.clientY];inside.setPointerCapture(e.pointerId)};
      inside.onpointermove=e=>{if(e.buttons&&start)parent.postMessage([e.clientX-start[0],e.clientY-start[1]],'http://127.0.0.1:${server.address().port}')};
    </script>`);
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<title>Drag regression</title>${dragMarkup}<script>${dragScript}</script>`);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const daemon = spawn(bsk, ["daemon", "start", "--foreground", "--port", String(port)], {
  env,
  stdio: ["ignore", "ignore", "pipe"],
});
let daemonLog = "";
daemon.stderr.on("data", (data) => {
  daemonLog += data;
});
try {
  await eventually(() => cli(["status"]));
  await withChrome(
    {
      executable: chrome,
      deviceScale: 1,
      zoom: 1,
      extensionPath: extension,
      headless: true,
      disableGpu: false,
      extensionViaCdp: true,
      onEvent: (event) => {
        if (
          event.method === "Runtime.consoleAPICalled" ||
          event.method === "Runtime.exceptionThrown"
        )
          browserLog.push(event);
      },
    },
    async (send) => {
      const worker = await eventually(async () => {
        const targets = (await send("Target.getTargets")).targetInfos;
        const t = targets.find(
          (t) =>
            t.type === "service_worker" &&
            t.url.startsWith("chrome-extension://") &&
            t.url.endsWith("/background.js"),
        );
        assert(t);
        return t;
      });
      const { sessionId: workerSession } = await send("Target.attachToTarget", {
        targetId: worker.targetId,
        flatten: true,
      });
      await send("Runtime.enable", {}, workerSession);
      transcript.push({ browser: await send("Browser.getVersion") });
      await eventually(async () => {
        const r = await cli(["browsers"]);
        assert.equal((Array.isArray(r) ? r : r.browsers).length, 1);
      });
      const { session_id: session } = await cli(["session", "start"]);
      const sessionArgs = ["--session", session];
      try {
        await cli(["navigate", `http://127.0.0.1:${server.address().port}/`, ...sessionArgs]);
        const action = async (args) => {
          const c = await cli(["cooperate", "sync", ...sessionArgs]);
          assert(c.context_id);
          return cli([
            ...(typeof args === "function" ? args(c) : args),
            ...sessionArgs,
            "--context",
            c.context_id,
          ]);
        };
        const verify = async (expression) => {
          const r = await action(["evaluate", expression]);
          assert.equal(r.ok, true);
          return r.value;
        };
        await action(["drag", "#mouse", "--dx", "120"]);
        assert.equal(await verify("window.moved.mouse.dx"), 120);
        await action(["drag", "#hold", "--dx", "100", "--hold", "300ms"]);
        assert.equal(await verify("window.moved.hold.dx"), 100);
        await action(["drag", "#native", "--to", "#drop"]);
        assert.equal(await verify("window.drops"), 1);
        await action(["drag", "#range", "--dx", "70"]);
        assert((await verify("Number(range.value)")) > 70);
        await action(["drag", "#handle", "--dx", "50", "--dy", "30"]);
        assert.deepEqual(await verify("[resize.style.width,resize.style.height]"), [
          "190px",
          "100px",
        ]);
        await action(["drag", "#first", "--to", "#third"]);
        assert.deepEqual(await verify("Array.from(sort.children,e=>e.id)"), [
          "second",
          "third",
          "first",
        ]);
        await assert.rejects(
          action(["drag", "#pointer", "--dx", "30", "--hold", "1s", "--timeout", "300ms"]),
          (error) => JSON.parse(error.stdout).code === "timeout",
        );
        await action(["drag", "#pointer", "--dx", "50"]);
        assert.equal(await verify("window.moved.pointer.dx"), 50);
        await action(["navigate", `http://127.0.0.1:${server.address().port}/frames`]);
        await action((context) => {
          const line = context.observation.text
            .split("\n")
            .find((line) => line.includes('[drag-handle] "Frame handle"'));
          const ref = line?.match(/@e\d+/)?.[0];
          assert(ref, context.observation.text);
          return [
            "drag",
            ref,
            "--dx",
            "60",
            "--dy",
            "20",
            "--observation-id",
            context.observation.observation_id,
          ];
        });
        assert.deepEqual(await verify("window.frameMove"), [60, 20]);
        console.log(
          "PASS installed extension: mouse, hold, native drop, range, resize, sort, timeout recovery, cross-origin frame ref",
        );
      } finally {
        await cli(["session", "stop", session]);
      }
    },
  );
} finally {
  if (daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, "exit");
    daemon.kill();
    await exited;
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "transcript.json"), JSON.stringify(transcript, null, 2));
  await writeFile(join(output, "daemon.log"), daemonLog);
  await writeFile(join(output, "browser.json"), JSON.stringify(browserLog, null, 2));
  await rm(home, { recursive: true, force: true });
}
