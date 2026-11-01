// Real CLI, daemon, extension and plugin; all browser/profile/runtime state is isolated.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { expect, it } from "vitest";
import {
  attachVideoBackground,
  type BrowserSend,
} from "../../../apps/extension/src/video/browser-fixture";
import { registerBrowserTools } from "../src/browser-tools";
import { ObservationService } from "../src/observation";
import { KeyedExecutor } from "../src/queue";
import { createBskRunner } from "../src/runner";
import { SessionRegistry } from "../src/sessions";

it
  .skipIf(!process.env.BSK_COOP_CHROME || !process.env.BSK_COOP_BSK)
  .each(["click", "press", "drag", "fill", "select"] as const)(
  "settles cancelled thumbnails before sync and preserves navigating %s receipts",
  async (action) => {
    // Keep the daemon's Unix socket path below macOS's length limit.
    const directory = await mkdtemp(path.join(tmpdir(), "bsk-coop-"));
    const executable = path.resolve(process.env.BSK_COOP_BSK!);
    const env = {
      ...process.env,
      BSK_HOME: path.join(directory, "state"),
      BSK_AUTO_START: "0",
      BSK_AUTO_UPDATE: "off",
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
                await readFile(path.join(env.BSK_HOME!, "daemon.json"), "utf8"),
              ).ws_port;
              return port;
            } catch {
              return 0;
            }
          },
          { timeout: 15000 },
        )
        .toBeGreaterThan(0);
      const extension = path.join(directory, "extension");
      await cp(path.resolve("../../apps/extension/dist/chrome-mv3"), extension, {
        recursive: true,
      });
      const manifestPath = path.join(extension, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.name = "BrowserSkill cooperation settlement regression";
      await writeFile(manifestPath, JSON.stringify(manifest));
      const backgroundPath = path.join(extension, "background.js");
      const background = await readFile(backgroundPath, "utf8");
      expect(background).toContain("ws://127.0.0.1:52800");
      await writeFile(
        backgroundPath,
        background.replaceAll("ws://127.0.0.1:52800", `ws://127.0.0.1:${port}`),
      );
      const { withChrome } = await import(
        new URL(
          "../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      await withChrome(
        {
          executable: process.env.BSK_COOP_CHROME,
          extensionPath: extension,
          deviceScale: 1,
          zoom: 1,
        },
        async (send: BrowserSend) => {
          await expect
            .poll(async () => (await cli("browsers")).length, { timeout: 15000 })
            .toBeGreaterThan(0);
          const worker = await attachVideoBackground(send, manifest.name);
          const evaluate = async <T>(expression: string) => {
            const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, returnByValue: true, awaitPromise: true },
              worker.sessionId,
            );
            expect(reply.exceptionDetails).toBeUndefined();
            return reply.result.value;
          };
          const tools = new Map<string, ToolDefinition>();
          const ctx = {
            tools: {
              register: (tool: ToolDefinition) => {
                tools.set(tool.name, tool);
                return () => tools.delete(tool.name);
              },
            },
            get: () => undefined,
          };
          const runner = createBskRunner(executable, (command, args, options) =>
            spawn(command, args, { ...options, env: { ...options?.env, ...env } }),
          );
          const registry = new SessionRegistry(1);
          const queue = new KeyedExecutor();
          const config = {
            bskPath: executable,
            defaultTimeoutMs: 15000,
            maxSessions: 1,
            observationEnabled: true,
            thumbnailIntervalMs: 1500,
            idleIntervalMs: 8000,
            lazyTools: false,
          };
          const observation = new ObservationService({
            ctx: ctx as never,
            runner,
            registry,
            queue,
            options: { enabled: true, thumbnailIntervalMs: 1500, idleIntervalMs: 8000 },
          });
          registerBrowserTools({ ctx: ctx as never, runner, registry, queue, config, observation });
          const call = (name: string, args: object) =>
            tools.get(name)!.execute(
              args as never,
              {
                callId: "regression",
                name,
                signal: new AbortController().signal,
              } as ToolRunContext,
            ) as Promise<Record<string, any>>;
          let session: string | undefined;
          let unsubscribe = () => {};
          try {
            session = (await call("bsk_session", { action: "start", url, noFocus: true }))
              .sessionId;
            // Only this fixture holds one Chrome reply. The installed extension,
            // dispatcher, daemon cancellation and plugin scheduler remain real.
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
                  (method === 'Runtime.callFunctionOn' && (value?.selected_values || value?.connected && value?.matches)))
                await committed;
              return result;
            };
          })()`);
            unsubscribe = observation.subscribe(() => {});
            await expect
              .poll(() => evaluate("typeof globalThis.finishHeldShot === 'function'"), {
                timeout: 10000,
              })
              .toBe(true);
            const syncing = call("bsk_session", { action: "sync", session });
            unsubscribe();
            const synced = await syncing;
            expect(synced.context_id).toEqual(expect.any(String));
            expect(observation.getState()[0].thumbnailAttachmentId).toBeUndefined();
            expect((await cli("debug", "activity", "--session", session!)).activity.state).toBe(
              "idle",
            );
            await evaluate("globalThis.finishHeldShot()");
            const fresh = await call("bsk_session", { action: "sync", session });
            expect(fresh.context_id).not.toBe(synced.context_id);
            expect(fresh.kind).toBe("unchanged");
            const ref = synced.observation.text.match(/(@e\d+) link "Continue"/)?.[1];
            expect(ref).toBeDefined();
            const input = {
              click: { target: ref },
              press: { target: "input", key: "Enter" },
              drag: { target: "#drag", deltaX: 80, durationMs: 50 },
              fill: { target: "input", value: "submitted" },
              select: { target: "select", values: ["b"] },
            }[action];
            const receipt = await call("bsk_interact", {
              action,
              session,
              ...input,
              contextId: fresh.context_id,
            });
            expect(action === "drag" ? receipt.tab_id : receipt.tabId).toEqual(expect.any(Number));
            const destination = await call("bsk_session", { action: "sync", session });
            expect(destination.observation.text).toContain("Navigation completed");
            expect(arrivals).toBe(1);
            await expect(
              call("bsk_interact", {
                action,
                session,
                ...input,
                contextId: fresh.context_id,
              }),
            ).rejects.toThrow();
            expect(arrivals).toBe(1);
          } finally {
            unsubscribe();
            observation.dispose();
            if (session) await cli("session", "stop", session);
            runner.killAll();
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
