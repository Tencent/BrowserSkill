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
    };
    for (const key of [
      "BSK_SESSION",
      "BSK_SCOPE",
      "CLAUDE_CODE_AGENT_ID",
      "CODEX_THREAD_ID",
      "ANTIGRAVITY_CONVERSATION_ID",
      "CURSOR_TRACE_ID",
      "DSH_SESSION_ID",
    ]) {
      delete (env as NodeJS.ProcessEnv)[key];
    }
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

it.skipIf(!process.env.BSK_TEST_CHROME)(
  "completes SPA query/hash updates, auto-submitting fills, subframe churn, and failed navigations without false control_context_invalid freezes",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bsk-coop-spa-"));
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
    };
    for (const key of [
      "BSK_SESSION",
      "BSK_SCOPE",
      "CLAUDE_CODE_AGENT_ID",
      "CODEX_THREAD_ID",
      "ANTIGRAVITY_CONVERSATION_ID",
      "CURSOR_TRACE_ID",
      "DSH_SESSION_ID",
    ]) {
      delete (env as NodeJS.ProcessEnv)[key];
    }
    const daemon = spawn(executable, ["daemon", "start", "--foreground", "--port", "0"], {
      env,
      stdio: "ignore",
    });
    let closedPort = 0;
    const closedServer = createServer();
    await new Promise<void>((resolve) => closedServer.listen(0, "127.0.0.1", resolve));
    closedPort = (closedServer.address() as { port: number }).port;
    await new Promise<void>((resolve) => closedServer.close(() => resolve()));

    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.url?.startsWith("/done")) {
        response.end("<!doctype html><h1>OTP Submitted</h1>");
        return;
      }
      if (request.url?.startsWith("/subframe")) {
        response.end("<!doctype html><p>subframe tick</p>");
        return;
      }
      response.end(`<!doctype html>
        <h1>SPA & Subframe Control</h1>
        <form id="otp-form" action="/done">
          <input id="search" aria-label="Search" value="init">
          <input id="otp" aria-label="OTP" name="otp">
          <button id="tab-anomalies" type="button">Anomalies</button>
          <button id="apply" type="button">Apply</button>
          <a id="spa-orders" href="/orders">Orders</a>
          <a id="broken-link" href="http://127.0.0.1:${closedPort}/">Broken</a>
          <output id="status">idle</output>
        </form>
        <iframe id="reloading-sub" src="/subframe?0" style="width:120px;height:40px"></iframe>
        <div style="height:1800px"></div>
        <section id="deep-section" style="height:120px">Deep section</section>
        <script>
          window.changeEvents = 0;
          const search = document.getElementById('search');
          search.addEventListener('input', () => {
            const next = new URL(location.href);
            next.searchParams.set('q', search.value);
            history.replaceState({ q: search.value }, '', next);
            // Mount a restricted sandboxed hidden iframe and reload a visible child frame mid-action.
            const ad = document.createElement('iframe');
            ad.style.display = 'none';
            ad.setAttribute('sandbox', '');
            ad.srcdoc = '<p>pixel</p>';
            document.body.appendChild(ad);
            document.getElementById('reloading-sub').src = '/subframe?' + Date.now();
          });
          search.addEventListener('change', () => { window.changeEvents++; });

          window.addEventListener('scroll', () => {
            if (window.scrollY > 200 && location.hash !== '#deep-section') {
              history.replaceState(history.state, '', location.pathname + location.search + '#deep-section');
            }
          });

          document.getElementById('tab-anomalies').addEventListener('click', () => {
            const next = new URL(location.href);
            next.searchParams.set('view', 'anomalies');
            history.pushState({ view: 'anomalies' }, '', next);
            document.getElementById('status').textContent = 'anomalies';
          });

          window.applied = 0;
          document.getElementById('apply').addEventListener('click', () => {
            window.applied++;
            document.getElementById('status').textContent = 'applied:' + window.applied + ':' + search.value;
          });

          document.getElementById('spa-orders').addEventListener('click', (event) => {
            event.preventDefault();
            history.pushState({ route: 'orders' }, '', '/orders');
            document.getElementById('status').textContent = 'orders-view';
          });

          const otp = document.getElementById('otp');
          otp.addEventListener('input', () => {
            if (otp.value === 'otp6') document.getElementById('otp-form').requestSubmit();
          });
        </script>`);
    });
    const runCli = async (...args: string[]) => {
      try {
        const { stdout } = await promisify(execFile)(executable, [...args, "--json"], {
          env,
          timeout: 25000,
        });
        return { exitCode: 0, body: JSON.parse(stdout) };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string };
        if (failed.stdout) {
          return { exitCode: failed.code ?? 1, body: JSON.parse(failed.stdout) };
        }
        throw error;
      }
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
      manifest.name = "BrowserSkill SPA coverage regression";
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
            .poll(async () => (await runCli("browsers")).body.length, { timeout: 15000 })
            .toBeGreaterThan(0);
          const mcp = await createMcpRegressionClient(executable, env);
          let session: string | undefined;
          try {
            session = (await mcp.run("bsk_session", { action: "start" })).session_id;
            const scope = ["--session", session!];
            await mcp.run("bsk_page", { action: "navigate", session, url });
            const synced = await mcp.run("bsk_session", { action: "sync", session });
            expect(synced.control_policy).toBe("target");
            const ctx = synced.context_id as string;

            // 1. `fill` triggering `history.replaceState(?q=...)` + subframe churn completes Step 3
            // (`change` event + readback), keeps IntentWal settled, and preserves `context_id`.
            const filled = await runCli(
              "fill",
              "#search",
              "--value",
              "shoes",
              ...scope,
              "--context",
              ctx,
            );
            expect(filled.body).toMatchObject({ actual_value: "shoes", value_length: 5 });
            expect(filled.exitCode).toBe(0);
            expect((await runCli("ledger", "status", ...scope)).body.frozen).toBe(false);
            // Same-pathname query update still consumes the strict baseline for opaque untargeted input.
            const untargetedAfterQuery = await runCli(
              "press",
              "Escape",
              ...scope,
              "--context",
              ctx,
              "--observation",
              synced.observation_id as string,
            );
            expect(untargetedAfterQuery.exitCode).not.toBe(0);
            expect(untargetedAfterQuery.body.data).toMatchObject({ effect_state: "none" });

            // 2. `scroll-to` triggering `history.replaceState(#deep-section)` completes visibility
            // measurement and keeps `context_id` ready for subsequent actions.
            const scrolled = await runCli("scroll-to", "#deep-section", ...scope, "--context", ctx);
            expect(scrolled.exitCode).toBe(0);
            expect(scrolled.body.height).toBeGreaterThan(0);
            expect((await runCli("cooperate", "status", ...scope)).body).toMatchObject({
              ready: true,
              state: { mode: "ready" },
            });

            // 3. `bsk plan` chains `fill` (`replaceState`) -> `click` tab (`pushState(?view=...)`)
            // -> `click` apply across a single pinned `context_id`.
            const planned = await runCli(
              "plan",
              ...scope,
              "--context",
              ctx,
              "--steps",
              JSON.stringify([
                { action: "fill", selector: "#search", value: "boots" },
                { action: "click", selector: "#tab-anomalies" },
                { action: "click", selector: "#apply" },
              ]),
            );
            expect(planned.exitCode, JSON.stringify(planned)).toBe(0);
            expect(planned.body).toMatchObject({ ok: true, completed: 3 });
            const readStatus = await runCli("read", "--selector", "#status", ...scope);
            expect(readStatus.body.items[0].values.text).toBe("applied:1:boots");
            expect((await runCli("ledger", "status", ...scope)).body.frozen).toBe(false);

            // 4. Clicking an SPA pathname link (`/orders`) completes its click receipt cleanly
            // without freezing IntentWal or entering `unavailable`, then revokes the old context
            // with `effect_state: "none"` for subsequent un-synced actions.
            const routeCtx = planned.body.post.context_id as string;
            const clickedRoute = await runCli(
              "click",
              "#spa-orders",
              ...scope,
              "--context",
              routeCtx,
            );
            expect(clickedRoute.exitCode).toBe(0);
            expect((await runCli("ledger", "status", ...scope)).body.frozen).toBe(false);
            expect((await runCli("cooperate", "status", ...scope)).body.state.mode).toBe("syncing");
            const staleAfterRoute = await runCli(
              "click",
              "#apply",
              ...scope,
              "--context",
              routeCtx,
            );
            expect(staleAfterRoute.exitCode).not.toBe(0);
            expect(staleAfterRoute.body.data).toMatchObject({
              reason: "control_context_invalid",
              effect_state: "none",
            });
            expect((await runCli("ledger", "status", ...scope)).body.frozen).toBe(false);

            // 5. Navigating to a closed port preserves the real `Page.navigate` network error
            // instead of masking it behind `Page interaction coverage changed`.
            const ordersSync = await mcp.run("bsk_session", { action: "sync", session });
            const failedNav = await runCli(
              "navigate",
              `http://127.0.0.1:${closedPort}/`,
              ...scope,
              "--context",
              ordersSync.context_id,
              "--observation",
              ordersSync.observation_id,
            );
            expect(failedNav.exitCode).not.toBe(0);
            expect(failedNav.body.code).toBe("cdp_failed");
            expect(failedNav.body.message).toContain("Page.navigate rejected");
            await runCli("ledger", "resolve", ...scope);

            // 6. Clicking a broken link (`ResponseBody::Ok` -> Chrome `page_load_failed` interstitial)
            // recovers on the first `back` attempt even with an auto-injected implicit `target` context,
            // and auto-submitting `fill` (`oninput="form.requestSubmit()"`) completes Step 3 cleanly.
            await mcp.run("bsk_page", { action: "navigate", session, url });
            await mcp.run("bsk_session", { action: "sync", session });
            expect((await runCli("click", "#broken-link", ...scope)).exitCode).toBe(0);
            await expect
              .poll(
                async () => {
                  const { targetInfos } = (await send("Target.getTargets")) as {
                    targetInfos: { type: string; url: string }[];
                  };
                  return targetInfos.some(
                    (info) =>
                      info.type === "page" &&
                      (info.url.includes("chromewebdata") || info.url.includes(`:${closedPort}/`)),
                  );
                },
                { timeout: 10000 },
              )
              .toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 150));
            const recoveredBack = await runCli("navigate-back", ...scope);
            expect(recoveredBack.exitCode, JSON.stringify(recoveredBack)).toBe(0);
            const otpSync = await mcp.run("bsk_session", { action: "sync", session });
            const otpFilled = await runCli(
              "fill",
              "#otp",
              "--value",
              "otp6",
              ...scope,
              "--context",
              otpSync.context_id,
            );
            expect(otpFilled.exitCode, JSON.stringify(otpFilled)).toBe(0);
            expect(otpFilled.body).toMatchObject({ actual_value: "otp6", value_length: 4 });
            expect((await runCli("ledger", "status", ...scope)).body.frozen).toBe(false);
            let doneSync = await mcp.run("bsk_session", { action: "sync", session });
            await expect
              .poll(
                async () => {
                  doneSync = await mcp.run("bsk_session", { action: "sync", session });
                  return doneSync.observation?.text ?? "";
                },
                { timeout: 10000 },
              )
              .toContain("OTP Submitted");
            // Same-document `#top` navigate (`ToolNavigate` + unchanged `sync`) preserves `cached_vom`.
            expect(
              (
                await runCli(
                  "navigate",
                  `${url}done?otp=otp6#top`,
                  ...scope,
                  "--context",
                  doneSync.context_id,
                  "--observation",
                  doneSync.observation_id,
                )
              ).exitCode,
            ).toBe(0);
            const hashSync = await mcp.run("bsk_session", { action: "sync", session });
            expect(
              (
                await runCli(
                  "navigate",
                  `${url}done?otp=otp6#top`,
                  ...scope,
                  "--context",
                  hashSync.context_id,
                  "--observation",
                  hashSync.observation_id,
                )
              ).exitCode,
            ).toBe(0);
            const unchangedAfterNav = await runCli("sync", ...scope);
            expect(unchangedAfterNav.exitCode).toBe(0);
            expect(unchangedAfterNav.body.vom).toContain("OTP Submitted");

            // 7. Verify both offscreen creation failure and Chrome 157+ packed/policy
            // `kRestrictedError` on `video-offscreen.html` fall back cleanly and cache
            // non-transient restrictions across `NativeInputClock` invalidations (#742).
            await expect
              .poll(
                async () => {
                  const reply = await send<{ result: { value: boolean } }>(
                    "Runtime.evaluate",
                    {
                      expression: "chrome.offscreen.hasDocument()",
                      returnByValue: true,
                      awaitPromise: true,
                    },
                    worker.sessionId,
                  );
                  return reply.result.value;
                },
                { timeout: 5000 },
              )
              .toBe(false);
            const hookReply = await send<{ exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              {
                expression: `(() => {
                  const offscreenUrl = chrome.runtime.getURL('video-offscreen.html');
                  const originalPerfNow = performance.now.bind(performance);
                  const originalCreate = chrome.offscreen.createDocument.bind(chrome.offscreen);
                  const originalAttach = chrome.debugger.attach.bind(chrome.debugger);
                  const originalGetTargets = chrome.debugger.getTargets.bind(chrome.debugger);
                  let perfShiftMs = 0;
                  let failNextCreate = true;
                  globalThis.__bskForceRecalibrate = () => { perfShiftMs += 65_000; };
                  globalThis.__bskOffscreenCreateAttempts = 0;
                  globalThis.__bskOffscreenAttachAttempts = 0;
                  performance.now = () => originalPerfNow() + perfShiftMs;
                  chrome.offscreen.createDocument = async (params) => {
                    if (failNextCreate) {
                      failNextCreate = false;
                      throw new Error('Only a single offscreen document may be created.');
                    }
                    globalThis.__bskOffscreenCreateAttempts++;
                    return originalCreate(params);
                  };
                  chrome.debugger.attach = async (target, version) => {
                    if (target.targetId) {
                      const targets = await originalGetTargets();
                      if (targets.some((item) => item.id === target.targetId && item.url === offscreenUrl)) {
                        globalThis.__bskOffscreenAttachAttempts++;
                        throw new Error('Cannot attach to this target.');
                      }
                    }
                    return originalAttach(target, version);
                  };
                })()`,
                returnByValue: true,
              },
              worker.sessionId,
            );
            expect(hookReply.exceptionDetails).toBeUndefined();
            const forceRecalibrate = async () => {
              const reply = await send<{ exceptionDetails?: unknown }>(
                "Runtime.evaluate",
                { expression: "globalThis.__bskForceRecalibrate()", returnByValue: true },
                worker.sessionId,
              );
              expect(reply.exceptionDetails).toBeUndefined();
            };
            const readProbeCounts = async () => {
              const reply = await send<{
                result: { value: { creates: number; attaches: number } };
                exceptionDetails?: unknown;
              }>(
                "Runtime.evaluate",
                {
                  expression:
                    "({ creates: globalThis.__bskOffscreenCreateAttempts, attaches: globalThis.__bskOffscreenAttachAttempts })",
                  returnByValue: true,
                },
                worker.sessionId,
              );
              expect(reply.exceptionDetails).toBeUndefined();
              return reply.result.value;
            };

            expect(
              (
                await runCli(
                  "navigate",
                  url,
                  ...scope,
                  "--context",
                  unchangedAfterNav.body.context_id,
                  "--observation",
                  unchangedAfterNav.body.observation_id,
                )
              ).exitCode,
            ).toBe(0);
            const createFallbackSync = await mcp.run("bsk_session", { action: "sync", session });
            await forceRecalibrate();
            const stepped = await runCli(
              "step",
              ...scope,
              "--action",
              "click",
              "--params",
              JSON.stringify({ selector: "#tab-anomalies" }),
              "--context",
              createFallbackSync.context_id,
              "--observation",
              createFallbackSync.observation_id,
            );
            expect(stepped.exitCode, JSON.stringify(stepped)).toBe(0);
            expect(stepped.body).toMatchObject({ ok: true });
            expect(await readProbeCounts()).toEqual({ creates: 0, attaches: 0 });

            const restrictedSync = await mcp.run("bsk_session", { action: "sync", session });
            await forceRecalibrate();
            expect(
              (
                await runCli(
                  "wheel",
                  "--delta-y",
                  "120",
                  ...scope,
                  "--context",
                  restrictedSync.context_id,
                  "--observation",
                  restrictedSync.observation_id,
                )
              ).exitCode,
            ).toBe(0);
            const afterWheelSync = await mcp.run("bsk_session", { action: "sync", session });
            expect(
              (
                await runCli(
                  "press",
                  "Tab",
                  ...scope,
                  "--context",
                  afterWheelSync.context_id,
                  "--observation",
                  afterWheelSync.observation_id,
                )
              ).exitCode,
            ).toBe(0);
            expect((await runCli("cooperate", "status", ...scope)).body).toMatchObject({
              ready: true,
              state: { mode: "ready" },
            });
            expect((await runCli("ledger", "status", ...scope)).body.frozen).toBe(false);
            expect(await readProbeCounts()).toEqual({ creates: 1, attaches: 1 });

            const cachedRestrictedSync = await mcp.run("bsk_session", { action: "sync", session });
            await forceRecalibrate();
            expect(
              (
                await runCli(
                  "click",
                  "#apply",
                  ...scope,
                  "--context",
                  cachedRestrictedSync.context_id,
                )
              ).exitCode,
            ).toBe(0);
            expect(await readProbeCounts()).toEqual({ creates: 1, attaches: 1 });
          } finally {
            if (session) await runCli("session", "stop", session).catch(() => {});
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
