import assert from "node:assert/strict";
import { attachExtensionWorker } from "./compatibility.mjs";

/** Exercise the shipped CLI and extension against a deterministic failed iframe. */
export async function runFrameObservabilityScenarios({ send, bsk, base }) {
  const worker = await attachExtensionWorker(send);
  const results = [];
  try {
    for (const policy of ["target", "strict"]) {
      const { session_id: session } = await bsk(["session", "start"]);
      const scope = ["--session", session];
      try {
        await bsk(["navigate", `${base}/broken-frame`, ...scope]);
        const sync = () => bsk(["cooperate", "sync", "--settle", "--policy", policy, ...scope]);
        const first = await sync();
        assert.equal(first.settle.outcome, "synchronized");
        assert.equal(first.control_policy, policy);
        assert.equal(first.frame_gaps.length, 1);
        assert.equal(first.frame_gaps[0].reason, "load_error");
        assert.notEqual(first.frame_gaps[0].frame_id, 0);
        await bsk(["click", "#apply", "--context", first.context_id, ...scope]);
        const current = await sync();
        const value = await bsk([
          "evaluate",
          "document.querySelector('#count').textContent",
          "--context",
          current.context_id,
          ...(current.observation_id ? ["--observation", current.observation_id] : []),
          ...scope,
        ]);
        assert.equal(value.value, "1");
        const passive = await bsk(["read", "--selector", "#count", ...scope]);
        assert.equal(passive.items[0].values.text, "1");
        assert.equal(passive.scope, "current_dom");

        await send(
          "Runtime.evaluate",
          {
            expression: `chrome.tabs.update(${first.tab_id}, {url:'http://127.0.0.1:9/main'})`,
            awaitPromise: true,
          },
          worker,
        );
        const deadline = performance.now() + 10000;
        while (true) {
          const reply = await send(
            "Runtime.evaluate",
            {
              expression: `chrome.webNavigation.getFrame({tabId:${first.tab_id},frameId:0})`,
              awaitPromise: true,
              returnByValue: true,
            },
            worker,
          );
          if (reply.result.value?.errorOccurred) break;
          assert(performance.now() < deadline, "main-page load failure was not reported");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        for (const args of [
          ["sync", "--settle"],
          ["wait", "--timeout-ms", "20000"],
        ]) {
          const failure = await bsk(["cooperate", ...args, ...scope], "page_load_failed");
          assert.equal(failure.data.effect_state, "none");
          assert.equal(failure.data.frames[0].frame_id, 0);
          assert.notEqual(failure.exit_code, 0);
        }
        results.push({
          policy,
          failedChildSkipped: true,
          click: true,
          evaluate: true,
          passiveReadAcrossFailedChild: true,
          failedMainRejected: true,
        });
      } finally {
        await bsk(["session", "stop", session]);
      }
    }
  } finally {
    await send("Target.detachFromTarget", { sessionId: worker }).catch(() => {});
  }
  return results;
}
