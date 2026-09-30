// Opt-in full CLI/IPC/WS/installed-MV3-extension regression in an owned Chrome profile.
// CDP is used for test setup / screenshots only; all dialog decisions use bsk.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withChrome } from "../snapshot-coordinates/chrome.mjs";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const bsk = resolve(process.env.BSK_DIALOG_BSK ?? "target/debug/bsk");
const extension = resolve(process.env.BSK_DIALOG_EXTENSION ?? "apps/extension/dist/chrome-mv3");
const chrome = process.env.BSK_DIALOG_CHROME;
assert(chrome, "Set BSK_DIALOG_CHROME to a local Chrome for Testing executable");
const output = resolve(process.env.BSK_DIALOG_OUTPUT ?? "evals/browser/results/js-dialog-control");
const port = Number(process.env.BSK_DIALOG_PORT ?? 52837);
const baseline = process.env.BSK_DIALOG_BASELINE === "1";
const bskHome = await mkdtemp(join(tmpdir(), "bsk-dialog-home-"));
const env = { ...process.env, BSK_HOME: bskHome, BSK_AUTO_UPDATE: "off", BSK_AUTO_START: "0" };
const transcript = [];
await mkdir(output, { recursive: true });
async function cli(args, expectedCode = 0) {
  let result;
  try {
    result = {
      ...(await exec(bsk, [...args, "--json"], {
        env,
        timeout: 75000,
        maxBuffer: 8 * 1024 * 1024,
      })),
      code: 0,
    };
  } catch (error) {
    result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Invalid CLI result: ${JSON.stringify({ args, ...result })}`);
  }
  transcript.push({ args, exit_code: result.code, result: body });
  assert.equal(result.code, expectedCode, JSON.stringify({ args, ...result }));
  return body;
}
async function eventually(fn, milliseconds = 15000) {
  const until = Date.now() + milliseconds;
  let error;
  while (Date.now() < until) {
    try {
      return await fn();
    } catch (caught) {
      error = caught;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw error;
}
async function screenshot(name) {
  if (!process.env.BSK_DIALOG_SCREENSHOT_HELPER) return;
  const captured = await exec(
    "python3",
    [
      process.env.BSK_DIALOG_SCREENSHOT_HELPER,
      "--app",
      "Google Chrome for Testing",
      "--window-name",
      "BrowserSkill Dialog Control",
      "--mode",
      "temp",
    ],
    { timeout: 20000 },
  );
  const paths = captured.stdout
    .trim()
    .split("\n")
    .filter((path) => path.startsWith("/") && path.endsWith(".png"));
  assert.equal(paths.length, 1, captured.stdout);
  await copyFile(paths[0], join(output, `${name}.png`));
}

const html = await readFile(join(here, "page.html"));
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    request.url === "/destination"
      ? "<title>Destination</title><h1>Navigation completed</h1>"
      : html,
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/`;
const daemon = spawn(bsk, ["daemon", "start", "--foreground", "--port", String(port)], {
  env,
  stdio: ["ignore", "ignore", "pipe"],
});
let daemonLog = "";
daemon.stderr.on("data", (data) => {
  daemonLog += data;
});
try {
  await eventually(async () => {
    await cli(["status"]);
  });
  await withChrome(
    { executable: chrome, deviceScale: 1, zoom: 1, extensionPath: extension, headless: false },
    async (send) => {
      const version = await send("Browser.getVersion");
      const worker = await eventually(async () => {
        const targets = (await send("Target.getTargets")).targetInfos;
        const target = targets.find(
          (target) =>
            target.type === "service_worker" &&
            target.url.startsWith("chrome-extension://") &&
            target.url.endsWith("/background.js"),
        );
        assert(target, "Built extension service worker not found");
        return target;
      });
      const browsers = await eventually(async () => {
        const reply = await cli(["browsers"]);
        assert.equal((Array.isArray(reply) ? reply : reply.browsers).length, 1);
        return reply;
      });
      const started = await cli(["session", "start"]);
      const session = started.session_id;
      const sessionArgs = ["--session", session];
      await cli(["debug", "start", ...sessionArgs, "--name", "JS dialog control E2E"]);
      await cli(["navigate", url, ...sessionArgs]);
      const evaluate = (expression, expectedCode = 0) =>
        cli(["evaluate", expression, ...sessionArgs], expectedCode);
      const pending = async (expression) => {
        const reply = await evaluate(expression, 6);
        assert.equal(reply.code, "dialog_pending");
        assert(reply.data.operation_id && reply.data.dialog.id);
        return reply.data;
      };
      const decide = (dialog, accept, text) =>
        cli([
          "dialog",
          accept ? "accept" : "dismiss",
          dialog.id,
          ...sessionArgs,
          ...(text !== undefined ? ["--text", text] : []),
        ]);
      const result = (id) => cli(["operation", "await", id, ...sessionArgs]);
      if (baseline) {
        assert.equal((await evaluate("runConfirm()")).value, true);
        assert.equal((await evaluate("runPrompt()")).value, "anonymous");
        await screenshot("baseline-forced-confirm-default-prompt");
      } else {
        let receipt = await pending("runConfirm()");
        assert.equal(receipt.dialog.type, "confirm");
        assert.equal(
          (await cli(["dialog", "status", ...sessionArgs])).dialogs[0].id,
          receipt.dialog.id,
        );
        await screenshot("confirm-pending");
        await decide(receipt.dialog, false);
        let finished = await result(receipt.operation_id);
        assert.equal(finished.state, "completed");
        assert.equal(finished.result.value, false);
        assert.equal((await evaluate("proofState.confirmCalls")).value, 1);
        assert.equal((await result(receipt.operation_id)).result.value, false);
        assert.equal((await evaluate("proofState.confirmCalls")).value, 1);
        console.log("PASS confirm dismiss + repeat result retrieval: action ran once");

        const click = await cli(["click", "#confirm", ...sessionArgs], 6);
        assert.equal(click.data.dialog.type, "confirm");
        await decide(click.data.dialog, true);
        assert.equal((await result(click.data.operation_id)).state, "completed");
        assert.equal((await evaluate("proofState.deleted")).value, true);
        assert.equal((await evaluate("proofState.confirmCalls")).value, 2);
        console.log("PASS real click confirm accept: one additional click");

        receipt = await pending("runPrompt()");
        await screenshot("prompt-pending");
        await decide(receipt.dialog, true, "Agent-selected name");
        assert.equal((await result(receipt.operation_id)).result.value, "Agent-selected name");
        await screenshot("agent-decisions-results");
        receipt = await pending("runPrompt()");
        await decide(receipt.dialog, true, "");
        assert.equal((await result(receipt.operation_id)).result.value, "");
        receipt = await pending("runPrompt()");
        await decide(receipt.dialog, false);
        assert.equal((await result(receipt.operation_id)).result.value, null);
        receipt = await pending("runPrompt()");
        await decide(receipt.dialog, true);
        assert.equal((await result(receipt.operation_id)).result.value, "anonymous");
        receipt = await pending("prompt('Long default', 'x'.repeat(10000))");
        await decide(receipt.dialog, true);
        assert.equal((await result(receipt.operation_id)).result.value.length, 10000);
        console.log("PASS prompt supplied text, empty text, cancel, and full native default");

        receipt = await pending("runAlert()");
        assert.equal(receipt.dialog.type, "alert");
        await decide(receipt.dialog, true);
        assert.equal((await result(receipt.operation_id)).result.value, null);
        console.log("PASS alert explicit agent acknowledgement");

        receipt = await pending("runChain()");
        const first = receipt.dialog;
        await decide(first, false);
        const second = await cli(["operation", "await", receipt.operation_id, ...sessionArgs], 6);
        assert.equal(second.data.operation_id, receipt.operation_id);
        assert.equal(second.data.dialog.type, "prompt");
        assert.notEqual(second.data.dialog.id, first.id);
        await cli(["dialog", "accept", first.id, ...sessionArgs], 1);
        await decide(second.data.dialog, true, "Second agent answer");
        assert.deepEqual((await result(receipt.operation_id)).result.value, {
          answer: false,
          text: "Second agent answer",
          calls: 1,
        });
        console.log("PASS chained dialogs share original operation; stale decision rejected");

        await cli(["click", "#arm", ...sessionArgs]);
        const navigation = await cli(["navigate", `${url}destination`, ...sessionArgs], 6);
        assert.equal(navigation.data.dialog.type, "beforeunload");
        await screenshot("beforeunload-pending");
        await decide(navigation.data.dialog, false);
        finished = await result(navigation.data.operation_id);
        assert.equal(finished.state, "failed");
        assert.equal(finished.error.code, "cancelled");
        assert.equal((await evaluate("location.href")).value, url);
        await screenshot("beforeunload-stay");
        await evaluate("window.onbeforeunload = null");
        console.log("PASS beforeunload stay: original navigation explicitly cancelled");

        receipt = await pending("runConfirm()");
        await cli(["operation", "cancel", receipt.operation_id, ...sessionArgs]);
        finished = await result(receipt.operation_id);
        assert.equal(finished.state, "failed");
        assert.equal(finished.error.code, "cancelled");
        assert.deepEqual((await cli(["dialog", "status", ...sessionArgs])).dialogs, []);
        console.log("PASS operation cancel clears the pending modal");

        receipt = await pending("runPrompt()");
        const secondSession = (await cli(["session", "start"])).session_id;
        assert.deepEqual((await cli(["dialog", "status", "--session", secondSession])).dialogs, []);
        await cli(
          [
            "dialog",
            "accept",
            receipt.dialog.id,
            "--session",
            secondSession,
            "--text",
            "Wrong session",
          ],
          1,
        );
        await cli(["operation", "await", receipt.operation_id, "--session", secondSession], 1);
        await cli(["session", "stop", secondSession]);
        await decide(receipt.dialog, true, "Owner session only");
        assert.equal((await result(receipt.operation_id)).result.value, "Owner session only");
        console.log("PASS another session cannot inspect, answer, or retrieve the modal");

        const confirmCalls = (await evaluate("proofState.confirmCalls")).value;
        await evaluate("setTimeout(() => runPrompt(), 500); 'scheduled'");
        const asynchronous = await eventually(async () => {
          const status = await cli(["dialog", "status", ...sessionArgs]);
          assert.equal(status.dialogs.length, 1);
          return status.dialogs[0];
        });
        const blocked = await evaluate("runConfirm()", 6);
        assert.equal(blocked.data.dispatched, false);
        assert.equal(blocked.data.operation_id, undefined);
        await decide(asynchronous, false);
        assert.equal((await evaluate("proofState.confirmCalls")).value, confirmCalls);
        assert.equal((await evaluate("proofState.name === null")).value, true);
        console.log(
          "PASS asynchronous modal discovered; new ordinary action rejected before dispatch",
        );

        await cli(["click", "#arm", ...sessionArgs]);
        const leave = await cli(["navigate", `${url}destination`, ...sessionArgs], 6);
        await decide(leave.data.dialog, true);
        const arrived = await result(leave.data.operation_id);
        assert.equal(arrived.state, "completed");
        assert.equal(arrived.result.final_url, `${url}destination`);
        await cli(["navigate", url, ...sessionArgs]);
        console.log(
          "PASS beforeunload leave: original navigation completes after agent acceptance",
        );

        if (process.env.BSK_DIALOG_TEST_TIMEOUT === "1") {
          receipt = await pending("runConfirm()");
          console.log("WAIT unanswered dialog decision deadline (60 seconds)");
          await new Promise((resolve) => setTimeout(resolve, 61000));
          finished = await result(receipt.operation_id);
          assert.equal(finished.state, "failed");
          assert.equal(finished.error.code, "cancelled");
          assert.equal((await evaluate("proofState.deleted")).value, false);
          assert.equal((await evaluate("proofState.confirmCalls")).value, 1);
          assert.deepEqual((await cli(["dialog", "status", ...sessionArgs])).dialogs, []);
          console.log(
            "PASS unanswered dialog rejected and original operation failed without replay",
          );
        }
      }
      await cli(["debug", "stop", ...sessionArgs]);
      const debugExport = `website-debug-${session}.json`;
      await cli(["debug", "export", ...sessionArgs, "--output", join(output, debugExport)]);
      await cli(["session", "stop", session]);
      await writeFile(
        join(output, "proof.json"),
        JSON.stringify(
          {
            baseline,
            test_timeout: process.env.BSK_DIALOG_TEST_TIMEOUT === "1",
            tested_at: new Date().toISOString(),
            debug_export: debugExport,
            browser: version,
            browsers,
            source_revision: process.env.BSK_DIALOG_REVISION ?? "working tree",
            transcript,
          },
          null,
          2,
        ),
      );
    },
  );
} finally {
  await writeFile(join(output, "transcript.json"), JSON.stringify(transcript, null, 2));
  await writeFile(join(output, "daemon.log"), daemonLog);
  if (daemon.exitCode === null) {
    daemon.kill();
    await once(daemon, "exit");
  }
  server.close();
  await rm(bskHome, { recursive: true, force: true });
}
