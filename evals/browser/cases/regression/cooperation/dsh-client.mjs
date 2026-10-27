import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createBskRunner,
  KeyedExecutor,
  ObservationService,
  registerBrowserTools,
  SessionRegistry,
} from "../../../../../packages/dsh-plugin-browserskill/lib/index.mjs";

/** Drive the shipped DSH tool definitions, runner and lifecycle against a real daemon.
 * A separate native-input connection represents the person; no model request is needed. */
export function createDshRegressionClient(cli, env) {
  const tools = new Map();
  const calls = [];
  const ctx = {
    get: () => undefined,
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
  };
  const runner = createBskRunner(cli, (command, args, options) => {
    calls.push(args);
    return spawn(command, args, { ...options, env });
  });
  const registry = new SessionRegistry(2);
  const queue = new KeyedExecutor();
  const observation = new ObservationService({
    ctx,
    runner,
    registry,
    queue,
    options: { enabled: false, thumbnailIntervalMs: 1500, idleIntervalMs: 8000 },
  });
  const deps = {
    ctx,
    runner,
    registry,
    queue,
    observation,
    config: {
      bskPath: cli,
      defaultTimeoutMs: 30000,
      maxSessions: 2,
      observationEnabled: false,
      thumbnailIntervalMs: 1500,
      idleIntervalMs: 8000,
      lazyTools: false,
    },
  };
  const dispose = registerBrowserTools(deps);
  const run = (name, args) =>
    tools.get(name).execute(args, {
      callId: crypto.randomUUID(),
      name,
      signal: new AbortController().signal,
      agent: { id: "default-cooperation-regression" },
    });
  return {
    run,
    runner,
    calls,
    async dispose() {
      await deps.starts?.dispose();
      dispose();
      observation.dispose();
      runner.killAll();
    },
  };
}

export async function runDefaultDshScenario({ send, base, cli, env, interruptStart = false }) {
  const { run, runner, calls, dispose } = createDshRegressionClient(cli, env);
  let human;
  let session;
  try {
    const url = `${base}/?dsh-default=1`;
    const humanUrl = `${base}/?dsh-human-start=1`;
    if (interruptStart) {
      const previous = new Set(
        (await send("Target.getTargets")).targetInfos.map((t) => t.targetId),
      );
      const original = runner.run.bind(runner);
      let pending = true;
      runner.run = async (args, options) => {
        if (pending && args[0] === "navigate") {
          pending = false;
          const target = (await send("Target.getTargets")).targetInfos.find(
            (t) => t.type === "page" && t.url === "about:blank" && !previous.has(t.targetId),
          );
          assert(target, "DSH must create its blank session before initial navigation");
          ({ sessionId: human } = await send("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
          }));
          // Intervene between the two real CLI processes in combined session startup.
          await send("Page.navigate", { url: humanUrl }, human);
        }
        return original(args, options);
      };
    }
    const started = await run("bsk_session", { action: "start", url });
    session = started.sessionId;
    assert(session, JSON.stringify(started));
    assert.equal(!!started.warning, interruptStart, JSON.stringify(started));
    if (interruptStart)
      assert.equal(started.url, undefined, "Do not claim the requested navigation succeeded");
    const target = (await send("Target.getTargets")).targetInfos.find(
      (t) => t.url === (interruptStart ? humanUrl : url),
    );
    assert(target, "DSH must preserve the page reached during startup");
    if (!human)
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
      assert(performance.now() < loaded, "DSH fixture did not load");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const sync = () => run("bsk_session", { action: "sync", session });
    const first = await sync();
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
        target: "#submit",
        session,
        contextId: first.context_id,
      }),
      (error) =>
        error.data?.reason === "cooperation_sync_required" && error.data.effect_state === "none",
    );
    assert.equal(
      (await run("bsk_session", { action: "wait-user", session, timeoutMs: 3000 })).ready,
      true,
    );
    const fresh = await sync();
    assert.notEqual(fresh.context_id, first.context_id);
    await run("bsk_interact", {
      action: "fill",
      target: "#city",
      value: "Shanghai",
      session,
      contextId: fresh.context_id,
    });
    await run("bsk_interact", {
      action: "fill",
      target: "#quantity",
      value: "2",
      session,
      contextId: (await sync()).context_id,
    });
    await run("bsk_interact", {
      action: "click",
      target: "#submit",
      session,
      contextId: (await sync()).context_id,
    });
    const deadline = performance.now() + 5000;
    while (!(await read("document.querySelector('#outcome').textContent.includes('Shanghai')"))) {
      assert(performance.now() < deadline, "DSH submission did not complete");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(!calls.some((args) => args[0] === "cooperate" && args[1] === "enable"));
    return {
      client: "dsh",
      automatic: true,
      startupInterruption: interruptStart,
      staleActionRejected: true,
      goal: { city: "Shanghai", quantity: "2" },
    };
  } finally {
    if (session) await run("bsk_session", { action: "stop", session }).catch(() => {});
    await dispose();
    if (human) await send("Target.detachFromTarget", { sessionId: human }).catch(() => {});
  }
}
