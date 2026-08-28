import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { verifyTask } from "./oracle.mjs";
import { runProcess } from "./process.mjs";
import { taskUrl } from "./tasks.mjs";

function parseJsonOutput(step) {
  try {
    return JSON.parse(step.stdout);
  } catch (error) {
    throw new Error(`could not parse bsk JSON output: ${error.message}`);
  }
}

function renderStepError(step) {
  const raw = step.stderr.trim() || step.stdout.trim();
  if (!raw) return `exit ${step.exitCode}`;
  try {
    const parsed = JSON.parse(raw);
    return parsed.hint ? `${parsed.message} (hint: ${parsed.hint})` : parsed.message;
  } catch {
    return raw;
  }
}

async function hasNonemptyFile(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

function readPath(value, path) {
  return path.split(".").reduce((current, part) => current?.[part], value);
}

function resolveValue(value, variables) {
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{([^{}]+)}$/);
  if (exact) {
    const resolved = readPath(variables, exact[1]);
    if (resolved === undefined) throw new Error(`unknown workflow variable ${exact[1]}`);
    return resolved;
  }
  return value.replaceAll(/\{([^{}]+)\}/g, (_match, path) => {
    const resolved = readPath(variables, path);
    if (resolved === undefined) throw new Error(`unknown workflow variable ${path}`);
    return String(resolved);
  });
}

function targetArgs(step, variables) {
  if (step.selector) return ["--selector", String(resolveValue(step.selector, variables))];
  if (step.ref) return ["--ref", String(resolveValue(step.ref, variables))];
  return [];
}

function tabArgs(step, variables) {
  return step.tabId === undefined ? [] : ["--tab-id", String(resolveValue(step.tabId, variables))];
}

function matchesWhere(value, where = {}) {
  return Object.entries(where).every(([path, expected]) => readPath(value, path) === expected);
}

