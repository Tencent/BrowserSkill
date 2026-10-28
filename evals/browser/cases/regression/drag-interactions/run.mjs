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
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/precision") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<title>Precision drag and card semantics</title><style>
      body{margin:40px} canvas{touch-action:none;background:#def}
      #cover{position:absolute;left:110px;top:70px;width:20px;height:20px;background:#789}
    </style><canvas id="precision" width="360" height="120"></canvas><div id="cover" hidden></div>
    <div role="group" contenteditable="true" draggable="true" aria-label="Editable card">Draft</div>
    <div role="group" onclick="window.cardClicks++" draggable="true" aria-label="Clickable card">Open card</div>
    <script>
      window.points=[];window.cardClicks=0;
      precision.onpointerdown=e=>{const r=precision.getBoundingClientRect();points.push([e.clientX-r.left,e.clientY-r.top]);precision.setPointerCapture(e.pointerId)};
      precision.onpointermove=e=>{if(e.buttons){const r=precision.getBoundingClientRect();const x=e.clientX-r.left,y=e.clientY-r.top;points.push([x,y]);precision.getContext('2d').fillRect(x,y,4,4)}};
    </script>`);
    return;
  }
  if (url.pathname === "/frame-drops") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<title>Nested frame drop</title><style>
      body{margin:0} #source{position:absolute;left:20px;top:80px;width:100px;height:80px;background:#def}
      iframe,#cover{position:absolute;left:210px;top:80px;width:400px;height:300px;border:0}
      #cover{background:#789}
    </style><div id="source" draggable="true" aria-label="Frame source">Frame source</div>
    <iframe id="middle" src="/frame-middle"></iframe><div id="cover" hidden></div><script>
      window.counts={presses:0,starts:0,intended:0,wrong:0};
      source.onmousedown=()=>counts.presses++;
      source.ondragstart=e=>{counts.starts++;e.dataTransfer.setData('text/plain','frame-card')};
      cover.ondragover=e=>e.preventDefault();cover.ondrop=e=>{e.preventDefault();counts.wrong++};
      onmessage=e=>{if(e.data==='intended')counts.intended++;if(e.data==='wrong')counts.wrong++};
      source.onmouseenter=()=>{const mode=${JSON.stringify(url.searchParams.get("cover"))};
        if(mode==='top')cover.hidden=false;
        if(mode==='middle')middle.contentDocument.getElementById('cover').hidden=false;
      };
    </script>`);
    return;
  }
  if (url.pathname === "/frame-middle") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<style>body{margin:0}iframe,#cover{position:absolute;left:20px;top:40px;width:300px;height:200px;border:0}#cover{background:#789}</style>
      <iframe src="http://localhost:${server.address().port}/drop-child"></iframe><div id="cover" hidden></div><script>
      cover.ondragover=e=>e.preventDefault();cover.ondrop=e=>{e.preventDefault();parent.postMessage('wrong','*')};
      onmessage=e=>parent.postMessage(e.data,'*');</script>`);
    return;
  }
  if (url.pathname === "/drop-child") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<div id="drop" aria-label="Nested destination" style="position:absolute;left:30px;top:20px;width:200px;height:100px;background:#def"
      ondragover="event.preventDefault()" ondrop="event.preventDefault();if(event.dataTransfer.getData('text/plain')==='frame-card')parent.postMessage('intended','*')">Nested destination</div>`);
    return;
  }
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
        let observation;
        const action = async (args) => {
          const c = await cli(["cooperate", "sync", ...sessionArgs]);
          assert(c.context_id);
          // Unchanged/delta replies retain the preceding observation's refs.
          observation = c.observation ?? observation;
          return cli([
            ...(typeof args === "function" ? args({ ...c, observation }) : args),
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
        const observedRef = (context, label, role) => {
          const line = context.observation.text
            .split("\n")
            .find((line) => line.includes(`"${label}"`));
          assert(line, context.observation.text);
          if (role) assert.match(line, new RegExp(`\\b${role}\\b`));
          const ref = line.match(/@e\d+/)?.[0];
          assert(ref, line);
          return ref;
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
        await action(["navigate", `http://127.0.0.1:${server.address().port}/precision`]);
        await action([
          "drag",
          "#precision",
          "--dx",
          "60",
          "--dy",
          "10",
          "--from-offset-x",
          "-100",
          "--from-offset-y",
          "-20",
        ]);
        assert.deepEqual(await verify("[points[0],points.at(-1)]"), [
          [80, 40],
          [140, 50],
        ]);
        assert.equal(
          await verify("precision.getContext('2d').getImageData(140,50,1,1).data[3]"),
          255,
        );
        await action(["evaluate", "points=[]"]);
        await action([
          "drag",
          "#precision",
          "--to",
          "#precision",
          "--from-offset-x",
          "-100",
          "--to-offset-x",
          "100",
        ]);
        assert.deepEqual(await verify("[points[0],points.at(-1)]"), [
          [80, 60],
          [280, 60],
        ]);
        await action(["evaluate", "points=[];cover.hidden=false"]);
        await assert.rejects(
          action([
            "drag",
            "#precision",
            "--dx",
            "60",
            "--from-offset-x",
            "-100",
            "--from-offset-y",
            "-20",
          ]),
          (error) => JSON.parse(error.stdout).data?.effect_state === "none",
        );
        assert.equal(await verify("points.length"), 0);
        await action(["evaluate", "cover.hidden=true"]);
        await action((c) => [
          "fill",
          observedRef(c, "Editable card", "textbox"),
          "--value",
          "Updated draft",
        ]);
        assert.equal(
          await verify("document.querySelector('[contenteditable]').textContent"),
          "Updated draft",
        );
        await action((c) => ["click", observedRef(c, "Clickable card", "button")]);
        assert.equal(await verify("cardClicks"), 1);
        for (const cover of ["top", "middle", "none"]) {
          await action([
            "navigate",
            `http://127.0.0.1:${server.address().port}/frame-drops?cover=${cover}`,
          ]);
          const gesture = () =>
            action((c) => [
              "drag",
              observedRef(c, "Frame source"),
              "--to",
              observedRef(c, "Nested destination"),
            ]);
          if (cover === "none") {
            await gesture();
            assert.deepEqual(await verify("counts"), {
              presses: 1,
              starts: 1,
              intended: 1,
              wrong: 0,
            });
          } else {
            await assert.rejects(
              gesture(),
              (error) => JSON.parse(error.stdout).data?.effect_state === "none",
            );
            assert.deepEqual(await verify("counts"), {
              presses: 0,
              starts: 0,
              intended: 0,
              wrong: 0,
            });
          }
        }
        console.log(
          "PASS installed extension: mouse, hold, native drop, range, resize, sort, timeout recovery, cross-origin frame ref, precise offsets, card semantics, nested frame occlusion",
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
