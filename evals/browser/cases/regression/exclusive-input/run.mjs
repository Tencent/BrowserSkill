// Full CLI -> daemon -> installed extension; all profiles and pages are disposable.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  attachPairingBackground,
  copyPairingExtension,
  pairLocalBrowser,
} from "../../../local-pairing.mjs";
import { withChrome } from "../snapshot-coordinates/chrome.mjs";

const chrome = process.env.BSK_EXCLUSIVE_CHROME;
assert(chrome, "Set BSK_EXCLUSIVE_CHROME to an isolated Chrome executable");
const executable = resolve(process.env.BSK_EXCLUSIVE_CLI ?? "target/debug/bsk");
const extension = resolve(process.env.BSK_EXCLUSIVE_EXTENSION ?? "apps/extension/dist/chrome-mv3");
const port = Number(process.env.BSK_EXCLUSIVE_PORT ?? 52919);
assert(Number.isInteger(port) && port !== 52800);
const directory = await mkdtemp(join(tmpdir(), "bsk-exclusive-"));
const env = { ...process.env, BSK_HOME: directory, BSK_AUTO_START: "0", BSK_AUTO_UPDATE: "off" };
const output = resolve(process.env.BSK_EXCLUSIVE_OUTPUT ?? "evals/browser/results/exclusive-input");
const transcript = [];
const evidence = [];
const exec = promisify(execFile);
async function cli(args) {
  try {
    const { stdout } = await exec(executable, [...args, "--json"], {
      env,
      timeout: 45000,
      maxBuffer: 2 ** 22,
    });
    const result = JSON.parse(stdout);
    transcript.push({ args, result });
    return result;
  } catch (error) {
    transcript.push({ args, error: error.stdout || error.message });
    throw error;
  }
}
async function poll(read, label) {
  const deadline = Date.now() + 15000;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`, { cause: last });
}
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const child = req.url.startsWith("/frame");
  res.end(`<!doctype html><title>Exclusive input fixture</title><style>
    body{margin:20px;min-height:2200px}input,button{margin:8px}iframe{display:block;width:600px;height:130px}
    </style><form onsubmit="event.preventDefault();window.submits++">
    <label>${child ? "Frame" : "Page"} value <input id="value" aria-label="${child ? "Frame" : "Page"} value"></label>
    <button id="apply" type="button" onclick="window.clicks++">Apply</button><button>Submit</button></form>
    ${child ? "" : `<iframe id="same" src="/frame"></iframe><iframe id="cross" src="http://localhost:${server.address().port}/frame-cross"></iframe>`}
    <script>window.clicks=0;window.submits=0;window.keys=[];
    addEventListener('keydown',e=>keys.push(e.key),true);</script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const daemon = spawn(executable, ["daemon", "start", "--foreground", "--port", String(port)], {
  env,
  stdio: ["ignore", "ignore", "pipe"],
});
let daemonLog = "";
daemon.stderr.on("data", (chunk) => {
  daemonLog += chunk;
});
try {
  await poll(() => cli(["status"]), "daemon startup");
  await withChrome(
    {
      executable: chrome,
      deviceScale: 1,
      zoom: 1,
      extensionViaCdp: true,
      extensionPath: await copyPairingExtension(extension, join(directory, "extension"), port),
    },
    async (send) => {
      const worker = await attachPairingBackground(send, extension);
      await pairLocalBrowser(send, { executable, env, worker });
      async function evaluate(sessionId, expression) {
        const result = await send(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        );
        assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        return result.result.value;
      }
      const background = (expression) => evaluate(worker.sessionId, expression);
      await background(
        "chrome.storage.local.set({i18nextLng:'en-US',bsk_interaction_preferences:{confirmTabBorrow:false,requestHelpEnabled:true}})",
      );
      await poll(async () => (await cli(["browsers"])).length === 1, "paired browser");
      async function attach(url) {
        const target = await poll(
          async () =>
            (await send("Target.getTargets")).targetInfos.find(
              (t) => t.type === "page" && t.url === url,
            ),
          "page target",
        );
        const { sessionId } = await send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        });
        await send("Page.enable", {}, sessionId);
        await send("Page.bringToFront", {}, sessionId);
        const read = (expression) => evaluate(sessionId, expression);
        await poll(
          () =>
            read(
              "document.readyState === 'complete' && !!document.querySelector('browser-skill-overlay')?.shadowRoot",
            ),
          "content ready",
        );
        const native = (method, params) => send(method, params, sessionId);
        const type = async (text) => {
          await native("Input.dispatchKeyEvent", { type: "keyDown", key: text, text });
          await native("Input.dispatchKeyEvent", { type: "keyUp", key: text });
        };
        const click = async (selector, overlay = false) => {
          const point = await read(`(() => {
          const root = ${overlay ? "document.querySelector('browser-skill-overlay').shadowRoot" : "document"};
          const element = root.querySelector(${JSON.stringify(selector)});
          if (!element) throw new Error('Missing click target: ' + ${JSON.stringify(selector)});
          const r = element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
        })()`);
          for (const type of ["mousePressed", "mouseReleased"])
            await native("Input.dispatchMouseEvent", {
              type,
              ...point,
              button: "left",
              clickCount: 1,
            });
        };
        const blocking = () =>
          read(
            "!!document.querySelector('browser-skill-overlay')?.shadowRoot?.querySelector('[data-slot=control-overlay-blocker]')",
          );
        return { read, native, type, click, blocking };
      }
      const scope = (session) => ["--session", session];
      const sync = (session) => cli(["cooperate", "sync", ...scope(session)]);
      const act = async (session, args, context) => {
        const current = context ?? (await sync(session));
        assert(current.context_id, JSON.stringify(current));
        return cli([
          ...args,
          ...scope(session),
          "--context",
          current.context_id,
          "--observation",
          current.observation_id,
        ]);
      };
      // Shared remains the default.
      const shared = (await cli(["session", "start"])).session_id;
      await cli(["navigate", base + "/shared", ...scope(shared)]);
      const sharedPage = await attach(base + "/shared");
      await sync(shared);
      assert.equal(await sharedPage.blocking(), false);
      await sharedPage.read("document.querySelector('#value').focus()");
      await sharedPage.type("s");
      assert.equal(await sharedPage.read("document.querySelector('#value').value"), "s");
      evidence.push("shared default keeps human input");
      await cli(["session", "stop", shared]);

      // Hiding ordinary hints must not hide the only way to release an input lock.
      await background("chrome.storage.local.set({bsk_control_hints_hidden:true})");
      const task = (await cli(["session", "start", "--lock-input"])).session_id;
      await cli(["navigate", base + "/exclusive", ...scope(task)]);
      const page = await attach(base + "/exclusive");
      await page.read("document.querySelector('#value').focus()");
      const initial = await sync(task);
      await poll(() => page.blocking(), "exclusive surface");
      await page.click(".bsk-cooperation-minimize", true);
      await poll(
        () =>
          page.read(
            "!!document.querySelector('browser-skill-overlay').shadowRoot.querySelector('.bsk-cooperation-expand')",
          ),
        "minimized exit control",
      );
      assert.equal(await page.blocking(), true);
      await page.click(".bsk-cooperation-expand", true);
      await poll(
        () =>
          page.read(
            "!!document.querySelector('browser-skill-overlay').shadowRoot.querySelector('.bsk-cooperation-primary')",
          ),
        "expanded handover controls",
      );
      const tabId = initial.tab_id;
      await page.type("x");
      await page.native("Input.insertText", { text: "误触" });
      await page.click("#apply");
      await page.native("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 100,
        y: 80,
        deltaX: 0,
        deltaY: 300,
      });
      assert.deepEqual(
        await page.read("({value:document.querySelector('#value').value,keys,clicks,y:scrollY})"),
        { value: "", keys: [], clicks: 0, y: 0 },
      );
      // Opening the hit-test lease cannot turn a real click into Agent activity.
      await background(
        `chrome.tabs.sendMessage(${tabId},{type:'bsk/input-passthrough',phase:'begin',id:'regression'})`,
      );
      await page.click("#apply");
      await background(
        `chrome.tabs.sendMessage(${tabId},{type:'bsk/input-passthrough',phase:'end',id:'regression'})`,
      );
      assert.equal(await page.read("clicks"), 0);
      await act(task, ["fill", "#value", "--value", "Agent"], initial);
      assert.equal(await page.read("document.querySelector('#value').value"), "Agent");
      await act(task, ["press", "Enter"]);
      assert.equal(await page.read("submits"), 1);
      await act(task, ["click", "#apply"]);
      assert.equal(await page.read("clicks"), 1);
      await act(task, ["wheel", "#apply", "--delta-y", "300"]);
      await poll(async () => (await page.read("scrollY")) > 0, "Agent wheel");
      await page.read("scrollTo(0,0)");
      evidence.push(
        "blocked trusted click, key, text and wheel preserve context; Agent fill, press, click and wheel succeed",
      );

      for (const path of ["/frame", "/frame-cross"]) {
        const frames = await background(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
        const frame = frames.find((f) => new URL(f.url).pathname === path);
        assert(frame, JSON.stringify(frames));
        await background(
          `chrome.scripting.executeScript({target:{tabId:${tabId},frameIds:[${frame.frameId}]},func:()=>document.querySelector('#value').focus()})`,
        );
        await sync(task);
        await page.type("x");
        const values = await background(
          `chrome.scripting.executeScript({world:"MAIN",target:{tabId:${tabId},frameIds:[${frame.frameId}]},func:()=>({value:document.querySelector('#value').value,keys})})`,
        );
        assert.deepEqual(values[0].result, { value: "", keys: [] });
      }
      evidence.push("focused same-origin and cross-origin frame inputs stay locked");

      await page.click(".bsk-cooperation-primary", true);
      await poll(async () => !(await page.blocking()), "Pause releases mask");
      await page.read("document.querySelector('#value').focus()");
      await page.type("h");
      assert.equal(await page.read("document.querySelector('#value').value"), "Agenth");
      await new Promise((resolve) => setTimeout(resolve, 3200));
      await assert.rejects(
        () => sync(task),
        (error) => JSON.parse(error.stdout).code === "permission_denied",
      );
      const held = await cli(["cooperate", "status", ...scope(task)]);
      assert.equal(held.state.mode, "held");
      assert.equal(await page.blocking(), false);
      await page.click(".bsk-cooperation-primary", true);
      await poll(() => page.blocking(), "explicit hand-back restores lock");
      await page.type("x");
      assert.equal(await page.read("document.querySelector('#value').value"), "Agenth");
      await page.click('[data-slot="control-overlay-stop-all"]', true);
      await poll(async () => !(await page.blocking()), "Stop releases mask");
      await page.type("z");
      assert.equal(await page.read("document.querySelector('#value').value"), "Agenthz");
      evidence.push(
        "Pause persists across idle sync; explicit Resume relocks; Stop restores input",
      );
      await cli(["session", "stop", task]);

      const borrowedTask = (await cli(["session", "start", "--lock-input"])).session_id;
      const userWindow = await background(
        `chrome.windows.create({url:[${JSON.stringify(base + "/borrowed")},"about:blank"],focused:false})`,
      );
      const borrowedId = userWindow.tabs[0].id;
      const borrowedPage = await attach(base + "/borrowed");
      await cli(["tab", "borrow", String(borrowedId), ...scope(borrowedTask)]);
      await sync(borrowedTask);
      await poll(() => borrowedPage.blocking(), "borrowed page lock");
      await borrowedPage.read("document.querySelector('#value').focus()");
      await borrowedPage.type("x");
      assert.equal(await borrowedPage.read("document.querySelector('#value').value"), "");
      await act(borrowedTask, ["tab", "return", String(borrowedId)]);
      await poll(async () => !(await borrowedPage.blocking()), "returned page unlock");
      await borrowedPage.type("r");
      assert.equal(await borrowedPage.read("document.querySelector('#value').value"), "r");
      assert.equal((await background(`chrome.tabs.get(${borrowedId})`)).windowId, userWindow.id);
      evidence.push(
        "borrowing applies the session lock; returning restores human input and original window",
      );
      await cli(["session", "stop", borrowedTask]);
      const disconnectedTask = (await cli(["session", "start", "--lock-input"])).session_id;
      await cli(["tab", "borrow", String(borrowedId), ...scope(disconnectedTask)]);
      await sync(disconnectedTask);
      await poll(() => borrowedPage.blocking(), "lock before disconnect");
      await exec(executable, ["daemon", "stop"], { env, timeout: 15000 });
      transcript.push({ args: ["daemon", "stop"], result: "stopped" });
      await poll(async () => !(await borrowedPage.blocking()), "disconnect releases input");
      await borrowedPage.read("document.querySelector('#value').focus()");
      await borrowedPage.type("d");
      assert.equal(await borrowedPage.read("document.querySelector('#value').value"), "rd");
      evidence.push("disconnect returns borrowed pages and releases their input lock");
      transcript.push({ browser: await send("Browser.getVersion") });
    },
  );
  console.log(JSON.stringify({ passed: evidence }, null, 2));
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "result.json"),
    JSON.stringify({ evidence, transcript }, null, 2) + "\n",
  );
  await writeFile(join(output, "daemon.log"), daemonLog);
  daemon.kill("SIGTERM");
  if (daemon.exitCode === null) await once(daemon, "exit");
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
