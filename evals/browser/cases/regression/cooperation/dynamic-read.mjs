import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { withChrome } from "../snapshot-coordinates/chrome.mjs";
import { createDshRegressionClient } from "./dsh-client.mjs";
import { createMcpRegressionClient } from "./mcp-client.mjs";

// Own every process/profile/session. Never reload the user's extension or daemon.
const cli = resolve(process.env.BSK_DYNAMIC_CLI ?? "target/debug/bsk");
const extensionPath = resolve(
  process.env.BSK_DYNAMIC_EXTENSION ?? "apps/extension/dist/chrome-mv3",
);
const executable = process.env.BSK_COOP_CHROME;
const port = Number(process.env.BSK_DYNAMIC_PORT ?? 52923);
const artifacts = resolve(process.env.BSK_DYNAMIC_ARTIFACTS ?? "reports/dynamic-read");
assert(executable, "BSK_COOP_CHROME must name an isolated-test browser executable");
assert(port !== 52800);
assert(
  (await readFile(join(extensionPath, "background.js"), "utf8")).includes(`ws://127.0.0.1:${port}`),
);
await mkdir(artifacts, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "bsk-dynamic-read-"));
const env = { ...process.env, BSK_HOME: home, BSK_AUTO_START: "0", BSK_AUTO_UPDATE: "off" };
const exec = promisify(execFile);
const evidence = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function bsk(label, args, reason, bin = cli) {
  const started = performance.now();
  let output;
  try {
    const result = await exec(bin, [...args, "--json"], {
      env,
      timeout: 45000,
      maxBuffer: 8 * 1024 * 1024,
    });
    output = { exit: 0, data: JSON.parse(result.stdout) };
  } catch (error) {
    if (!error.stdout) throw error;
    output = { exit: error.code, data: JSON.parse(error.stdout) };
  }
  const record = { label, args, elapsed_ms: Math.round(performance.now() - started), ...output };
  evidence.push(record);
  await writeFile(
    join(artifacts, `${String(evidence.length).padStart(3, "0")}-${label}.json`),
    JSON.stringify(record, null, 2),
  );
  if (typeof reason === "function") reason(output);
  else if (reason)
    assert(
      (Array.isArray(reason) ? reason : [reason]).includes(output.data.data?.reason),
      JSON.stringify(record),
    );
  else assert.equal(output.exit, 0, JSON.stringify(record));
  return output.data;
}
async function poll(read) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error("setup timed out");
}
const html = await readFile(new URL("dynamic-read.html", import.meta.url));
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (req.url.startsWith("/frame"))
    res.end(
      `<title>Frame</title><button id="frame-button" data-id="frame">${req.url.includes("cross") ? "Cross frame action" : "Frame action"}</button><iframe title="Nested" src="/nested"></iframe>`,
    );
  else if (req.url.startsWith("/nested"))
    res.end('<button id="nested-button">Nested action</button>');
  else if (req.url.startsWith("/ad")) res.end(`<title>Ad</title><p>${req.url}</p>`);
  else res.end(html);
});
let daemon,
  daemonLog = "";
