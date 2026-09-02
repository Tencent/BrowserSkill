import { relative, sep } from "node:path";

import { validateCaseFixtureLinks } from "./fixture-registry.mjs";
import { casesDirectory } from "./paths.mjs";

function templateRoots(value) {
  if (typeof value === "string") {
    return [...value.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1].split(".")[0]);
  }
  if (Array.isArray(value)) return value.flatMap(templateRoots);
  if (value && typeof value === "object") return Object.values(value).flatMap(templateRoots);
  return [];
}

export function validateRepositoryCases(cases, fixtureRegistry) {
  const errors = [...validateCaseFixtureLinks(cases, fixtureRegistry)];
  for (const testCase of cases) {
    const relativePath = relative(casesDirectory, testCase.sourceFile);
    const suiteDirectory = relativePath.split(sep)[0];
    if (suiteDirectory !== testCase.suite) {
      errors.push(
        `case ${testCase.id} declares suite ${testCase.suite} but is stored under ${suiteDirectory}`,
      );
    }

    const availableVariables = new Set(["baseUrl", "runId", "seed", "sessionId", "url"]);
    const evidence = new Set(["sessionStopped"]);
    for (const [index, step] of testCase.smokeSteps.entries()) {
      for (const root of templateRoots(step)) {
        if (!availableVariables.has(root)) {
          errors.push(
            `case ${testCase.id} smoke.steps[${index}] references unavailable variable ${root}`,
          );
        }
      }
      if (step.saveAs) availableVariables.add(step.saveAs);
      if (step.evidence) evidence.add(step.evidence);
    }
    for (const assertion of testCase.adapterAssertions) {
      if (!evidence.has(assertion.key)) {
        errors.push(
          `case ${testCase.id} expects adapter evidence ${assertion.key} but no smoke step produces it`,
        );
      }
    }
  }
  return errors;
}

export function repositorySummary(cases, fixtureRegistry) {
  const suites = Object.fromEntries(
    [...new Set(cases.map(({ suite }) => suite))]
      .sort()
      .map((suite) => [suite, cases.filter((testCase) => testCase.suite === suite).length]),
  );
  const tags = [...new Set(cases.flatMap(({ tags }) => tags))].sort();
  return {
    cases: cases.length,
    suites,
    tags: tags.length,
    fixtureModules: fixtureRegistry.definitions.length,
    fixtureRoutes: fixtureRegistry.routes.length,
  };
}
