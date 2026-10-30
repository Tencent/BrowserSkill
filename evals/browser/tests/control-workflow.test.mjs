import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBskSmokeTask } from "../lib/bsk-runner.mjs";
import { loadCaseManifests, validateCaseManifest } from "../lib/case-loader.mjs";

async function workflow(smokeSteps, respond) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "control-workflow-"));
  const calls = [];
  try {
    const report = await runBskSmokeTask({
      bskCommand: "bsk",
      outputDirectory,
      server: { reset() {}, snapshot: () => ({ events: [] }) },
      serverInfo: { baseUrl: "http://localhost:4173" },
      runId: "control-test",
      task: {
        id: "control-test",
        suite: "regression",
        tags: [],
        startPath: "/form",
        siteAssertions: [],
        responseAssertions: [],
        adapterAssertions: [],
        smokeSteps,
      },
      executeProcess: async (_command, args) => {
        calls.push(args);
        if (args[0] === "session") {
          const result = args[1] === "start" ? { session_id: "test" } : { stopped: ["test"] };
          return { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };
        }
        const result = await respond(args);
        return {
          exitCode: result.code ? 1 : 0,
          stdout: JSON.stringify(result),
          stderr: "",
        };
      },
    });
    return { report, calls };
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

const valueOf = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test("workflows explicitly reuse DOM control and select strict observations across navigation", async () => {
  let syncs = 0;
  const { report, calls } = await workflow(
    [
      { action: "navigate", saveAs: "page" },
      { action: "sync", tabId: "{page.tab_id}", saveAs: "first" },
      { action: "click", ref: "@e1", contextId: "{first.context_id}" },
      { action: "observe", saveAs: "details" },
      { action: "click", ref: "@e1", contextId: "{first.context_id}" },
      { action: "sync", saveAs: "next" },
      { action: "click", ref: "@e1", contextId: "{first.context_id}" },
      {
        action: "navigate",
        url: "{baseUrl}/next",
        contextId: "{next.context_id}",
        observationId: "{next.observation_id}",
      },
      { action: "sync", saveAs: "new-document" },
      { action: "click", ref: "@e8", contextId: "{new-document.context_id}" },
    ],
    async (args) => {
      if (args[0] === "cooperate") {
        syncs++;
        return {
          control_policy: "target",
          context_id: syncs === 3 ? "document-2" : "document-1",
          observation_id: `sync-${syncs}`,
        };
      }
      if (args[0] === "observe")
        return { context_id: "not-authority", observation_id: "supplementary-read" };
      return { tab_id: 7 };
    },
  );
  assert.equal(report.executionError, undefined);
  assert.equal(report.evidence.sessionStopped, true);
  const syncCalls = calls.filter((args) => args[0] === "cooperate");
  assert.equal(syncCalls.length, 3);
  assert.deepEqual(syncCalls[0], [
    "cooperate",
    "sync",
    "--session",
    "test",
    "--tab-id",
    "7",
    "--json",
  ]);
  const clicks = calls.filter((args) => args[0] === "click");
  assert.deepEqual(
    clicks.map((args) => valueOf(args, "--context")),
    ["document-1", "document-1", "document-1", "document-2"],
  );
  assert(clicks.every((args) => !args.includes("--observation")));
  const navigations = calls.filter((args) => args[0] === "navigate");
  assert.equal(valueOf(navigations[0], "--context"), undefined);
  assert.equal(valueOf(navigations[0], "--observation"), undefined);
  assert.equal(valueOf(navigations[1], "--context"), "document-1");
  assert.equal(valueOf(navigations[1], "--observation"), "sync-2");
  const supplementary = calls.find((args) => args[0] === "observe");
  assert.equal(valueOf(supplementary, "--context"), undefined);
  assert.equal(valueOf(supplementary, "--observation"), undefined);
});

test("a rejected action is never replayed or given an implicit latest receipt", async () => {
  const { report, calls } = await workflow(
    [
      { action: "sync", saveAs: "control" },
      { action: "click", selector: "#buy" },
      { action: "sync", saveAs: "later" },
    ],
    async (args) =>
      args[0] === "cooperate"
        ? { context_id: "available", observation_id: "available-observation" }
        : {
            code: "permission_denied",
            message: "A control context is required",
            data: { reason: "control_context_invalid", effect_state: "none" },
          },
  );
  assert.match(report.executionError, /A control context is required/);
  const clicks = calls.filter((args) => args[0] === "click");
  assert.equal(clicks.length, 1);
  assert.equal(valueOf(clicks[0], "--context"), undefined);
  assert.equal(valueOf(clicks[0], "--observation"), undefined);
  assert.equal(calls.filter((args) => args[0] === "cooperate").length, 1);
  assert.equal(report.evidence.sessionStopped, true);
});

test("an unavailable receipt variable fails before action dispatch and still cleans up", async () => {
  const { report, calls } = await workflow(
    [{ action: "click", selector: "#buy", contextId: "{missing.context_id}" }],
    async () => ({}),
  );
  assert.match(report.executionError, /unknown workflow variable missing.context_id/);
  assert(!calls.some((args) => args[0] === "click"));
  assert.equal(report.evidence.sessionStopped, true);
});

test("manifest validation accepts explicit sync receipts and rejects malformed authority", async () => {
  const [base] = await loadCaseManifests();
  const manifest = JSON.parse(await readFile(base.sourceFile, "utf8"));
  manifest.smoke.steps = [
    { action: "sync", saveAs: "control" },
    { action: "click", ref: "@e1", contextId: "{control.context_id}" },
    {
      action: "reload",
      contextId: "{control.context_id}",
      observationId: "{control.observation_id}",
    },
  ];
  assert.deepEqual(validateCaseManifest(manifest), []);
  for (const step of [
    { action: "sync" },
    { action: "sync", saveAs: "control", contextId: "old" },
    { action: "reload", observationId: "o" },
    { action: "reload", contextId: 1 },
    { action: "reload", contextId: " " },
    { action: "reload", contextId: "c", observationId: null },
  ]) {
    manifest.smoke.steps = [step];
    assert.notDeepEqual(validateCaseManifest(manifest), [], JSON.stringify(step));
  }
});
