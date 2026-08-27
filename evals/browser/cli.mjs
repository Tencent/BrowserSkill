#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadAgentConfig, runCommandTask } from "./lib/agent-runner.mjs";
import { runBskSmokeTask } from "./lib/bsk-runner.mjs";
import { buildOperationCoverage } from "./lib/coverage.mjs";
import { loadFixtureRegistry } from "./lib/fixture-registry.mjs";
import { verifyTask } from "./lib/oracle.mjs";
import { resultsDirectory } from "./lib/paths.mjs";
import { repositorySummary, validateRepositoryCases } from "./lib/repository-validation.mjs";
import { scaffoldCase } from "./lib/scaffold-case.mjs";
import { describeSeed, normalizeSeed } from "./lib/seeded-generator.mjs";
import { createEvalServer } from "./lib/server.mjs";
import { printSummary, summarizeReports } from "./lib/summary.mjs";
import { allTasks, getTask, listTasks, renderPrompt } from "./lib/tasks.mjs";

const booleanOptions = new Set(["help", "json"]);

function parseArguments(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  let [command, ...rest] = normalized;
  const options = new Map();
  const positionals = [];
  if (command === "--help" || command === "-h") {
    command = undefined;
    options.set("help", [true]);
  }
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    let value = equals === -1 ? undefined : argument.slice(equals + 1);
    if (value === undefined && !booleanOptions.has(name)) {
      const candidate = rest[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        throw new Error(`--${name} requires a value`);
      }
      value = candidate;
      index += 1;
    }
    const values = options.get(name) ?? [];
    values.push(value ?? true);
    options.set(name, values);
  }
  return { command, options, positionals };
}

function option(parsed, name, fallback) {
  return parsed.options.get(name)?.at(-1) ?? fallback;
}

