import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withChrome } from "../snapshot-coordinates/chrome.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const cli = resolve(process.env.BSK_COOP_CLI ?? "target/debug/bsk");
const executable = process.env.BSK_COOP_CHROME;
assert(executable, "Set BSK_COOP_CHROME to an isolated Chromium executable");
const port = Number(process.env.BSK_COOP_PORT ?? 52931);
assert(Number.isInteger(port) && port > 0 && port !== 52800);
const extensionPath = resolve(process.env.BSK_COOP_EXTENSION ?? "apps/extension/dist/chrome-mv3");
assert(
  (await readFile(join(extensionPath, "background.js"), "utf8")).includes(`ws://127.0.0.1:${port}`),
  "Build the test extension with BSK_DAEMON_WS_URL matching BSK_COOP_PORT",
);
const artifacts = resolve(
  process.env.BSK_COOP_ARTIFACTS ?? "evals/browser/results/cooperation-video",
);
await mkdir(artifacts, { recursive: true });
const runtime = await mkdtemp(join(tmpdir(), "bsk-video-live-"));
const env = { ...process.env, BSK_HOME: runtime, BSK_AUTO_START: "0", BSK_AUTO_UPDATE: "off" };
const exec = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const commands = [];
const results = [];
let daemon;
let daemonOutput = "";
let browserVersion;
const bsk = async (args) => {
  const start = performance.now();
  let output, stderr, exitCode;
  try {
    const result = await exec(cli, [...args, "--json"], {
      env,
      timeout: 35000,
      maxBuffer: 2 ** 22,
    });
    output = result.stdout;
    stderr = result.stderr;
    exitCode = 0;
  } catch (error) {
    output = error.stdout || "";
    stderr = error.stderr || error.message;
    exitCode = error.code;
  }
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    result = { stdout: output, stderr };
  }
  const entry = {
    args,
    exitCode,
    durationMs: Math.round(performance.now() - start),
    result,
    stderr,
  };
  commands.push(entry);
  await appendFile(join(artifacts, "commands.jsonl"), JSON.stringify(entry) + "\n");
  return entry;
};
const ok = async (args) => {
  const reply = await bsk(args);
  assert.equal(reply.exitCode, 0, JSON.stringify(reply));
  return reply.result;
};
const poll = async (read, label, timeout = 15000) => {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error("Timed out: " + label);
};
const html = await readFile(join(directory, "fixture.html"));
const clip = await readFile(join(directory, "preview.webm"));
const server = createServer((req, res) => {
  if (req.url.startsWith("/preview.webm")) {
    res.setHeader("Content-Type", "video/webm");
    res.setHeader("Content-Length", clip.length);
    res.end(clip);
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
});
const cases = [
  { name: "video_pixels_only", variant: "pixels", target: false, dependencies: false, allow: true },
  {
    name: "timer_text_untargeted_space",
    variant: "text",
    target: false,
    dependencies: false,
    allow: false,
  },
  {
    name: "timer_text_targeted_scoped_space",
    variant: "text",
    target: true,
    dependencies: true,
    allow: true,
  },
  {
    name: "timer_text_dependencies_without_target",
    variant: "text",
    target: false,
    dependencies: true,
    allow: true,
  },
  {
    name: "progress_range_targeted_scoped_space",
    variant: "range",
    target: true,
    dependencies: true,
    allow: true,
  },
  {
    name: "cosmetic_class_untargeted_space",
    variant: "cosmetic",
    target: false,
    dependencies: false,
    allow: true,
  },
  {
    name: "continuous_progress_sync_and_space",
    variant: "range",
    target: true,
    dependencies: true,
    allow: true,
    continuous: true,
  },
  {
    name: "progress_dependencies_without_target",
    variant: "range",
    target: false,
    dependencies: true,
    allow: true,
  },
  {
    name: "business_range_still_blocked",
    variant: "business-range",
    target: true,
    dependencies: true,
    allow: false,
  },
  {
    name: "submitted_timeline_still_blocked",
    variant: "submitted-range",
    target: true,
    dependencies: true,
    allow: false,
  },
  {
    name: "form_timeline_still_blocked",
    variant: "form-range",
    target: true,
    dependencies: true,
    allow: false,
  },
  {
    name: "progress_and_business_field_still_blocked",
    variant: "combined",
    target: true,
    dependencies: true,
    allow: false,
  },
  {
    name: "programmatic_focus_still_blocked",
    variant: "focus",
    target: false,
    dependencies: true,
    allow: false,
    focus: true,
  },
  {
    name: "business_field_targeted_scoped_space",
    variant: "field",
    target: true,
    dependencies: true,
    allow: false,
  },
  {
    name: "learned_price_current_target_blocked",
    variant: "learned-price",
    learn: true,
    target: true,
    targetSelector: "#buy",
    allow: false,
  },
  {
    name: "learned_price_declared_dependency_blocked",
    variant: "learned-price",
    learn: true,
    target: true,
    dependencies: ["#buy"],
    allow: false,
  },
  {
    name: "learned_price_bare_key_blocked",
    variant: "learned-price",
    learn: true,
    target: false,
    allow: false,
  },
  {
    name: "learned_price_untargeted_dependency_blocked",
    variant: "learned-price",
    learn: true,
    target: false,
    dependencies: ["#buy"],
    allow: false,
  },
  {
    name: "refused_context_requires_sync",
    variant: "learned-price",
    learn: true,
    retryRefused: true,
    target: true,
    allow: true,
  },
  {
    name: "explicit_timeline_dependency_still_blocked",
    variant: "range",
    target: true,
    dependencies: ["#progress"],
    allow: false,
  },
  {
    name: "focused_buy_price_change_unrelated_dependency",
    variant: "focused-price",
    key: "Enter",
    target: false,
    dependencies: ["#pause"],
    allow: false,
    manual: true,
  },
  {
    name: "focused_buy_price_change_no_dependency",
    variant: "focused-price",
    key: "Enter",
    target: false,
    dependencies: false,
    allow: false,
    manual: true,
  },
  {
    name: "focused_buy_price_change_explicit_target",
    variant: "focused-price",
    key: "Enter",
    target: true,
    targetSelector: "#buy",
    dependencies: ["#pause"],
    allow: false,
    manual: true,
  },
  {
    name: "child_source_changes_with_progress",
    variant: "source-range",
    target: true,
    dependencies: ["#pause"],
    allow: false,
    manual: true,
    source: true,
  },
  {
    name: "child_source_changes_without_progress",
    variant: "source-only",
    target: true,
    dependencies: ["#pause"],
    allow: false,
    manual: true,
    source: true,
  },
  {
    name: "video_src_changes_with_progress",
    variant: "src-range",
    target: true,
    dependencies: ["#pause"],
    allow: false,
    manual: true,
    source: true,
  },
  {
    name: "progress_and_pause_in_same_player_region",
    variant: "same-region",
    target: true,
    dependencies: ["#pause"],
    allow: true,
  },
  {
    name: "same_player_business_field_still_blocked",
    variant: "same-region-field",
    target: true,
    dependencies: ["#pause"],
    allow: false,
  },
  {
    name: "same_player_declared_timeline_still_blocked",
    variant: "same-region",
    target: true,
    dependencies: ["#progress"],
    allow: false,
  },
  {
    name: "same_player_declared_container_still_blocked",
    variant: "same-region",
    target: true,
    dependencies: ["#player"],
    allow: false,
  },
  {
    name: "focused_pause_in_same_player_allows_progress",
    variant: "same-region",
    target: false,
    focusBefore: "#pause",
    dependencies: ["#pause"],
    allow: true,
  },
  {
    name: "focused_timeline_still_exact",
    variant: "same-region",
    target: false,
    focusBefore: "#progress",
    dependencies: ["#pause"],
    allow: false,
  },
  {
    name: "focused_pause_after_delta_sync_allows_progress",
    variant: "same-region",
    target: false,
    dependencies: ["#pause"],
    allow: true,
    focusAfterFirstSync: "#pause",
  },
  {
    name: "closed_shadow_media_progress_is_incidental",
    variant: "range",
    closedShadow: true,
    target: true,
    dependencies: ["#pause"],
    allow: true,
    manual: true,
  },
  {
    name: "closed_shadow_child_source_changes_with_progress",
    variant: "source-range",
    closedShadow: true,
    target: true,
    dependencies: ["#pause"],
    allow: false,
    manual: true,
    source: true,
  },
  {
    name: "closed_shadow_child_source_changes_without_progress",
    variant: "source-only",
    closedShadow: true,
    target: true,
    dependencies: ["#pause"],
    allow: false,
    manual: true,
    source: true,
  },
  {
    name: "body_becomes_specific_recipient_is_blocked",
    variant: "body-recipient",
    target: false,
    dependencies: ["#pause"],
    allow: false,
    focus: true,
  },
  {
    name: "form_role_none_progress_still_blocked",
    formRole: "none",
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    dependencies: ["#pause"],
    allow: false,
  },
  {
    name: "form_role_presentation_progress_still_blocked",
    formRole: "presentation",
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    dependencies: ["#pause"],
    allow: false,
  },
  {
    name: "form_display_contents_progress_still_blocked",
    formRole: "none",
    formContents: true,
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    dependencies: ["#pause"],
    allow: false,
  },
  {
    name: "external_form_owner_progress_still_blocked",
    formRole: "external",
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    dependencies: ["#pause"],
    allow: false,
  },
  {
    name: "form_role_none_named_progress_still_blocked",
    formRole: "none",
    named: true,
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    dependencies: ["#pause"],
    allow: false,
  },
  {
    name: "form_role_none_explicit_timeline_still_blocked",
    formRole: "none",
    dependencies: ["#progress"],
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    allow: false,
  },
  {
    name: "form_role_none_whole_page_still_blocked",
    formRole: "none",
    dependencies: false,
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    allow: false,
  },
  {
    name: "form_role_none_business_label_still_blocked",
    formRole: "none",
    businessLabel: true,
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    dependencies: ["#pause"],
    allow: false,
  },
  {
    name: "non_form_role_none_progress_allowed",
    formRole: "none",
    nonForm: true,
    allow: true,
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    dependencies: ["#pause"],
  },
  {
    name: "open_shadow_form_progress_still_blocked",
    formRole: "none",
    controlShadow: "open",
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    dependencies: ["#pause"],
    allow: false,
  },
  {
    name: "closed_shadow_form_progress_still_blocked",
    formRole: "none",
    controlShadow: "closed",
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    dependencies: ["#pause"],
    allow: false,
  },
  {
    name: "closed_shadow_continuous_progress_allowed",
    controlShadow: "closed",
    continuous: true,
    allow: true,
    variant: "range",
    target: true,
    manual: false,
    ownershipCheck: true,
    dependencies: ["#pause"],
  },
  {
    name: "open_shadow_continuous_progress_allowed",
    controlShadow: "open",
    continuous: true,
    allow: true,
    variant: "range",
    target: true,
    manual: false,
    ownershipCheck: true,
    dependencies: ["#pause"],
  },
  {
    name: "shadow_host_form_does_not_own_timeline",
    controlShadow: "closed",
    shadowHostForm: true,
    continuous: true,
    allow: true,
    variant: "range",
    target: true,
    manual: false,
    ownershipCheck: true,
    dependencies: ["#pause"],
  },
  {
    name: "custom_progress_in_pruned_form_still_blocked",
    formRole: "none",
    customProgress: true,
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    dependencies: ["#pause"],
    allow: false,
  },
  {
    name: "custom_non_form_progress_allowed",
    customProgress: true,
    allow: true,
    variant: "range",
    target: true,
    manual: true,
    ownershipCheck: true,
    dependencies: ["#pause"],
  },
];
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  daemon = spawn(cli, ["daemon", "start", "--foreground", "--port", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", (chunk) => {
    daemonOutput += chunk;
  });
  daemon.stderr.on("data", (chunk) => {
    daemonOutput += chunk;
  });
  await poll(async () => (await bsk(["status"])).exitCode === 0, "isolated daemon");
  await withChrome(
    {
      executable,
      extensionPath,
      extensionViaCdp: process.env.BSK_COOP_LOAD_CDP !== "0",
      deviceScale: 1,
      zoom: 1,
      headless: true,
      softwareRendering: true,
      startupTimeout: 30000,
      extraArgs: ["--autoplay-policy=no-user-gesture-required"],
    },
    async (send) => {
      browserVersion = await send("Browser.getVersion");
      const browsers = await poll(async () => {
        const reply = await ok(["browsers"]);
        return reply.length && reply;
      }, "test extension connection");
      assert.equal(browsers.length, 1, "Only the isolated test browser should use this daemon");
      for (const scenario of cases) {
        console.log("CASE " + scenario.name);
        const { session_id: session } = await ok([
          "session",
          "start",
          "--browser",
          browsers[0].instance_id,
        ]);
        const scope = ["--session", session];
        let oracle;
        try {
          const query = new URLSearchParams({
            variant: scenario.variant,
            case: scenario.name,
            interval: String(scenario.continuous ? 10 : 80),
            shadow: scenario.closedShadow ? "closed" : "none",
          });
          for (const key of [
            "formRole",
            "formContents",
            "named",
            "businessLabel",
            "nonForm",
            "controlShadow",
            "customProgress",
            "shadowHostForm",
          ])
            if (scenario[key] !== undefined) query.set(key, String(scenario[key]));
          const url = `${base}/?${query}`;
          await ok(["navigate", url, ...scope]);
          const target = (await send("Target.getTargets")).targetInfos.find(
            (target) => target.url === url,
          );
          assert(target, "Test tab must exist");
          ({ sessionId: oracle } = await send("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
          }));
          await send("Runtime.enable", {}, oracle);
          await send("Page.bringToFront", {}, oracle);
          const read = async (expression) => {
            const reply = await send(
              "Runtime.evaluate",
              { expression, returnByValue: true, awaitPromise: true },
              oracle,
            );
            assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
            return reply.result.value;
          };
          let playback;
          try {
            await poll(async () => {
              playback = await read(
                "({ready:window.fixtureReady,error:window.fixtureError,report:window.report?.()})",
              );
              assert(!playback.error, playback.error);
              return playback.ready && playback.report.decodedFrames >= 3;
            }, "actual video playback");
          } catch (error) {
            await writeFile(
              join(artifacts, scenario.name + ".playback-error.json"),
              JSON.stringify(playback, null, 2),
            );
            throw error;
          }
          if (scenario.focusBefore)
            await read(
              `document.querySelector(${JSON.stringify(scenario.focusBefore)}).focus(); true`,
            );
          // These cases verify legacy learning, dependencies and single-use contexts.
          const syncStrict = async () => {
            const state = await ok(["cooperate", "sync", ...scope, "--policy", "strict"]);
            assert.equal(state.control_policy, "strict");
            return state;
          };
          let learning;
          if (scenario.learn) {
            const initial = await syncStrict();
            // Keep node identities stable and tick exactly once per observation.
            await read("window.tickNoise(); true");
            const learnArgs = [
              "press",
              "Space",
              ...scope,
              "--context",
              initial.context_id,
              "--selector",
              "#pause",
            ];
            const refused = await bsk(learnArgs);
            assert.notEqual(refused.exitCode, 0);
            assert.match(refused.result.message, /changed by itself/);
            assert.equal(refused.result.data?.effect_state, "none");
            learning = { refused };
            if (scenario.retryRefused) {
              learning.retry = await bsk(learnArgs);
              assert.notEqual(learning.retry.exitCode, 0);
              assert.equal(
                learning.retry.result.message,
                "This action requires the context returned by the latest cooperate sync",
              );
              assert.equal(learning.retry.result.data?.effect_state, "none");
            }
            const report = await read("window.report()");
            assert.equal(report.keydowns, 0);
            assert.equal(report.paused, false);
          }
          if (scenario.continuous) {
            await read("window.startNoise(); true");
            await delay(100);
          }
          let sync = await syncStrict();
          if (scenario.continuous) {
            for (let i = 0; i < 2; i++) {
              await delay(100);
              sync = await syncStrict();
            }
          }
          if (scenario.focusAfterFirstSync) {
            await read(
              `document.querySelector(${JSON.stringify(scenario.focusAfterFirstSync)}).focus(); true`,
            );
            sync = await syncStrict();
            assert(sync.observation, "A new recipient must refresh semantic focus evidence");
          }
          const before = await read("window.report()");
          assert.equal(before.paused, false);
          if (scenario.ownershipCheck || scenario.variant === "form-range") {
            assert.equal(
              before.progressLabel,
              scenario.businessLabel ? "Order amount" : "Playback progress",
              "The regression must keep the media-like accessible name",
            );
            assert.equal(
              before.formOwner,
              scenario.variant === "form-range" || (scenario.formRole && !scenario.nonForm)
                ? "order-form"
                : null,
            );
            if (scenario.ownershipCheck)
              assert.equal(before.controlName, scenario.named ? "start_time" : "");
            assert.equal(before.progressShadow, !!scenario.controlShadow);
          }
          // Start page-origin updates after the observation, before the proposed input.
          await read(
            scenario.learn || scenario.manual
              ? "window.tickNoise(); true"
              : "window.startNoise(); true",
          );
          let progressReport;
          let sourceBaseline;
          let atAction;
          try {
            atAction = await poll(async () => {
              progressReport = await read("window.report()");
              // A reload resets the native frame counter. Establish a new
              // baseline only after currentSrc changes, then require more
              // decoded frames from that same source on a later read.
              if (scenario.source) {
                if (progressReport.currentSrc === before.currentSrc || !progressReport.currentSrc)
                  return;
                if (sourceBaseline?.currentSrc !== progressReport.currentSrc) {
                  sourceBaseline = progressReport;
                  return;
                }
              }
              const advanced =
                progressReport.decodedFrames > (sourceBaseline ?? before).decodedFrames;
              return advanced && progressReport.ticks > before.ticks && progressReport;
            }, "actual video frames and page updates before input");
          } catch (error) {
            await writeFile(
              join(artifacts, scenario.name + ".progress-error.json"),
              JSON.stringify({ before, current: progressReport }, null, 2),
            );
            throw error;
          }
          if (scenario.source) assert.notEqual(atAction.currentSrc, before.currentSrc);
          assert(atAction.ticks > before.ticks, "Page updates must run before the input");
          if (atAction.progress !== undefined) assert.notEqual(atAction.progress, before.progress);
          if (scenario.variant === "text") assert.notEqual(atAction.clock, before.clock);
          if (["field", "combined", "same-region-field"].includes(scenario.variant))
            assert.notEqual(atAction.order, before.order);
          if (scenario.learn || scenario.variant === "focused-price")
            assert.notEqual(atAction.price, before.price);
          if (scenario.focus && scenario.variant !== "body-recipient")
            assert.notEqual(atAction.focused, before.focused);
          const wait = await ok(["cooperate", "wait", ...scope, "--timeout-ms", "0"]);
          const action = await bsk([
            "press",
            scenario.key ?? "Space",
            ...scope,
            "--context",
            sync.context_id,
            ...(scenario.target ? ["--selector", scenario.targetSelector ?? "#pause"] : []),
            ...(scenario.dependencies
              ? (Array.isArray(scenario.dependencies) ? scenario.dependencies : ["#pause"]).flatMap(
                  (dependency) => ["--depends-on", dependency],
                )
              : []),
          ]);
          const after = await read("window.report()");
          const evidence = {
            ...scenario,
            session,
            learning,
            before,
            atAction,
            sourceBaseline,
            coordinationReady: wait.ready,
            action,
            after,
          };
          results.push(evidence);
          await writeFile(
            join(artifacts, scenario.name + ".json"),
            JSON.stringify(evidence, null, 2),
          );
          if (scenario.name === "timer_text_untargeted_space") {
            // Diagnostic only: all input and page-state assertions still run.
            try {
              const screenshot = await send("Page.captureScreenshot", { format: "png" }, oracle);
              await writeFile(
                join(artifacts, "blocked-preview.png"),
                Buffer.from(screenshot.data, "base64"),
              );
            } catch (error) {
              await writeFile(join(artifacts, "blocked-preview-error.txt"), String(error));
            }
          }
          assert.equal(wait.ready, true, "No person should be holding control");
          assert.equal(after.purchases, 0, "No simulated purchase may execute");
          if (scenario.allow) {
            assert.equal(action.exitCode, 0, JSON.stringify(action));
            assert.equal(after.keydowns, 1);
            assert.equal(after.paused, true);
          } else {
            assert.notEqual(action.exitCode, 0, JSON.stringify(action));
            assert.equal(
              action.result.message,
              scenario.focus
                ? "The keyboard focus changed; synchronize before pressing a key"
                : scenario.source
                  ? "The media source changed; synchronize and replan"
                  : "The action's observed content changed; synchronize and replan",
            );
            assert.equal(action.result.data?.effect_state, "none");
            assert.equal(after.keydowns, 0);
            assert.equal(after.pauseCalls, 0);
            assert.equal(after.paused, false);
          }
          console.log(
            JSON.stringify({
              name: scenario.name,
              exit: action.exitCode,
              keydowns: after.keydowns,
              paused: after.paused,
              elapsedMs: action.durationMs,
            }),
          );
        } finally {
          if (oracle) await send("Target.detachFromTarget", { sessionId: oracle }).catch(() => {});
          await ok(["session", "stop", session]);
        }
      }
    },
  );
  await writeFile(
    join(artifacts, "result.json"),
    JSON.stringify({ passed: true, policy: "strict", browserVersion, cases: results }, null, 2),
  );
  console.log(`PASS ${results.length} real-browser cases; artifacts=${artifacts}`);
} catch (error) {
  await writeFile(
    join(artifacts, "result.json"),
    JSON.stringify(
      {
        passed: false,
        policy: "strict",
        browserVersion,
        error: String(error.stack || error),
        cases: results,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await writeFile(join(artifacts, "daemon.log"), daemonOutput);
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, "exit");
    daemon.kill("SIGTERM");
    const force = setTimeout(() => daemon.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(force);
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(runtime, { recursive: true, force: true });
}
