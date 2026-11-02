import assert from "node:assert/strict";
import { createDshRegressionClient } from "./dsh-client.mjs";

/** Exercise both shipped defaults through the installed extension, including real human input. */
export async function runTargetPolicyScenarios({ send, bsk, cli, env, base }) {
  const results = [];
  for (const client of ["cli", "dsh"]) {
    const dsh =
      client === "dsh" ? createDshRegressionClient(cli, env, { legacyStrict: false }) : undefined;
    let session, human, targetId;
    try {
      const url = `${base}/target-policy?client=${client}`;
      session = dsh
        ? (await dsh.run("bsk_session", { action: "start", url })).sessionId
        : (await bsk(["session", "start"])).session_id;
      const scope = ["--session", session];
      if (!dsh) await bsk(["navigate", url, ...scope]);
      const target = (await send("Target.getTargets")).targetInfos.find(
        (entry) => entry.url === url,
      );
      assert(target, `${client} target-policy task page was not created`);
      targetId = target.targetId;
      ({ sessionId: human } = await send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      }));
      await send("Page.bringToFront", {}, human);
      const read = async (expression) => {
        const reply = await send("Runtime.evaluate", { expression, returnByValue: true }, human);
        assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
        return reply.result.value;
      };
      const deadline = performance.now() + 5000;
      while (
        !(await read("!!document.querySelector('#apply') && typeof window.applied === 'number'"))
      ) {
        assert(performance.now() < deadline, "Target-policy fixture did not load");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // No policy override: the new CLI and the shipped plugin must negotiate their own defaults.
      const sync = () =>
        dsh
          ? dsh.run("bsk_session", { action: "sync", session })
          : bsk(["cooperate", "sync", ...scope]);
      const first = await sync();
      assert.equal(first.control_policy, "target", `${client} did not negotiate target by default`);
      const ref = first.observation.text.match(/(@e\d+) button "Apply"/)?.[1];
      assert(ref, JSON.stringify(first));
      const click = (context) =>
        dsh
          ? dsh.run("bsk_interact", { action: "click", session, target: ref, contextId: context })
          : bsk(["click", ref, ...scope, "--context", context]);
      const tick = await read("ticks");
      await click(first.context_id);
      await click(first.context_id);
      assert.equal(await read("applied"), 2);
      assert((await read("ticks")) > tick, "same-form clock must keep changing during the actions");

      await read(`const form = document.querySelector('form');
        form.insertAdjacentHTML('afterbegin', '<button type="button">Inserted</button>');
        form.prepend(document.querySelector('#human')); true`);
      const observed = dsh
        ? await dsh.run("bsk_inspect", { action: "snapshot", session })
        : await bsk(["snapshot", ...scope]);
      assert(
        observed.text.includes(`${ref} button "Apply"`),
        "supplementary read rebound the DOM ref",
      );
      await click(first.context_id);
      assert.equal(await read("applied"), 3);

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
      if (dsh) {
        await assert.rejects(
          click(first.context_id),
          (error) =>
            error.data?.reason === "human_intervention" && error.data.effect_state === "none",
        );
      } else {
        const refused = await bsk(
          ["click", ref, ...scope, "--context", first.context_id],
          "human_intervention",
        );
        assert.equal(refused.data.effect_state, "none");
      }
      assert.equal(await read("applied"), 3, "revoked context sent another click");
      const ready = dsh
        ? await dsh.run("bsk_session", { action: "wait-user", session, timeoutMs: 3000 })
        : await bsk(["cooperate", "wait", ...scope, "--timeout-ms", "3000"]);
      assert.equal(ready.ready, true);
      const fresh = await sync();
      assert.equal(fresh.control_policy, "target");
      assert.notEqual(fresh.context_id, first.context_id);
      await click(fresh.context_id);
      assert.equal(await read("applied"), 4);
      results.push({
        client,
        policy: "target",
        reusedContext: true,
        stableRefAfterSnapshot: true,
        humanRevokedContext: true,
        finalClicks: 4,
      });
    } finally {
      if (session) {
        if (dsh) await dsh.run("bsk_session", { action: "stop", session }).catch(() => {});
        else await bsk(["session", "stop", session]).catch(() => {});
      }
      await dsh?.dispose();
      if (human) await send("Target.detachFromTarget", { sessionId: human }).catch(() => {});
      // Human-touched pages survive session stop; this fixture owns its isolated page.
      if (targetId) {
        await send("Target.closeTarget", { targetId }).catch(() => {});
        const deadline = performance.now() + 5000;
        while (
          (await send("Target.getTargets")).targetInfos.some((entry) => entry.targetId === targetId)
        ) {
          assert(performance.now() < deadline, "Target-policy fixture page was not cleaned up");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
  }
  return results;
}
