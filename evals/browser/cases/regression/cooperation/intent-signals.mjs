import assert from "node:assert/strict";
import { join } from "node:path";

const targetParam = (target) => (target.startsWith("@e") ? { ref: target } : { selector: target });

/** Real native input from the second CDP connection represents the person. */
export async function runIntentScenarios({
  client,
  mcp,
  bsk,
  send,
  scope,
  session,
  human,
  read,
  sync,
  click,
}) {
  const status = () =>
    mcp
      ? mcp.run("bsk_session", { action: "status", session })
      : bsk(["cooperate", "status", ...scope]);
  const wait = () =>
    mcp
      ? mcp.run("bsk_session", { action: "wait", session, timeout_ms: 3000 })
      : bsk(["cooperate", "wait", ...scope, "--timeout-ms", "3000"]);
  const fill = (target, value, context) =>
    mcp
      ? mcp.run("bsk_interact", {
          action: "fill",
          session,
          context,
          params: { ...targetParam(target), value },
        })
      : bsk(["fill", target, "--value", value, ...scope, "--context", context]);
  const press = (target, key, context) =>
    mcp
      ? mcp.run("bsk_interact", {
          action: "press",
          session,
          context,
          params: { ...targetParam(target), key },
        })
      : bsk(["press", key, "--ref", target, ...scope, "--context", context]);
  const refuse = async (context) => {
    if (mcp)
      await assert.rejects(
        click(context),
        (error) =>
          error.data?.reason === "human_intervention" && error.data.effect_state === "none",
      );
    else {
      const error = await bsk(
        ["click", "#apply", ...scope, "--context", context],
        "human_intervention",
      );
      assert.equal(error.data.effect_state, "none");
    }
  };
  const key = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ["keyDown", "keyUp"])
      await send(
        "Input.dispatchKeyEvent",
        {
          type,
          key,
          code,
          windowsVirtualKeyCode,
          ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}),
        },
        human,
      );
  };
  const humanClick = async (selector) => {
    const point = await read(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await send(
        "Input.dispatchMouseEvent",
        { type, button: "left", clickCount: 1, ...point },
        human,
      );
  };
  await bsk(["debug", "start", ...scope, "--name", `intent-${client}`]);
  try {
    let context = (await sync()).context_id;
    const count = await read("applied");
    await send(
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x: 650, y: 400, deltaX: 0, deltaY: 260 },
      human,
    );
    const deadline = performance.now() + 3000;
    while (!(await read("scrollY > 0"))) {
      assert(performance.now() < deadline, "Native wheel did not scroll the page");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await click(context);
    assert.equal(await read("applied"), count + 1, "Scrolled Agent click missed its target");
    assert.equal(
      (await status()).activity.length,
      0,
      "Browsing scroll invented human intervention",
    );

    await read("document.querySelector('#note').focus(); true");
    for (const args of [
      ["Shift", "ShiftLeft", 16],
      ["ArrowLeft", "ArrowLeft", 37],
      ["Backspace", "Backspace", 8],
      ["Tab", "Tab", 9],
    ])
      await key(...args);
    await click(context);
    assert.equal(await read("applied"), count + 2);
    assert.equal((await status()).activity.length, 0, "Ineffective keys revoked control");

    await send("Emulation.setTouchEmulationEnabled", { enabled: true }, human);
    const touch = await read(
      `(() => { const r = document.querySelector('#apply').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
    );
    await send(
      "Input.dispatchTouchEvent",
      { type: "touchStart", touchPoints: [{ ...touch, id: 1 }] },
      human,
    );
    let dispatched = false;
    const queued = click(context).then((result) => {
      dispatched = true;
      return result;
    });
    queued.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(dispatched, false, "Agent input raced an unconfirmed human gesture");
    await send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }, human);
    await queued;
    await send("Emulation.setTouchEmulationEnabled", { enabled: false }, human);
    assert.equal(await read("applied"), count + 3);
    assert.equal((await status()).activity.length, 0, "A cancelled touch revoked control");

    // No mouse click precedes this edit: effective content itself must yield.
    await read("document.querySelector('#note').focus(); true");
    await send("Input.insertText", { text: "人工日期 2026-11-05" }, human);
    assert.equal(await read("document.querySelector('#note').value"), "人工日期 2026-11-05");
    await refuse(context);
    const editing = await status();
    assert.equal(editing.state.editing, true);
    assert(editing.activity.some((event) => event.type === "input"));
    await humanClick("#clock");
    assert.equal((await wait()).ready, true);
    context = (await sync()).context_id;
    await fill("#note", "Agent 中文 👩‍💻", context);
    assert.equal(await read("document.querySelector('#note').value"), "Agent 中文 👩‍💻");
    assert.equal((await status()).activity.length, 0, "Agent insertText was classified as human");

    // The same ownership rule covers an iframe editing host.
    await read(
      "document.querySelector('#frame-input').contentDocument.querySelector('input').focus(); true",
    );
    await send("Input.insertText", { text: "人工 iframe" }, human);
    await refuse(context);
    assert((await status()).activity.some((event) => event.type === "input" && event.frame_id > 0));
    await humanClick("#clock");
    assert.equal((await wait()).ready, true);
    const frameSync = await sync();
    context = frameSync.context_id;
    const frameSnapshot = mcp
      ? await mcp.run("bsk_inspect", { action: "snapshot", session })
      : await bsk(["snapshot", ...scope]);
    const frameRef = frameSnapshot.text
      .split("\n")
      .find((line) => line.includes('textbox "Frame note"'))
      ?.match(/@e\d+/)?.[0];
    assert(frameRef, "Frame input was not observed: " + frameSnapshot.text);
    await fill(frameRef, "Agent iframe 中文", context);
    assert.equal(
      await read(
        "document.querySelector('#frame-input').contentDocument.querySelector('input').value",
      ),
      "Agent iframe 中文",
    );
    assert.equal((await status()).activity.length, 0, "Agent iframe edit was classified as human");

    const noteRef = frameSnapshot.text
      .split("\n")
      .find((line) => line.includes('textbox "Note"'))
      ?.match(/@e\d+/)?.[0];
    assert(noteRef, "Note input was not observed");
    await press(noteRef, "x", context);
    assert.equal(await read("document.querySelector('#note').value"), "Agent 中文 👩‍💻x");
    assert.equal(
      (await status()).activity.length,
      0,
      "Agent character key was classified as human",
    );
    const applyRef = frameSnapshot.text
      .split("\n")
      .find((line) => line.includes('button "Apply"'))
      ?.match(/@e\d+/)?.[0];
    assert(applyRef, "Apply button was not observed");
    await press(applyRef, "Enter", context);
    assert.equal(await read("applied"), count + 4);
    assert.equal(
      (await status()).activity.length,
      0,
      "Agent keyboard activation was classified as human",
    );

    await send("Page.bringToFront", {}, human);
    await read("document.querySelector('#apply').focus(); true");
    await key("Enter", "Enter", 13);
    assert.equal(
      await read("applied"),
      count + 5,
      "Keyboard activation did not click Apply exactly once",
    );
    await refuse(context);
    assert.equal((await wait()).ready, true);
    await sync();
    return {
      nativeWheel: true,
      contextReusedAfterScroll: true,
      ineffectiveKeysIgnored: true,
      cancelledGestureResumed: true,
      contentEditYielded: true,
      nativeAgentUnicodeFill: true,
      agentCharacterAndActivationKeys: true,
      iframeHumanAndAgentInput: true,
      keyboardActivationYielded: true,
      sameTaskResumed: true,
    };
  } finally {
    await bsk(["debug", "stop", ...scope]);
    if (process.env.BSK_COOP_ARTIFACTS)
      await bsk([
        "debug",
        "export",
        ...scope,
        "--output",
        join(process.env.BSK_COOP_ARTIFACTS, `intent-${client}.json`),
      ]);
  }
}
