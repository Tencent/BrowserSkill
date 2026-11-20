import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

/** Exercise the shipped `bsk mcp` stdio boundary against a real daemon. */
export async function createMcpRegressionClient(cli, env, { legacyStrict = false } = {}) {
  const child = spawn(cli, ["mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let sequence = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-8192)));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const reply = JSON.parse(line);
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    clearTimeout(waiter.timer);
    if (reply.error) waiter.reject(new Error(JSON.stringify(reply.error)));
    else waiter.resolve(reply.result);
  });
  child.on("exit", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP closed: ${stderr}`));
    }
    pending.clear();
  });
  const sendRequest = (method, params) => {
    const id = ++sequence;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, 45000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    return { id, promise };
  };
  const rpc = (method, params) => sendRequest(method, params).promise;
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cooperation-regression", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const normalizeArgs = (name, args) =>
    legacyStrict && name === "bsk_session" && args.action === "sync" && args.policy === undefined
      ? { ...args, policy: "strict" }
      : args;
  const decodeResult = (result, reason) => {
    const value = JSON.parse(result.content[0].text);
    if (reason) {
      assert.equal(value.data?.reason, reason, JSON.stringify(result));
      return value;
    }
    if (result.isError) {
      throw Object.assign(new Error(value.message ?? JSON.stringify(result)), value);
    }
    // Restore VOM only for test selection; never change the evidence metadata.
    if (value.observation?.text === "(VOM text in the next content block)")
      value.observation.text = result.content[1].text;
    if (value.text === "(VOM text in the next content block)") value.text = result.content[1].text;
    return value;
  };
  return {
    rpc,
    startCall(name, args) {
      const { id, promise } = sendRequest("tools/call", {
        name,
        arguments: normalizeArgs(name, args),
      });
      return { requestId: id, promise: promise.then((result) => decodeResult(result)) };
    },
    cancel(requestId) {
      const waiter = pending.get(requestId);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(requestId);
      }
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId },
        }) + "\n",
      );
    },
    async run(name, args, reason) {
      const result = await rpc("tools/call", { name, arguments: normalizeArgs(name, args) });
      return decodeResult(result, reason);
    },
    async dispose() {
      const closed = once(child, "exit");
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      await closed;
      clearTimeout(timer);
      lines.close();
    },
  };
}

export async function runLegacyStrictMcpScenario({
  send,
  base,
  cli,
  env,
  implicitSession = false,
}) {
  const { run, dispose } = await createMcpRegressionClient(cli, env, { legacyStrict: true });
  let human;
  let session;
  try {
    const url = `${base}/?mcp-strict=${implicitSession ? "implicit" : "explicit"}`;
    const started = await run("bsk_session", { action: "start" });
    session = started.session_id;
    assert(session, JSON.stringify(started));
    const scope = implicitSession ? {} : { session };
    await run("bsk_page", { action: "navigate", ...scope, url });
    const target = (await send("Target.getTargets")).targetInfos.find((t) => t.url === url);
    assert(target, "MCP must navigate its task page");
    ({ sessionId: human } = await send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    }));
    await send("Page.bringToFront", {}, human);
    const read = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true }, human);
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const loaded = performance.now() + 5000;
    while (!(await read("!!document.querySelector('#mistake')"))) {
      assert(performance.now() < loaded, "MCP fixture did not load");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const sync = () => run("bsk_session", { action: "sync", ...scope });
    const first = await sync();
    assert.equal(first.control_policy, "strict", "legacy MCP regression must select strict policy");
    const point = await read(
      "(() => { const r = document.querySelector('#mistake').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()",
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await send(
        "Input.dispatchMouseEvent",
        { type, button: "left", clickCount: 1, ...point },
        human,
      );
    assert.equal(await read("document.querySelector('#city').value"), "Beijing");
    await assert.rejects(
      run("bsk_interact", {
        action: "click",
        ...scope,
        context: first.context_id,
        params: { selector: "#submit" },
      }),
      (error) =>
        error.data?.reason === "cooperation_sync_required" && error.data.effect_state === "none",
    );
    assert.equal(
      (await run("bsk_session", { action: "wait", ...scope, timeout_ms: 3000 })).ready,
      true,
    );
    const fresh = await sync();
    assert.notEqual(fresh.context_id, first.context_id);
    await run("bsk_interact", {
      action: "fill",
      ...scope,
      context: fresh.context_id,
      params: { selector: "#city", value: "Shanghai" },
    });
    await run("bsk_interact", {
      action: "fill",
      ...scope,
      context: (await sync()).context_id,
      params: { selector: "#quantity", value: "2" },
    });
    await run("bsk_interact", {
      action: "click",
      ...scope,
      context: (await sync()).context_id,
      params: { selector: "#submit" },
    });
    const deadline = performance.now() + 5000;
    while (!(await read("document.querySelector('#outcome').textContent.includes('Shanghai')"))) {
      assert(performance.now() < deadline, "MCP submission did not complete");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      client: "mcp",
      policy: "strict",
      automatic: true,
      implicitSession,
      staleActionRejected: true,
      goal: { city: "Shanghai", quantity: "2" },
    };
  } finally {
    if (session) await run("bsk_session", { action: "stop", session }).catch(() => {});
    await dispose();
    if (human) await send("Target.detachFromTarget", { sessionId: human }).catch(() => {});
  }
}
