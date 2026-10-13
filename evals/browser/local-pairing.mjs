// Pair only the daemon and extension profile owned by a browser regression.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export async function copyPairingExtension(source, destination, port) {
  assert(Number.isInteger(port) && port > 0 && port <= 65535);
  await cp(source, destination, { recursive: true });
  const backgroundPath = path.join(destination, "background.js");
  const background = await readFile(backgroundPath, "utf8");
  // Seed only this regression's fresh profile before the controller starts.
  // Preserve the preference on worker restarts after pairing has completed.
  await writeFile(
    backgroundPath,
    `chrome.storage.local.get('bh_connection_enabled').then(async items => {
      if (items.bh_connection_enabled === undefined)
        await chrome.storage.local.set({bh_connection_enabled:false,bsk_daemon_port:${port}});
      ${background}\n
    });`,
  );
  return destination;
}

export async function attachPairingBackground(send, extension) {
  const { name } = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { targetInfos } = await send("Target.getTargets");
    for (const target of targetInfos) {
      if (target.type !== "service_worker" || !target.url.startsWith("chrome-extension://"))
        continue;
      const { sessionId } = await send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      const reply = await send(
        "Runtime.evaluate",
        { expression: "chrome.runtime.getManifest().name", returnByValue: true },
        sessionId,
      );
      // Chrome can start component workers also named background.js.
      if (reply.result.value === name)
        return { sessionId, origin: target.url.split("/").slice(0, 3).join("/") };
      await send("Target.detachFromTarget", { sessionId });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Extension background did not load: ${name}`);
}

export async function buildPairingFixture(directory, version) {
  const input = path.join(directory, "pairing-entry.js");
  await writeFile(
    input,
    `import { verifyLocalPairing } from '@/transport/pairing-verifier';
     import { getOrCreateInstanceId } from '@/lib/instance-id';
     export async function pair(link) {
       return verifyLocalPairing(link, await getOrCreateInstanceId(),
         chrome.runtime.getURL('').replace(/\\/$/, ''));
     }`,
  );
  const require = createRequire(new URL("../../apps/extension/package.json", import.meta.url));
  const { build } = await import(require.resolve("vite", { paths: [require.resolve("vitest")] }));
  const bundle = await build({
    configFile: false,
    logLevel: "error",
    resolve: {
      alias: { "@": fileURLToPath(new URL("../../apps/extension/src", import.meta.url)) },
    },
    define: {
      __BSK_EXT_VERSION__: JSON.stringify(version),
      __BSK_DAEMON_WS_URL__: JSON.stringify("ws://127.0.0.1:52800"),
    },
    build: {
      write: false,
      lib: { entry: input, formats: ["iife"], name: "PairingFixture" },
    },
  });
  const result = Array.isArray(bundle) ? bundle[0] : bundle;
  return result.output[0].code;
}

export async function pairLocalBrowser(send, { executable, env, worker }) {
  assert(env.BSK_HOME, "Pairing requires the regression's isolated BSK_HOME");
  const directory = await mkdtemp(path.join(tmpdir(), "bsk-browser-pair-"));
  let targetId;
  const evaluate = async (sessionId, expression, phase) => {
    let reply;
    try {
      reply = await send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
    } catch {
      throw new Error(`Extension pairing setup failed: ${phase}`);
    }
    assert(!reply.exceptionDetails, `Extension pairing setup failed: ${phase}`);
    return reply.result.value;
  };
  try {
    ({ targetId } = await send("Target.createTarget", { url: `${worker.origin}/popup.html` }));
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const deadline = Date.now() + 10_000;
    while (!(await evaluate(sessionId, "Boolean(globalThis.chrome?.runtime?.id)", "popup load"))) {
      assert(Date.now() < deadline, "Extension connection controls did not load");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const setEnabled = (enabled) =>
      evaluate(
        sessionId,
        `new Promise(resolve => {
          const port = chrome.runtime.connect({name:'popup'});
          port.onMessage.addListener(message => {
            if (message.kind === 'snapshot' && message.data.connectionEnabled === ${enabled} &&
                message.data.state === '${enabled ? "connected" : "disconnected"}') {
              port.disconnect(); resolve(true);
            }
          });
          port.postMessage({kind:'set_connection_enabled',value:${enabled}});
        })`,
        enabled ? "enable connection" : "disable connection",
      );
    // copyPairingExtension disables automatic attempts before startup, avoiding
    // authentication failure backoff while this profile is still unpaired.
    await setEnabled(false);
    const version = await evaluate(
      worker.sessionId,
      "chrome.runtime.getManifest().version",
      "read manifest",
    );
    const source = await buildPairingFixture(directory, version);
    const { stdout } = await promisify(execFile)(executable, ["daemon", "pair"], {
      env,
      timeout: 10_000,
    });
    const paired = await evaluate(
      worker.sessionId,
      `${source};PairingFixture.pair(${JSON.stringify(stdout.trim())})`,
      "verify daemon",
    );
    assert.equal(paired.state, "verified");
    await setEnabled(true);
  } finally {
    if (targetId) await send("Target.closeTarget", { targetId });
    await rm(directory, { recursive: true, force: true });
  }
}
