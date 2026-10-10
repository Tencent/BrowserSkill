import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { withChrome } from "../cases/regression/snapshot-coordinates/chrome.mjs";
import { runProcess } from "../lib/process.mjs";
import { createEvalServer } from "../lib/server.mjs";

export async function runBenchmark({
  chrome,
  bskCommand = "target/release/bsk",
  samples = 20,
  out,
  sourceRoot,
  createBatchRunner,
  afterTrials,
}) {
  assert(chrome && out, "Supply chrome and out");
  assert(Number.isSafeInteger(samples) && samples > 0);
  const root = sourceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const bskPath = resolve(bskCommand);
  const scratch = await mkdtemp(join(tmpdir(), "bsk-known-actions-"));
  const env = { BSK_HOME: scratch, BSK_AUTO_START: "0", BSK_AUTO_UPDATE: "off" };
  const server = createEvalServer();
  const rows = [];
  let daemon;

  function checked(result) {
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return result;
  }
  async function bsk(args) {
    return JSON.parse(checked(await runProcess(bskPath, [...args, "--json"], { env })).stdout);
  }
  async function until(probe, description) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out: ${description}`);
  }
  function quote(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
  }
  try {
    daemon = spawn(bskPath, ["daemon", "start", "--port", "0", "--foreground"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let daemonError = "";
    let startError;
    daemon.on("error", (error) => {
      startError = error;
    });
    daemon.stderr.on("data", (chunk) => {
      daemonError += chunk;
    });
    const info = await until(async () => {
      if (startError) throw startError;
      if (daemon.exitCode !== null) throw new Error(daemonError);
      try {
        return JSON.parse(await readFile(join(scratch, "daemon.json"), "utf8"));
      } catch {
        return null;
      }
    }, "isolated daemon startup");
    console.log("daemon", info.ws_port);
    const buildConfig = join(scratch, "wxt.config.ts");
    const extensionOutput = join(scratch, "extension");
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
    const batchMode = createBatchRunner ? "dsh-batch" : "native-batch";
    const modes = ["separate", "shell-chain", batchMode];
    await withChrome(
      {
        executable: chrome,
        deviceScale: 1,
        zoom: 1,
        extensionPath: join(extensionOutput, "chrome-mv3"),
      },
      async (send) => {
        const browsers = await until(async () => {
          const result = await bsk(["browsers"]);
          return result.length ? result : null;
        }, "extension connection");
        console.log("browsers", JSON.stringify(browsers));
        // One warmup per mode, then rotate execution order each round.
        for (let round = -1; round < samples; round++) {
          for (let slot = 0; slot < modes.length; slot++) {
            const mode = modes[(slot + Math.max(0, round)) % modes.length];
            const runId = `known-${round + 1}-${mode}`;
            const session = await bsk(["session", "start", "--name", runId, "--no-focus"]);
            const sessionId = session.session_id;
            assert(sessionId, JSON.stringify(session));
            const scoped = ["--session", sessionId];
            try {
              await bsk(["navigate", `${serverInfo.baseUrl}/form?run=${runId}`, ...scoped]);
              const observation = await bsk(["observe", ...scoped, "--max-tokens", "2000"]);
              if (round === -1 && slot === 0)
                console.log("observation", JSON.stringify(observation));
              const ref = (label) => {
                const line = observation.text
                  .split("\n")
                  .find((line) => /@e\d+ /.test(line) && line.includes(`\"${label}`));
                const match = line?.match(/@?(e\d+)/);
                assert(match, `Missing ref for ${label}: ${observation.text}`);
                return `@${match[1]}`;
              };
              const steps = [
                { action: "fill", target: ref("Text input"), value: "benchmark" },
                { action: "fill", target: ref("Textarea"), value: "known actions" },
                { action: "select", target: ref("Dropdown"), values: ["two"] },
                { action: "click", target: ref("Submit") },
              ];
              const commands = steps.map((step) => [
                step.action,
                step.target,
                ...(step.value ? ["--value", step.value] : []),
                ...(step.values ? step.values.flatMap((value) => ["--value", value]) : []),
                ...scoped,
              ]);
              commands.push(["observe", ...scoped, "--max-tokens", "2000"]);
              let finalObservation;
              let extraObservations = 0;
              const runBatch = createBatchRunner?.({ bskPath, env, sessionId });
              const started = performance.now();
              if (mode === "separate") {
                for (const command of commands) finalObservation = await bsk(command);
              } else if (mode === "shell-chain") {
                const command = commands
                  .map(
                    (args, index) =>
                      [bskPath, ...args, "--json"].map(quote).join(" ") +
                      (index < 4 ? " > /dev/null" : ""),
                  )
                  .join(" && ");
                finalObservation = JSON.parse(
                  checked(await runProcess("/bin/sh", ["-c", command], { env })).stdout,
                );
              } else if (runBatch) {
                const result = await runBatch({
                  session: sessionId,
                  tabId: observation.tab_id,
                  steps,
                });
                assert.equal(result.status, "completed", JSON.stringify(result));
                finalObservation = result.observation;
              } else {
                const path = join(scratch, "plan.json");
                await writeFile(
                  path,
                  JSON.stringify({ observation_id: observation.observation_id, steps }),
                  { mode: 0o600 },
                );
                try {
                  finalObservation = (await bsk(["batch", "--file", path, ...scoped])).observation;
                } finally {
                  await rm(path, { force: true });
                }
              }
              const firstObservationReady = finalObservation?.text?.includes("Received!") ?? false;
              while (!finalObservation?.text?.includes("Received!")) {
                assert(extraObservations < 10, "Result was not observable");
                finalObservation = await bsk(["observe", ...scoped, "--max-tokens", "2000"]);
                extraObservations++;
              }
              const durationMs = performance.now() - started;
              const submissions = server
                .snapshot(runId)
                .events.filter((event) => event.type === "form.submitted");
              assert.equal(submissions.length, 1, "Each trial must submit exactly once");
              assert.deepEqual(submissions[0].data, {
                text: "benchmark",
                notes: "known actions",
                choice: "two",
              });
              assert(finalObservation.text.includes("benchmark | known actions | two"));
              const row = {
                round,
                mode,
                durationMs,
                extraObservations,
                firstObservationReady,
                logicalToolCalls: (mode === "separate" ? 5 : 1) + extraObservations,
                cliProcesses: (mode === "native-batch" ? 1 : 5) + extraObservations,
                success: true,
              };
              console.log(JSON.stringify(row));
              if (round >= 0) rows.push(row);
            } finally {
              await bsk(["session", "stop", sessionId]);
            }
          }
        }
        await afterTrials?.({ send, bsk, bskPath, env, server, serverInfo });
      },
    );
    const summary = modes.map((mode) => {
      const group = rows.filter((row) => row.mode === mode);
      const times = group.map((row) => row.durationMs).sort((a, b) => a - b);
      return {
        mode,
        samples: group.length,
        medianMs:
          (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2,
        p95Ms: times[Math.ceil(times.length * 0.95) - 1],
        extraObservations: group.reduce((n, row) => n + row.extraObservations, 0),
      };
    });
    await writeFile(
      out,
      JSON.stringify(
        {
          commit: checked(
            await runProcess("git", ["rev-parse", "HEAD"], { cwd: root }),
          ).stdout.trim(),
          dirty:
            checked(await runProcess("git", ["status", "--porcelain"], { cwd: root })).stdout
              .length > 0,
          date: new Date().toISOString(),
          chrome: checked(await runProcess(chrome, ["--version"])).stdout.trim(),
          platform: `${process.platform}/${process.arch}`,
          node: process.version,
          samples,
          audit: "disabled during timings",
          boundary:
            "Known observation to verified result; includes process startup, batch plan write/delete, actions, final observe and any extra observe; excludes setup and model/tool transport latency.",
          summary,
          rows,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await server.stop();
    if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, "exit");
      const force = setTimeout(() => daemon.kill("SIGKILL"), 5000);
      daemon.kill();
      await exited;
      clearTimeout(force);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      chrome: { type: "string" },
      bsk: { type: "string", default: "target/release/bsk" },
      samples: { type: "string", default: "20" },
      out: { type: "string" },
      root: { type: "string" },
    },
  });
  await runBenchmark({
    chrome: values.chrome,
    bskCommand: values.bsk,
    samples: Number(values.samples),
    out: values.out,
    sourceRoot: values.root,
  });
}
