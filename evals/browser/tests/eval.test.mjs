import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runCommandTask } from "../lib/agent-runner.mjs";
import { loadCaseManifests, validateCaseManifest } from "../lib/case-loader.mjs";
import { buildOperationCoverage } from "../lib/coverage.mjs";
import { loadFixtureRegistry } from "../lib/fixture-registry.mjs";
import { verifyTask } from "../lib/oracle.mjs";
import { runProcess } from "../lib/process.mjs";
import { repositorySummary, validateRepositoryCases } from "../lib/repository-validation.mjs";
import { scaffoldCase } from "../lib/scaffold-case.mjs";
import { describeSeed } from "../lib/seeded-generator.mjs";
import { createEvalServer } from "../lib/server.mjs";
import { summarizeReports } from "../lib/summary.mjs";
import { allTasks, getTask, renderPrompt } from "../lib/tasks.mjs";

const cases = await allTasks();
const fixtureRegistry = await loadFixtureRegistry();

async function withServer(run) {
  const server = createEvalServer({ fixtureRegistry });
  const info = await server.start();
  try {
    await run(server, info);
  } finally {
    await server.stop();
  }
}

test("case manifests are discovered, ordered, and grouped into suites", () => {
  assert.deepEqual(
    cases.map(({ id }) => id),
    [
      "navigation-history",
      "form-controls",
      "hover-inspect",
      "tabs",
      "diagnostics",
      "mobile-emulation",
      "generated-form",
    ],
  );
  assert.deepEqual(repositorySummary(cases, fixtureRegistry).suites, { core: 6, matrix: 1 });
});

test("repository validation links every case to a fixture and valid workflow evidence", () => {
  assert.deepEqual(validateRepositoryCases(cases, fixtureRegistry), []);
  const summary = repositorySummary(cases, fixtureRegistry);
  assert.equal(summary.cases, 7);
  assert.equal(summary.fixtureModules, 8);
  assert.equal(summary.fixtureRoutes, 12);
});

test("manifest validation rejects unknown operations and incomplete workflow steps", () => {
  const invalid = {
    schemaVersion: 1,
    id: "invalid-case",
    title: "Invalid",
    suite: "regression",
    tags: ["regression"],
    fixture: { startPath: "/invalid" },
    prompts: { en: "Open {url}", "zh-CN": "打开 {url}" },
    coverage: ["page.teleport"],
    assertions: { site: [], response: [], adapter: [] },
    smoke: { steps: [{ action: "select", selector: "#choice", values: [] }] },
    typo: true,
  };
  const errors = validateCaseManifest(invalid);
  assert.ok(errors.some((error) => error.includes("unknown top-level property typo")));
  assert.ok(errors.some((error) => error.includes("unknown operation page.teleport")));
  assert.ok(errors.some((error) => error.includes("values must be a non-empty array")));
});

test("fixture server exposes deterministic task and seeded matrix markers", async () => {
  await withServer(async (_server, { baseUrl }) => {
    const fixtures = [
      ["/navigation/detail?run=test-markers", "NAV-42"],
      ["/form?run=test-markers", '<option value="two">Two</option>'],
      ["/hover-inspect?run=test-markers", "INSPECT-27"],
      ["/tabs/child?run=test-markers", "TAB-29"],
      ["/diagnostics?run=test-markers", "CONSOLE-61"],
      ["/responsive?run=test-markers", "VIEWPORT-84"],
      ["/matrix/generated-form?run=test-markers&seed=17", "SEED-17"],
    ];
    for (const [path, marker] of fixtures) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(marker));
    }
  });
});

test("server records and resets run-scoped events", async () => {
  await withServer(async (server, { baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "event-test", type: "example", data: { value: 7 } }),
    });
    assert.equal(response.status, 202);
    assert.equal(server.snapshot("event-test").events[0].data.value, 7);
    const resetResponse = await fetch(`${baseUrl}/api/runs/event-test`, { method: "DELETE" });
    assert.equal(resetResponse.status, 200);
    assert.deepEqual(server.snapshot("event-test").events, []);
  });
});

