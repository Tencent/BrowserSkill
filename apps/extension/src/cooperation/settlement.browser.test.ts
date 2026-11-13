// @vitest-environment node
// Real CLI, MCP stdio server, daemon, and extension; all browser/profile/runtime state is isolated.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { attachVideoBackground, type BrowserSend } from "../video/browser-fixture";

const defaultCli = fileURLToPath(
  new URL(
    `../../../../target/debug/bsk${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);

it
  .skipIf(!process.env.BSK_TEST_CHROME)
  .each(
    (["strict", "target"] as const).flatMap((policy) =>
      (["click", "press", "drag", "fill", "select"] as const).map((action) => ({ policy, action })),
    ),
  )(
  "$policy policy settles cancelled screenshots before sync and preserves navigating $action receipts",
  async ({ policy, action }) => {
    // Keep the daemon's Unix socket path below macOS's length limit.
    const directory = await mkdtemp(path.join(tmpdir(), "bsk-coop-"));
    const executable = path.resolve(process.env.BSK_TEST_CLI ?? defaultCli);
    const fixtureHome = path.join(directory, "user");
    const env = {
      ...process.env,
      HOME: fixtureHome,
      USERPROFILE: fixtureHome,
      KIMI_CODE_HOME: path.join(fixtureHome, ".kimi-code"),
      HERMES_HOME: path.join(fixtureHome, ".hermes"),
      DSH_HOME: path.join(fixtureHome, ".dsh"),
      CODEX_HOME: path.join(fixtureHome, ".codex"),
      BSK_HOME: path.join(directory, "state"),
      BSK_AUTO_START: "0",
      BSK_AUTO_UPDATE: "off",
      BSK_SESSION: "",
      BSK_SCOPE: "",
    };
    const daemon = spawn(executable, ["daemon", "start", "--foreground", "--port", "0"], {
      env,
      stdio: "ignore",
    });
    let arrivals = 0;
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      if (request.url?.startsWith("/done")) {
        arrivals++;
        response.end("<!doctype html><h1>Navigation completed</h1>");
      } else {
        response.end(`<!doctype html><h1>Settlement regression</h1><a href="/done">Continue</a>
          <form id="form" action="/done">
            <input aria-label="Search" name="q" value="test" onchange="if(this.value==='submitted')setTimeout(()=>this.form.requestSubmit(),100)">
            <select aria-label="Category" name="category" onchange="this.form.requestSubmit()"><option value="a">A</option><option value="b">B</option></select>
            <button>Submit</button>
          </form>
          <div id="drag" role="button" style="width:240px;height:60px;user-select:none"
            onpointerdown="this.startX=event.clientX;this.setPointerCapture(event.pointerId)"
            onpointerup="if(event.clientX-this.startX>20)document.querySelector('form').requestSubmit()">Drag to submit</div>`);
      }
    });
    const cli = async (...args: string[]) => {
      const result = await promisify(execFile)(executable, [...args, "--json"], {
        env,
        timeout: 20000,
      });
      return JSON.parse(result.stdout);
    };
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
      let port = 0;
      await expect
        .poll(
          async () => {
            try {
              port = JSON.parse(
                await readFile(path.join(env.BSK_HOME, "daemon.json"), "utf8"),
              ).ws_port;
              return port;
            } catch {
              return 0;
            }
          },
          { timeout: 15000 },
        )
        .toBeGreaterThan(0);
      const { copyPairingExtension, pairLocalBrowser } = await import(
        new URL("../../../../evals/browser/local-pairing.mjs", import.meta.url).href
      );
      const distPath = fileURLToPath(new URL("../../dist/chrome-mv3", import.meta.url));
      const extension = await copyPairingExtension(
        distPath,
        path.join(directory, "extension"),
        port,
      );
      const manifestPath = path.join(extension, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.name = "BrowserSkill cooperation settlement regression";
      await writeFile(manifestPath, JSON.stringify(manifest));
      const { withChrome } = await import(
        new URL(
          "../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      const { createMcpRegressionClient } = await import(
        new URL(
          "../../../../evals/browser/cases/regression/cooperation/mcp-client.mjs",
          import.meta.url,
        ).href
      );
      await withChrome(
        {
          executable: process.env.BSK_TEST_CHROME,
          extensionPath: extension,
          extensionViaCdp: process.env.BSK_TEST_LOAD_CDP === "1",
          deviceScale: 1,
          zoom: 1,
        },
        async (send: BrowserSend) => {
          const worker = await attachVideoBackground(send, manifest.name);
          await pairLocalBrowser(send, { executable, env, worker });
          await expect
            .poll(async () => (await cli("browsers")).length, { timeout: 15000 })
            .toBeGreaterThan(0);
          const evaluate = async <T>(expression: string) => {
            const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, returnByValue: true, awaitPromise: true },
              worker.sessionId,
            );
            expect(reply.exceptionDetails).toBeUndefined();
            return reply.result.value;
          };
          const mcp = await createMcpRegressionClient(executable, env);
          let session: string | undefined;
          try {
            session = (await mcp.run("bsk_session", { action: "start" })).session_id;
            await mcp.run("bsk_page", { action: "navigate", session, url });
            // Only this fixture holds one Chrome reply. The installed extension,
            // dispatcher, daemon cancellation, and MCP stdio server remain real.
            await evaluate(`(() => {
              const original = chrome.debugger.sendCommand.bind(chrome.debugger);
              const committed = new Promise(resolve => {
                const onCommitted = details => {
                  if (details.frameId !== 0 || new URL(details.url).pathname !== '/done') return;
                  chrome.webNavigation.onCommitted.removeListener(onCommitted);
                  resolve();
                };
                chrome.webNavigation.onCommitted.addListener(onCommitted);
              });
              globalThis.holdNextShot = true;
              chrome.debugger.sendCommand = async (target, method, params) => {
                if (method === 'Page.captureScreenshot' && globalThis.holdNextShot) {
                  globalThis.holdNextShot = false;
                  return new Promise(resolve => { globalThis.finishHeldShot = () => resolve({data: ''}); });
                }
                const result = await original(target, method, params);
                const value = result?.result?.value;
                // Hold only a completed input/verification reply until navigation commits.
                if ((method === 'Input.dispatchKeyEvent' && params.type === 'keyUp' && params.key === 'Enter') ||
                    (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') ||
                    (method === 'Runtime.callFunctionOn' && (value?.selected_values || (value?.connected && (value?.matches || typeof value?.valueLength === 'number')))))
                  await committed;
                return result;
              };
            })()`);
            const heldShot = mcp.startCall("bsk_inspect", { action: "screenshot", session });
            void heldShot.promise.catch(() => {});
            await expect
              .poll(() => evaluate("typeof globalThis.finishHeldShot === 'function'"), {
                timeout: 10000,
              })
              .toBe(true);
            const syncing = mcp.run("bsk_session", {
              action: "sync",
              session,
              policy,
              settle: true,
            });
            mcp.cancel(heldShot.requestId);
            const synced = await syncing;
            expect(synced.context_id).toEqual(expect.any(String));
            expect(synced.control_policy).toBe(policy);
            expect((await cli("debug", "activity", "--session", session!)).activity.state).toBe(
              "idle",
            );
            await evaluate("globalThis.finishHeldShot()");
            const fresh = await mcp.run("bsk_session", { action: "sync", session, policy });
            if (policy === "strict") expect(fresh.context_id).not.toBe(synced.context_id);
            else {
              expect(fresh.context_id).toBe(synced.context_id);
              expect(fresh.observation_id).toEqual(expect.any(String));
              expect(fresh.observation_id).not.toBe(synced.observation_id);
            }
            expect(fresh.control_policy).toBe(policy);
            expect(fresh.kind).toBe("unchanged");
            const ref = synced.observation.text.match(/(@e\d+) link "Continue"/)?.[1];
            expect(ref).toBeDefined();
            const interactArgs = {
              click: { params: { ref } },
              press: { params: { selector: "input", key: "Enter" } },
              drag: {
                params: {
                  source: { selector: "#drag" },
                  delta: { x: 80, y: 0 },
                  duration_ms: 50,
                },
                ...(policy === "target" ? { observation: fresh.observation_id } : {}),
              },
              fill: { params: { selector: "input", value: "submitted" } },
              select: { params: { selector: "select", values: ["b"] } },
            }[action];
            const receipt = await mcp.run("bsk_interact", {
              action,
              session,
              context: fresh.context_id,
              ...interactArgs,
            });
            expect(receipt.tab_id).toEqual(expect.any(Number));
            const destination = await mcp.run("bsk_session", { action: "sync", session, policy });
            expect(destination.observation.text).toContain("Navigation completed");
            expect(arrivals).toBe(1);
            await expect(
              mcp.run("bsk_interact", {
                action,
                session,
                context: fresh.context_id,
                ...interactArgs,
              }),
            ).rejects.toThrow();
            expect(arrivals).toBe(1);
          } finally {
            if (session) await cli("session", "stop", session).catch(() => {});
            await mcp.dispose();
          }
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exited = once(daemon, "exit");
        daemon.kill();
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
