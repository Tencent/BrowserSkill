import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** `bsk plan` through the installed extension, including real human input between steps. */
export async function runPlanScenarios({ send, bsk, cli, env, base }) {
  const url = `${base}/target-policy?client=plan`;
  const { session_id: session } = await bsk(["session", "start"]);
  const scope = ["--session", session];
  let human;
  try {
    await bsk(["navigate", url, ...scope]);
    const target = (await send("Target.getTargets")).targetInfos.find((entry) => entry.url === url);
    assert(target, "plan task page was not created");
    ({ sessionId: human } = await send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    }));
    await send("Page.bringToFront", {}, human);
    const read = async (expression) => {
      const reply = await send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        human,
      );
      assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
      return reply.result.value;
    };
    const fixtureReady = "!!document.querySelector('#apply') && typeof window.applied === 'number'";
    const loaded = performance.now() + 5000;
    while (!(await read(fixtureReady))) {
      assert(performance.now() < loaded, "plan fixture did not load");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const plan = async (context, steps) => {
      const args = ["plan", ...scope, "--context", context, "--steps", JSON.stringify(steps)];
      try {
        return JSON.parse((await exec(cli, args, { env, timeout: 35000 })).stdout);
      } catch (error) {
        assert(error.stdout, String(error));
        return JSON.parse(error.stdout);
      }
    };
    const first = await bsk(["cooperate", "sync", ...scope]);
    assert.equal(first.control_policy, "target");
    const apply = first.observation.text.match(/(@e\d+) button "Apply"/)?.[1];
    const note = first.observation.text.match(/(@e\d+) textbox "Note"/)?.[1];
    assert(apply && note, first.observation.text);

    // One context survives every step, while the page's own clock keeps changing.
    const started = performance.now();
    const done = await plan(first.context_id, [
      { action: "fill", ref: note, value: "planned" },
      { action: "click", ref: apply },
      { action: "click", ref: apply },
    ]);
    const elapsed = Math.round(performance.now() - started);
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.completed, 3);
    assert.equal(await read("applied"), 2);
    assert.equal(await read("document.querySelector('#note').value"), "planned");
    assert.equal(done.post.control_policy, "target");
    assert(done.post.context_id, "a plan returns the context for the next decision");

    // A failed precondition sends nothing, and later steps never run.
    const guarded = await plan(done.post.context_id, [
      { action: "click", ref: apply },
      {
        action: "click",
        ref: apply,
        expect: [{ target: "#count", field: "text", equals: "not this" }],
      },
      { action: "fill", ref: note, value: "never" },
    ]);
    assert.equal(guarded.ok, false);
    assert.equal(guarded.completed, 1);
    assert.equal(guarded.stopped.index, 1);
    assert.equal(guarded.stopped.effect_state, "none");
    assert.deepEqual(guarded.not_run, [2]);
    assert.equal(await read("applied"), 3, "a refused step must not click");
    assert.equal(await read("document.querySelector('#note').value"), "planned");
    assert(guarded.post.context_id, "a refused step still returns state to replan from");

    // A wait that times out stops the plan instead of acting on an unready page.
    const unready = await plan(guarded.post.context_id, [
      { action: "wait_for_element", selector: "#never", state: "attached", timeout_ms: 100 },
      { action: "click", ref: apply },
    ]);
    assert.equal(unready.completed, 0);
    assert.equal(unready.stopped.reason, "wait_unsatisfied");
    assert.equal(await read("applied"), 3);

    // The person acts while the plan is waiting: its next input is refused.
    const running = plan(unready.post.context_id, [
      { action: "click", ref: apply },
      { action: "wait_for_element", selector: "#go-on", state: "attached", timeout_ms: 10000 },
      { action: "click", ref: apply },
    ]);
    const clicked = performance.now() + 5000;
    while ((await read("applied")) < 4) {
      assert(performance.now() < clicked, "the plan's first click did not land");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const point = await read(`(() => {
      const rect = document.querySelector('#human').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"])
      await send(
        "Input.dispatchMouseEvent",
        { type, button: "left", clickCount: 1, ...point },
        human,
      );
    assert.equal(await read("humanChanged"), true);
    await read("document.body.insertAdjacentHTML('beforeend', '<i id=\"go-on\"></i>'); true");
    const interrupted = await running;
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.completed, 2);
    assert.equal(interrupted.stopped.index, 2);
    assert.equal(interrupted.stopped.effect_state, "none");
    assert.equal(interrupted.stopped.error.data.reason, "human_intervention");
    assert.equal(await read("applied"), 4, "the person's action must stop later input");

    return { elapsedMs: elapsed };
  } finally {
    if (human) await send("Target.detachFromTarget", { sessionId: human }).catch(() => {});
    await bsk(["session", "stop", session]).catch(() => {});
  }
}
