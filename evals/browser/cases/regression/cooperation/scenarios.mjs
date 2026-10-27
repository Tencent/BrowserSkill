import assert from "node:assert/strict";

/** The person acts through a separate native-input connection. Assertions read
 * application state independently of the cooperative tool's claimed result. */
export async function runGenericScenarios({
  bsk,
  scope,
  humanClick,
  humanPointer,
  evaluate,
  sync,
  wait,
}) {
  await humanClick("#open-controls");
  await wait();
  const before = await sync();
  await humanClick("#choice");
  assert.equal((await wait()).ready, true, "readonly controls must not hold a text editing lease");
  await bsk(["click", "#hover-action", ...scope, "--context", before.context_id], true);
  await humanClick("#choice-b");
  await wait();
  const helped = await sync();
  assert.equal(await evaluate("document.querySelector('#choice').value"), "B");
  assert(helped.activity.some((event) => event.label.includes("B")));
  await humanClick("#check");
  assert.equal((await wait()).ready, true, "checkboxes must return control automatically");
  let context = await sync();
  await bsk(["select", "#category", "--value", "b", ...scope, "--context", context.context_id]);
  assert.equal(await evaluate("document.querySelector('#category').value"), "b");
  assert.equal((await wait()).ready, true, "Agent select must not be attributed to the person");

  context = await sync();
  await humanPointer("#slider", "mousePressed");
  assert.equal(
    (await bsk(["cooperate", "wait", ...scope, "--timeout-ms", "900"])).ready,
    false,
    "a live drag must not expire after quiet time",
  );
  await bsk(["click", "#hover-action", ...scope, "--context", context.context_id], true);
  await humanPointer("#slider", "mouseReleased");
  assert.equal((await wait()).ready, true, "drag release must return control");

  context = await sync();
  await humanClick("#shadow >>> input");
  assert.equal(
    (await bsk(["cooperate", "wait", ...scope, "--timeout-ms", "900"])).ready,
    false,
    "a shadow text field must retain its editing lease",
  );
  await bsk(["click", "#hover-action", ...scope, "--context", context.context_id], true);
  await humanClick("#controls h2");
  assert.equal((await wait()).ready, true);
  const observed = await bsk(["snapshot", ...scope]);
  const shadowRef = observed.text
    .split("\n")
    .find((line) => line.includes("Shadow note") && /@e\d+/.test(line))
    ?.match(/@e\d+/)?.[0];
  assert(shadowRef, observed.text);
  context = await sync();
  await bsk([
    "fill",
    shadowRef,
    "--value",
    "shared note",
    ...scope,
    "--context",
    context.context_id,
  ]);
  assert.equal(
    await evaluate("document.querySelector('#shadow').shadowRoot.querySelector('input').value"),
    "shared note",
  );
  assert.equal((await wait()).ready, true, "Agent shadow fill must not create human activity");

  // Continuous updates overlap both planning and hover preparation.
  await humanClick("#noise");
  await wait();
  context = await sync();
  await new Promise((resolve) => setTimeout(resolve, 130));
  const started = performance.now();
  await bsk([
    "click",
    "#hover-action",
    ...scope,
    "--depends-on",
    "#hover-action",
    "--context",
    context.context_id,
  ]);
  const resumeMs = performance.now() - started;
  assert.equal(await evaluate("document.querySelector('#probe').value"), "1");
  assert.equal((await wait()).ready, true);
  const afterAgent = await sync();
  assert.equal(afterAgent.activity.length, 0, "Agent click must not invent human activity");

  await humanClick("#arm-price");
  await wait();
  context = await sync();
  await new Promise((resolve) => setTimeout(resolve, 4100));
  await bsk(["click", "#pick-a", ...scope, "--context", context.context_id], true);
  assert.equal(
    await evaluate("document.querySelector('#candidates').dataset.selected ?? null"),
    null,
  );

  await humanClick("#arm-cover");
  await wait();
  context = await sync();
  await bsk(["click", "#covered", ...scope, "--context", context.context_id], true);
  assert.equal(await evaluate("document.querySelector('#covered').dataset.clicked ?? null"), null);

  // A shared help request needs no action context and must keep the page usable.
  const help = bsk([
    "request-help",
    ...scope,
    "--prompt",
    "Complete the manual step",
    "--target",
    "#finish-help",
    "--timeout",
    "15s",
    "--completion-criteria",
    JSON.stringify({
      all: [{ selector_exists: "#controls[data-complete=yes]" }],
      stable_for_ms: 100,
    }),
  ]);
  // Attach the rejection handler immediately; the oracle below still awaits it.
  help.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 700));
  await humanClick("#finish-help");
  const result = await help;
  assert.equal(result.outcome, "completed");
  await humanClick("#close-controls");
  assert.equal((await wait()).ready, true);
  return {
    readonlyHandBack: true,
    customChoice: true,
    discreteControls: true,
    dragHandBack: true,
    shadowInput: true,
    continuousUpdates: true,
    hoverPreparation: true,
    changedDecisionRejected: true,
    coveredTargetRejected: true,
    sharedHelp: true,
    agentAttribution: true,
    resumeMs,
  };
}