function optionList(parsed, name) {
  return (parsed.options.get(name) ?? [])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function numericOption(parsed, name, fallback) {
  const value = Number(option(parsed, name, fallback));
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be non-negative`);
  return value;
}

function seedOptions(parsed, fallback) {
  const requested = optionList(parsed, "seed");
  return requested.length > 0 ? unique(requested.map(normalizeSeed)) : [fallback];
}

function seedOption(parsed, fallback) {
  const seeds = seedOptions(parsed, fallback);
  if (seeds.length > 1) throw new Error("this command accepts only one --seed value");
  return seeds[0];
}

function unique(values) {
  return [...new Set(values)];
}

function selectCases(cases, parsed, { defaultSuite } = {}) {
  const requestedIds = unique([...optionList(parsed, "case"), ...optionList(parsed, "task")]);
  const requestedSuites = unique(optionList(parsed, "suite"));
  const requestedTags = unique(optionList(parsed, "tag"));
  const hasSelector =
    requestedIds.length > 0 || requestedSuites.length > 0 || requestedTags.length > 0;

  if (requestedIds.includes("all") && requestedIds.length > 1) {
    throw new Error("--case all cannot be combined with named cases");
  }
  if (requestedSuites.includes("all") && requestedSuites.length > 1) {
    throw new Error("--suite all cannot be combined with named suites");
  }

  const caseIds = requestedIds.includes("all") ? [] : requestedIds;
  const suites = requestedSuites.includes("all")
    ? []
    : requestedSuites.length > 0
      ? requestedSuites
      : !hasSelector && defaultSuite
        ? [defaultSuite]
        : [];

  const knownIds = new Set(cases.map(({ id }) => id));
  const missingIds = caseIds.filter((id) => !knownIds.has(id));
  if (missingIds.length > 0) throw new Error(`unknown case(s): ${missingIds.join(", ")}`);
  const knownSuites = new Set(cases.map(({ suite }) => suite));
  const missingSuites = suites.filter((suite) => !knownSuites.has(suite));
  if (missingSuites.length > 0) throw new Error(`unknown suite(s): ${missingSuites.join(", ")}`);
  const knownTags = new Set(cases.flatMap(({ tags }) => tags));
  const missingTags = requestedTags.filter((tag) => !knownTags.has(tag));
  if (missingTags.length > 0) throw new Error(`unknown tag(s): ${missingTags.join(", ")}`);

  const selected = cases.filter(
    (testCase) =>
      (caseIds.length === 0 || caseIds.includes(testCase.id)) &&
      (suites.length === 0 || suites.includes(testCase.suite)) &&
      requestedTags.every((tag) => testCase.tags.includes(tag)),
  );
  if (selected.length === 0) throw new Error("case selectors matched no cases");
  return selected;
}

function reportFilename(mode) {
  return `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${mode}.json`;
}

async function saveReport(report, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const path = join(outputDirectory, reportFilename(report.mode));
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

async function loadValidatedCorpus() {
  const [cases, fixtureRegistry] = await Promise.all([allTasks(), loadFixtureRegistry()]);
  const errors = validateRepositoryCases(cases, fixtureRegistry);
  if (errors.length > 0) throw new Error(`browser eval validation failed:\n${errors.join("\n")}`);
  return { cases, fixtureRegistry };
}

function selectionMetadata(cases) {
  return {
    cases: cases.map(({ id }) => id),
    suites: unique(cases.map(({ suite }) => suite)),
    tags: unique(cases.flatMap(({ tags }) => tags)).sort(),
  };
}

function usage() {
  console.log(`BrowserSkill local browser evaluation

Usage:
  node evals/browser/cli.mjs validate [--json]
  node evals/browser/cli.mjs list [--suite NAME] [--tag NAME] [--case ID] [--json]
  node evals/browser/cli.mjs coverage [--suite NAME] [--tag NAME] [--case ID] [--json]
  node evals/browser/cli.mjs serve [--host 127.0.0.1] [--port 4173]
  node evals/browser/cli.mjs prompt <case> [--base-url URL] [--run-id ID] [--seed VALUE]
  node evals/browser/cli.mjs verify <case> --base-url URL --run-id ID [--response TEXT]
  node evals/browser/cli.mjs smoke [--bsk bsk] [--suite core] [--case ID] [--seed VALUE]
  node evals/browser/cli.mjs run-agent --config FILE --agent NAME [--suite core] [--case ID]
  node evals/browser/cli.mjs generate --seed VALUE [--json]
  node evals/browser/cli.mjs scaffold <case-id> [--suite regression] [--title TEXT]
  node evals/browser/cli.mjs summarize <report.json> [more reports...]

Selection:
  --case ID[,ID]       Select case ids; --task is a backward-compatible alias
  --suite NAME[,NAME]  Select suites
  --tag NAME[,NAME]    Require every selected tag
  --case all           Explicitly include every suite (run commands default to core)
  --seed VALUE[,VALUE] Run one or more reproducible matrix seeds

run-agent options:
  --agent NAME[,NAME]  One or more entries from the config file
  --variant NAME       Override the report label (does not switch plugin code)
  --locale en|zh-CN    Prompt language (default zh-CN)
  --repeat N           Repeat every selected case (default 1)
  --timeout MS         Per-agent timeout (default 300000)
  --out DIRECTORY      Report/artifact directory
`);
}

async function commandValidate(parsed) {
  const { cases, fixtureRegistry } = await loadValidatedCorpus();
  const summary = { ok: true, ...repositorySummary(cases, fixtureRegistry) };
  if (option(parsed, "json", false)) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`Validated ${summary.cases} cases and ${summary.fixtureRoutes} fixture routes.`);
    console.log(
      `Suites: ${Object.entries(summary.suites)
        .map(([suite, count]) => `${suite}=${count}`)
        .join(", ")}`,
    );
  }
}

async function commandList(parsed) {
  const cases = selectCases(await allTasks(), parsed);
  const tasks = listTasks(cases);
  if (option(parsed, "json", false)) console.log(JSON.stringify(tasks, null, 2));
  else {
    for (const task of tasks) {
      console.log(`${task.id}\t${task.suite}\t${task.tags.join(",")}\t${task.title}`);
    }
  }
}

async function commandCoverage(parsed) {
  const cases = selectCases(await allTasks(), parsed);
  const coverage = buildOperationCoverage(cases);
  if (option(parsed, "json", false)) {
    console.log(JSON.stringify(coverage, null, 2));
  } else {
    console.table(
      coverage.map(({ operation, agentCases, smokeCases, directSmoke, note }) => ({
        operation,
        agent_cases: agentCases.join(", ") || "-",
        smoke_cases: smokeCases.join(", ") || "-",
        direct_smoke: directSmoke ? "yes" : "manual",
        note: note ?? "",
      })),
    );
  }
}

async function commandServe(parsed) {
  const { fixtureRegistry } = await loadValidatedCorpus();
  const server = createEvalServer({
    host: option(parsed, "host", "127.0.0.1"),
    port: numericOption(parsed, "port", 4173),
    fixtureRegistry,
  });
  const info = await server.start();
  console.log(`Browser eval server listening at ${info.baseUrl}`);
  console.log("Press Ctrl-C to stop.");
  await new Promise((resolveSignal) => {
    process.once("SIGINT", resolveSignal);
    process.once("SIGTERM", resolveSignal);
  });
  await server.stop();
}

async function commandPrompt(parsed) {
  const cases = await allTasks();
  const task = getTask(parsed.positionals[0], cases);
  const prompt = renderPrompt(task, {
    baseUrl: option(parsed, "base-url", "http://127.0.0.1:4173"),
    runId: option(parsed, "run-id", randomUUID()),
    locale: option(parsed, "locale", "zh-CN"),
    seed: seedOption(parsed, task.seed),
  });
  console.log(prompt);
}

async function commandVerify(parsed) {
  const task = getTask(parsed.positionals[0], await allTasks());
  const baseUrl = option(parsed, "base-url");
  const runId = option(parsed, "run-id");
  if (!baseUrl || !runId) throw new Error("verify requires --base-url and --run-id");
  let responseText = option(parsed, "response", "");
  const responseFile = option(parsed, "response-file");
  if (responseFile) responseText = await readFile(resolve(responseFile), "utf8");
  const stateResponse = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}`);
  if (!stateResponse.ok) throw new Error(`oracle request failed with ${stateResponse.status}`);
  const state = await stateResponse.json();
  const verification = verifyTask(task, { events: state.events, responseText });
  console.log(JSON.stringify(verification, null, 2));
  if (verification.status === "failed") process.exitCode = 1;
}

