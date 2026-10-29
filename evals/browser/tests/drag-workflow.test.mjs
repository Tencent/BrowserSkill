import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBskSmokeTask } from "../lib/bsk-runner.mjs";
import { validateCaseManifest } from "../lib/case-loader.mjs";

const manifest = JSON.parse(
  await readFile(
    new URL("../cases/regression/drag-interactions/drag-interactions.case.json", import.meta.url),
    "utf8",
  ),
);
test("drag manifests validate a unique destination or finite nonzero displacement", () => {
  for (const step of [
    { action: "drag", ref: "@e1", to: "@e2", mode: "click-move-click" },
    { action: "drag", selector: "#handle", dx: -100, hold: "300ms", duration: "1s" },
  ]) {
    const copy = structuredClone(manifest);
    copy.smoke.steps = [step];
    assert.deepEqual(validateCaseManifest(copy), []);
  }
  for (const step of [
    { action: "drag", selector: "#start", to: "#end", mode: "auto" },
    { action: "drag", selector: "#start", dx: 20, mode: "click-move-click" },
    { action: "drag", selector: "#start", to: "#end", hold: "1s", mode: "click-move-click" },
    { action: "drag", to: "#end" },
    { action: "drag", selector: "#start" },
    { action: "drag", selector: "#start", to: "#end", dx: 10 },
    { action: "drag", selector: "#start", to: "" },
    { action: "drag", selector: "#start", dx: 0 },
    { action: "drag", selector: "#start", dx: Infinity },
    { action: "drag", selector: "#start", dy: "20" },
  ]) {
    const copy = structuredClone(manifest);
    copy.smoke.steps = [step];
    assert.notDeepEqual(validateCaseManifest(copy), []);
  }
});
test("drag smoke routes refs, destination, hold and signed displacement, then stops the session", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "drag-workflow-"));
  const calls = [];
  try {
    const report = await runBskSmokeTask({
      bskCommand: "bsk",
      outputDirectory,
      runId: "drag-test",
      server: { reset() {}, snapshot: () => ({ events: [] }) },
      serverInfo: { baseUrl: "http://localhost:4173" },
      task: {
        id: "drag-test",
        suite: "regression",
        tags: [],
        startPath: "/drag-interactions",
        siteAssertions: [],
        responseAssertions: [],
        adapterAssertions: [],
        smokeSteps: [
          { action: "drag", ref: "@e1", to: "@e2", mode: "click-move-click" },
          { action: "drag", selector: "#handle", dx: -100, dy: 20, hold: "300ms", duration: "1s" },
        ],
      },
      executeProcess: async (_command, args) => {
        calls.push(args);
        let response = {};
        if (args[0] === "session" && args[1] === "start") response = { session_id: "test" };
        if (args[0] === "session" && args[1] === "stop") response = { stopped: ["test"] };
        return { exitCode: 0, stdout: JSON.stringify(response), stderr: "" };
      },
    });
    assert.equal(report.executionError, undefined);
    const drags = calls.filter((args) => args[0] === "drag");
    assert.deepEqual(drags[0].slice(0, 4), ["drag", "@e1", "--to", "@e2"]);
    assert.deepEqual(drags[0].slice(4, 6), ["--mode", "click-move-click"]);
    assert.deepEqual(drags[1].slice(0, 10), [
      "drag",
      "#handle",
      "--dx",
      "-100",
      "--dy",
      "20",
      "--hold",
      "300ms",
      "--duration",
      "1s",
    ]);
    assert.equal(report.evidence.sessionStopped, true);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
