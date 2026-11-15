// @vitest-environment node
// Run with BSK_TEST_CHROME=/path/to/chrome after `pnpm ext:build`.
import { execFile, spawn } from "node:child_process";
import { type EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const runExecFile = promisify(execFile);
const defaultCli = path.resolve(
  "../../target/debug",
  process.platform === "win32" ? "bsk.exe" : "bsk",
);

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

async function attachBackgroundByName(send: Send, expectedName: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { targetInfos } = await send<{
      targetInfos: { type: string; url: string; targetId: string }[];
    }>("Target.getTargets");
    for (const target of targetInfos) {
      if (target.type !== "service_worker" || !target.url.startsWith("chrome-extension://")) {
        continue;
      }
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      const reply = await send<{ result: { value?: string } }>(
        "Runtime.evaluate",
        { expression: "chrome.runtime.getManifest().name", returnByValue: true },
        sessionId,
      );
      if (reply.result.value === expectedName) {
        return {
          targetId: target.targetId,
          sessionId,
          origin: target.url.split("/").slice(0, 3).join("/"),
        };
      }
      await send("Target.detachFromTarget", { sessionId });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Extension Service Worker did not load: ${expectedName}`);
}

describe.skipIf(!process.env.BSK_TEST_CHROME)(
  "Wave 5A MV3 runtime injection & orphan window reaping",
  () => {
    it("enforces zero static manifest content_scripts, on-demand Tier A/B activation, overlay/marker isolation, and SW-restart orphan window cleanup", async () => {
      const distDir = path.resolve("dist/chrome-mv3");
      const shippedManifest = JSON.parse(
        await readFile(path.join(distDir, "manifest.json"), "utf8"),
      ) as { content_scripts?: unknown };
      expect(shippedManifest.content_scripts).toBeUndefined();

      const directory = await mkdtemp(path.join(tmpdir(), "bsk-wave5a-runtime-"));
      const executable = path.resolve(process.env.BSK_TEST_CLI ?? defaultCli);
      const fixtureHome = path.join(directory, "user");
      const env: NodeJS.ProcessEnv = {
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
        delete env[key];
      }

      const daemon = spawn(executable, ["daemon", "start", "--foreground", "--port", "0"], {
        env,
        stdio: "ignore",
      });

      const pageServer = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (req.url === "/child") {
          res.end(
            '<!doctype html><title>Child Frame</title><label>Child input<input id="child-field" value="child-ok"></label>',
          );
          return;
        }
        if (req.url === "/prerender-start") {
          res.end(
            '<!doctype html><title>Prerender Host</title><a href="/prerendered">Activate</a><script type="speculationrules">{"prerender":[{"source":"list","urls":["/prerendered"]}]}</script>',
          );
          return;
        }
        if (req.url === "/prerendered") {
          res.end(
            '<!doctype html><title>Prerendered Target</title><button id="prerendered-btn" type="button">Prerender Ready</button>',
          );
          return;
        }
        if (req.url === "/record-page") {
          res.end(`<!doctype html><title>Record Target</title>
          <input id="secret" aria-label="Secret" value="top-secret">
          <button id="real-btn" type="button">Real Page Action</button>`);
          return;
        }
        res.end(`<!doctype html><head><script>window.__bskMessages=[];window.addEventListener("message",function(e){window.__bskMessages.push(e.data);});</script></head><body><title>User Page ${req.url}</title>
        <input id="city" aria-label="City" value="Shanghai">
        <iframe id="static-child" src="/child"></iframe></body>`);
      });
      pageServer.listen(0, "127.0.0.1");
      await once(pageServer as unknown as EventEmitter, "listening");
      const port = (pageServer.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      const cli = async (...args: string[]) => {
        const result = await runExecFile(executable, ["--json", ...args], {
          env,
          timeout: 45_000,
        }).catch((error) => {
          error.message += `\n${error.stdout}\n${error.stderr}`;
          throw error;
        });
        return JSON.parse(result.stdout);
      };

      try {
        let wsPort = 0;
        await expect
          .poll(
            async () => {
              try {
                wsPort = JSON.parse(
                  await readFile(path.join(env.BSK_HOME!, "daemon.json"), "utf8"),
                ).ws_port;
                return wsPort;
              } catch {
                return 0;
              }
            },
            { timeout: 15_000 },
          )
          .toBeGreaterThan(0);

        const { copyPairingExtension, pairLocalBrowser } = await import(
          new URL("../../../../../evals/browser/local-pairing.mjs", import.meta.url).href
        );
        const extension = await copyPairingExtension(
          distDir,
          path.join(directory, "extension"),
          wsPort,
        );
        const manifestPath = path.join(extension, "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        manifest.name = "BrowserSkill Wave5A integration";
        expect(manifest.content_scripts).toBeUndefined();
        await writeFile(manifestPath, JSON.stringify(manifest));

        const { withChrome } = await import(
          new URL(
            "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );

        const chromePath = process.env.BSK_TEST_CHROME ?? "";
        const useCdpExtensionLoad =
          process.env.BSK_TEST_LOAD_CDP === "1" ||
          (chromePath.includes("Google Chrome") && !chromePath.includes("Chrome for Testing"));

        const attachedTabPages: { parent: string; session: string; prerender: boolean }[] = [];
        await withChrome(
          {
            executable: process.env.BSK_TEST_CHROME,
            extensionPath: extension,
            extensionViaCdp: useCdpExtensionLoad,
            deviceScale: 1,
            zoom: 1,
            extraArgs: ["--force-effective-connection-type=4G"],
            onEvent: (event: {
              method: string;
              sessionId?: string;
              params?: { sessionId: string; targetInfo: { type: string; subtype?: string } };
            }) => {
              if (
                event.method === "Target.attachedToTarget" &&
                event.sessionId &&
                event.params?.targetInfo.type === "page"
              ) {
                attachedTabPages.push({
                  parent: event.sessionId,
                  session: event.params.sessionId,
                  prerender: event.params.targetInfo.subtype === "prerender",
                });
              }
            },
          },
          async (send: Send) => {
            let worker = await attachBackgroundByName(send, manifest.name);
            const swEval = async <T>(expression: string): Promise<T> => {
              const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
                "Runtime.evaluate",
                { expression, returnByValue: true, awaitPromise: true },
                worker.sessionId,
              );
              if (reply.exceptionDetails) {
                throw new Error(JSON.stringify(reply.exceptionDetails));
              }
              return reply.result.value;
            };

            const tabEval = async <T>(tabId: number, funcBody: string): Promise<T> => {
              return swEval<T>(`(async () => {
              const [res] = await chrome.scripting.executeScript({
                target: { tabId: ${tabId} },
                func: () => { ${funcBody} },
              });
              return res?.result;
            })()`);
            };

            await pairLocalBrowser(send, { executable, env, worker });
            await expect
              .poll(async () => (await cli("browsers")).length, { timeout: 15_000 })
              .toBe(1);

            // =========================================================================
            // Counterexample A: Zero-session zero-tax + bystander isolation + borrow
            // =========================================================================
            await expect
              .poll(() => swEval<unknown[]>("chrome.scripting.getRegisteredContentScripts()"))
              .toEqual([]);

            const userWindowId = await swEval<number>(
              "(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0].id)()",
            );
            const bystanderTabId = await swEval<number>(`(async () => {
            const tab = await chrome.tabs.create({ windowId: ${userWindowId}, url: ${JSON.stringify(`${baseUrl}/bystander`)}, active: false });
            return tab.id;
          })()`);
            const userTabId = await swEval<number>(`(async () => {
            const tab = await chrome.tabs.create({ windowId: ${userWindowId}, url: ${JSON.stringify(`${baseUrl}/borrow-candidate`)}, active: true });
            await chrome.windows.update(${userWindowId}, { focused: true });
            return tab.id;
          })()`);

            await expect
              .poll(() =>
                swEval<boolean>(
                  `(async () => (await chrome.tabs.get(${userTabId})).status === 'complete' && (await chrome.tabs.get(${bystanderTabId})).status === 'complete')()`,
                ),
              )
              .toBe(true);

            // Both ordinary tabs have 0 Overlay DOM and 0 cooperation receivers when idle.
            for (const id of [userTabId, bystanderTabId]) {
              expect(
                await tabEval<boolean>(
                  id,
                  "return document.querySelector('browser-skill-overlay') !== null;",
                ),
              ).toBe(false);
              expect(
                await swEval<string>(
                  `chrome.tabs.sendMessage(${id}, { kind: 'cooperation.read', lease: 'probe' }).then(() => 'ok', (e) => String(e?.message ?? e))`,
                ),
              ).toContain("Receiving end does not exist");
            }

            // Require explicit in-page borrow confirmation before borrowing `userTabId`.
            await swEval(
              "chrome.storage.local.set({ bsk_interaction_preferences: { confirmTabBorrow: true, requestHelpEnabled: true } })",
            );

            const sessionStart = (await cli("session", "start")) as { session_id: string };
            const sessionId = sessionStart.session_id;

            // Tier B cooperation is dynamically registered with persistAcrossSessions: false.
            await expect
              .poll(() =>
                swEval<chrome.scripting.RegisteredContentScript[]>(
                  "chrome.scripting.getRegisteredContentScripts()",
                ),
              )
              .toEqual([
                expect.objectContaining({
                  id: "bsk-tier-b-cooperation",
                  js: ["content-scripts/cooperation.js"],
                  allFrames: true,
                  matchOriginAsFallback: true,
                  runAt: "document_start",
                  persistAcrossSessions: false,
                }),
              ]);

            // Even after session start, opening another normal user tab loads 0 bytes of Tier A React UI.
            const postSessionBystanderTabId = await swEval<number>(`(async () => {
            const tab = await chrome.tabs.create({ windowId: ${userWindowId}, url: ${JSON.stringify(`${baseUrl}/bystander-2`)}, active: false });
            return tab.id;
          })()`);
            await expect
              .poll(() =>
                swEval<boolean>(
                  `(async () => (await chrome.tabs.get(${postSessionBystanderTabId})).status === 'complete')()`,
                ),
              )
              .toBe(true);
            expect(
              await tabEval<{ hasOverlay: boolean; messages: unknown[] }>(
                postSessionBystanderTabId,
                "return { hasOverlay: document.querySelector('browser-skill-overlay') !== null, messages: window.__bskMessages ?? [] };",
              ),
            ).toEqual({ hasOverlay: false, messages: [] });

            // Re-focus userWindowId + userTabId and trigger `tab borrow`, which must inject Tier A on demand
            // into the candidate user tab BEFORE it becomes controlled so the Allow modal renders.
            await swEval(
              `chrome.tabs.update(${userTabId}, { active: true }).then(() => chrome.windows.update(${userWindowId}, { focused: true }))`,
            );
            const borrowPromise = cli("tab", "borrow", "--session", sessionId, String(userTabId));

            await expect
              .poll(
                () =>
                  tabEval<boolean>(
                    userTabId,
                    `const host = document.querySelector('browser-skill-overlay');
                   const btn = host?.shadowRoot?.querySelector('[data-slot="borrow-confirmation-allow-button"]');
                   if (!btn) return false;
                   btn.click();
                   return true;`,
                  ),
                { timeout: 10_000 },
              )
              .toBe(true);

            const borrowed = await borrowPromise;
            expect(borrowed.tab_id).toBe(userTabId);

            // Borrowed tab now has both Tier A and Tier B (main + static child iframe), while bystanders remain at 0 Tier A!
            const synced = await cli("cooperate", "sync", "--session", sessionId);
            expect(synced.observation_id).toEqual(expect.any(String));
            for (const bystander of [bystanderTabId, postSessionBystanderTabId]) {
              expect(
                await tabEval<boolean>(
                  bystander,
                  "return document.querySelector('browser-skill-overlay') !== null;",
                ),
              ).toBe(false);
            }

            // =========================================================================
            // Counterexample B: Repeated injection idempotency, dynamic about:blank/srcdoc
            //                   50ms coalesced arming, and Speculation Rules prerender
            // =========================================================================
            await tabEval(
              userTabId,
              "document.querySelector('browser-skill-overlay').dataset.bskIdentity = 'singleton-host';",
            );
            for (let i = 0; i < 3; i++) {
              await swEval(
                `chrome.scripting.executeScript({ target: { tabId: ${userTabId} }, files: ['content-scripts/content.js'] })`,
              );
            }
            expect(
              await tabEval<{ count: number; identity: string | undefined }>(
                userTabId,
                `const hosts = document.querySelectorAll('browser-skill-overlay');
               return { count: hosts.length, identity: hosts[0]?.dataset.bskIdentity };`,
              ),
            ).toEqual({ count: 1, identity: "singleton-host" });

            // Dynamically insert BOTH a same-origin empty `about:blank` iframe AND an `<iframe srcdoc>`
            // in one synchronous DOM turn, and verify the 50ms `COOPERATION_SUBFRAME_READY` debounce
            // injects & arms both subframes BEFORE any explicit `cooperate sync` call!
            await tabEval(
              userTabId,
              `const blankFrame = document.createElement('iframe');
             blankFrame.id = 'dynamic-blank-frame';
             document.body.appendChild(blankFrame);
             blankFrame.contentDocument.body.innerHTML = '<input id="blank-input" aria-label="Blank note" value="ready">';
             const srcdocFrame = document.createElement('iframe');
             srcdocFrame.id = 'dynamic-srcdoc-frame';
             srcdocFrame.srcdoc = '<!doctype html><input id="srcdoc-input" aria-label="Srcdoc note" value="srcdoc-ok">';
             document.body.appendChild(srcdocFrame);`,
            );
            await expect
              .poll(
                async () => {
                  const frames = await swEval<
                    Array<{ frameId: number; documentId: string; errorOccurred?: boolean }>
                  >(`chrome.webNavigation.getAllFrames({ tabId: ${userTabId} })`);
                  const childFrames = frames.filter((f) => f.frameId !== 0 && !f.errorOccurred);
                  if (childFrames.length < 3) return 0;
                  let reachable = 0;
                  for (const frame of childFrames) {
                    const ok = await swEval<boolean>(
                      `chrome.tabs.sendMessage(${userTabId}, { kind: 'cooperation.owners' }, { documentId: ${JSON.stringify(frame.documentId)} }).then((res) => Array.isArray(res), () => false)`,
                    );
                    if (ok) reachable += 1;
                  }
                  return reachable;
                },
                { timeout: 5_000 },
              )
              .toBeGreaterThanOrEqual(3);
            for (let i = 0; i < 3; i++) {
              await swEval(
                `chrome.scripting.executeScript({ target: { tabId: ${userTabId}, allFrames: true }, files: ['content-scripts/cooperation.js'] })`,
              );
            }
            const syncedAfterBlank = await cli("cooperate", "sync", "--session", sessionId);
            expect(syncedAfterBlank.observation_id).toEqual(expect.any(String));

            // Speculation Rules prerender: controlled tab receives Tier A on `outermost_frame` (frameId > 0)
            // and retains its live `<browser-skill-overlay>` across prerender activation!
            const prerenderCreated = (await cli(
              "tab",
              "create",
              "--session",
              sessionId,
              "--url",
              "about:blank#wave5a-prerender",
            )) as { tab_id: number };
            const prerenderTabId = prerenderCreated.tab_id;
            const tabTargets = await send<{ targetInfos: { targetId: string; url: string }[] }>(
              "Target.getTargets",
              { filter: [{ type: "tab", exclude: false }] },
            );
            const prerenderTabTarget = tabTargets.targetInfos.find((t) =>
              t.url.endsWith("#wave5a-prerender"),
            )!;
            const prerenderTabSession = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: prerenderTabTarget.targetId,
              flatten: true,
            });
            try {
              await send(
                "Target.setAutoAttach",
                { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
                prerenderTabSession.sessionId,
              );
              await expect
                .poll(() =>
                  attachedTabPages.find((p) => p.parent === prerenderTabSession.sessionId),
                )
                .toBeDefined();
              const activePrerenderPage = attachedTabPages.find(
                (p) => p.parent === prerenderTabSession.sessionId,
              )!;
              await send(
                "Page.setPrerenderingAllowed",
                { isAllowed: true },
                activePrerenderPage.session,
              );
              await swEval(
                `chrome.tabs.update(${prerenderTabId}, { url: ${JSON.stringify(`${baseUrl}/prerender-start`)} })`,
              );
              await expect
                .poll(
                  () =>
                    swEval<{ frameId: number; frameType: string } | undefined>(
                      `chrome.webNavigation.getAllFrames({ tabId: ${prerenderTabId} }).then((frames) => frames.find((f) => f.documentLifecycle === 'prerender' && f.url.endsWith('/prerendered')))`,
                    ),
                  { timeout: 15_000 },
                )
                .toMatchObject({ frameType: "outermost_frame" });
              await tabEval(prerenderTabId, "document.querySelector('a').click();");
              await expect
                .poll(
                  () =>
                    tabEval<{ activationStart: number; hasOverlay: boolean }>(
                      prerenderTabId,
                      `return {
                        activationStart: performance.getEntriesByType('navigation')[0]?.activationStart ?? 0,
                        hasOverlay: document.querySelector('browser-skill-overlay') !== null,
                      };`,
                    ),
                  { timeout: 10_000 },
                )
                .toMatchObject({
                  activationStart: expect.any(Number),
                  hasOverlay: true,
                });
              expect(
                await tabEval<number>(
                  prerenderTabId,
                  "return performance.getEntriesByType('navigation')[0]?.activationStart ?? 0;",
                ),
              ).toBeGreaterThan(0);
            } finally {
              await send("Target.detachFromTarget", {
                sessionId: prerenderTabSession.sessionId,
              }).catch(() => {});
            }

            // Repeated `content-scripts/cooperation.js` execution across all frames of `userTabId`
            // must be strictly idempotent, preserving every live frame's `document` UUID.
            const readCooperationDocs = (lease: string) =>
              swEval<Record<string, string>>(`(async () => {
                const frames = await chrome.webNavigation.getAllFrames({ tabId: ${userTabId} });
                const out = {};
                for (const frame of frames) {
                  if (frame.errorOccurred) continue;
                  const state = await chrome.tabs.sendMessage(
                    ${userTabId},
                    { kind: 'cooperation.read', lease: ${JSON.stringify(lease)} },
                    { documentId: frame.documentId },
                  );
                  out[String(frame.frameId)] = state?.document ?? 'missing';
                }
                return out;
              })()`);
            const docsBeforeReinject = await readCooperationDocs("wave5a-idempotent-lease");
            expect(Object.keys(docsBeforeReinject).length).toBeGreaterThanOrEqual(4);
            expect(Object.values(docsBeforeReinject)).not.toContain("missing");
            for (let i = 0; i < 3; i++) {
              await swEval(
                `chrome.scripting.executeScript({ target: { tabId: ${userTabId}, allFrames: true }, files: ['content-scripts/cooperation.js'] })`,
              );
            }
            const docsAfterReinject = await readCooperationDocs("wave5a-idempotent-lease");
            expect(docsAfterReinject).toEqual(docsBeforeReinject);

            // Stop session -> dynamic registrations drop back to 0!
            await cli("session", "stop", sessionId);
            await expect
              .poll(() => swEval<unknown[]>("chrome.scripting.getRegisteredContentScripts()"))
              .toEqual([]);

            // =========================================================================
            // Counterexample C: Recording + Cooperation zero self-pollution & overlay filter
            // =========================================================================
            const traceDir = path.join(directory, "trace-out");
            const recordProc = spawn(
              executable,
              [
                "--json",
                "record",
                "start",
                "--url",
                `${baseUrl}/record-page`,
                "--output",
                traceDir,
              ],
              { env, stdio: ["ignore", "pipe", "pipe"] },
            );
            let recordStdout = "";
            let recordStderr = "";
            recordProc.stdout.on("data", (chunk) => {
              recordStdout += String(chunk);
            });
            recordProc.stderr.on("data", (chunk) => {
              recordStderr += String(chunk);
            });

            let recordTabId = 0;
            await expect
              .poll(
                async () => {
                  const scripts = await swEval<{ id: string; persistAcrossSessions?: boolean }[]>(
                    "chrome.scripting.getRegisteredContentScripts()",
                  );
                  if (
                    !scripts.some(
                      (s) => s.id === "bsk-tier-b-cooperation" && s.persistAcrossSessions === false,
                    ) ||
                    !scripts.some(
                      (s) =>
                        s.id === "bsk-tier-b-record-frame" && s.persistAcrossSessions === false,
                    )
                  ) {
                    return 0;
                  }
                  const found = await swEval<number>(`(async () => {
                  const tabs = await chrome.tabs.query({});
                  const match = tabs.find((t) => t.url?.endsWith('/record-page') && t.status === 'complete');
                  return match?.id ?? 0;
                })()`);
                  if (!found) return 0;
                  const ready = await tabEval<boolean>(
                    found,
                    `const host = document.querySelector('browser-skill-overlay');
                   return document.documentElement.hasAttribute('data-bsk-record-document') &&
                     Boolean(host?.shadowRoot?.querySelector('[data-slot="record-overlay-finish"]'));`,
                  );
                  if (ready) recordTabId = found;
                  return ready ? found : 0;
                },
                { timeout: 15_000 },
              )
              .toBeGreaterThan(0);

            // Verify `data-bsk-*` attribute writes, overlay host mutations, and repeated `cooperation.arm_frame`
            // keep cooperation `document` and `structure` unchanged on `recordTabId` (using a non-matching
            // `cooperation.disable` probe so the recording session's active cooperation lease stays intact).
            const baselineFrame = await swEval<{ document: string; structure: number }>(
              `chrome.tabs.sendMessage(${recordTabId}, { kind: 'cooperation.disable', lease: 'readonly-probe-before' }, { frameId: 0 })`,
            );
            await tabEval(
              recordTabId,
              `document.querySelector('#secret').setAttribute('data-bsk-record-password', '');
             document.querySelector('browser-skill-overlay').setAttribute('data-bsk-test-attr', '1');`,
            );
            for (let i = 0; i < 3; i++) {
              await swEval(
                `chrome.tabs.sendMessage(${recordTabId}, { kind: 'cooperation.arm_frame' }, { frameId: 0 })`,
              );
            }
            const afterInternalMarkers = await swEval<{ document: string; structure: number }>(
              `chrome.tabs.sendMessage(${recordTabId}, { kind: 'cooperation.disable', lease: 'readonly-probe-after' }, { frameId: 0 })`,
            );
            expect(afterInternalMarkers.document).toBe(baselineFrame.document);
            expect(afterInternalMarkers.structure).toBe(baselineFrame.structure);

            // Dynamically insert:
            //   1. a synchronous empty same-origin `about:blank` child `<iframe>` (`#dynamic-record-blank`),
            //   2. a nested grandchild empty `about:blank` `<iframe>` (`#grandchild-record-blank`) inside it, and
            //   3. a closed-ShadowRoot host (`#shadow-iframe-host`) containing an empty `about:blank` `<iframe>`
            // while recording is active on `recordTabId`: BOTH `record-frame.js` AND `cooperation.js` must arm
            // across all 4 frames so `cooperation.read` never fails on `undefined` replies and all clicks record!
            await tabEval(
              recordTabId,
              `const blankFrame = document.createElement('iframe');
             blankFrame.id = 'dynamic-record-blank';
             document.body.appendChild(blankFrame);
             blankFrame.contentDocument.body.innerHTML = '<button id="blank-record-btn" type="button">Blank Subframe Action</button>';
             const grandchildFrame = blankFrame.contentDocument.createElement('iframe');
             grandchildFrame.id = 'grandchild-record-blank';
             blankFrame.contentDocument.body.appendChild(grandchildFrame);
             grandchildFrame.contentDocument.body.innerHTML = '<button id="grandchild-record-btn" type="button">Grandchild Blank Action</button>';
             const shadowHost = document.createElement('div');
             shadowHost.id = 'shadow-iframe-host';
             const closedShadow = shadowHost.attachShadow({ mode: 'closed' });
             const shadowBlankFrame = document.createElement('iframe');
             shadowBlankFrame.id = 'shadow-record-blank';
             closedShadow.appendChild(shadowBlankFrame);
             document.body.appendChild(shadowHost);
             shadowBlankFrame.contentDocument.body.innerHTML = '<button id="shadow-record-btn" type="button">Shadow Blank Action</button>';
             window.__wave5aClosedShadowFrame = shadowBlankFrame;`,
            );

            await expect
              .poll(
                async () => {
                  const armedInAllSubframes = await tabEval<boolean>(
                    recordTabId,
                    `const childDoc = document.querySelector('#dynamic-record-blank')?.contentDocument;
                   const grandDoc = childDoc?.querySelector('#grandchild-record-blank')?.contentDocument;
                   const shadowDoc = window.__wave5aClosedShadowFrame?.contentDocument;
                   return Boolean(
                     childDoc?.documentElement?.hasAttribute('data-bsk-record-document') &&
                       grandDoc?.documentElement?.hasAttribute('data-bsk-record-document') &&
                       shadowDoc?.documentElement?.hasAttribute('data-bsk-record-document'),
                   );`,
                  );
                  if (!armedInAllSubframes) return false;
                  return swEval<boolean>(`(async () => {
                    const frames = await chrome.webNavigation.getAllFrames({ tabId: ${recordTabId} });
                    if (!frames || frames.length < 4) return false;
                    for (const frame of frames) {
                      if (frame.errorOccurred) continue;
                      const ack = await chrome.tabs.sendMessage(
                        ${recordTabId},
                        { kind: 'cooperation.arm_frame' },
                        { documentId: frame.documentId },
                      );
                      if (!ack || ack.ok !== true) return false;
                    }
                    return true;
                  })()`);
                },
                { timeout: 5_000 },
              )
              .toBe(true);

            const recordFramesRead = await swEval<
              Array<{ frameId: number; hasDocument: boolean; wasUndefined: boolean }>
            >(`(async () => {
              const frames = await chrome.webNavigation.getAllFrames({ tabId: ${recordTabId} });
              const results = [];
              for (const frame of frames) {
                if (frame.errorOccurred) continue;
                const state = await chrome.tabs.sendMessage(
                  ${recordTabId},
                  { kind: 'cooperation.read', lease: 'check-record-blank-subframe' },
                  { documentId: frame.documentId },
                );
                results.push({
                  frameId: frame.frameId,
                  hasDocument: typeof state?.document === 'string',
                  wasUndefined: state === undefined,
                });
              }
              return results;
            })()`);
            expect(recordFramesRead.length).toBeGreaterThanOrEqual(4);
            expect(recordFramesRead.every((r) => r.hasDocument && !r.wasUndefined)).toBe(true);

            // Click inside the child, grandchild, and closed-ShadowRoot `about:blank` iframes (spacing
            // clicks across post-action observation settles), then click the main-page button and the
            // RecordOverlay Finish button inside `<browser-skill-overlay>`'s ShadowRoot.
            await tabEval(
              recordTabId,
              `document.querySelector('#dynamic-record-blank').contentDocument.querySelector('#blank-record-btn').click();`,
            );
            await new Promise((resolve) => setTimeout(resolve, 250));
            await tabEval(
              recordTabId,
              `document.querySelector('#dynamic-record-blank').contentDocument.querySelector('#grandchild-record-blank').contentDocument.querySelector('#grandchild-record-btn').click();`,
            );
            await new Promise((resolve) => setTimeout(resolve, 250));
            await tabEval(
              recordTabId,
              `window.__wave5aClosedShadowFrame.contentDocument.querySelector('#shadow-record-btn').click();`,
            );
            await new Promise((resolve) => setTimeout(resolve, 250));
            await tabEval(
              recordTabId,
              `document.querySelector('#real-btn').click();
             document.querySelector('browser-skill-overlay').shadowRoot.querySelector('[data-slot="record-overlay-finish"]').click();`,
            );

            const [recordExitCode] = (await once(
              recordProc as unknown as EventEmitter,
              "close",
            )) as [number];
            if (recordExitCode !== 0) {
              throw new Error(
                `record start failed (${recordExitCode}): ${recordStderr}\n${recordStdout}`,
              );
            }

            const traceJson = JSON.parse(
              await readFile(path.join(traceDir, "trace.json"), "utf8"),
            ) as { steps: Array<{ op: string; target?: { name?: string } }> };
            const clickNames = traceJson.steps
              .filter((step) => step.op === "click")
              .map((step) => step.target?.name);
            expect(clickNames).toEqual([
              "Blank Subframe Action",
              "Grandchild Blank Action",
              "Shadow Blank Action",
              "Real Page Action",
            ]);

            // After recording finishes and 0 sessions remain, dynamic registrations are cleared again!
            await expect
              .poll(() => swEval<unknown[]>("chrome.scripting.getRegisteredContentScripts()"))
              .toEqual([]);

            // =========================================================================
            // Task 2: Orphan Agent Window reaping across real MV3 SW stop/restart (Full CLI E2E)
            // =========================================================================
            const pureSession = (await cli("session", "start")) as { session_id: string };
            const mixedSession = (await cli("session", "start")) as { session_id: string };
            const pureTabs = (await cli(
              "tab",
              "list",
              "--scope",
              "agent",
              "--session",
              pureSession.session_id,
            )) as {
              tabs: Array<{ tab_id: number }>;
            };
            const mixedTabs = (await cli(
              "tab",
              "list",
              "--scope",
              "agent",
              "--session",
              mixedSession.session_id,
            )) as {
              tabs: Array<{ tab_id: number }>;
            };
            const orphanSetup = await swEval<{
              pureOrphanWinId: number;
              mixedUserWinId: number;
              ledgerKeys: string[];
            }>(`(async () => {
            const pureWinId = (await chrome.tabs.get(${pureTabs.tabs[0]!.tab_id})).windowId;
            const mixedWinId = (await chrome.tabs.get(${mixedTabs.tabs[0]!.tab_id})).windowId;
            await chrome.tabs.create({ windowId: mixedWinId, url: ${JSON.stringify(`${baseUrl}/user-keep`)}, active: false });
            const stored = await chrome.storage.session.get('bsk.orphan_agent_windows');
            return {
              pureOrphanWinId: pureWinId,
              mixedUserWinId: mixedWinId,
              ledgerKeys: Object.keys(stored['bsk.orphan_agent_windows'] ?? {}),
            };
          })()`);
            expect(orphanSetup.ledgerKeys).toEqual(
              expect.arrayContaining([
                String(orphanSetup.pureOrphanWinId),
                String(orphanSetup.mixedUserWinId),
              ]),
            );

            // Stop the MV3 Service Worker V8 isolate mid-session (dropping the daemon WS so
            // daemon purges both sessions while both dedicated Agent Windows remain open),
            // then wake a fresh SW V8 isolate and verify orphan window + Tier B cleanup!
            await swEval("globalThis.__swBootToken = 'before-stop'");
            await send("Target.detachFromTarget", { sessionId: worker.sessionId });

            const wakeTarget = await send<{ targetId: string }>("Target.createTarget", {
              url: `${worker.origin}/manifest.json`,
              background: true,
            });
            try {
              const { sessionId: extPageSessionId } = await send<{ sessionId: string }>(
                "Target.attachToTarget",
                { targetId: wakeTarget.targetId, flatten: true },
              );
              await send("ServiceWorker.enable", {}, extPageSessionId);
              await send("ServiceWorker.stopAllWorkers", {}, extPageSessionId);
              await new Promise((resolve) => setTimeout(resolve, 150));

              // Wake a fresh Service Worker isolate from the extension page while preserving `chrome.storage.session`.
              await send(
                "Runtime.evaluate",
                {
                  expression:
                    "chrome.runtime.sendMessage({ kind: 'overlay.who_am_i' }).catch(() => null)",
                  awaitPromise: true,
                },
                extPageSessionId,
              );
              worker = await attachBackgroundByName(send, manifest.name);
              expect(await swEval<unknown>("globalThis.__swBootToken")).toBeUndefined();

              await expect
                .poll(
                  () =>
                    swEval<boolean>(
                      `chrome.windows.get(${orphanSetup.pureOrphanWinId}).then(() => false, () => true)`,
                    ),
                  { timeout: 10_000 },
                )
                .toBe(true);

              const mixedStillOpen = await swEval<boolean>(
                `chrome.windows.get(${orphanSetup.mixedUserWinId}).then(() => true, () => false)`,
              );
              expect(mixedStillOpen).toBe(true);

              // Restarted SW with 0 active sessions also clears Tier B dynamic registrations!
              await expect
                .poll(() => swEval<unknown[]>("chrome.scripting.getRegisteredContentScripts()"))
                .toEqual([]);
            } finally {
              await send("Target.closeTarget", { targetId: wakeTarget.targetId }).catch(() => {});
            }
          },
        );
      } finally {
        daemon.kill("SIGTERM");
        pageServer.close();
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    }, 90_000);
  },
);
