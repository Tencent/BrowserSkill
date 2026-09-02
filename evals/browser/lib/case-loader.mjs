import { readFile } from "node:fs/promises";

import { discoverFiles } from "./discovery.mjs";
import { OPERATION_NAMES, WORKFLOW_ACTIONS } from "./operations.mjs";
import { casesDirectory as defaultCasesDirectory } from "./paths.mjs";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVIDENCE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const TOP_LEVEL_KEYS = new Set([
  "$schema",
  "schemaVersion",
  "id",
  "title",
  "order",
  "suite",
  "tags",
  "seed",
  "source",
  "fixture",
  "prompts",
  "coverage",
  "assertions",
  "smoke",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkString(errors, value, path) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${path} must be a string`);
}

function validateAssertion(errors, assertion, path, kind) {
  if (!isObject(assertion)) {
    errors.push(`${path} must be an object`);
    return;
  }
  checkString(errors, assertion.label, `${path}.label`);
  if (kind === "site") {
    checkString(errors, assertion.type, `${path}.type`);
    if (!Number.isInteger(assertion.minCount) || assertion.minCount < 1) {
      errors.push(`${path}.minCount must be a positive integer`);
    }
    if (assertion.where !== undefined && !isObject(assertion.where)) {
      errors.push(`${path}.where must be an object`);
    }
  } else if (kind === "response") {
    checkString(errors, assertion.includes, `${path}.includes`);
  } else {
    checkString(errors, assertion.key, `${path}.key`);
  }
}

function validateWorkflowStep(errors, step, path) {
  if (!isObject(step)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!WORKFLOW_ACTIONS.has(step.action)) {
    errors.push(`${path}.action is unsupported: ${JSON.stringify(step.action)}`);
  }
  if (step.saveAs !== undefined && !ID_PATTERN.test(step.saveAs)) {
    errors.push(`${path}.saveAs must use lowercase kebab-case`);
  }
  if (step.evidence !== undefined && !EVIDENCE_PATTERN.test(step.evidence)) {
    errors.push(`${path}.evidence must be an identifier`);
  }
  if (["click", "hover", "fill", "select"].includes(step.action) && !step.selector && !step.ref) {
    errors.push(`${path} requires selector or ref`);
  }
  if (step.action === "fill") checkString(errors, step.value, `${path}.value`);
  if (step.action === "select") {
    if (!Array.isArray(step.values) || step.values.length === 0) {
      errors.push(`${path}.values must be a non-empty array`);
    } else if (step.values.some((value) => typeof value !== "string")) {
      errors.push(`${path}.values must contain only strings`);
    }
  }
  if (step.action === "press") checkString(errors, step.key, `${path}.key`);
  if (step.action === "wait") checkString(errors, step.duration, `${path}.duration`);
  if (step.action === "wait-site-event") checkString(errors, step.type, `${path}.type`);
  if (["tab-select", "tab-close", "borrow", "return"].includes(step.action)) {
    checkString(errors, step.tabId, `${path}.tabId`);
  }
  if (step.action === "resize") {
    if (
      !Number.isInteger(step.width) ||
      step.width < 1 ||
      !Number.isInteger(step.height) ||
      step.height < 1
    ) {
      errors.push(`${path}.width and height must be positive integers`);
    }
  }
  if (step.action === "emulate") checkString(errors, step.device, `${path}.device`);
  if (step.action === "request-help") checkString(errors, step.prompt, `${path}.prompt`);
  if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 1)) {
    errors.push(`${path}.timeoutMs must be a positive integer`);
  }
}

export function validateCaseManifest(manifest, { source = "case manifest" } = {}) {
  const errors = [];
  if (!isObject(manifest)) return [`${source} must contain a JSON object`];
  for (const key of Object.keys(manifest)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown top-level property ${key}`);
  }
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  if (!ID_PATTERN.test(manifest.id ?? "")) errors.push("id must use lowercase kebab-case");
  checkString(errors, manifest.title, "title");
  if (manifest.order !== undefined && (!Number.isInteger(manifest.order) || manifest.order < 0)) {
    errors.push("order must be a non-negative integer");
  }
  if (!ID_PATTERN.test(manifest.suite ?? "")) errors.push("suite must use lowercase kebab-case");
  if (!Array.isArray(manifest.tags) || manifest.tags.some((tag) => !ID_PATTERN.test(tag))) {
    errors.push("tags must be an array of lowercase kebab-case strings");
  } else if (new Set(manifest.tags).size !== manifest.tags.length) {
    errors.push("tags must not contain duplicates");
  }
  if (!isObject(manifest.fixture)) errors.push("fixture must be an object");
  else if (
    typeof manifest.fixture.startPath !== "string" ||
    !manifest.fixture.startPath.startsWith("/")
  ) {
    errors.push("fixture.startPath must be an absolute URL path");
  }
  if (!isObject(manifest.prompts)) errors.push("prompts must be an object");
  else {
    checkString(errors, manifest.prompts.en, "prompts.en");
    checkString(errors, manifest.prompts["zh-CN"], "prompts.zh-CN");
  }
  if (!Array.isArray(manifest.coverage)) errors.push("coverage must be an array");
  else {
    for (const operation of manifest.coverage) {
      if (!OPERATION_NAMES.has(operation))
        errors.push(`coverage contains unknown operation ${operation}`);
    }
    if (new Set(manifest.coverage).size !== manifest.coverage.length) {
      errors.push("coverage must not contain duplicates");
    }
  }
  if (!isObject(manifest.assertions)) errors.push("assertions must be an object");
  else {
    for (const kind of ["site", "response", "adapter"]) {
      if (!Array.isArray(manifest.assertions[kind])) {
        errors.push(`assertions.${kind} must be an array`);
      } else {
        manifest.assertions[kind].forEach((assertion, index) =>
          validateAssertion(errors, assertion, `assertions.${kind}[${index}]`, kind),
        );
      }
    }
  }
  if (!isObject(manifest.smoke) || !Array.isArray(manifest.smoke.steps)) {
    errors.push("smoke.steps must be an array");
  } else {
    manifest.smoke.steps.forEach((step, index) =>
      validateWorkflowStep(errors, step, `smoke.steps[${index}]`),
    );
  }
  if (manifest.seed !== undefined && !Number.isSafeInteger(manifest.seed)) {
    errors.push("seed must be a safe integer");
  }
  if (manifest.source !== undefined && !isObject(manifest.source)) {
    errors.push("source must be an object");
  }
  return errors.map((error) => `${source}: ${error}`);
}