export async function runBskSmokeTask({
  bskCommand,
  outputDirectory,
  server,
  serverInfo,
  task,
  runId,
  seed = task.seed,
  timeoutMs = 60_000,
}) {
  const steps = [];
  const evidence = {};
  const variables = {
    baseUrl: serverInfo.baseUrl,
    runId,
    seed: seed ?? "",
    url: taskUrl(task, serverInfo.baseUrl, runId, seed),
  };
  let sessionId;
  let executionError;
  await mkdir(outputDirectory, { recursive: true });

  async function bsk(args, { timeout = timeoutMs } = {}) {
    const execution = await runProcess(bskCommand, [...args, "--json"], { timeoutMs: timeout });
    steps.push(execution);
    if (execution.exitCode !== 0 || execution.timedOut || execution.error) {
      throw new Error(
        `bsk ${args.join(" ")} failed: ${execution.error ?? renderStepError(execution)}`,
      );
    }
    return parseJsonOutput(execution);
  }

  async function waitForSiteEvent(step) {
    const timeout = step.timeoutMs ?? 3_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (
        server
          .snapshot(runId)
          .events.some(
            (event) => event.type === step.type && matchesWhere(event.data ?? {}, step.where ?? {}),
          )
      ) {
        return { observed: true };
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    throw new Error(`local fixture did not report ${step.type} within ${timeout}ms`);
  }

  async function executeWorkflowStep(step) {
    const session = ["--session", sessionId];
    let result;
    switch (step.action) {
      case "navigate":
        result = await bsk([
          "navigate",
          String(resolveValue(step.url ?? "{url}", variables)),
          ...session,
          ...tabArgs(step, variables),
        ]);
        break;
      case "back":
      case "forward":
        result = await bsk([`navigate-${step.action}`, ...session, ...tabArgs(step, variables)]);
        break;
      case "reload":
        result = await bsk(["reload", ...session, ...tabArgs(step, variables)]);
        break;
      case "wait":
        result = await bsk(["wait-ms", String(resolveValue(step.duration, variables))]);
        break;
      case "wait-site-event":
        result = await waitForSiteEvent(step);
        break;
      case "observe":
      case "snapshot":
      case "html": {
        const command = step.action === "html" ? "get-html" : step.action;
        result = await bsk([command, ...session, ...tabArgs(step, variables)]);
        break;
      }
      case "screenshot": {
        const name = resolveValue(step.artifactName ?? "screenshot.png", variables);
        const path = join(outputDirectory, `${runId}-${name}`);
        result = await bsk(["screenshot", ...session, ...tabArgs(step, variables), "--out", path]);
        if (step.evidence) evidence[step.evidence] = await hasNonemptyFile(path);
        break;
      }
      case "console":
      case "network":
        result = await bsk([step.action, ...session, ...tabArgs(step, variables)]);
        break;
      case "click":
      case "hover":
        result = await bsk([
          step.action,
          ...targetArgs(step, variables),
          ...session,
          ...tabArgs(step, variables),
        ]);
        break;
      case "fill":
        result = await bsk([
          "fill",
          ...targetArgs(step, variables),
          "--value",
          String(resolveValue(step.value, variables)),
          ...session,
          ...tabArgs(step, variables),
        ]);
        break;
      case "select":
        result = await bsk([
          "select",
          ...targetArgs(step, variables),
          ...step.values.flatMap((value) => ["--value", String(resolveValue(value, variables))]),
          ...session,
          ...tabArgs(step, variables),
        ]);
        break;
      case "press":
        result = await bsk([
          "press",
          String(resolveValue(step.key, variables)),
          ...targetArgs(step, variables),
          ...session,
          ...tabArgs(step, variables),
        ]);
        break;
      case "tab-list":
        result = await bsk(["tab", "list", ...session]);
        break;
      case "tab-create":
        result = await bsk([
          "tab",
          "create",
          ...session,
          ...(step.url ? ["--url", String(resolveValue(step.url, variables))] : []),
        ]);
        break;
      case "tab-select":
      case "tab-close":
        result = await bsk([
          "tab",
          step.action.slice(4),
          String(resolveValue(step.tabId, variables)),
          ...session,
        ]);
        break;
      case "borrow":
      case "return":
        result = await bsk([
          "tab",
          step.action,
          String(resolveValue(step.tabId, variables)),
          ...session,
        ]);
        break;
      case "resize":
        result = await bsk([
          "window",
          "resize",
          ...session,
          "--width",
          String(step.width),
          "--height",
          String(step.height),
        ]);
        break;
      case "emulate":
        result = await bsk([
          "emulate",
          ...session,
          ...tabArgs(step, variables),
          "--device",
          String(resolveValue(step.device, variables)),
        ]);
        break;
      case "request-help":
        result = await bsk([
          "request-help",
          ...session,
          "--prompt",
          String(resolveValue(step.prompt, variables)),
          ...(step.title ? ["--title", String(resolveValue(step.title, variables))] : []),
          ...(step.timeout ? ["--timeout", String(step.timeout)] : []),
        ]);
        break;
      default:
        throw new Error(`unsupported smoke workflow action ${step.action}`);
    }
    if (step.saveAs) variables[step.saveAs] = result;
    if (step.evidence && step.action !== "screenshot") evidence[step.evidence] = true;
  }

  server.reset(runId);
  try {
    if (task.smokeSteps.length === 0) throw new Error(`case ${task.id} has no smoke workflow`);
    const started = await bsk(["session", "start", "--no-focus"], { timeout: 90_000 });
    sessionId = started.session_id;
    variables.sessionId = sessionId;
    await bsk(["session", "list"]);
    for (const step of task.smokeSteps) await executeWorkflowStep(step);
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
  } finally {
    if (sessionId) {
      try {
        const stopped = await bsk(["session", "stop", sessionId], { timeout: 90_000 });
        evidence.sessionStopped =
          stopped.stopped?.includes(sessionId) === true && (stopped.failed?.length ?? 0) === 0;
        if (!evidence.sessionStopped) {
          executionError ??= `bsk did not confirm that session ${sessionId} stopped`;
        }
      } catch (error) {
        evidence.sessionStopped = false;
        executionError ??= error instanceof Error ? error.message : String(error);
      }
    }
  }

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
  const responseText = steps.map(({ stdout }) => stdout).join("\n");
  const events = server.snapshot(runId).events;
  return {
    runId,
    caseId: task.id,
    taskId: task.id,
    suite: task.suite,
    tags: task.tags,
    seed,
    adapter: "bsk-direct",
    variant: "cli-direct",
    executionError,
    steps,
    evidence,
    eventCount: events.length,
    verification: verifyTask(task, { events, responseText, adapterEvidence: evidence }),
  };
}
