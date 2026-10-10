import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { withChrome } from "../cases/regression/snapshot-coordinates/chrome.mjs";
import { loadFixtureRegistry } from "../lib/fixture-registry.mjs";
import { runProcess } from "../lib/process.mjs";
import { createEvalServer } from "../lib/server.mjs";

const { values } = parseArgs({
  options: {
    chrome: { type: "string" },
    baseline: { type: "string" },
    out: { type: "string" },
    samples: { type: "string", default: "5" },
    modes: { type: "string", default: "main,candidate" },
    cases: { type: "string", default: "static,results,enabled" },
    cli: { type: "string" },
    smoke: { type: "boolean", default: false },
    profile: { type: "string", default: "headless" },
  },
});
assert(values.chrome && values.baseline && values.out, "Supply --chrome, --baseline and --out");
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0);
const modes = values.modes.split(",");
assert(modes.every((mode) => ["main", "candidate"].includes(mode)));
const cases = values.cases.split(",");
assert(
  cases.every((name) =>
    ["static", "results", "enabled", "timeout", "unsupported", "stale"].includes(name),
  ),
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(values.out);
await mkdir(out, { recursive: true, mode: 0o700 });
assert.equal(
  (await readdir(out)).length,
  0,
  "Use an empty output directory; traces are append-only",
);
const scratch = await mkdtemp(join(tmpdir(), "bsk-model-"));
const bskPath = resolve(values.cli ?? join(root, "target/release/bsk"));
const env = { BSK_HOME: scratch, BSK_AUTO_START: "0", BSK_AUTO_UPDATE: "off" };
const fixtureRegistry = await loadFixtureRegistry();
const fixture = await readFile(new URL("./dsh-element-waits.html", import.meta.url), "utf8");
const delays = new Map();
const server = createEvalServer({
  fixtureRegistry: {
    render(pathname, context) {
      if (pathname !== "/element-waits") return fixtureRegistry.render(pathname, context);
      const scenario = context.query.get("case");
      assert(cases.includes(scenario));
      return fixture.replace(
        "/* CONFIG */ {}",
        JSON.stringify({
          runId: context.runId,
          scenario,
          token: `READY-${context.runId.slice(0, 8)}`,
          delayMs: delays.get(context.runId),
          completed: context.query.get("completed") === "yes",
        }),
      );
    },
  },
});
let daemon;
const rows = [];
let stopRequested = false;
let stopDsh = () => {};
const stop = () => {
  stopRequested = true;
  stopDsh();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
function checked(result) {
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result;
}
async function bsk(args) {
  return JSON.parse(checked(await runProcess(bskPath, [...args, "--json"], { env })).stdout);
}
async function until(probe) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out starting isolated browser");
}
function analyze(events) {
  const models = events
    .filter(
      (e) => e.type === "http_start" && /\/(messages|chat\/completions|responses)$/.test(e.path),
    )
    .map((start) => {
      const end = events.find(
        (e) => ["http_end", "http_error"].includes(e.type) && e.id === start.id,
      );
      const headers = events.find((e) => e.type === "http_headers" && e.id === start.id);
      return {
        ...start,
        durationMs: end ? end.atMs - start.atMs : null,
        status: headers?.status,
        closeCode: end?.code,
      };
    });
  const tools = events
    .filter((e) => e.type === "tool/call")
    .map((start) => {
      const end = events.find((e) => e.type === "tool/result" && e.callId === start.callId);
      return { ...start, durationMs: end ? end.atMs - start.atMs : null, isError: end?.isError };
    });
  let toolMs = 0;
  let lastEnd = -Infinity;
  for (const tool of [...tools].sort((a, b) => a.atMs - b.atMs)) {
    const end = tool.atMs + (tool.durationMs ?? 0);
    toolMs += Math.max(0, end - Math.max(tool.atMs, lastEnd));
    lastEnd = Math.max(lastEnd, end);
  }
  return {
    models,
    tools,
    modelCalls: models.length,
    toolCalls: tools.length,
    modelMs: models.reduce((sum, m) => sum + (m.durationMs ?? 0), 0),
    toolMs,
  };
}
async function runDsh(args, options) {
  const events = [];
  const started = performance.now();
  const child = spawn("dsh", args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    pending = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        events.push({ ...JSON.parse(line), receivedMs: performance.now() - started });
      } catch {}
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let killTimer;
  stopDsh = () => {
    child.kill("SIGTERM");
    clearTimeout(killTimer);
    killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
  };
  const timer = setTimeout(stopDsh, 90_000);
  try {
    const [exitCode] = await once(child, "close");
    return { stdout, stderr, exitCode, events };
  } finally {
    stopDsh = () => {};
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
}
try {
  const metadata = {
    startedAt: new Date().toISOString(),
    sourceRevision: checked(
      await runProcess("git", ["rev-parse", "HEAD"], { cwd: root }),
    ).stdout.trim(),
    dshVersion: checked(await runProcess("dsh", ["--version"])).stdout.trim(),
    nodeVersion: process.version,
    chromeVersion: checked(await runProcess(values.chrome, ["--version"])).stdout.trim(),
    samples,
    modes,
    cases,
    hashes: {},
  };
  for (const [label, file] of Object.entries({
    baseline: resolve(values.baseline),
    candidate: join(root, "packages/dsh-plugin-browserskill/lib/index.mjs"),
    cli: bskPath,
  }))
    metadata.hashes[label] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  await writeFile(join(out, "metadata.json"), JSON.stringify(metadata, null, 2));
  daemon = spawn(bskPath, ["daemon", "start", "--port", "0", "--foreground"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let daemonError = "";
  daemon.stderr.on("data", (chunk) => {
    daemonError += chunk;
  });
  const info = await until(async () => {
    if (daemon.exitCode !== null) throw new Error(daemonError);
    try {
      return JSON.parse(await readFile(join(scratch, "daemon.json"), "utf8"));
    } catch {
      return null;
    }
  });
  const extensionOutput = join(scratch, "extension");
  const buildConfig = join(scratch, "wxt.config.ts");
  await writeFile(
    buildConfig,
    `import base from ${JSON.stringify(pathToFileURL(join(root, "apps/extension/wxt.config.ts")).href)};\n` +
      `export default { ...base, outDir: ${JSON.stringify(extensionOutput)} };\n`,
  );
  checked(
    await runProcess(
      join(root, "apps/extension/node_modules/.bin/wxt"),
      ["build", "--config", buildConfig],
      {
        cwd: join(root, "apps/extension"),
        env: { BSK_DAEMON_WS_URL: `ws://127.0.0.1:${info.ws_port}` },
      },
    ),
  );
  const serverInfo = await server.start();
  await withChrome(
    {
      executable: values.chrome,
      deviceScale: 1,
      zoom: 1,
      extensionPath: join(extensionOutput, "chrome-mv3"),
    },
    async () => {
      await until(async () => (await bsk(["browsers"])).length);
      if (values.smoke) {
        for (const suite of ["all", "matrix"]) {
          const smoke = checked(
            await runProcess(
              process.execPath,
              [
                join(root, "evals/browser/cli.mjs"),
                "smoke",
                ...(suite === "all" ? ["--case", "all"] : ["--suite", suite, "--seed", "4,7,14"]),
                "--bsk",
                bskPath,
                "--out",
                join(out, `smoke-${suite}`),
              ],
              { cwd: root, env },
            ),
          );
          await writeFile(join(out, `smoke-${suite}.log`), smoke.stdout);
        }
      }
      trials: for (const scenario of cases) {
        for (let round = 0; round < samples; round++) {
          for (let slot = 0; slot < modes.length; slot++) {
            if (stopRequested) break trials;
            const mode = modes[(round + slot) % modes.length];
            const runId = `${scenario}-${round}-${mode}`;
            const fixtureId = randomUUID();
            const delayMs =
              scenario === "static"
                ? 0
                : scenario === "timeout"
                  ? 16000
                  : ["unsupported", "stale"].includes(scenario)
                    ? 6000
                    : [6000, 1500, 10000][round % 3];
            delays.set(fixtureId, delayMs);
            const tracePath = join(out, `${runId}.trace.jsonl`);
            const workspace = join(scratch, runId);
            await mkdir(workspace);
            const plugin =
              mode === "main"
                ? resolve(values.baseline)
                : join(root, "packages/dsh-plugin-browserskill/lib/index.mjs");
            let configuredCli = bskPath;
            if (scenario === "unsupported") {
              configuredCli = join(workspace, "legacy-cli.mjs");
              await writeFile(
                configuredCli,
                `#!/usr/bin/env node
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "wait-for-element") {
  process.stderr.write("error: unrecognized subcommand 'wait-for-element'\\n");
  process.exit(2);
}
const child = spawn(${JSON.stringify(bskPath)}, args, { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", () => process.exit(1));
child.on("exit", (code) => process.exit(code ?? 1));
`,
                { mode: 0o700 },
              );
            }
            const patch = [
              { id: "session-title-llm", disabled: true },
              { id: "skill-filesystem", disabled: true },
              { id: "session-persistence-jsonl", config: { root: join(scratch, "sessions") } },
              { id: "storage-json", config: { root: join(scratch, "storages") } },
              {
                insert: [
                  {
                    id: "browserskill",
                    name: pathToFileURL(plugin).href,
                    config: { bskPath: configuredCli, observationEnabled: false },
                  },
                ],
              },
            ];
            const patchPath = join(workspace, "patch.json");
            await writeFile(patchPath, JSON.stringify(patch));
            const token = `READY-${fixtureId.slice(0, 8)}`;
            const prompt =
              scenario === "static"
                ? `使用 browser-skill 打开 ${serverInfo.baseUrl}/form?run=${fixtureId}。` +
                  "将 Text input 填为“benchmark”，Textarea 填为“element waits”，Dropdown 选择“Two”（value 为“two”），点击 Submit。" +
                  "确认结果页显示“Received!”且三个值正确，关闭浏览器会话，然后简短报告结果。"
                : `使用 browser-skill 打开 ${serverInfo.baseUrl}/element-waits?run=${fixtureId}&case=${scenario}。` +
                  "点击“开始处理”，等处理完成后点击“确认结果”，核对完成页，报告校验码并关闭浏览器会话。" +
                  (scenario === "timeout"
                    ? "首次元素条件等待只给100毫秒；如果超时，检查页面并继续完成任务，不要重复开始处理。"
                    : "") +
                  (scenario === "unsupported"
                    ? "先尝试一次元素条件等待；若当前安装不支持，用已有工具继续完成任务。"
                    : "") +
                  (scenario === "stale"
                    ? "开始处理后观察页面，用这次观察中“处理中”的ref等待hidden；如果页面跳转令ref失效，重新观察并继续完成任务。"
                    : "");
            await writeFile(join(out, `${runId}.prompt.txt`), prompt);
            console.log(JSON.stringify({ phase: "start", scenario, round, mode }));
            const started = performance.now();
            const execution = await runDsh(
              ["--profile", values.profile, "--patch", patchPath, "--json", prompt],
              {
                cwd: workspace,
                env: {
                  ...env,
                  DSH_TELEMETRY_DISABLED: "1",
                  BSK_MODEL_TRACE: tracePath,
                  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./dsh-http-timing.mjs", import.meta.url).href}`,
                },
              },
            );
            const totalMs = performance.now() - started;
            await writeFile(join(out, `${runId}.stdout.jsonl`), execution.stdout, { mode: 0o600 });
            await writeFile(join(out, `${runId}.stderr.txt`), execution.stderr, { mode: 0o600 });
            const events = (await readFile(tracePath, "utf8").catch(() => ""))
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            for (const event of execution.events) {
              if (event.type === "tool_call")
                events.push({
                  type: "tool/call",
                  atMs: event.receivedMs,
                  callId: event.callId,
                  tool: event.tool,
                  action: event.input?.action,
                  state: event.input?.state,
                  timeoutMs: event.input?.timeoutMs,
                });
              if (event.type === "tool_result")
                events.push({
                  type: "tool/result",
                  atMs: event.receivedMs,
                  callId: event.callId,
                  isError: event.status === "error",
                });
            }
            await writeFile(join(out, `${runId}.events.json`), JSON.stringify(execution.events), {
              mode: 0o600,
            });
            const sessionId = execution.events.find((e) => e.type === "session")?.sessionId;
            let durable = [];
            if (sessionId) {
              for (const dir of await readdir(join(scratch, "sessions"))) {
                const source = join(scratch, "sessions", dir, sessionId, "session.v4.jsonl.zstd");
                try {
                  await cp(source, join(out, `${runId}.session.zstd`));
                } catch (error) {
                  if (error.code === "ENOENT") continue;
                  throw error;
                }
                const decoded = checked(await runProcess("zstd", ["-dc", source]));
                durable = decoded.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
              }
            }
            const fixtureEvents = server.snapshot(fixtureId).events;
            const submissions = fixtureEvents.filter((e) => e.type === "form.submitted");
            const confirmations = fixtureEvents.filter((e) => e.type === "waits.confirmed");
            const starts = fixtureEvents.filter((e) => e.type === "waits.started");
            const final = execution.events.find((e) => e.type === "final");
            const expected =
              scenario === "static" ? "benchmark | element waits | two" : `完成 ${token}`;
            const observed = execution.events.some(
              (e) => e.type === "tool_result" && e.result?.includes(expected),
            );
            const stopped = execution.events.some(
              (e) => e.type === "tool_result" && e.result?.includes("stopped browser session"),
            );
            const oracle =
              scenario === "static"
                ? submissions.length === 1 &&
                  JSON.stringify(submissions[0].data) ===
                    JSON.stringify({ text: "benchmark", notes: "element waits", choice: "two" })
                : starts.length === 1 &&
                  confirmations.length === 1 &&
                  confirmations[0].data.ready === true &&
                  confirmations[0].data.token === token;
            const success =
              execution.exitCode === 0 &&
              oracle &&
              observed &&
              stopped &&
              Boolean(final?.text.includes(scenario === "static" ? "Received!" : token));
            await writeFile(
              join(out, `${runId}.oracle.json`),
              JSON.stringify(fixtureEvents, null, 2),
            );
            const stats = analyze(events);
            const modelConfig = durable.find((e) => e.type === "request/header")?.data.header
              .config;
            const usage = execution.events
              .filter((e) => e.usage)
              .reduce((sum, e) => {
                for (const [key, value] of Object.entries(e.usage))
                  sum[key] = (sum[key] ?? 0) + value;
                return sum;
              }, {});
            const modelSteps = execution.events.filter((e) => e.phase === "step_end").length;
            const waitResults = execution.events
              .filter((e) => e.type === "tool_call" && e.input?.action === "wait-for-element")
              .map((call) => {
                const result = execution.events.find(
                  (e) => e.type === "tool_result" && e.callId === call.callId,
                );
                return {
                  state: call.input.state ?? "visible",
                  timeoutMs: call.input.timeoutMs ?? 10000,
                  result: result?.result,
                  isError: result?.status === "error",
                };
              });
            const toolErrors = stats.tools.filter((t) => t.isError).length;
            const attempts = durable.filter((e) =>
              ["assistant/message", "assistant/attempt"].includes(e.type),
            ).length;
            const measurementValid =
              stats.modelCalls > 0 &&
              stats.modelCalls === attempts &&
              stats.models.every((m) => m.durationMs !== null) &&
              stats.tools.every((t) => t.durationMs !== null);
            const turnStart = execution.events.find((e) => e.phase === "turn_start");
            const row = {
              scenario,
              delayMs,
              round,
              mode,
              totalMs,
              turnMs: (final?.receivedMs ?? totalMs) - (turnStart?.receivedMs ?? 0),
              measurementValid,
              success,
              exitCode: execution.exitCode,
              starts: starts.length,
              confirmations: confirmations.length,
              observed,
              stopped,
              modelConfig,
              usage,
              modelSteps,
              waitResults,
              toolErrors,
              ...stats,
            };
            rows.push(row);
            await writeFile(join(out, "results.json"), JSON.stringify({ rows }, null, 2));
            console.log(
              JSON.stringify({ phase: "done", ...row, models: undefined, tools: undefined }),
            );
            // The isolated daemon owns only this experiment's sessions, including failed runs.
            const sessions = await bsk(["session", "list"]);
            for (const session of sessions.sessions ?? sessions) {
              await bsk(["session", "stop", session.session_id ?? session.id]);
            }
          }
        }
      }
    },
  );
} finally {
  await server.stop();
  if (daemon && daemon.exitCode === null) {
    const exited = once(daemon, "exit");
    const timeout = setTimeout(() => daemon.kill("SIGKILL"), 5000);
    daemon.kill();
    await exited;
    clearTimeout(timeout);
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  if (stopRequested) process.exitCode = 130;
}
