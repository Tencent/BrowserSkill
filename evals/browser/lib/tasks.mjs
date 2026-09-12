import { loadCaseManifests } from "./case-loader.mjs";

let casesPromise;

export function allTasks({ reload = false } = {}) {
  if (reload || !casesPromise) casesPromise = loadCaseManifests();
  return casesPromise;
}

export function listTasks(cases) {
  return cases.map(({ id, title, suite, tags, seed }) => ({ id, title, suite, tags, seed }));
}

export function getTask(taskId, cases) {
  const task = cases.find(({ id }) => id === taskId);
  if (!task) {
    const ids = cases.map(({ id }) => id).join(", ");
    throw new Error(`unknown case ${JSON.stringify(taskId)}; expected one of: ${ids}`);
  }
  return task;
}

export function taskUrl(task, baseUrl, runId, seed = task.seed) {
  const url = new URL(task.startPath, baseUrl);
  url.searchParams.set("run", runId);
  if (seed !== undefined) url.searchParams.set("seed", String(seed));
  return url.toString();
}

function expandTemplate(template, values) {
  return Object.entries(values).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

export function renderPrompt(task, { baseUrl, runId, locale = "zh-CN", seed = task.seed }) {
  const template = task.prompts[locale];
  if (!template) {
    throw new Error(`unsupported locale ${JSON.stringify(locale)}; expected en or zh-CN`);
  }
  return expandTemplate(template, {
    baseUrl,
    runId: encodeURIComponent(runId),
    seed: seed ?? "",
    url: taskUrl(task, baseUrl, runId, seed),
  });
}