const results = [];
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  daemon = spawn(cli, ["daemon", "start", "--foreground", "--port", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr])
    stream.on("data", (chunk) => (daemonLog = (daemonLog + chunk).slice(-131072)));
  await poll(() =>
    exec(cli, ["status", "--json"], { env }).then(
      (r) => JSON.parse(r.stdout),
      () => false,
    ),
  );
  await withChrome(
    {
      executable,
      extensionPath,
      extensionViaCdp: true,
      deviceScale: 1,
      zoom: 1,
      headless: process.env.BSK_DYNAMIC_HEADFUL !== "1",
      disableGpu: false,
      extraArgs: ["--disable-background-timer-throttling"],
      startupTimeout: 30000,
    },
    async (send) => {
      await poll(() =>
        exec(cli, ["browsers", "--json"], { env }).then(
          (r) => JSON.parse(r.stdout).length,
          () => false,
        ),
      );
      await bsk("environment", ["status"]);
      await writeFile(
        join(artifacts, "browser-version.json"),
        JSON.stringify(await send("Browser.getVersion"), null, 2),
      );
      const attach = async (url) => {
        const target = await poll(async () =>
          (await send("Target.getTargets")).targetInfos.find((t) => t.url === url),
        );
        const { sessionId } = await send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        });
        return { targetId: target.targetId, sessionId };
      };
      const evaluate = async (sessionId, expression) => {
        const reply = await send(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        );
        assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
        return reply.result.value;
      };
      for (const policy of ["target", "strict"]) {
        const started = await bsk(`${policy}-start`, [
          "session",
          "start",
          "--name",
          `dynamic-read-${policy}`,
        ]);
        const session = started.session_id,
          scope = ["--session", session];
        let cdp;
        try {
          await bsk(`${policy}-navigate`, ["navigate", `${base}/?policy=${policy}`, ...scope]);
          cdp = await attach(`${base}/?policy=${policy}`);
          const page = (expression) => evaluate(cdp.sessionId, expression);
          const sync = () =>
            bsk(`${policy}-sync`, ["cooperate", "sync", ...scope, "--policy", policy]);
          let observed = await sync();
          let context = observed.context_id;
          const read = (label, selector, fields) =>
            bsk(label, [
              "read",
              ...scope,
              ...(selector ? ["--selector", selector] : []),
              ...(fields ? ["--fields-json", JSON.stringify(fields)] : []),
            ]);
          const before = await read(`${policy}-before`, "#clock");
          // Model/scheduler-scale delay, during continuous text, DOM, style, canvas and frame updates.
          await delay(5500);
          const after = await read(`${policy}-after`, "#clock");
          assert(Number(after.items[0].values.text) > Number(before.items[0].values.text));
          assert((await page("rotations")) >= 3);
          const facts = await read(`${policy}-business`, "#business", [
            { key: "price", read: "text", selector: "#price" },
            { key: "recipient", read: "text", selector: "#recipient" },
            { key: "label", read: "text", selector: "#apply" },
            { key: "id", read: "attribute", attribute: "data-record-id", selector: "#apply" },
          ]);
          assert.deepEqual(facts.items[0].values, {
            price: "100",
            recipient: "Alice",
            label: "Apply",
            id: "42",
          });
          const refusal = await bsk(
            `${policy}-script-refused`,
            [
              "evaluate",
              "document.title",
              ...scope,
              "--context",
              context,
              "--observation",
              observed.observation_id,
            ],
            policy === "target"
              ? ["observation_changed", "document_changed"]
              : "cooperation_sync_required",
          );
          assert.equal(refusal.data.effect_state, "none");
          if (policy === "strict") {
            // Passive reads do not renew the consumed strict baseline.
            await read("strict-read-after-refusal", "#apply");
            await bsk(
              "strict-no-renewal",
              ["click", "#apply", ...scope, "--context", context],
              "cooperation_sync_required",
            );
            results.push({
              policy,
              read_across_dynamic_change: true,
              strict_guard_preserved: true,
            });
            continue;
          }
          const checks = [
            { target: "#price", field: "text", equals: "100" },
            { target: "#recipient", field: "text", equals: "Alice" },
            { target: "#apply", field: "text", equals: "Apply" },
            { target: "#apply", field: "attribute", attribute: "data-record-id", equals: "42" },
          ];
          const click = async (label, target = "#apply", expect = checks, reason) =>
            bsk(
              label,
              [
                "click",
                target,
                ...scope,
                "--context",
                context,
                "--expect",
                JSON.stringify(expect),
                "--timeout",
                reason ? "500ms" : "3000ms",
              ],
              reason,
            );
          await click("target-workflow-click");
          assert.equal((await read("target-workflow-result", "#result")).items[0].values.text, "1");
          await page("document.querySelector('#price').textContent='200'");
          await click("price-rejected", "#apply", checks, "precondition_failed");
          await page(
            "document.querySelector('#price').textContent='100';document.querySelector('#apply').dataset.recordId='99'",
          );
          await click("reused-record-rejected", "#apply", checks, "precondition_failed");
          await page(
            "document.querySelector('#apply').dataset.recordId='42';document.querySelector('#apply').textContent='Delete'",
          );
          await click("meaning-rejected", "#apply", checks, "precondition_failed");
          await page("document.querySelector('#apply').textContent='Apply'");
          // Restored values may authorize a newly chosen target-policy action; no refusal is auto-retried.
          await click("restored-facts-accepted");
          assert.equal(await page("applied"), 2);
          for (const [kind, setup, reason] of [
            ["disabled", "document.querySelector('#apply').disabled=true", "target_disabled"],
            ["hidden", "document.querySelector('#apply').style.display='none'", "target_hidden"],
            [
              "covered",
              "let cover=document.createElement('div');cover.id='cover';cover.style='position:fixed;inset:0;z-index:10000;background:#fff';document.body.append(cover)",
              "target_covered",
            ],
          ]) {
            await page(setup);
            const rejected = await click(`${kind}-rejected`, "#apply", checks, [
              reason,
              "action_timeout",
            ]);
            if (kind !== "covered") assert.equal(rejected.data.effect_state, "none");
            else assert(["none", "unknown"].includes(rejected.data.effect_state));
            assert.equal(await page("applied"), 2);
            await page(
              "document.querySelector('#apply').disabled=false;document.querySelector('#apply').style.display='';document.querySelector('#cover')?.remove()",
            );
          }
          observed = await sync();
          context = observed.context_id;
          // Change a checked fact in the browser's mouseover handler, after the
          // initial check but before the final native press. No click may follow.
          await bsk("race-move-away", ["hover", "#apply", ...scope, "--context", context]);
          await page("document.querySelector('#price').textContent='100';window.armRace=true");
          await read("race-before", "#price");
          await click(
            "last-moment-fact-rejected",
            "#race",
            [{ target: "#price", field: "text", equals: "100" }],
            "precondition_failed",
          );
          assert.equal(await page("applied"), 2);
          await page("window.armRace=false;document.querySelector('#price').textContent='100'");
          observed = await sync();
          context = observed.context_id;
          const original = await read("read-exact-node", "#apply");
          await page(
            "document.querySelector('#apply').replaceWith(document.querySelector('#apply').cloneNode(true))",
          );
          await bsk(
            "read-detached-rejected",
            ["read", ...scope, "--ref", original.items[0].ref],
            "read_target_stale",
          );
          await click("click-detached-rejected", original.items[0].ref, [], "target_detached");
          // A new observation chooses a replacement; no old ref is redirected.
          observed = await sync();
          // Fixed isolated code must not call page-world getters, serialization hooks or timers.
          await page(
            `window.__nativeReadDescriptors={value:Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value'),attribute:Element.prototype.getAttribute};Object.defineProperty(HTMLInputElement.prototype,'value',{configurable:true,get(){readEffects++;setTimeout(()=>readEffects++,50);return 'unsafe'}});Element.prototype.getAttribute=function(){readEffects++;return 'unsafe'};Object.prototype.toJSON=function(){readEffects++;return 'unsafe'}`,
          );
          assert.equal(
            (await read("isolated-native-value", "#note", [{ key: "value", read: "value" }]))
              .items[0].values.value,
            "initial",
          );
          assert.equal(
            (
              await read("isolated-native-attribute", "#apply", [
                { key: "id", read: "attribute", attribute: "data-record-id" },
              ])
            ).items[0].values.id,
            "42",
          );
          await delay(150);
          assert.equal(await page("readEffects"), 0);
          await page(
            "Object.defineProperty(HTMLInputElement.prototype,'value',__nativeReadDescriptors.value);Element.prototype.getAttribute=__nativeReadDescriptors.attribute;delete Object.prototype.toJSON",
          );
          // Read a shadow target through the observed ref.
          const shadow = observed.observation.text.match(/(@e\d+) button "Shadow action"/)?.[1];
          assert(shadow, observed.observation.text);
          assert.equal(
            (await bsk("shadow-read", ["read", ...scope, "--ref", shadow])).items[0].values.text,
            "Shadow action",
          );
          const frame = observed.observation.text.match(/(@e\d+) button "Frame action"/)?.[1];
          assert(frame, observed.observation.text);
          assert.equal(
            (await bsk("frame-read", ["read", ...scope, "--ref", frame])).items[0].values.text,
            "Frame action",
          );
          for (const label of ["Cross frame action", "Nested action"]) {
            const line = observed.observation.text
              .split("\n")
              .find((line) => line.includes(`button "${label}"`));
            const ref = line?.match(/@e\d+/)?.[0];
            assert(ref, observed.observation.text);
            const result = await bsk(`read-${label.replaceAll(" ", "-")}`, [
              "read",
              ...scope,
              "--ref",
              ref,
            ]);
            assert.equal(result.items[0].values.text, label);
            if (label === "Cross frame action")
              assert(new URL(result.frame_url).hostname === "localhost");
          }
          await page("document.querySelector('#stable-frame').src='/frame?new'");
          await delay(250);
          await bsk(
            "frame-action-stale",
            ["click", frame, ...scope, "--context", observed.context_id],
            "document_changed",
          );
          await read("root-read-after-child-navigation", "#price");
          observed = await sync();
          const old = observed.context_id;
          const oldref = (await read("before-spa", "#note")).items[0].ref;
          await page(
            "history.pushState({},'', '/other');history.replaceState({},'', '/?policy=target')",
          );
          await bsk(
            "spa-context-rejected",
            ["click", "#apply", ...scope, "--context", old],
            "control_context_invalid",
          );
          await bsk(
            "spa-read-context-rejected",
            ["read", ...scope, "--context", old],
            "control_context_invalid",
          );
          await bsk("spa-ref-rejected", ["read", ...scope, "--ref", oldref], "ref_not_found");
          await read("read-does-not-renew-spa-context", "#price");
          await bsk(
            "spa-still-rejected",
            ["click", "#apply", ...scope, "--context", old],
            "control_context_invalid",
          );
          results.push({
            policy,
            read_across_dynamic_change: true,
            workflow: true,
            preconditions: true,
            target_identity: true,
            spa: true,
            isolated_getters: true,
          });
        } finally {
          if (cdp)
            await send("Target.detachFromTarget", { sessionId: cdp.sessionId }).catch(() => {});
          await bsk(`${policy}-stop`, ["session", "stop", session]);
        }
      }
      for (const client of ["mcp", "dsh"]) {
        const api =
          client === "mcp"
            ? await createMcpRegressionClient(cli, env)
            : createDshRegressionClient(cli, env, { legacyStrict: false });
        let session;
        let clientSequence = 0;
        const call = async (label, name, args, reason) => {
          let value;
          try {
            value = await api.run(name, args, client === "mcp" ? reason : undefined);
          } catch (error) {
            if (!reason) throw error;
            assert.equal(error.data?.reason, reason);
            value = { message: error.message, data: error.data };
          }
          await writeFile(
            join(artifacts, `${client}-${String(++clientSequence).padStart(3, "0")}-${label}.json`),
            JSON.stringify({ name, args, value }, null, 2),
          );
          return value;
        };
        try {
          const start = await call("start", "bsk_session", { action: "start" });
          session = start.session_id ?? start.sessionId;
          assert(session, JSON.stringify(start));
          await call("navigate", "bsk_page", {
            action: "navigate",
            session,
            url: `${base}/?client=${client}`,
          });
          const observed = await call("sync", "bsk_session", { action: "sync", session });
          const read = (selector) =>
            call(`read-${selector.slice(1)}`, "bsk_inspect", { action: "read", session, selector });
          const before = await read("#clock");
          await delay(5500);
          const after = await read("#clock");
          assert(Number(after.items[0].values.text) > Number(before.items[0].values.text));
          const facts = await read("#price");
          assert.equal(facts.items[0].values.text, "100");
          const action = (selector, expect) =>
            client === "mcp"
              ? {
                  action: "click",
                  session,
                  context: observed.context_id,
                  params: { selector },
                  ...(expect ? { expect } : {}),
                }
              : {
                  action: "click",
                  session,
                  contextId: observed.context_id,
                  target: selector,
                  ...(expect ? { expect } : {}),
                };
          const checks = [
            { target: "#price", field: "text", equals: "100" },
            { target: "#apply", field: "attribute", attribute: "data-record-id", equals: "42" },
          ];
          await call("click", "bsk_interact", action("#apply", checks));
          assert.equal((await read("#result")).items[0].values.text, "1");
          await call("change-price", "bsk_interact", action("#advance"));
          await call(
            "changed-fact-rejected",
            "bsk_interact",
            action("#apply", checks),
            "precondition_failed",
          );
          assert.equal((await read("#result")).items[0].values.text, "1");
          results.push({ client, delayed_read_workflow: true, expect_preserved: true });
        } finally {
          if (session) await call("stop", "bsk_session", { action: "stop", session });
          await api.dispose();
        }
      }
      {
        const planCli = process.env.BSK_DYNAMIC_PLAN_CLI ?? cli;
        const session = (await bsk("plan-start", ["session", "start"])).session_id;
        const scope = ["--session", session];
        try {
          await bsk("plan-navigate", ["navigate", `${base}/?client=plan`, ...scope]);
          const observed = await bsk("plan-sync", ["cooperate", "sync", ...scope]);
          await delay(5500);
          await bsk("plan-supplementary-read", ["read", "--selector", "#price", ...scope]);
          await bsk(
            "plan-relevant-change-rejected",
            [
              "plan",
              ...scope,
              "--context",
              observed.context_id,
              "--steps",
              JSON.stringify([
                { action: "click", selector: "#advance" },
                {
                  action: "click",
                  selector: "#apply",
                  expect: [{ target: "#price", field: "text", equals: "100" }],
                },
              ]),
            ],
            ({ exit, data }) => {
              assert.notEqual(exit, 0);
              assert.equal(data.completed, 1);
              assert.equal(data.stopped.error.data.reason, "precondition_failed");
              assert.equal(data.stopped.effect_state, "none");
            },
            planCli,
          );
          assert.equal(
            (await bsk("plan-no-replay", ["read", "--selector", "#result", ...scope])).items[0]
              .values.text,
            "0",
          );
          results.push({ client: "plan", per_step_expect: true, no_replay: true });
        } finally {
          await bsk("plan-stop", ["session", "stop", session]);
        }
      }
      if (process.env.BSK_DYNAMIC_OCEAN === "1") {
        const started = await bsk("ocean-start", [
          "session",
          "start",
          "--name",
          "dynamic-read-ocean",
        ]);
        const session = started.session_id,
          scope = ["--session", session];
        let cdp;
        try {
          await bsk("ocean-capabilities", ["debug", "capabilities", ...scope]);
          await bsk("ocean-debug-start", [
            "debug",
            "start",
            ...scope,
            "--name",
            "dynamic-read-ocean",
          ]);
          await bsk("ocean-navigate", ["navigate", "https://www.oceanengine.com/", ...scope]);
          cdp = await attach("https://www.oceanengine.com/");
          const tree = await send("Page.getFrameTree", {}, cdp.sessionId);
          const isolated = await send(
            "Page.createIsolatedWorld",
            { frameId: tree.frameTree.frame.id, worldName: "bsk-pagination-evidence" },
            cdp.sessionId,
          );
          const page = async (expression) => {
            const reply = await send(
              "Runtime.evaluate",
              { expression, contextId: isolated.executionContextId, returnByValue: true },
              cdp.sessionId,
            );
            assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
            return reply.result.value;
          };
          // Read-only identity tracking: observe removals, never patch or pause site behavior.
          await page(
            `window.__bskPaginationEvidence={samples:[],removed:[]};window.__bskPaginationNodes=[...document.querySelectorAll('.banner-wrapper .swiper-pagination-bullet')];new MutationObserver(records=>{for(const record of records)for(const n of record.removedNodes)if(n.nodeType===1&&(n.matches?.('.swiper-pagination-bullet')||n.querySelector?.('.swiper-pagination-bullet')))__bskPaginationEvidence.removed.push({time:Date.now(),html:n.outerHTML.slice(0,1000)})}).observe(document.querySelector('.banner-wrapper'),{childList:true,subtree:true})`,
          );
          const fields = [
            { key: "index", read: "attribute", attribute: "data-swiper-slide-index" },
            { key: "class", read: "attribute", attribute: "class" },
            { key: "text", read: "text" },
          ];
          for (let i = 0; i < 3; i++) {
            const observed = await bsk(`ocean-${i}-sync`, ["cooperate", "sync", ...scope]);
            const before = await bsk(`ocean-${i}-before`, [
              "read",
              ...scope,
              "--selector",
              ".banner-wrapper .swiper-slide-active",
              "--fields-json",
              JSON.stringify(fields),
            ]);
            const oldButtons = await bsk(`ocean-${i}-old-buttons`, [
              "read",
              ...scope,
              "--selector",
              ".banner-wrapper .swiper-pagination-bullet",
              "--fields-json",
              JSON.stringify([{ key: "label", read: "attribute", attribute: "aria-label" }]),
            ]);
            await delay(5500);
            const after = await bsk(`ocean-${i}-after`, [
              "read",
              ...scope,
              "--selector",
              ".banner-wrapper .swiper-slide-active",
              "--fields-json",
              JSON.stringify(fields),
            ]);
            assert.notEqual(
              after.items[0].values.index,
              before.items[0].values.index,
              "Carousel must cross a real autoplay transition",
            );
            await bsk(
              `ocean-${i}-evaluate-refused`,
              [
                "evaluate",
                "document.title",
                ...scope,
                "--context",
                observed.context_id,
                "--observation",
                observed.observation_id,
              ],
              "observation_changed",
            );
            const detached = await bsk(
              `ocean-${i}-old-node-rejected`,
              ["click", oldButtons.items[0].ref, ...scope, "--context", observed.context_id],
              "target_detached",
            );
            assert.equal(detached.data.effect_state, "none");
            const desired = (Number(after.items[0].values.index) + 2) % 9;
            const selector = `.banner-wrapper [aria-label="Go to slide ${desired + 1}"]`;
            const button = await bsk(`ocean-${i}-button`, [
              "read",
              ...scope,
              "--selector",
              selector,
              "--fields-json",
              JSON.stringify([{ key: "label", read: "attribute", attribute: "aria-label" }]),
            ]);
            assert.equal(button.items.length, 1);
            // Decide from the live read, protect the selected button's meaning, act with the original reusable context.
            await bsk(`ocean-${i}-click`, [
              "click",
              button.items[0].ref,
              ...scope,
              "--context",
              observed.context_id,
              "--expect",
              JSON.stringify([
                {
                  target: button.items[0].ref,
                  field: "attribute",
                  attribute: "aria-label",
                  equals: button.items[0].values.label,
                },
              ]),
            ]);
            await delay(700);
            const post = await bsk(`ocean-${i}-post`, [
              "read",
              ...scope,
              "--selector",
              ".banner-wrapper .swiper-slide-active",
              "--fields-json",
              JSON.stringify(fields),
            ]);
            assert.equal(post.items[0].values.index, String(desired));
            results.push({
              ocean_trial: i,
              before: before.items[0].values.index,
              after: after.items[0].values.index,
              chosen: desired,
              post: post.items[0].values.index,
              context: observed.context_id,
            });
          }
          await writeFile(
            join(artifacts, "ocean-pagination-identity.json"),
            JSON.stringify(
              await page(
                `({...__bskPaginationEvidence,originalsConnected:__bskPaginationNodes.map(n=>n.isConnected),sameNodes:__bskPaginationNodes.map((n,i)=>n===document.querySelectorAll('.banner-wrapper .swiper-pagination-bullet')[i])})`,
              ),
              null,
              2,
            ),
          );
          const shot = await send("Page.captureScreenshot", { format: "png" }, cdp.sessionId);
          await writeFile(join(artifacts, "ocean.png"), Buffer.from(shot.data, "base64"));
        } finally {
          await bsk("ocean-debug-stop", ["debug", "stop", ...scope]);
          await bsk("ocean-debug-export", [
            "debug",
            "export",
            ...scope,
            "--output",
            join(artifacts, "ocean-debug.json"),
          ]);
          if (cdp)
            await send("Target.detachFromTarget", { sessionId: cdp.sessionId }).catch(() => {});
          await bsk("ocean-stop", ["session", "stop", session]);
        }
      }
    },
  );
  await writeFile(
    join(artifacts, "summary.json"),
    JSON.stringify({ results, commands: evidence.length }, null, 2),
  );
  console.log(JSON.stringify({ results, commands: evidence.length, artifacts }, null, 2));
} finally {
  await writeFile(join(artifacts, "daemon.log"), daemonLog);
  if (daemon?.exitCode === null) {
    const closed = once(daemon, "exit");
    daemon.kill();
    await closed;
  }
  await new Promise((r) => server.close(r));
  await rm(home, { recursive: true, force: true });
}
