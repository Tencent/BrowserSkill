// @vitest-environment node
// Opt in with built BSK_REMOTE_CLI and BSK_REMOTE_CHROME. Owns every process/profile.
import { spawn } from "node:child_process";
import { type EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
async function poll<T>(read: () => Promise<T | false | undefined>, timeout = 20_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Remote browser condition timed out");
}
const enabled = !!process.env.BSK_REMOTE_CLI && !!process.env.BSK_REMOTE_CHROME;
describe.skipIf(!enabled)("standalone remote browser", () => {
  it("pairs, preserves windows, restricts tabs and cleans up on revocation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bsk-remote-browser-"));
    const page = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><title>Remote fixture</title><button>Remote action</button>");
    });
    await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
    const pageUrl = `http://127.0.0.1:${(page.address() as { port: number }).port}/`;
    const reserve = createServer();
    await new Promise<void>((r) => reserve.listen(0, "127.0.0.1", r));
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>((r) => reserve.close(() => r()));
    const env = {
      ...process.env,
      HOME: directory,
      USERPROFILE: directory,
      BSK_HOME: directory,
      BSK_AUTO_START: "0",
      BSK_AUTO_UPDATE: "off",
      BSK_UPDATE_MANIFEST_URL: "http://127.0.0.1:1/disabled",
    };
    const cli = process.env.BSK_REMOTE_CLI!;
    const command = async (args: string[]) => {
      const child = spawn(cli, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (b) => {
        stdout += b;
      });
      child.stderr.on("data", (b) => {
        stderr += b;
      });
      const [code] = await once(child as unknown as EventEmitter, "close");
      if (code !== 0) throw new Error(`CLI failed: ${stderr || stdout}`);
      return stdout.trim();
    };
    const daemon = spawn(
      cli,
      [
        "daemon",
        "start",
        "--mode",
        "server",
        "--port",
        String(port),
        "--public-url",
        `ws://127.0.0.1:${port}/extension`,
      ],
      { env, stdio: "ignore" },
    );
    try {
      const info = await poll(async () => {
        try {
          return JSON.parse(await readFile(path.join(directory, "daemon.json"), "utf8")) as {
            sock_path: string;
          };
        } catch {
          return false;
        }
      });
      const rpc = (method: string, params: object = {}) =>
        new Promise<Record<string, any>>((resolve, reject) => {
          const socket = createConnection(info.sock_path);
          let data = "";
          socket.setTimeout(15_000, () => socket.destroy(new Error(`RPC timeout: ${method}`)));
          socket.on("error", reject);
          socket.on("connect", () =>
            socket.write(JSON.stringify({ id: crypto.randomUUID(), method, params }) + "\n"),
          );
          socket.on("data", (chunk) => {
            data += chunk;
            if (!data.includes("\n")) return;
            socket.end();
            const reply = JSON.parse(data.split("\n")[0]);
            if (reply.error) reject(Object.assign(new Error(reply.error.message), reply.error));
            else resolve(reply.result);
          });
        });
      const pairing = await command(["daemon", "pair"]);
      const { withChrome } = await import(
        new URL(
          "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      await withChrome(
        {
          executable: process.env.BSK_REMOTE_CHROME,
          deviceScale: 1,
          zoom: 1,
          extensionPath: path.resolve("dist/chrome-mv3"),
        },
        async (send: Send) => {
          const worker = await poll(async () =>
            (
              await send<{ targetInfos: { type: string; url: string; targetId: string }[] }>(
                "Target.getTargets",
              )
            ).targetInfos.find(
              (t) => t.type === "service_worker" && t.url.endsWith("/background.js"),
            ),
          );
          const origin = worker.url.split("/").slice(0, 3).join("/");
          const popup = await send<{ targetId: string }>("Target.createTarget", {
            url: `${origin}/popup.html`,
          });
          const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId: popup.targetId,
            flatten: true,
          });
          const evaluate = async <T>(expression: string): Promise<T> => {
            const value = await send<{ result: { value: T }; exceptionDetails?: object }>(
              "Runtime.evaluate",
              { expression, awaitPromise: true, returnByValue: true },
              sessionId,
            );
            if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
            return value.result.value;
          };
          await poll(() => evaluate<boolean>("!!globalThis.chrome?.storage?.local"));
          const reply = await evaluate<{ error?: string }>(
            `chrome.runtime.sendMessage({kind:'bsk-remote-authorization',pairing:${JSON.stringify(pairing)}})`,
          );
          expect(reply.error).toBeUndefined();
          await evaluate("chrome.storage.local.set({bh_connection_enabled:true})");
          await poll(async () => (await rpc("system.status")).browsers?.length > 0);
          const preferences = await evaluate<Record<string, unknown>>(
            "chrome.storage.local.get(null)",
          );
          expect(preferences.bsk_remote_endpoint).toBeUndefined();
          expect(JSON.stringify(preferences)).not.toContain(pairing.split("#")[1]);
          const readGrant =
            "new Promise((resolve,reject)=>{const request=indexedDB.open('bsk-remote-authorization',1);request.onsuccess=()=>{const db=request.result;const get=db.transaction('connection').objectStore('connection').get('endpoint');get.onsuccess=()=>{db.close();resolve(get.result)};get.onerror=()=>reject(get.error)};request.onerror=()=>reject(request.error)})";
          const grant = await evaluate<{ deviceId: string; token: string }>(readGrant);
          expect(grant.deviceId).toMatch(/^[a-f0-9]{32}$/);
          expect(JSON.stringify(preferences)).not.toContain(grant.token);
          const user = await evaluate<{ id: number; tabs: { id: number }[] }>(
            `chrome.windows.create({url:${JSON.stringify(pageUrl)},focused:false})`,
          );
          const userTab = user.tabs[0].id;
          await evaluate(
            `chrome.tabs.create({windowId:${user.id},url:"about:blank",active:false})`,
          );
          const started = await rpc("session.start", { focused: false });
          const session = started.session_id;
          expect(started.agent_window_id).not.toBe(user.id);
          await rpc("tool.navigate", { session_id: session, url: pageUrl });
          expect(JSON.stringify(await rpc("tool.snapshot", { session_id: session }))).toContain(
            "Remote action",
          );
          await expect(
            rpc("tool.snapshot", { session_id: session, tab_id: userTab }),
          ).rejects.toMatchObject({ code: "permission_denied" });
          for (const method of ["tool.upload", "tool.download"])
            await expect(rpc(method, { session_id: session })).rejects.toMatchObject({
              code: "unsupported",
            });
          // Change the browser user's preference; remote request flags cannot set it.
          await evaluate(
            "chrome.storage.local.set({bsk_interaction_preferences:{confirmTabBorrow:false,requestHelpEnabled:true}})",
          );
          await poll(
            async () =>
              (await rpc("system.status")).sessions?.find(
                (s: { session_id: string }) => s.session_id === session,
              )?.interaction?.borrow_confirmation === "never",
          );
          await rpc("tool.tab_borrow", { session_id: session, tab_id: userTab });
          expect(await evaluate<number>(`chrome.tabs.get(${userTab}).then(t=>t.windowId)`)).toBe(
            started.agent_window_id,
          );
          expect(
            JSON.stringify(await rpc("tool.snapshot", { session_id: session, tab_id: userTab })),
          ).toContain("Remote action");
          await rpc("tool.tab_return", { session_id: session, tab_id: userTab });
          expect(await evaluate<number>(`chrome.tabs.get(${userTab}).then(t=>t.windowId)`)).toBe(
            user.id,
          );
          await expect(
            rpc("tool.snapshot", { session_id: session, tab_id: userTab }),
          ).rejects.toMatchObject({ code: "permission_denied" });
          await rpc("tool.tab_borrow", { session_id: session, tab_id: userTab });
          await command(["daemon", "revoke", grant.deviceId]);
          await poll(async () => (await rpc("system.status")).browsers?.length === 0);
          await poll(() =>
            evaluate<boolean>(`chrome.tabs.get(${userTab}).then(t=>t.windowId===${user.id})`),
          );
          const windows = await evaluate<{ id: number }[]>("chrome.windows.getAll()");
          expect(windows.some((w) => w.id === started.agent_window_id)).toBe(false);
          expect((await evaluate<{ deviceId: string }>(readGrant)).deviceId).toBe(grant.deviceId);
          await expect(rpc("tool.snapshot", { session_id: session })).rejects.toBeDefined();
        },
      );
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exit = once(daemon as unknown as EventEmitter, "exit");
        daemon.kill();
        const force = setTimeout(() => daemon.kill("SIGKILL"), 2000);
        try {
          await exit;
        } finally {
          clearTimeout(force);
        }
      }
      await new Promise<void>((r) => page.close(() => r()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