async function commandRunAgent(parsed) {
  const configPath = option(parsed, "config");
  const agentNames = optionList(parsed, "agent");
  if (!configPath || agentNames.length === 0) {
    throw new Error("run-agent requires --config and at least one --agent");
  }
  const { cases, fixtureRegistry } = await loadValidatedCorpus();
  const selected = selectCases(cases, parsed, { defaultSuite: "core" });
  const repeat = numericOption(parsed, "repeat", 1);
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be at least 1");
  const outputDirectory = resolve(option(parsed, "out", resultsDirectory));
  const server = createEvalServer({ fixtureRegistry });
  const serverInfo = await server.start();
  const results = [];
  const startedAt = new Date().toISOString();
  try {
    for (const agentName of agentNames) {
      const { adapter, configDirectory } = await loadAgentConfig(configPath, agentName);
      for (let iteration = 1; iteration <= repeat; iteration += 1) {
        for (const task of selected) {
          for (const seed of seedOptions(parsed, task.seed)) {
            const seedLabel = seed === undefined ? "" : ` seed=${seed}`;
            console.log(`[run] ${agentName} ${task.id}${seedLabel} (${iteration}/${repeat})`);
            const result = await runCommandTask({
              server,
              serverInfo,
              task,
              adapter,
              adapterName: agentName,
              configDirectory,
              iteration,
              locale: option(parsed, "locale", "zh-CN"),
              seed,
              timeoutMs: numericOption(parsed, "timeout", 300_000),
              variantOverride: option(parsed, "variant"),
            });
            results.push(result);
            console.log(`  ${result.verification.status} in ${result.execution.durationMs}ms`);
          }
        }
      }
    }
  } finally {
    await server.stop();
  }
  const report = {
    schemaVersion: 1,
    mode: "agent",
    startedAt,
    finishedAt: new Date().toISOString(),
    selection: selectionMetadata(selected),
    seeds: unique(results.map(({ seed }) => seed).filter((seed) => seed !== undefined)),
    results,
  };
  const path = await saveReport(report, outputDirectory);
  printSummary(summarizeReports([report]));
  console.log(`Report: ${path}`);
  if (
    results.some(
      (result) =>
        result.verification.status === "failed" ||
        result.execution.timedOut ||
        result.execution.exitCode !== 0,
    )
  ) {
    process.exitCode = 1;
  }
}

