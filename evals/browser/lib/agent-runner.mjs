import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { verifyTask } from "./oracle.mjs";
import { countPattern, runProcess, substituteArgs } from "./process.mjs";
import { renderPrompt } from "./tasks.mjs";

function safeRunPart(value) {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
}

export async function loadAgentConfig(configPath, agentName) {
  const absolute = resolve(configPath);
  const config = JSON.parse(await readFile(absolute, "utf8"));
  const adapter = config.agents?.[agentName];
  if (!adapter) {
    const names = Object.keys(config.agents ?? {}).join(", ");
    throw new Error(`unknown agent ${JSON.stringify(agentName)}; configured agents: ${names}`);
  }
  if (typeof adapter.command !== "string" || !Array.isArray(adapter.args)) {
    throw new Error(`agent ${JSON.stringify(agentName)} must define command and args`);
  }
  return { adapter, configDirectory: dirname(absolute) };
}

export async function runCommandTask({
  server,
  serverInfo,
  task,
  adapter,
  adapterName,
  configDirectory,
  iteration,
  locale,
  seed = task.seed,
  timeoutMs,
  variantOverride,
}) {
  const variant = variantOverride ?? adapter.variant ?? "unspecified";
  const runId = [
    safeRunPart(adapterName),
    safeRunPart(variant),
    safeRunPart(task.id),
    iteration,
    randomUUID().slice(0, 8),
  ].join("-");
  server.reset(runId);
  const prompt = renderPrompt(task, { baseUrl: serverInfo.baseUrl, runId, locale, seed });
  const values = {
    prompt,
    caseId: task.id,
    taskId: task.id,
    runId,
    baseUrl: serverInfo.baseUrl,
    seed: seed ?? "",
    variant,
  };
  const args = substituteArgs(adapter.args, values);
  const execution = await runProcess(adapter.command, args, {
    cwd: adapter.cwd ? resolve(configDirectory, adapter.cwd) : configDirectory,
    env: adapter.env,
    timeoutMs: adapter.timeoutMs ?? timeoutMs,
  });

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  const responseText = execution.stdout;
  const combinedOutput = `${execution.stdout}\n${execution.stderr}`;
  const verification = verifyTask(task, {
    events: server.snapshot(runId).events,
    responseText,
  });
  const defaultErrorPattern = "(?:\\bError:|timed out|unfinished command|session already has)";
  return {
    runId,
    caseId: task.id,
    taskId: task.id,
    suite: task.suite,
    tags: task.tags,
    seed,
    iteration,
    adapter: adapterName,
    variant,
    adapterMetadata: adapter.metadata ?? {},
    locale,
    prompt,
    execution,
    metrics: {
      errorCount: countPattern(
        combinedOutput,
        adapter.metrics?.errorPattern ?? defaultErrorPattern,
      ),
      toolCallCount: countPattern(combinedOutput, adapter.metrics?.toolCallPattern),
      responseChars: responseText.length,
    },
    eventCount: server.snapshot(runId).events.length,
    verification,
  };
}
