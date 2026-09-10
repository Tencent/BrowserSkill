import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This regression owns its browser/profile. It never attaches to a user's Chrome.
export async function withChrome(
  { executable, deviceScale, zoom, extensionPath, headless = true },
  run,
) {
  const profile = await mkdtemp(join(tmpdir(), "bsk-snapshot-coordinates-"));
  let chrome;
  let socket;
  const pending = new Map();
  try {
    await mkdir(join(profile, "Default"));
    await writeFile(
      join(profile, "Default", "Preferences"),
      JSON.stringify({
        partition: { default_zoom_level: { x: Math.log(zoom) / Math.log(1.2) } },
      }),
    );
    chrome = spawn(
      executable,
      [
        ...(headless ? ["--headless=new"] : []),
        "--no-first-run",
        "--no-default-browser-check",
        ...(extensionPath
          ? [
              "--disable-gpu",
              `--disable-extensions-except=${extensionPath}`,
              `--load-extension=${extensionPath}`,
            ]
          : ["--disable-extensions"]),
        "--site-per-process",
        "--remote-debugging-port=0",
        "--window-size=1600,1200",
        `--force-device-scale-factor=${deviceScale}`,
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const endpoint = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(new Error(`Chrome startup timed out: ${output}`)),
        15_000,
      );
      const fail = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      chrome.once("error", fail);
      chrome.once("exit", (code) => fail(new Error(`Chrome exited (${code}): ${output}`)));
      chrome.stderr.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.addEventListener("message", ({ data }) => {
      const reply = JSON.parse(data);
      const request = pending.get(reply.id);
      if (!request) return;
      clearTimeout(request.timeout);
      pending.delete(reply.id);
      if (reply.error) request.reject(new Error(JSON.stringify(reply.error)));
      else request.resolve(reply.result);
    });
    let sequence = 0;
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timed out: ${method}`));
        }, 10_000);
        pending.set(id, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    await run(send);
  } finally {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("regression browser closed"));
    }
    socket?.close();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = once(chrome, "exit");
      const timeout = setTimeout(() => chrome.kill("SIGKILL"), 5_000);
      chrome.kill();
      await exited;
      clearTimeout(timeout);
    }
    await rm(profile, { recursive: true, force: true });
  }
}