async function commandSmoke(parsed) {
  const { cases, fixtureRegistry } = await loadValidatedCorpus();
  const selected = selectCases(cases, parsed, { defaultSuite: "core" });
  const outputDirectory = resolve(option(parsed, "out", resultsDirectory));
  const server = createEvalServer({ fixtureRegistry });
  const serverInfo = await server.start();
  const results = [];
  const startedAt = new Date().toISOString();
  try {
    for (const task of selected) {
      for (const seed of seedOptions(parsed, task.seed)) {
        const runId = `bsk-${task.id}-${randomUUID().slice(0, 8)}`;
        const seedLabel = seed === undefined ? "" : ` seed=${seed}`;
        console.log(`[smoke] ${task.id}${seedLabel}`);
        const result = await runBskSmokeTask({
          bskCommand: option(parsed, "bsk", "bsk"),
          outputDirectory,
          server,
          serverInfo,
          task,
          runId,
          seed,
          timeoutMs: numericOption(parsed, "timeout", 60_000),
        });
        results.push(result);
        console.log(
          `  ${result.verification.status}${result.executionError ? `: ${result.executionError}` : ""}`,
        );
      }
    }
  } finally {
    await server.stop();
  }
  const report = {
    schemaVersion: 1,
    mode: "bsk-smoke",
    startedAt,
    finishedAt: new Date().toISOString(),
    selection: selectionMetadata(selected),
    seeds: unique(results.map(({ seed }) => seed).filter((seed) => seed !== undefined)),
    results,
  };
  const path = await saveReport(report, outputDirectory);
  printSummary(summarizeReports([report]));
  console.log(`Report: ${path}`);
  if (results.some((result) => result.executionError || result.verification.status === "failed")) {
    process.exitCode = 1;
  }
}

async function commandGenerate(parsed) {
  if (!parsed.options.has("seed")) throw new Error("generate requires --seed");
  const dimensions = unique(optionList(parsed, "seed").map(normalizeSeed)).map(describeSeed);
  const output = dimensions.length === 1 ? dimensions[0] : dimensions;
  if (option(parsed, "json", false)) console.log(JSON.stringify(output, null, 2));
  else console.table(dimensions);
}

async function commandScaffold(parsed) {
  const id = parsed.positionals[0];
  if (!id) throw new Error("scaffold requires a case id");
  const result = await scaffoldCase({
    id,
    title: option(parsed, "title", id),
    suite: option(parsed, "suite", "regression"),
    source: option(parsed, "source"),
  });
  if (option(parsed, "json", false)) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Created ${result.directory}`);
    console.log(
      "Edit the fixture, prompt, workflow, and assertions, then run eval:browser validate.",
    );
  }
}

async function commandSummarize(parsed) {
  const paths = [...parsed.positionals, ...optionList(parsed, "input")];
  if (paths.length === 0) throw new Error("summarize requires at least one report path");
  const reports = await Promise.all(
    paths.map(async (path) => JSON.parse(await readFile(resolve(path), "utf8"))),
  );
  const rows = summarizeReports(reports);
  if (option(parsed, "json", false)) console.log(JSON.stringify(rows, null, 2));
  else printSummary(rows);
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.command || option(parsed, "help", false)) return usage();
  switch (parsed.command) {
    case "validate":
      return commandValidate(parsed);
    case "list":
      return commandList(parsed);
    case "coverage":
      return commandCoverage(parsed);
    case "serve":
      return commandServe(parsed);
    case "prompt":
      return commandPrompt(parsed);
    case "verify":
      return commandVerify(parsed);
    case "run-agent":
      return commandRunAgent(parsed);
    case "smoke":
      return commandSmoke(parsed);
    case "generate":
      return commandGenerate(parsed);
    case "scaffold":
      return commandScaffold(parsed);
    case "summarize":
      return commandSummarize(parsed);
    default:
      throw new Error(`unknown command ${JSON.stringify(parsed.command)}`);
  }
}

main().catch((error) => {
  console.error(`browser eval: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
