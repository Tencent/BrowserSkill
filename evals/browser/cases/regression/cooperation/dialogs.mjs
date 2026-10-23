import assert from "node:assert/strict";

/** Real CLI/daemon/extension decisions while a shared renderer is blocked. */
export async function runDialogScenarios({ send, bsk, base }) {
  const { session_id: session } = await bsk(["session", "start"]);
  const scope = ["--session", session];
  const url = `${base}/dialogs`;
  let observer;
  try {
    await bsk(["navigate", url, ...scope]);
    const target = (await send("Target.getTargets")).targetInfos.find((t) => t.url === url);
    assert(target);
    ({ sessionId: observer } = await send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    }));
    const read = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true }, observer);
      assert(!result.exceptionDetails, JSON.stringify(result));
      return result.result.value;
    };
    const sync = () => bsk(["cooperate", "sync", ...scope]);
    const status = () => bsk(["dialog", "status", ...scope]);
    const settled = async () => {
      const deadline = performance.now() + 5000;
      do {
        const result = await status();
        assert.equal(result.pending, null);
        if (!result.execution_pending) return;
        await new Promise((r) => setTimeout(r, 40));
      } while (performance.now() < deadline);
      assert.fail("The original action did not finish after the dialog decision");
    };
    const cases = [
      ["confirm", "accept", undefined, true],
      ["confirm", "dismiss", undefined, false],
      ["prompt", "accept", "Agent 填写", "Agent 填写"],
      ["prompt", "accept", "", ""],
      ["prompt", "accept", undefined, "default text"],
      ["prompt", "dismiss", undefined, null],
      ["alert", "accept", undefined, null],
    ];
    let count = 0;
    for (const [type, action, text, expected] of cases) {
      const context = await sync();
      const blocked = await bsk(
        ["click", `#${type}`, ...scope, "--context", context.context_id],
        "dialog_pending",
      );
      const pending = (await status()).pending;
      assert.equal(pending.type, type);
      assert.equal(pending.id, blocked.data.dialog.id);
      const answer = await bsk([
        "dialog",
        action,
        ...scope,
        "--dialog-id",
        pending.id,
        ...(text === undefined ? [] : ["--text", text]),
      ]);
      assert.equal(answer.handled.handled, action === "accept" ? "accepted" : "dismissed");
      await settled();
      count++;
      assert.deepEqual(await read("({started,finished,answer})"), {
        started: count,
        finished: count,
        answer: expected,
      });
      // Modal completion consumes any old DOM observation. No stale replay is allowed.
      await bsk(["click", "#alert", ...scope, "--context", context.context_id], true);
    }
    for (const action of ["dismiss", "accept"]) {
      let context = await sync();
      await bsk(["click", "#arm-unload", ...scope, "--context", context.context_id]);
      context = await sync();
      const blocked = await bsk(
        ["navigate", `${url}?left=1`, ...scope, "--context", context.context_id],
        "dialog_pending",
      );
      assert.equal(blocked.data.dialog.type, "beforeunload");
      await bsk(["dialog", action, ...scope, "--dialog-id", blocked.data.dialog.id]);
      await settled();
      assert.equal(await read("location.href"), action === "accept" ? `${url}?left=1` : url);
    }
    console.error("dialogs: shared alert/confirm/prompt/beforeunload passed");
    return {
      passed: true,
      decisions: cases.length + 2,
      emptyPrompt: true,
      staleContextRejected: true,
    };
  } finally {
    if (observer) {
      // This connection owns the isolated fixture only; also release any modal on failure.
      await send("Page.handleJavaScriptDialog", { accept: false }, observer).catch(() => {});
      await send(
        "Runtime.evaluate",
        { expression: "window.onbeforeunload = null" },
        observer,
      ).catch(() => {});
      await send("Target.detachFromTarget", { sessionId: observer }).catch(() => {});
    }
    await bsk(["session", "stop", session]).catch(() => {});
  }
}