test("form case oracle checks submitted values and separates adapter evidence", () => {
  const task = getTask("form-controls", cases);
  const events = [
    { type: "form.enter_pressed", data: {} },
    {
      type: "form.submitted",
      data: { text: "agent-parity", notes: "BrowserSkill works", choice: "two" },
    },
    { type: "page.shown", data: { path: "/result" } },
  ];
  const partial = verifyTask(task, { events, responseText: "The page says Received!" });
  assert.equal(partial.status, "passed-with-unverified");
  assert.equal(partial.summary.unverified, 2);

  const complete = verifyTask(task, {
    events,
    responseText: "The page says Received!",
    adapterEvidence: { screenshotCreated: true, sessionStopped: true },
  });
  assert.equal(complete.status, "passed");
});

test("navigation case fails when reload is missing", () => {
  const task = getTask("navigation-history", cases);
  const verification = verifyTask(task, {
    events: [
      { type: "navigation.detail.clicked", data: {} },
      { type: "page.shown", data: { path: "/navigation/start" } },
      { type: "page.shown", data: { path: "/navigation/start" } },
      { type: "page.shown", data: { path: "/navigation/detail" } },
      { type: "page.shown", data: { path: "/navigation/detail" } },
    ],
    responseText: "NAV-42",
  });
  assert.equal(verification.status, "failed");
  assert.equal(
    verification.checks.find(({ label }) => label === "detail page was reloaded").status,
    "failed",
  );
});

test("prompt rendering is run-scoped, localized, and seed-aware", () => {
  const task = getTask("generated-form", cases);
  const input = { baseUrl: "http://127.0.0.1:4173", runId: "prompt-test", seed: 17 };
  assert.match(renderPrompt(task, { ...input, locale: "en" }), /seed=17/);
  assert.match(renderPrompt(task, { ...input, locale: "zh-CN" }), /seeded form/);
});

test("command adapter carries a run from process launch through oracle verification", async () => {
  await withServer(async (server, serverInfo) => {
    const script = `
      const [baseUrl, runId] = process.argv.slice(1);
      const send = (type, data) => fetch(baseUrl + "/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, type, data }),
      });
      await send("navigation.detail.clicked", {});
      await send("page.shown", { path: "/navigation/start" });
      await send("page.shown", { path: "/navigation/start" });
      await send("page.shown", { path: "/navigation/detail" });
      await send("page.shown", { path: "/navigation/detail" });
      await send("page.shown", { path: "/navigation/detail", navigationType: "reload" });
      console.log("NAV-42");
    `;
    const result = await runCommandTask({
      server,
      serverInfo,
      task: getTask("navigation-history", cases),
      adapter: {
        command: process.execPath,
        args: ["--input-type=module", "-e", script, "{baseUrl}", "{runId}"],
        variant: "fake-test",
      },
      adapterName: "fake-agent",
      configDirectory: process.cwd(),
      iteration: 1,
      locale: "en",
      timeoutMs: 5_000,
    });
    assert.equal(result.execution.exitCode, 0);
    assert.equal(result.verification.status, "passed-with-unverified");
    assert.equal(result.eventCount, 6);
  });
});

test("report summary keeps partial verification distinct from full verification", () => {
  const rows = summarizeReports([
    {
      results: [
        {
          adapter: "agent-a",
          variant: "granular-28",
          execution: { exitCode: 0, durationMs: 100 },
          metrics: { errorCount: 0, toolCallCount: 4 },
          verification: { status: "passed-with-unverified" },
        },
        {
          adapter: "agent-a",
          variant: "granular-28",
          execution: { exitCode: 0, durationMs: 300 },
          metrics: { errorCount: 1, toolCallCount: 6 },
          verification: { status: "passed" },
        },
      ],
    },
  ]);
  assert.equal(rows[0].passRate, 1);
  assert.equal(rows[0].fullyVerifiedRate, 0.5);
  assert.equal(rows[0].averageDurationMs, 200);
  assert.equal(rows[0].averageToolCalls, 5);
  assert.equal(rows[0].errors, 1);
});

