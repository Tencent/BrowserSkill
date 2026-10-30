import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { runBskSmokeTask } from "../lib/bsk-runner.mjs";
import { loadCaseManifests } from "../lib/case-loader.mjs";
import { createEvalServer } from "../lib/server.mjs";

const mobile = (await loadCaseManifests()).find(({ id }) => id === "mobile-emulation");

async function mobileWorkflow(t, sample, check) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "mobile-readiness-"));
  const server = createEvalServer();
  const calls = [];
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const result = runBskSmokeTask({
      bskCommand: "bsk",
      outputDirectory,
      server,
      serverInfo: { baseUrl: "http://localhost:4173" },
      runId: "mobile-readiness",
      task: mobile,
      executeProcess: async (_command, args) => {
        calls.push({ args, at: Date.now() });
        let reply = {};
        if (args[0] === "session")
          reply = args[1] === "start" ? { session_id: "test" } : { stopped: ["test"] };
        if (args[0] === "cooperate")
          reply = {
            control_policy: "target",
            context_id: "control",
            observation_id: "observation",
          };
        if (args[0] === "emulate") {
          if (sample)
            setTimeout(() => server.record("mobile-readiness", "viewport.sample", sample), 750);
          started();
        }
        if (args[0] === "get-html") reply = { html: "<p>VIEWPORT-84</p>" };
        return { exitCode: 0, stdout: JSON.stringify(reply), stderr: "" };
      },
    });
    await waiting;
    await flush();
    await check({
      calls,
      async advance(ms) {
        t.mock.timers.tick(ms);
        await flush();
      },
    });
    // The runner gives late event delivery a final 350ms after closing the session.
    t.mock.timers.tick(350);
    return { report: await result, calls };
  } finally {
    t.mock.timers.reset();
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

test("mobile emulation waits for the exact viewport event after 300ms without replaying actions", async (t) => {
  const { report, calls } = await mobileWorkflow(
    t,
    { width: 390, height: 844 },
    async ({ calls, advance }) => {
      await advance(300);
      assert(!calls.some(({ args }) => args[0] === "get-html"));
      assert(!calls.some(({ args }) => args[0] === "session" && args[1] === "stop"));
      await advance(450);
      assert.equal(calls.find(({ args }) => args[0] === "get-html").at, 750);
    },
  );
  assert.equal(report.executionError, undefined);
  assert.equal(report.verification.status, "passed");
  const actions = calls.filter(({ args }) => args[0] !== "session");
  assert.deepEqual(
    actions.map(({ args }) => args[0]),
    ["window", "navigate", "cooperate", "emulate", "get-html"],
  );
  assert.deepEqual(actions[0].args, [
    "window",
    "resize",
    "--session",
    "test",
    "--width",
    "900",
    "--height",
    "700",
    "--json",
  ]);
  assert(!actions[1].args.includes("--context"));
  assert.deepEqual(actions[3].args.slice(-5), [
    "--context",
    "control",
    "--observation",
    "observation",
    "--json",
  ]);
  assert.equal(report.evidence.sessionStopped, true);
});

for (const [name, sample] of [
  ["wrong width", { width: 900, height: 844 }],
  ["wrong height", { width: 390, height: 613 }],
  ["no event", undefined],
]) {
  test(`mobile emulation rejects ${name} and still closes its session`, async (t) => {
    const { report, calls } = await mobileWorkflow(t, sample, async ({ calls, advance }) => {
      await advance(750);
      assert(!calls.some(({ args }) => args[0] === "get-html"));
      await advance(2250);
    });
    assert.match(report.executionError, /did not report viewport.sample within 3000ms/);
    assert.equal(report.verification.checks.find(({ kind }) => kind === "site").status, "failed");
    assert(!calls.some(({ args }) => args[0] === "get-html"));
    assert.equal(calls.filter(({ args }) => args[0] === "emulate").length, 1);
    assert.equal(report.evidence.sessionStopped, true);
  });
}
