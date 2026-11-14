// Pair only the daemon and extension profile owned by a browser regression.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

async function rewriteIsolatedWsPort(directory, port) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteIsolatedWsPort(fullPath, port);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const source = await readFile(fullPath, "utf8");
    const rewritten = source.replace(/ws:\/\/127\.0\.0\.1:\d+/g, `ws://127.0.0.1:${port}`);
    if (rewritten !== source) {
      await writeFile(fullPath, rewritten);
    }
  }
}

export async function copyIsolatedExtension(source, destination, port) {
  assert(Number.isInteger(port) && port > 0 && port <= 65535);
  await cp(source, destination, { recursive: true });
  await rewriteIsolatedWsPort(destination, port);
  const backgroundPath = path.join(destination, "background.js");
  const background = await readFile(backgroundPath, "utf8");
  assert(
    background.includes(`ws://127.0.0.1:${port}`),
    `Expected copied extension background.js to contain ws://127.0.0.1:${port}`,
  );
  return destination;
}

export async function copyPairingExtension(source, destination, port) {
  await copyIsolatedExtension(source, destination, port);
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
      globalThis.__bskPairingFixtureReady = true;
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

export async function pairLocalBrowser(send, { executable, env, worker }) {
  assert(env.BSK_HOME, "Pairing requires the regression's isolated BSK_HOME");
  let targetId;
  const evaluate = async (sessionId, expression, phase, sensitive = false) => {
    let reply;
    try {
      reply = await send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
    } catch (error) {
      throw new Error(`Extension pairing setup failed: ${phase}`, {
        cause: sensitive ? undefined : error,
      });
    }
    if (reply.exceptionDetails) {
      throw new Error(`Extension pairing setup failed: ${phase}`, {
        cause: sensitive ? undefined : reply.exceptionDetails.exception?.description,
      });
    }
    return reply.result.value;
  };
  try {
    const deadline = Date.now() + 10_000;
    while (
      !(await evaluate(
        worker.sessionId,
        "Boolean(globalThis.__bskPairingFixtureReady)",
        "background load",
      ))
    ) {
      assert(Date.now() < deadline, "Extension background did not finish pairing fixture setup");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A tab at popup.html is not the trusted action popup. Exercise the same
    // browser message sender and pairing path as a real toolbar interaction.
    await evaluate(worker.sessionId, "chrome.action.openPopup()", "open action popup");
    const popupDeadline = Date.now() + 5_000;
    while (!targetId) {
      const { targetInfos } = await send("Target.getTargets");
      targetId = targetInfos.find(
        (target) => target.url === `${worker.origin}/popup.html`,
      )?.targetId;
      if (targetId) break;
      assert(Date.now() < popupDeadline, "Extension action popup did not open");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const { stdout } = await promisify(execFile)(executable, ["daemon", "pair"], {
      env,
      timeout: 10_000,
    });
    const paired = await evaluate(
      sessionId,
      `chrome.runtime.sendMessage({kind:'bsk-local-pairing', action:'pair', link:${JSON.stringify(stdout.trim())}})`,
      "pair daemon",
      true,
    );
    assert.equal(paired?.ok, true, `Extension pairing failed: ${paired?.error ?? "no reply"}`);
    await evaluate(
      sessionId,
      `new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({name:'popup'});
        port.onDisconnect.addListener(() => reject(new Error(chrome.runtime.lastError?.message ?? 'Popup port disconnected')));
        port.onMessage.addListener(message => {
          if (message.kind === 'snapshot' && message.data.connectionEnabled &&
              message.data.state === 'connected' && message.data.localAuth?.state === 'verified') {
            resolve(true);
            port.disconnect();
          }
        });
        port.postMessage({kind:'set_connection_enabled',value:true});
      })`,
      "enable verified connection",
    );
  } finally {
    if (targetId) await send("Target.closeTarget", { targetId });
  }
}