test("coverage inventory contains all 28 operations and three manual lanes", () => {
  const coverage = buildOperationCoverage(cases);
  const operations = coverage.map(({ operation }) => operation);
  assert.equal(operations.length, 28);
  assert.equal(new Set(operations).size, 28);
  assert.deepEqual(
    coverage.filter(({ directSmoke }) => !directSmoke).map(({ operation }) => operation),
    ["tabs.borrow", "tabs.return", "assist.request-help"],
  );
  assert.deepEqual(coverage.find(({ operation }) => operation === "interact.fill").smokeCases, [
    "form-controls",
    "generated-form",
  ]);
});

test("seeded dimensions are reproducible and vary across seeds", () => {
  assert.deepEqual(describeSeed("badcase-17"), describeSeed("badcase-17"));
  assert.notDeepEqual(describeSeed("badcase-17"), describeSeed("badcase-18"));
  assert.equal(describeSeed(17).seed, 17);
});

test("badcase scaffold creates a loadable, escaped, self-contained case", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "browser-eval-scaffold-"));
  try {
    const title = "Quoted `title` ${notCode} <unsafe>";
    const result = await scaffoldCase({
      id: "reported-timeout",
      title,
      suite: "regression",
      source: "issue-123",
      rootCasesDirectory: temporaryRoot,
    });
    const loaded = await loadCaseManifests({ casesDirectory: temporaryRoot });
    assert.equal(loaded[0].id, "reported-timeout");
    assert.equal(loaded[0].source.reference, "issue-123");

    const generatedRegistry = await loadFixtureRegistry({ roots: [temporaryRoot] });
    const html = generatedRegistry.render("/cases/reported-timeout", {
      runId: "scaffold-test",
      query: new URLSearchParams(),
      record() {},
    });
    assert.match(html, /Quoted `title` \$\{notCode\} &lt;unsafe&gt;/);
    assert.match(await readFile(result.files.readme, "utf8"), /issue-123/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("CLI accepts pnpm separator and supports suite and tag filters", async () => {
  const cli = resolve("evals/browser/cli.mjs");
  const coverageResult = await runProcess(process.execPath, [cli, "--", "coverage", "--json"], {
    timeoutMs: 5_000,
  });
  assert.equal(coverageResult.exitCode, 0, coverageResult.stderr);
  assert.equal(JSON.parse(coverageResult.stdout).length, 28);

  const coreResult = await runProcess(
    process.execPath,
    [cli, "list", "--suite", "core", "--json"],
    {
      timeoutMs: 5_000,
    },
  );
  assert.equal(coreResult.exitCode, 0, coreResult.stderr);
  assert.equal(JSON.parse(coreResult.stdout).length, 6);

  const formResult = await runProcess(process.execPath, [cli, "list", "--tag", "form", "--json"], {
    timeoutMs: 5_000,
  });
  assert.equal(formResult.exitCode, 0, formResult.stderr);
  assert.deepEqual(
    JSON.parse(formResult.stdout).map(({ id }) => id),
    ["form-controls", "generated-form"],
  );
});

test("CLI validation and seed generation are machine-readable", async () => {
  const cli = resolve("evals/browser/cli.mjs");
  const validation = await runProcess(process.execPath, [cli, "validate", "--json"], {
    timeoutMs: 5_000,
  });
  assert.equal(validation.exitCode, 0, validation.stderr);
  assert.equal(JSON.parse(validation.stdout).ok, true);

  const generated = await runProcess(
    process.execPath,
    [cli, "generate", "--seed", "known-badcase", "--json"],
    { timeoutMs: 5_000 },
  );
  assert.equal(generated.exitCode, 0, generated.stderr);
  assert.equal(typeof JSON.parse(generated.stdout).hydrationDelayMs, "number");

  const generatedSet = await runProcess(
    process.execPath,
    [cli, "generate", "--seed", "4,7,14", "--json"],
    { timeoutMs: 5_000 },
  );
  assert.equal(generatedSet.exitCode, 0, generatedSet.stderr);
  assert.deepEqual(
    JSON.parse(generatedSet.stdout).map(({ seed }) => seed),
    [4, 7, 14],
  );
});