function normalizeCase(manifest, sourceFile) {
  return Object.freeze({
    ...manifest,
    startPath: manifest.fixture.startPath,
    siteAssertions: manifest.assertions.site,
    responseAssertions: manifest.assertions.response,
    adapterAssertions: manifest.assertions.adapter,
    smokeSteps: manifest.smoke.steps,
    sourceFile,
  });
}

export async function loadCaseManifests({ casesDirectory = defaultCasesDirectory } = {}) {
  const files = await discoverFiles(casesDirectory, (path) => path.endsWith(".case.json"));
  const cases = [];
  const ids = new Map();
  const errors = [];
  for (const file of files) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      errors.push(`${file}: invalid JSON: ${error.message}`);
      continue;
    }
    const manifestErrors = validateCaseManifest(manifest, { source: file });
    errors.push(...manifestErrors);
    if (typeof manifest?.id === "string") {
      if (ids.has(manifest.id)) {
        errors.push(`${file}: duplicate id also declared by ${ids.get(manifest.id)}`);
      } else {
        ids.set(manifest.id, file);
      }
    }
    if (manifestErrors.length === 0) cases.push(normalizeCase(manifest, file));
  }
  if (files.length === 0) errors.push(`${casesDirectory}: no .case.json files found`);
  if (errors.length > 0) throw new Error(`case validation failed:\n${errors.join("\n")}`);
  cases.sort(
    (left, right) =>
      left.suite.localeCompare(right.suite) ||
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id),
  );
  return Object.freeze(cases);
}
