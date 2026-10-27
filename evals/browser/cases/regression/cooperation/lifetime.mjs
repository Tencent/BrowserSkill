import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachExtensionWorker } from "./compatibility.mjs";
import { createDshRegressionClient } from "./dsh-client.mjs";

/** Exercise real task pages, not just never-used blank sessions. No tool call
 * touches the idle tasks during the wait; session list is a registry-only read. */
export async function runLifetimeScenario({
  bsk,
  send,
  base,
  cli,
  env,
  session,
  idleWaitMs,
  fullIdle,
  artifacts,
}) {
  const dsh = createDshRegressionClient(cli, env);
  const tasks = [];
  const targets = async () => (await send("Target.getTargets")).targetInfos;
  const start = async (client, suffix) => {
    const url = `${base}/?lifetime=${client}-${suffix}`;
    let id;
    if (client === "cli") {
      id = (await bsk(["session", "start"])).session_id;
      tasks.push({ client, id, url });
      await bsk(["navigate", url, "--session", id]);
      const state = await bsk(["cooperate", "sync", "--session", id]);
      await bsk([
        "fill",
        "#city",
        "--value",
        "Shanghai",
        "--session",
        id,
        "--context",
        state.context_id,
      ]);
    } else {
      id = (await dsh.run("bsk_session", { action: "start", url })).sessionId;
      assert(id);
      tasks.push({ client, id, url });
      const state = await dsh.run("bsk_session", { action: "sync", session: id });
      await dsh.run("bsk_interact", {
        action: "fill",
        target: "#city",
        value: "Shanghai",
        session: id,
        contextId: state.context_id,
      });
    }
    const task = tasks.at(-1);
    const target = (await targets()).find((t) => t.url === url);
    assert(target, `${client} unattended page was not created`);
    task.targetId = target.targetId;
    task.windowId = (
      await send("Browser.getWindowForTarget", { targetId: target.targetId })
    ).windowId;
    return task;
  };
  const stop = (task) =>
    task.client === "cli"
      ? bsk(["session", "stop", task.id])
      : dsh.run("bsk_session", { action: "stop", session: task.id });
  const assertCleaned = async (task) => {
    assert(
      !(await targets()).some((t) => t.targetId === task.targetId),
      `${task.client} task page leaked after cleanup`,
    );
    await assert.rejects(
      send("Browser.getWindowBounds", { windowId: task.windowId }),
      `${task.client} empty task window leaked`,
    );
  };
  try {
    for (const client of ["cli", "dsh"]) {
      const task = await start(client, "stop");
      await stop(task);
      await assertCleaned(task);
    }
    const moved = await start("cli", "detached");
    // Keep the task window alive so explicit stop, rather than window-close cleanup, is tested.
    await bsk(["tab", "create", "--session", moved.id]);
    const destinationUrl = `${base}/?lifetime=user-window`;
    const destination = await send("Target.createTarget", { url: destinationUrl, newWindow: true });
    const worker = await attachExtensionWorker(send);
    try {
      const result = await send(
        "Runtime.evaluate",
        {
          expression: `(async () => {
          const [page] = await chrome.tabs.query({url: ${JSON.stringify(moved.url)}});
          const [destination] = await chrome.tabs.query({url: ${JSON.stringify(destinationUrl)}});
          await chrome.tabs.move(page.id, {windowId: destination.windowId, index: -1});
        })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        worker,
      );
      assert(!result.exceptionDetails, JSON.stringify(result));
      await stop(moved);
      assert(
        (await targets()).some((t) => t.targetId === moved.targetId),
        "Stopping a task closed the page moved into the user's window",
      );
    } finally {
      await send("Target.detachFromTarget", { sessionId: worker });
      await send("Target.closeTarget", { targetId: moved.targetId }).catch(() => {});
      await send("Target.closeTarget", { targetId: destination.targetId }).catch(() => {});
    }
    const ordinary = [await start("cli", "idle"), await start("dsh", "idle")];
    console.error(`idle-check: waiting ${idleWaitMs} ms without task keepalive`);
    const started = performance.now();
    let beforeDeadline;
    if (fullIdle) {
      await new Promise((resolve) => setTimeout(resolve, 270000));
      beforeDeadline = await bsk(["session", "list"]);
      for (const task of ordinary)
        assert(
          beforeDeadline.some((s) => s.session_id === task.id),
          `${task.client} task reaped before five minutes`,
        );
      console.error("idle-check: both unattended task sessions still present at 270 seconds");
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, idleWaitMs - (performance.now() - started))),
    );
    const elapsedMs = performance.now() - started;
    const sessions = await bsk(["session", "list"]);
    assert(
      sessions.some((s) => s.session_id === session),
      "Human-held session disappeared during idle wait",
    );
    for (const task of ordinary) {
      assert(
        !sessions.some((s) => s.session_id === task.id),
        `${task.client} unattended idle session was not reaped`,
      );
      await assertCleaned(task);
    }
    const result = {
      elapsedMs,
      defaultTimeout: fullIdle,
      sharedRetained: true,
      ordinaryReaped: true,
      cliAndDsh: true,
      nonblankTasks: true,
      explicitStopCleaned: true,
      detachedUserPagePreserved: true,
      idleTabsAndWindowsCleaned: true,
    };
    if (artifacts)
      await writeFile(
        join(artifacts, "idle-state.json"),
        JSON.stringify(
          {
            ...result,
            sharedSession: session,
            ordinary,
            beforeDeadline,
            sessions,
            status: await bsk(["status"]),
          },
          null,
          2,
        ),
      );
    return result;
  } finally {
    for (const task of tasks) await stop(task).catch(() => {});
    await dsh.dispose();
  }
}
