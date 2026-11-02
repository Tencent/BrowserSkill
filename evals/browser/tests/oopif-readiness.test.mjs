import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import fixture from "../cases/regression/oopif-scrollbars/oopif-scrollbars.fixture.mjs";
import { runBskSmokeTask } from "../lib/bsk-runner.mjs";
import { loadCaseManifests } from "../lib/case-loader.mjs";
import { verifyTask } from "../lib/oracle.mjs";

const task = (await loadCaseManifests()).find(({ id }) => id === "oopif-scrollbars");

function framePage(frame, mode = "both") {
  const pathname = `/oopif-scrollbars${frame === "root" ? "" : frame === "outer" ? "/frame" : "/nested"}`;
  const html = fixture.render({
    pathname,
    runId: "readiness",
    query: new URLSearchParams({ scrollbars: mode }),
  });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const listeners = new Map();
  const pending = [];
  const events = [];
  const scrolls = [];
  const root = { dataset: {}, clientWidth: 0, clientHeight: 0 };
  const context = {
    URL,
    location: new URL(`http://localhost${pathname}`),
    history: {},
    innerWidth: 0,
    innerHeight: 0,
    document: { documentElement: root, querySelector: () => null, addEventListener() {} },
    window: { addEventListener: (type, callback) => listeners.set(type, callback) },
    requestAnimationFrame: (callback) => pending.push(callback),
    scrollTo: (x, y) => scrolls.push([x, y]),
    browserEval: {
      send: (type, data) => events.push({ type, data: JSON.parse(JSON.stringify(data)) }),
    },
  };
  runInNewContext(script, context);
  listeners.get("load")();
  return {
    events,
    scrolls,
    root,
    layout(width, height, clientWidth, clientHeight) {
      Object.assign(context, { innerWidth: width, innerHeight: height });
      Object.assign(root, { clientWidth, clientHeight });
    },
    advanceFrames(count = 6) {
      for (let index = 0; index < count; index++) {
        for (const callback of pending.splice(0)) callback();
      }
    },
  };
}

test("child readiness waits for real viewport and both occupied scrollbars", () => {
  const page = framePage("nested");
  for (const layout of [
    [0, 0, 0, 0],
    [200, 120, 200, 120],
    [200, 120, 183, 120],
  ]) {
    page.layout(...layout);
    page.advanceFrames();
    assert.deepEqual(page.events, []);
    assert.equal(page.root.dataset.geometryReady, undefined);
    assert.deepEqual(page.scrolls, []);
  }
  page.layout(200, 120, 183, 109);
  page.advanceFrames();
  assert.equal(page.root.dataset.geometryReady, "true");
  assert.deepEqual(page.scrolls, [[10, 20]]);
  assert.deepEqual(
    page.events.map(({ type }) => type),
    ["geometry.scrollbars", "geometry.ready"],
  );
  assert.deepEqual(page.events[0].data, {
    frame: "nested",
    width: 200,
    height: 120,
    clientWidth: 183,
    clientHeight: 109,
    vertical: true,
    horizontal: true,
  });
  page.advanceFrames();
  assert.equal(page.events.length, 2, "one frame must publish only one sample");
});

for (const [mode, vertical, horizontal] of [
  ["both", true, true],
  ["vertical", true, false],
  ["horizontal", false, true],
  ["none", false, false],
]) {
  test(`fixture preserves the ${mode} scrollbar mode`, () => {
    const page = framePage("outer", mode);
    page.layout(420, 320, vertical ? 403 : 420, horizontal ? 309 : 320);
    page.advanceFrames();
    const sample = page.events.find(({ type }) => type === "geometry.scrollbars");
    assert.equal(sample.data.frame, "outer");
    assert.equal(sample.data.vertical, vertical);
    assert.equal(sample.data.horizontal, horizontal);
    assert.equal(page.root.dataset.geometryReady, "true");
    assert.deepEqual(page.scrolls, [[40, 100]]);
  });
}

const rootReady = { type: "geometry.ready", data: { root: true } };
const sample = (frame, vertical = true, horizontal = true) => ({
  type: "geometry.scrollbars",
  data: { frame, vertical, horizontal },
});

test("the oracle requires two distinct child frames with both scrollbars", () => {
  const verify = (events) =>
    verifyTask(task, {
      events: [rootReady, ...events],
      responseText: "OOPIF-SCROLLBARS",
      adapterEvidence: { sessionStopped: true },
    }).status;
  assert.equal(verify([sample("outer"), sample("outer")]), "failed");
  assert.equal(verify([sample("outer"), sample("nested", false, false)]), "failed");
  assert.equal(verify([sample("outer"), sample("nested")]), "passed");
});

for (const receivesNested of [true, false]) {
  test(`workflow ${receivesNested ? "waits for" : "times out without"} the nested frame sample`, async (t) => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "oopif-readiness-"));
    const calls = [];
    const events = [rootReady, sample("outer"), sample("outer")];
    let navigated;
    const waiting = new Promise((resolve) => {
      navigated = resolve;
    });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    try {
      const result = runBskSmokeTask({
        bskCommand: "bsk",
        outputDirectory,
        runId: "readiness",
        serverInfo: { baseUrl: "http://localhost:4173" },
        task,
        server: {
          reset() {},
          snapshot: () => ({ events }),
        },
        executeProcess: async (_command, args) => {
          calls.push(args[0]);
          let result = {};
          if (args[0] === "session" && args[1] === "start") result = { session_id: "test" };
          if (args[0] === "session" && args[1] === "stop") result = { stopped: ["test"] };
          if (args[0] === "navigate") {
            if (receivesNested) setTimeout(() => events.push(sample("nested")), 750);
            navigated();
          }
          if (args[0] === "cooperate" || args[0] === "observe") {
            assert(
              events.some(({ data }) => data.frame === "nested"),
              "root/outer readiness is insufficient",
            );
            result = { context_id: "c", observation_id: "o", text: "OOPIF-SCROLLBARS" };
          }
          return { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };
        },
      });
      await waiting;
      await flush();
      t.mock.timers.tick(300);
      await flush();
      assert(!calls.includes("cooperate"));
      assert(!calls.includes("observe"));
      t.mock.timers.tick(receivesNested ? 450 : 2700);
      await flush();
      t.mock.timers.tick(350);
      const report = await result;
      assert.equal(report.evidence.sessionStopped, true);
      if (receivesNested) {
        assert.equal(report.executionError, undefined);
        assert.equal(report.verification.status, "passed");
        assert(calls.includes("observe"));
      } else {
        assert.match(report.executionError, /geometry.scrollbars/);
        assert.equal(report.verification.status, "failed");
        assert(!calls.includes("cooperate"));
        assert(!calls.includes("observe"));
      }
    } finally {
      t.mock.timers.reset();
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
}
