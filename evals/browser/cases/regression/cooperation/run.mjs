import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { withChrome } from "../snapshot-coordinates/chrome.mjs";
import { attachExtensionWorker, runCompatibilityScenarios } from "./compatibility.mjs";
import { runDialogScenarios } from "./dialogs.mjs";
import { runDefaultDshScenario } from "./dsh-client.mjs";
import { runLifetimeScenario } from "./lifetime.mjs";
import { runGenericScenarios } from "./scenarios.mjs";

const executable = process.env.BSK_COOP_CHROME;
const cli = resolve(process.env.BSK_COOP_CLI ?? "target/debug/bsk");
const extensionPath = resolve(process.env.BSK_COOP_EXTENSION ?? "apps/extension/dist/chrome-mv3");
const port = Number(process.env.BSK_COOP_PORT ?? 52917);
const artifacts = process.env.BSK_COOP_ARTIFACTS;
const loadExtensionOverCdp = process.env.BSK_COOP_LOAD_CDP === "1";
const compatibilityOnly = process.env.BSK_COOP_COMPAT_ONLY === "1";
const fullIdle = process.env.BSK_COOP_FULL_IDLE === "1";
const headful = process.env.BSK_COOP_HEADFUL === "1";
const deviceScale = Number(process.env.BSK_COOP_DPR ?? 1);
// The full run uses the unmodified five-minute session default and 30-second reaper.
const idleWaitMs = fullIdle ? 360500 : 12500;
if (artifacts) await mkdir(artifacts, { recursive: true });
assert(executable, "Set BSK_COOP_CHROME to an isolated Chromium executable");
assert(port !== 52800 && Number.isInteger(port));
assert(
  (await readFile(join(extensionPath, "background.js"), "utf8")).includes(`ws://127.0.0.1:${port}`),
  "Build with BSK_DAEMON_WS_URL pointing to the isolated test port",
);
const directory = await mkdtemp(join(tmpdir(), "bsk-cooperation-"));
const env = {
  ...process.env,
  BSK_HOME: directory,
  BSK_AUTO_START: "0",
  BSK_AUTO_UPDATE: "off",
  RUST_LOG: "info",
};
const exec = promisify(execFile);
const bsk = async (args, failure = false) => {
  if (process.env.BSK_COOP_DEBUG) console.error("step", args.slice(0, 3).join(" "));
  try {
    const { stdout } = await exec(cli, [...args, "--json"], {
      env,
      timeout: 35000,
      maxBuffer: 2 ** 20,
    });
    assert(!failure, `Unexpectedly accepted stale/blocked action: ${args.join(" ")}`);
    return JSON.parse(stdout);
  } catch (error) {
    if (!failure || !error.stdout) {
      if (args.includes("--context")) {
        const scope = ["--session", args[args.indexOf("--session") + 1]];
        if (args.includes("--tab-id")) scope.push("--tab-id", args[args.indexOf("--tab-id") + 1]);
        const diagnostic = await exec(cli, ["cooperate", "status", ...scope, "--json"], {
          env,
        }).then(
          ({ stdout }) => JSON.parse(stdout),
          (failure) => ({ error: failure.stdout }),
        );
        console.error("action-state", JSON.stringify({ action: args, diagnostic }));
        if (artifacts)
          await writeFile(
            join(artifacts, "failure.json"),
            JSON.stringify({ action: args, diagnostic }, null, 2),
          );
      }
      throw error;
    }
    const result = JSON.parse(error.stdout);
    assert.equal(
      result.data?.reason,
      typeof failure === "string" ? failure : "cooperation_sync_required",
      JSON.stringify(result),
    );
    return result;
  }
};
const poll = async (read, label = "setup") => {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Timed out: ${label}`);
};
const html = await readFile(new URL("fixture.html", import.meta.url));
const dialogHtml = await readFile(new URL("dialogs.html", import.meta.url));
const submissions = [];
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/dialogs")) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(dialogHtml);
  } else if (req.url === "/submit") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const submission = JSON.parse(body);
    submissions.push(submission);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...submission, count: submissions.length }));
  } else {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      req.url === "/frame" ? '<label>Frame note <input aria-label="Frame note"></label>' : html,
    );
  }
});
let browserVersion;
let compatibility;
let dialogs;
let daemon;
let daemonOutput = "";
const evidence = [];
const executionContexts = new Map();
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  daemon = spawn(
    cli,
    [
      "daemon",
      "start",
      "--foreground",
      "--port",
      String(port),
      // Capability-only runs must not inherit the accelerated idle-test clock.
      ...(fullIdle || compatibilityOnly ? [] : ["--session-idle", "8s"]),
    ],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [daemon.stdout, daemon.stderr])
    stream.on("data", (chunk) => {
      daemonOutput = (daemonOutput + chunk).slice(-65536);
    });
  await poll(async () => {
    try {
      return await bsk(["status"]);
    } catch {
      return false;
    }
  });
  await withChrome(
    {
      executable,
      extensionPath,
      deviceScale,
      zoom: Number(process.env.BSK_COOP_ZOOM ?? 1),
      headless: !headful,
      disableGpu: !headful,
      softwareRendering: !headful,
      // Headless screen size is independent of window size; preserve CSS space at high DPR.
      // Preserve native occlusion: overriding it can report minimized macOS windows as visible.
      extraArgs: headful ? [] : [`--screen-info={${1600 * deviceScale}x${1200 * deviceScale}}`],
      startupTimeout: 30000,
      extensionViaCdp: loadExtensionOverCdp,
      onEvent: (event) => {
        if (event.method === "Runtime.executionContextCreated")
          executionContexts.set(`${event.sessionId}:${event.params.context.id}`, {
            ...event.params.context,
            session: event.sessionId,
          });
        if (event.method === "Runtime.executionContextDestroyed")
          executionContexts.delete(`${event.sessionId}:${event.params.executionContextId}`);
        if (event.method === "Runtime.executionContextsCleared")
          for (const [key, context] of executionContexts)
            if (context.session === event.sessionId) executionContexts.delete(key);
        if (process.env.BSK_COOP_DEBUG && event.method === "Runtime.exceptionThrown")
          console.error("renderer", JSON.stringify(event.params));
      },
    },
    async (send) => {
      browserVersion = (await send("Browser.getVersion")).product;
      await poll(async () => (await bsk(["browsers"])).length, "extension connection");
      dialogs = await runDialogScenarios({ send, bsk, base });
      for (const seed of compatibilityOnly ? [] : [4, 7, 14]) {
        const { session_id: session } = await bsk(["session", "start"]);
        const scope = ["--session", session];
        const url = `${base}/?seed=${seed}`;
        let userSession;
        try {
          if (seed === 4) {
            await bsk(["emulate", "--device", "iphone-14", ...scope]);
            await bsk(["emulate", "--off", ...scope]);
          }
          await bsk(["navigate", url, ...scope]);
          const targets = await send("Target.getTargets");
          const target = targets.targetInfos.find((t) => t.url === url);
          assert(target);
          ({ sessionId: userSession } = await send("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
          }));
          await send("Runtime.enable", {}, userSession);
          await send("Page.bringToFront", {}, userSession);
          const evaluate = async (expression) => {
            const result = await send(
              "Runtime.evaluate",
              { expression, returnByValue: true },
              userSession,
            );
            assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
            return result.result.value;
          };
          const epochSkew = { 4: 8.8, 7: -8.8, 14: 120_000 }[seed];
          const skewCollectorOrigins = async () => {
            const contexts = await poll(() => {
              const worlds = [...executionContexts.values()].filter(
                (context) =>
                  context.session === userSession &&
                  context.origin.startsWith("chrome-extension://"),
              );
              return worlds.length >= 2 && worlds;
            }, "main-frame and iframe collector clocks");
            for (const context of contexts) {
              const result = await send(
                "Runtime.evaluate",
                {
                  contextId: context.id,
                  expression: `Object.defineProperty(performance, 'timeOrigin', { configurable: true, value: performance.timeOrigin + ${epochSkew} })`,
                },
                userSession,
              );
              assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
            }
          };
          await skewCollectorOrigins();
          // Only the isolated collector clock is perturbed. An independent native-input
          // actor exercises real events; page evaluation reads the application's truth.
          const humanPointer = async (selector, type) => {
            const rect = await evaluate(
              `(() => { let root = document; const parts = ${JSON.stringify(selector)}.split(" >>> "); let element; for (const part of parts) { element = root.querySelector(part); root = element.shadowRoot; } const r = element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
            );
            await send(
              "Input.dispatchMouseEvent",
              { type, button: "left", clickCount: 1, ...rect },
              userSession,
            );
          };
          const humanClick = async (selector) => {
            await humanPointer(selector, "mousePressed");
            await humanPointer(selector, "mouseReleased");
          };
          const toolbarClick = async (index = 0) => {
            const point = await evaluate(
              `(() => { const r = document.querySelector('browser-skill-overlay').shadowRoot.querySelectorAll('[data-slot=cooperation-toolbar] button')[${index}].getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
            );
            await send(
              "Input.dispatchMouseEvent",
              { type: "mousePressed", button: "left", clickCount: 1, ...point },
              userSession,
            );
            await send(
              "Input.dispatchMouseEvent",
              { type: "mouseReleased", button: "left", clickCount: 1, ...point },
              userSession,
            );
          };
          const sync = () => bsk(["cooperate", "sync", ...scope]);
          const wait = () => bsk(["cooperate", "wait", ...scope, "--timeout-ms", "3000"]);
          // Neither client activates cooperation. The toolbar and capture exist before first sync.
          await poll(() =>
            evaluate(
              "!!document.querySelector('browser-skill-overlay')?.shadowRoot?.querySelector('[data-slot=cooperation-toolbar]')",
            ),
          );
          await bsk(["click", "#submit", ...scope], true);
          assert.equal(submissions.length, evidence.length, "missing context must never submit");
          // The preference controls only visual hints. Capture and stale-action
          // rejection must keep working while both card and target marker are hidden.
          if (seed === 4) {
            const workerSession = await attachExtensionWorker(send);
            try {
              const hints = async (hidden) => {
                const response = await send(
                  "Runtime.evaluate",
                  {
                    expression: `chrome.storage.local.set({bsk_control_hints_hidden:${hidden}})`,
                    awaitPromise: true,
                    returnByValue: true,
                  },
                  workerSession,
                );
                assert(!response.exceptionDetails, JSON.stringify(response));
              };
              const visible = () =>
                evaluate(
                  "!!document.querySelector('browser-skill-overlay')?.shadowRoot?.querySelector('[data-slot=cooperation-toolbar]')",
                );
              const before = await sync();
              assert.equal(before.kind, "baseline");
              await hints(true);
              await poll(async () => !(await visible()), "hidden cooperation card");
              await humanClick("#city");
              await bsk(["click", "#submit", ...scope, "--context", before.context_id], true);
              assert.equal((await bsk(["cooperate", "status", ...scope])).state.mode, "human");
              assert.equal(await visible(), false);
              await humanClick("#neutral");
              await wait();
              await hints(false);
              await poll(visible, "restored cooperation card");
            } finally {
              await send("Target.detachFromTarget", { sessionId: workerSession });
            }
          }
          await humanClick("#city");
          assert.equal(
            (await bsk(["cooperate", "wait", ...scope, "--timeout-ms", "100"])).ready,
            false,
          );
          await humanClick("#neutral");
          await wait();
          const baseline = await sync();
          assert(baseline.context_id, JSON.stringify(baseline));
          assert.equal(baseline.kind, seed === 4 ? "delta" : "baseline");
          assert(
            baseline.activity.some((event) => event.label.includes("City")),
            "capture precedes first sync",
          );
          scope.push("--tab-id", String(baseline.tab_id));
          await toolbarClick();
          await poll(
            async () => (await bsk(["cooperate", "status", ...scope])).state.mode === "held",
            "explicit hold",
          );
          if (artifacts && seed === 4) {
            const screenshot = await send("Page.captureScreenshot", { format: "png" }, userSession);
            await writeFile(
              join(artifacts, "manual-control.png"),
              Buffer.from(screenshot.data, "base64"),
            );
          }
          let idle;
          if (seed === 4)
            idle = await runLifetimeScenario({
              bsk,
              send,
              base,
              cli,
              env,
              session,
              idleWaitMs,
              fullIdle,
              artifacts,
            });
          await bsk(["click", "#submit", ...scope, "--context", baseline.context_id], true);
          await toolbarClick();
          assert.equal((await wait()).ready, true);
          const generic = await runGenericScenarios({
            bsk,
            scope,
            humanClick,
            humanPointer,
            evaluate,
            sync,
            wait,
          });
          const beforeReload = await sync();
          await send("Page.reload", {}, userSession);
          await poll(
            () =>
              evaluate("document.readyState === 'complete' && !!document.querySelector('#submit')"),
            "replacement document",
          );
          await bsk(["click", "#submit", ...scope, "--context", beforeReload.context_id], true);
          await skewCollectorOrigins();
          let afterHold = await sync();
          assert.equal(afterHold.kind, "baseline");
          // Changing the foreground page exercises fill's native, keyless caret
          // command. Foreground-only tests skip it and can miss false human attribution.
          const { targetId: otherTarget } = await send("Target.createTarget", {
            url: "about:blank",
          });
          try {
            assert.equal(
              (await send("Browser.getWindowForTarget", { targetId: otherTarget })).windowId,
              (await send("Browser.getWindowForTarget", { targetId: target.targetId })).windowId,
              "the unrelated foreground tab must be in the task window",
            );
            const { sessionId: otherSession } = await send("Target.attachToTarget", {
              targetId: otherTarget,
              flatten: true,
            });
            await send(
              "Page.setDocumentContent",
              {
                frameId: (await send("Page.getFrameTree", {}, otherSession)).frameTree.frame.id,
                html: '<label>Unrelated quantity<input id="quantity" value="untouched"></label><button id="scroll-probe" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Unrelated action</button>',
              },
              otherSession,
            );
            const otherState = async () =>
              (
                await send(
                  "Runtime.evaluate",
                  {
                    expression:
                      "({value:document.querySelector('#quantity').value,clicks:document.querySelector('#scroll-probe').dataset.clicks||'0',visible:document.visibilityState})",
                    returnByValue: true,
                  },
                  otherSession,
                )
              ).result.value;
            await send("Page.bringToFront", {}, otherSession);
            // A native human click in the unrelated foreground tab must not retarget
            // the task or invalidate an otherwise current task-page context.
            const {
              result: { value: otherPoint },
            } = await send(
              "Runtime.evaluate",
              {
                expression:
                  "(()=>{const r=document.querySelector('#scroll-probe').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
                returnByValue: true,
              },
              otherSession,
            );
            for (const type of ["mousePressed", "mouseReleased"])
              await send(
                "Input.dispatchMouseEvent",
                { type, ...otherPoint, button: "left", clickCount: 1 },
                otherSession,
              );
            assert.deepEqual(await otherState(), {
              value: "untouched",
              clicks: "1",
              visible: "visible",
            });
            await poll(
              async () => !(await evaluate("document.hasFocus()")),
              "shared page moved into background",
            );
            const implicitScope = ["--session", session];
            const implicitWait = await bsk(["cooperate", "wait", ...implicitScope]);
            assert.equal(
              implicitWait.tab_id,
              baseline.tab_id,
              "tab activation must not retarget the task",
            );
            await bsk([
              "fill",
              "#quantity",
              "--value",
              "2",
              ...implicitScope,
              "--context",
              afterHold.context_id,
            ]);
            assert.equal(await evaluate("document.querySelector('#quantity').value"), "2");
            const implicitSnapshot = await bsk(["snapshot", ...implicitScope]);
            assert.equal(implicitSnapshot.tab_id, baseline.tab_id);
            const implicitSync = await bsk(["cooperate", "sync", ...implicitScope]);
            assert.equal(implicitSync.tab_id, baseline.tab_id);
            assert.equal(
              (await wait()).ready,
              true,
              "background Agent fill must not create a human editing lease",
            );
            assert.equal(
              await evaluate("document.visibilityState"),
              "hidden",
              "Agent fill must not activate the background tab",
            );
            // Scroll in both a foreground and background renderer; the application's
            // counter is independent of the tool response and catches misdirected input.
            await evaluate(
              "document.querySelector('#scroll-probe').scrollIntoView({block:'center'})",
            );
            const scrolled = await sync();
            await bsk([
              "click",
              "#scroll-probe",
              ...implicitScope,
              "--depends-on",
              "#scroll-probe",
              "--context",
              scrolled.context_id,
            ]);
            assert.equal(await evaluate("document.querySelector('#scroll-count').value"), "1");
            assert.equal(await evaluate("document.visibilityState"), "hidden");
            assert.deepEqual(await otherState(), {
              value: "untouched",
              clicks: "1",
              visible: "visible",
            });
          } finally {
            await send("Target.closeTarget", { targetId: otherTarget });
          }
          await send("Page.bringToFront", {}, userSession);
          await evaluate(
            "document.querySelector('#scroll-probe').scrollIntoView({block:'center'})",
          );
          const foreground = await sync();
          await bsk([
            "click",
            "#scroll-probe",
            ...scope,
            "--depends-on",
            "#scroll-probe",
            "--context",
            foreground.context_id,
          ]);
          assert.equal(await evaluate("document.querySelector('#scroll-count').value"), "2");
          await evaluate("scrollTo(0,0)");
          const afterBackground = await sync();
          const initialCount = submissions.length;
          await humanClick("#mistake");
          const rejected = await bsk(
            ["click", "#submit", ...scope, "--context", afterBackground.context_id],
            true,
          );
          assert.equal(rejected.data.effect_state, "none");
          assert.equal(
            submissions.length,
            initialCount,
            "stale action reached the independent business oracle",
          );
          assert.equal((await wait()).ready, true);
          const changed = await sync();
          assert.equal(changed.kind, "delta", JSON.stringify(changed));
          assert(
            changed.changes.some((field) => field.label === "City" && field.value === "Beijing"),
          );
          await bsk([
            "fill",
            "#city",
            "--value",
            "Shanghai",
            ...scope,
            "--context",
            changed.context_id,
          ]);
          assert.equal(await evaluate("document.querySelector('#city').value"), "Shanghai");

          // Agent input inside a frame uses local DOM coordinates. Its native timestamp
          // must still identify it as Agent input, without creating a human editing lease.
          const frameLine = afterHold.observation.text
            .split("\n")
            .find((line) => line.includes("Frame note") && /@e\d+/.test(line));
          const frameRef = frameLine?.match(/@e\d+/)?.[0];
          assert(frameRef, afterHold.observation.text);
          for (let repeat = 0; repeat < 32; repeat++) {
            const forFrameClick = await sync();
            try {
              await bsk(["click", frameRef, ...scope, "--context", forFrameClick.context_id]);
            } catch (error) {
              console.error(
                "frame-attribution",
                JSON.stringify(await bsk(["cooperate", "status", ...scope])),
              );
              throw error;
            }
            assert.equal(
              (await wait()).ready,
              true,
              "Agent frame input must not seize human control",
            );
          }

          // Human input in an iframe revokes the top-level action context too.
          const beforeFrame = await sync();
          const point = await evaluate(
            "(() => {const f=document.querySelector('iframe'); const outer=f.getBoundingClientRect(); const inner=f.contentDocument.querySelector('input').getBoundingClientRect(); return {x:outer.x+inner.x+20,y:outer.y+inner.y+10};})()",
          );
          await send(
            "Input.dispatchMouseEvent",
            { type: "mousePressed", button: "left", clickCount: 1, ...point },
            userSession,
          );
          await send(
            "Input.dispatchMouseEvent",
            { type: "mouseReleased", button: "left", clickCount: 1, ...point },
            userSession,
          );
          await bsk(["click", "#submit", ...scope, "--context", beforeFrame.context_id], true);
          assert.equal(
            (await bsk(["cooperate", "wait", ...scope, "--timeout-ms", "50"])).ready,
            false,
          );
          await humanClick("#neutral");
          await wait();

          // Holding a text field is not silently released by elapsed quiet time.
          const beforeEdit = await sync();
          await humanClick("#city");
          if (seed === 7) {
            await send(
              "Input.imeSetComposition",
              { text: "上", selectionStart: 1, selectionEnd: 1 },
              userSession,
            );
          } else {
            await send(
              "Input.dispatchKeyEvent",
              { type: "keyDown", key: "a", text: "a" },
              userSession,
            );
            await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a" }, userSession);
          }
          assert.equal(
            (await bsk(["cooperate", "wait", ...scope, "--timeout-ms", "900"])).ready,
            false,
          );
          const humanValue = await evaluate("document.querySelector('#city').value");
          await bsk(
            ["fill", "#city", "--value", "Shanghai", ...scope, "--context", beforeEdit.context_id],
            true,
          );
          assert.equal(await evaluate("document.querySelector('#city').value"), humanValue);
          if (seed === 7)
            await send(
              "Input.imeSetComposition",
              { text: "", selectionStart: 0, selectionEnd: 0 },
              userSession,
            );
          await humanClick("#help");
          assert.equal(
            (await wait()).ready,
            true,
            "editing must hand back after composition ends and the field blurs",
          );
          const final = await sync();
          if (seed === 14) {
            // The person finishes the goal before the planned action. Reconciliation
            // must recognize that result instead of making a second submission.
            await humanClick("#submit");
            await wait();
          } else {
            await bsk(["click", "#submit", ...scope, "--context", final.context_id]);
          }
          await poll(() => submissions.length === initialCount + 1, "business submission");
          assert.deepEqual(submissions.at(-1), { city: "Shanghai", quantity: "2" });
          await bsk(["click", "#submit", ...scope, "--context", final.context_id], true);
          assert.equal(
            submissions.length,
            initialCount + 1,
            "replayed context caused a duplicate order",
          );
          const completed = await sync();
          assert.equal(completed.kind, "baseline");
          assert(completed.observation.text.includes("订单已提交"), JSON.stringify(completed));
          assert.equal(
            await evaluate(
              "!!document.querySelector('browser-skill-overlay')?.shadowRoot?.querySelector('[data-slot=control-overlay-blocker]')",
            ),
            false,
          );
          assert.equal(
            await evaluate(
              "!!document.querySelector('browser-skill-overlay')?.shadowRoot?.querySelector('[data-slot=cooperation-toolbar]')",
            ),
            true,
          );
          await toolbarClick(1);
          await poll(
            async () =>
              !(await evaluate(
                "!!document.querySelector('browser-skill-overlay')?.shadowRoot?.querySelector('[data-slot=cooperation-toolbar]')",
              )),
            "explicit task stop",
          );
          for (const action of ["wait", "sync"])
            await assert.rejects(
              bsk(["cooperate", action, ...scope]),
              (error) => JSON.parse(error.stdout).code === "user_aborted",
              "a stopped task must not be treated as temporary manual activity",
            );
          evidence.push({
            seed,
            generic,
            initialDeviceSetup: seed === 4,
            staleSubmissionBlocked: true,
            manualEditPreserved: true,
            compositionInput: seed === 7,
            humanCompletedGoal: seed === 14,
            explicitHold: true,
            explicitStop: true,
            iframeInput: true,
            agentIframeInput: true,
            agentBackgroundFill: true,
            stableImplicitTab: true,
            scrolledPointerClicks: 2,
            unrelatedTabPreserved: true,
            contextSurvivesUnrelatedInput: true,
            idleWaitMs: seed === 4 ? idleWaitMs : 0,
            idle,
            collectorEpochSkewMs: epochSkew,
            goal: submissions.at(-1),
            submissions: 1,
            incrementalSync: changed.kind,
          });
          await bsk(["session", "stop", session]);
          assert(
            (await send("Target.getTargets")).targetInfos.some(
              (t) => t.targetId === target.targetId,
            ),
            "shared page was closed during teardown",
          );
        } finally {
          try {
            await bsk(["session", "stop", session]);
          } catch {
            /* Already stopped. */
          }
          if (userSession)
            await send("Target.detachFromTarget", { sessionId: userSession }).catch(() => {});
        }
      }
      for (const interruptStart of compatibilityOnly ? [] : [false, true])
        evidence.push(await runDefaultDshScenario({ send, base, cli, env, interruptStart }));
      compatibility = await runCompatibilityScenarios({ send, bsk, cli, env, directory, headful });
      if (artifacts)
        await writeFile(
          join(artifacts, "compatibility-results.json"),
          JSON.stringify(compatibility, null, 2),
        );
      // Closing the bound task tab must fail closed while another live tab remains
      // in the same window, including callers that omit --tab-id.
      const { session_id: closedSession } = await bsk(["session", "start"]);
      const closedScope = ["--session", closedSession];
      let otherTarget;
      try {
        const url = `${base}/?closed-tab=1`;
        await bsk(["navigate", url, ...closedScope]);
        const task = (await send("Target.getTargets")).targetInfos.find((t) => t.url === url);
        assert(task);
        const context = await bsk(["cooperate", "sync", ...closedScope]);
        await send("Target.activateTarget", { targetId: task.targetId });
        ({ targetId: otherTarget } = await send("Target.createTarget", { url: "about:blank" }));
        assert.equal(
          (await send("Browser.getWindowForTarget", { targetId: otherTarget })).windowId,
          (await send("Browser.getWindowForTarget", { targetId: task.targetId })).windowId,
        );
        const { sessionId: otherSession } = await send("Target.attachToTarget", {
          targetId: otherTarget,
          flatten: true,
        });
        await send(
          "Page.setDocumentContent",
          {
            frameId: (await send("Page.getFrameTree", {}, otherSession)).frameTree.frame.id,
            html: '<button id="submit" onclick="this.dataset.clicked=1">Unrelated submit</button>',
          },
          otherSession,
        );
        await send("Page.bringToFront", {}, otherSession);
        await send("Target.closeTarget", { targetId: task.targetId });
        // CDP acknowledges the close request before Chrome finishes removing the
        // tab. Wait on the tab inventory, not a retry of the behavior under test.
        await poll(
          async () =>
            !(await bsk(["tab", "list", "--scope", "all", ...closedScope])).tabs.some(
              (tab) => tab.tab_id === context.tab_id,
            ),
          "task tab removed",
        );
        for (const args of [["cooperate", "wait"], ["cooperate", "sync"], ["snapshot"]])
          await assert.rejects(
            bsk([...args, ...closedScope]),
            (error) => JSON.parse(error.stdout).code === "not_found",
          );
        await bsk(["click", "#submit", ...closedScope, "--context", context.context_id], true);
        const untouched = await send(
          "Runtime.evaluate",
          {
            expression:
              "({clicked:document.querySelector('#submit').dataset.clicked||null,visible:document.visibilityState})",
            returnByValue: true,
          },
          otherSession,
        );
        assert.deepEqual(untouched.result.value, { clicked: null, visible: "visible" });
      } finally {
        await bsk(["session", "stop", closedSession]).catch(() => {});
        if (otherTarget)
          await send("Target.closeTarget", { targetId: otherTarget }).catch(() => {});
      }
    },
  );
  assert.deepEqual(
    submissions,
    evidence.map((entry) => entry.goal),
    "unexpected or duplicate submission outside the final action",
  );
  const report = {
    passed: true,
    browserVersion,
    headful,
    closedTaskTabFailsClosed: true,
    compatibility,
    dialogs,
    submissions,
    evidence,
  };
  console.log(JSON.stringify(report, null, 2));
  if (artifacts)
    await writeFile(join(artifacts, "browser-results.json"), JSON.stringify(report, null, 2));
} finally {
  if (daemon?.exitCode === null) {
    const exited = once(daemon, "exit");
    daemon.kill();
    await exited;
  }
  if (artifacts) await writeFile(join(artifacts, "daemon.log"), daemonOutput);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(directory, { recursive: true, force: true });
}
