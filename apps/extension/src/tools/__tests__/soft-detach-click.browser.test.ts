// @vitest-environment node
// Opt in with BSK_TEST_CHROME; exercises full end-to-end idle CDP soft-detach
// and transparent reattach against real Chrome (cross-origin OOPIFs, CooperationController, dialogs, waits).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggee, type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { CooperationController } from "@/cooperation/controller";
import { pointerTargetValidator } from "@/cooperation/pointer-target";
import type { CooperationFrames, FrameState } from "@/cooperation/types";
import { DebugManager } from "@/debug/manager";
import { SessionManager } from "@/session-manager/manager";
import { handleConsole } from "../console";
import { handleClick, handleFill, handleFocus } from "../interaction";
import { handleNetwork } from "../network";
import { handleObserve, handleScreenshot, handleSnapshot } from "../observation";
import { handleScrollTo } from "../scroll";
import { sessionCdpRunner } from "../shared";
import { handleUpload } from "../upload";
import { handleWaitForElement, handleWaitForNavigation } from "../waits";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

interface CdpEvent {
  sessionId?: string;
  method: string;
  params?: object;
}

type CdpEventListener = (source: CdpDebuggee, method: string, params: unknown) => void;

const stubInputClock = (cdp: ChromiumCdp) => {
  vi.spyOn(cdp, "prepareInputTimestamp").mockImplementation(async () => ({
    timestamp: Date.now(),
    nativeTimestamp: Date.now() / 1000,
    assertValid: () => {},
  }));
};

describe.skipIf(!process.env.BSK_TEST_CHROME)(
  "real browser idle CDP soft-detach end-to-end lifecycle",
  () => {
    it("preserves cross-origin OOPIF @eN actions across chained soft-detaches (direct & CooperationController) and invalidates navigated OOPIFs", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "bsk-soft-detach-"));
      const stagedFile = join(tempDir, "receipt.txt");
      writeFileSync(stagedFile, "hello-oopif-upload");

      let finishSlowLoad: (() => void) | undefined;
      const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (req.url === "/child") {
          res.end(`<!doctype html>
              <style>html,body{margin:0;padding:8px;font:14px sans-serif}</style>
              <input id="oopif-input" aria-label="OOPIF Field" value="">
              <button id="oopif-btn" type="button">Confirm Payment</button>
              <input id="oopif-file" type="file" style="display:none">
              <button id="oopif-upload" type="button">Choose Receipt</button>
              <script>
                window.clicks = 0;
                document.getElementById('oopif-btn').addEventListener('click', () => { window.clicks += 1; });
                document.getElementById('oopif-upload').addEventListener('click', () => {
                  document.getElementById('oopif-file').click();
                });
              </script>`);
          return;
        }
        if (req.url === "/child-next") {
          res.end(`<!doctype html><main>Submitted</main>`);
          return;
        }
        if (req.url === "/slow-load") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.write("<!doctype html><body>Loading");
          finishSlowLoad = () => {
            res.end("...done</body>");
          };
          return;
        }
        const port = (server.address() as { port: number }).port;
        res.end(`<!doctype html>
            <style>body{margin:0;padding:12px} iframe{width:460px;height:220px;border:1px solid #ccc;display:block}</style>
            <button id="host-btn" type="button">Host Action</button>
            <script>
              window.hostClicks = 0;
              document.getElementById('host-btn').addEventListener('click', () => { window.hostClicks += 1; });
            </script>
            <iframe id="oopif" src="http://localhost:${port}/child"></iframe>`);
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as { port: number }).port;
      const hostUrl = `http://127.0.0.1:${port}/`;

      try {
        const { withChrome } = await import(
          new URL(
            "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );
        let forwardEvent: ((event: CdpEvent) => void) | undefined;
        await withChrome(
          {
            executable: process.env.BSK_TEST_CHROME,
            deviceScale: 1,
            zoom: 1,
            startupTimeout: 30_000,
            onEvent: (event: CdpEvent) => forwardEvent?.(event),
          },
          async (send: Send) => {
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
              url: hostUrl,
            });
            const { sessionId: monitorSession } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId, flatten: true },
            );
            const evalHost = async <T>(expression: string): Promise<T> => {
              const reply = await send<{ result: { value: T } }>(
                "Runtime.evaluate",
                { expression, returnByValue: true },
                monitorSession,
              );
              return reply.result.value;
            };

            let oopifTargetId = "";
            await expect
              .poll(async () => {
                const { targetInfos } = await send<{
                  targetInfos: { targetId: string; type: string; url: string }[];
                }>("Target.getTargets");
                const found = targetInfos.find(
                  (t) => t.type === "iframe" && t.url === `http://localhost:${port}/child`,
                );
                if (found) oopifTargetId = found.targetId;
                return Boolean(found);
              })
              .toBe(true);
            const { sessionId: monitorOopif } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId: oopifTargetId, flatten: true },
            );
            await expect
              .poll(async () => {
                const r = await send<{ result: { value: string } }>(
                  "Runtime.evaluate",
                  { expression: "document.readyState", returnByValue: true },
                  monitorOopif,
                );
                return r.result.value;
              })
              .toBe("complete");

            let activeRootSession = "";
            const childSessions = new Set<string>();
            const eventListeners = new Set<CdpEventListener>();
            forwardEvent = (event) => {
              if (!activeRootSession) return;
              if (
                event.method === "Target.attachedToTarget" &&
                event.sessionId === activeRootSession
              ) {
                const sid = (event.params as { sessionId?: string } | undefined)?.sessionId;
                if (sid) childSessions.add(sid);
              }
              if (event.sessionId === activeRootSession) {
                for (const fn of [...eventListeners]) fn({ tabId: 4 }, event.method, event.params);
              } else if (event.sessionId && childSessions.has(event.sessionId)) {
                for (const fn of [...eventListeners])
                  fn({ tabId: 4, sessionId: event.sessionId }, event.method, event.params);
              }
            };

            const api: CdpDebuggerApi = {
              attach: async () => {
                childSessions.clear();
                const reply = await send<{ sessionId: string }>("Target.attachToTarget", {
                  targetId,
                  flatten: true,
                });
                activeRootSession = reply.sessionId;
              },
              detach: async () => {
                const prev = activeRootSession;
                activeRootSession = "";
                childSessions.clear();
                if (prev) await send("Target.detachFromTarget", { sessionId: prev });
              },
              sendCommand: async (target, method, params) => {
                const sid = target.sessionId ?? activeRootSession;
                if (!sid) throw new Error("debugger detached");
                return send(method, params, sid);
              },
              onEvent: {
                addListener: (fn: CdpEventListener) => eventListeners.add(fn),
                removeListener: (fn: CdpEventListener) => eventListeners.delete(fn),
              } as unknown as CdpDebuggerApi["onEvent"],
              onDetach: {
                addListener() {},
                removeListener() {},
              } as unknown as CdpDebuggerApi["onDetach"],
            };

            const sessions = new SessionManager({
              agentWindow: {
                create: async () => ({ windowId: 100, initialTabIds: [4] }),
                remove: async () => {},
                ensureActiveTab: async () => 4,
              },
            });
            const ctx = await sessions.start("soft-detach-e2e");

            const baseFrame: FrameState = {
              document: "doc-host",
              focusIsDocument: true,
              revision: 1,
              structure: 1,
              human: 0,
              busy: false,
              editing: false,
              lastInput: 0,
              fields: [],
              events: [],
            };
            const controller = new CooperationController({
              sessions,
              readFrames: async (): Promise<CooperationFrames> => ({
                frames: new Map([[0, structuredClone(baseFrame)]]),
                gaps: [],
              }),
              resumeFrames: async () => {},
              changed: () => {},
            });

            const cdp = new ChromiumCdp(api, {
              idleDetachMs: 350,
              canControlDialog: () => true,
              onDocumentChanged: (tabId) => {
                sessions.invalidateTabRefs(tabId);
                controller.invalidate(tabId);
              },
              onChildFramesInvalidated: (tabId, stale) => {
                sessions.invalidateTabChildFrames(tabId, stale);
                controller.invalidateChildFrames(tabId);
              },
              onSoftDetached: (tabId) => controller.markAccessibilityNeedsEnable(tabId),
            });
            stubInputClock(cdp);
            const runner = sessionCdpRunner(cdp, ctx.sessionId, () => sessions.has(ctx.sessionId));
            const tab = async () =>
              ({
                id: 4,
                windowId: 100,
                active: true,
                url: await evalHost<string>("location.href"),
              }) as chrome.tabs.Tab;
            const tabsApi = {
              get: tab,
              query: async () => [await tab()],
              sendMessage: async () => ({ ok: true }),
            };

            const prevChrome = (globalThis as { chrome?: unknown }).chrome;
            (globalThis as { chrome?: unknown }).chrome = { tabs: tabsApi };

            try {
              const signal = new AbortController().signal;
              // 1. Cooperative sync (`target` policy) captures both host and cross-origin OOPIF @eN refs.
              const syncReply = (await controller.command(
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  action: "sync",
                  control_policy: "target",
                },
                runner,
                signal,
              )) as { context_id: string; observation: { text: string } };
              expect(syncReply.context_id).toBeTruthy();

              const findRefByLabel = (needle: string): string => {
                const line = syncReply.observation.text.split("\n").find((l) => l.includes(needle));
                const match = line?.match(/@(e\d+)/);
                if (!match)
                  throw new Error(`missing ref for "${needle}" in:\n${syncReply.observation.text}`);
                return match[1];
              };
              const hostRef = findRefByLabel("Host Action");
              const inputRef = findRefByLabel("OOPIF Field");
              const btnRef = findRefByLabel("Confirm Payment");
              const uploadRef = findRefByLabel("Choose Receipt");
              const btnEntry = ctx.refStore.resolveEntry(btnRef);
              expect(btnEntry?.kind).toBe("dom");
              if (btnEntry?.kind === "dom") {
                expect(btnEntry.handle).toMatchObject({
                  tabId: 4,
                  frameId: expect.any(String),
                  loaderId: expect.any(String),
                  backendNodeId: expect.any(Number),
                });
                expect("cdpSessionId" in btnEntry).toBe(false);
                expect(btnEntry.handle && "cdpSessionId" in btnEntry.handle).toBe(false);
              }

              const waitForSoftDetach = async () => {
                await expect.poll(() => cdp.isAttached(4), { timeout: 2_000 }).toBe(false);
              };

              // Soft-detach #1 -> handleScrollTo + handleScreenshot on OOPIF ref.
              await waitForSoftDetach();
              const scrolled = await handleScrollTo(
                sessions,
                { session_id: ctx.sessionId, tab_id: 4, ref: btnRef },
                { cdp: runner, tabsApi },
              );
              expect(scrolled).not.toHaveProperty("code");

              await waitForSoftDetach();
              const shot = await handleScreenshot(
                sessions,
                { session_id: ctx.sessionId, tab_id: 4, ref: btnRef },
                {
                  cdp: runner,
                  tabsApi,
                  captureApi: { ...tabsApi, captureVisibleTab: async () => "" },
                  sendToTab: async () => ({ ok: true }),
                },
              );
              expect(shot).toMatchObject({ format: "png", tab_id: 4 });

              // Soft-detach #2 -> handleFocus + handleFill + handleWaitForElement on OOPIF refs.
              await waitForSoftDetach();
              const focused = await handleFocus(
                sessions,
                { session_id: ctx.sessionId, tab_id: 4, ref: inputRef },
                { cdp: runner, tabsApi },
              );
              expect(focused).toMatchObject({ focused: true, used_ref: inputRef });

              await waitForSoftDetach();
              const filled = await handleFill(
                sessions,
                { session_id: ctx.sessionId, tab_id: 4, ref: inputRef, value: "42.50" },
                { cdp: runner, tabsApi },
              );
              expect(filled).toMatchObject({ used_ref: inputRef, value_length: 5 });

              await waitForSoftDetach();
              const waitedEl = await handleWaitForElement(
                sessions,
                { session_id: ctx.sessionId, tab_id: 4, ref: btnRef, state: "visible" },
                { cdp: runner, tabsApi },
              );
              expect(waitedEl).toMatchObject({ satisfied: true, visible: true });

              // Soft-detach #3 -> full CooperationController.run + handleClick on OOPIF button ref!
              await waitForSoftDetach();
              const coopClicked = await controller.run(
                {
                  id: "coop-click-oopif",
                  method: "tool.click",
                  params: {
                    session_id: ctx.sessionId,
                    tab_id: 4,
                    context_id: syncReply.context_id,
                    ref: btnRef,
                  },
                },
                runner,
                signal,
                (guarded, opSignal) =>
                  handleClick(
                    sessions,
                    { session_id: ctx.sessionId, tab_id: 4, ref: btnRef },
                    {
                      cdp: guarded,
                      tabsApi,
                      signal: opSignal,
                      bypassOverlay: async () => {},
                    },
                  ),
              );
              expect(coopClicked).toMatchObject({ used_ref: btnRef, tab_id: 4 });
              const clickCount = await send<{ result: { value: number } }>(
                "Runtime.evaluate",
                { expression: "window.clicks", returnByValue: true },
                monitorOopif,
              );
              expect(clickCount.result.value).toBe(1);

              // Soft-detach #4 -> handleUpload on OOPIF file-chooser button ref.
              await waitForSoftDetach();
              const uploaded = await handleUpload(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  ref: uploadRef,
                  files: [{ transfer_id: "tx-1", name: "receipt.txt", staged_path: stagedFile }],
                },
                {
                  cdp: runner,
                  tabsApi,
                  bypassOverlay: async () => {},
                  sendToTab: async () => ({ ok: true }),
                },
              );
              expect(uploaded).toMatchObject({
                tab_id: 4,
                used_ref: uploadRef,
                file_names: ["receipt.txt"],
              });
              const uploadedName = await send<{ result: { value: string } }>(
                "Runtime.evaluate",
                {
                  expression: "document.getElementById('oopif-file').files[0]?.name ?? ''",
                  returnByValue: true,
                },
                monitorOopif,
              );
              expect(uploadedName.result.value).toBe("receipt.txt");

              // Soft-detach #5 -> navigate OOPIF while soft-detached!
              // CooperationController.run on stale OOPIF ref refuses with document_changed + effect_state: none,
              // while main-document @eN action reusing the same target-policy context still succeeds!
              await waitForSoftDetach();
              await evalHost(
                `document.getElementById('oopif').src = 'http://localhost:${port}/child-next'`,
              );
              await expect
                .poll(async () => {
                  const { targetInfos } = await send<{
                    targetInfos: { type: string; url: string }[];
                  }>("Target.getTargets");
                  return targetInfos.some(
                    (t) => t.type === "iframe" && t.url === `http://localhost:${port}/child-next`,
                  );
                })
                .toBe(true);

              const coopStale = await controller.run(
                {
                  id: "coop-click-stale",
                  method: "tool.click",
                  params: {
                    session_id: ctx.sessionId,
                    tab_id: 4,
                    context_id: syncReply.context_id,
                    ref: btnRef,
                  },
                },
                runner,
                signal,
                (guarded, opSignal) =>
                  handleClick(
                    sessions,
                    { session_id: ctx.sessionId, tab_id: 4, ref: btnRef },
                    { cdp: guarded, tabsApi, signal: opSignal, bypassOverlay: async () => {} },
                  ),
              );
              expect(coopStale).toMatchObject({
                code: "permission_denied",
                data: { reason: "document_changed", effect_state: "none" },
              });

              const coopHostClick = await controller.run(
                {
                  id: "coop-click-host",
                  method: "tool.click",
                  params: {
                    session_id: ctx.sessionId,
                    tab_id: 4,
                    context_id: syncReply.context_id,
                    ref: hostRef,
                  },
                },
                runner,
                signal,
                (guarded, opSignal) =>
                  handleClick(
                    sessions,
                    { session_id: ctx.sessionId, tab_id: 4, ref: hostRef },
                    { cdp: guarded, tabsApi, signal: opSignal, bypassOverlay: async () => {} },
                  ),
              );
              expect(coopHostClick).toMatchObject({ used_ref: hostRef, tab_id: 4 });
              expect(await evalHost<number>("window.hostClicks")).toBe(1);

              // Deterministic passive wait_for_navigation: server holds `/slow-load` body open
              // (`readyState === "loading"`) across >idleDetachMs (500ms > 350ms), proving
              // retainTabAttachment prevents soft-detach until finishSlowLoad() completes load!
              await evalHost(`(() => { location.href = 'http://127.0.0.1:${port}/slow-load'; })()`);
              await expect.poll(() => typeof finishSlowLoad).toBe("function");
              await expect.poll(() => evalHost("document.readyState")).toBe("loading");

              const navWait = handleWaitForNavigation(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  wait_until: "load",
                  timeout_ms: 5_000,
                },
                { cdp: runner, tabsApi },
              );
              await new Promise((r) => setTimeout(r, 500));
              expect(cdp.isAttached(4)).toBe(true);
              finishSlowLoad!();
              const navRes = await navWait;
              expect(navRes).toMatchObject({ reached: "load", tab_id: 4 });
            } finally {
              finishSlowLoad?.();
              (globalThis as { chrome?: unknown }).chrome = prevChrome;
              cdp.dispose();
            }
          },
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    }, 60_000);

    it("blocks soft-detach while a native JS dialog is open and invalidates refs when document.open() replaced the DOM while soft-detached", async () => {
      const server = createServer((_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><button id="before" type="button">Original Button</button>`);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

      try {
        const { withChrome } = await import(
          new URL(
            "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );
        let forwardEvent: ((event: CdpEvent) => void) | undefined;
        await withChrome(
          {
            executable: process.env.BSK_TEST_CHROME,
            deviceScale: 1,
            zoom: 1,
            startupTimeout: 30_000,
            onEvent: (event: CdpEvent) => forwardEvent?.(event),
          },
          async (send: Send) => {
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url });
            const { sessionId: monitorSession } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId, flatten: true },
            );

            let activeRootSession = "";
            const eventListeners = new Set<CdpEventListener>();
            forwardEvent = (event) => {
              if (activeRootSession && event.sessionId === activeRootSession) {
                for (const fn of [...eventListeners]) fn({ tabId: 8 }, event.method, event.params);
              }
            };
            const api: CdpDebuggerApi = {
              attach: async () => {
                const reply = await send<{ sessionId: string }>("Target.attachToTarget", {
                  targetId,
                  flatten: true,
                });
                activeRootSession = reply.sessionId;
              },
              detach: async () => {
                const prev = activeRootSession;
                activeRootSession = "";
                if (prev) await send("Target.detachFromTarget", { sessionId: prev });
              },
              sendCommand: async (_target, method, params) => {
                if (!activeRootSession) throw new Error("debugger detached");
                return send(method, params, activeRootSession);
              },
              onEvent: {
                addListener: (fn: CdpEventListener) => eventListeners.add(fn),
                removeListener: (fn: CdpEventListener) => eventListeners.delete(fn),
              } as unknown as CdpDebuggerApi["onEvent"],
              onDetach: {
                addListener() {},
                removeListener() {},
              } as unknown as CdpDebuggerApi["onDetach"],
            };

            const sessions = new SessionManager({
              agentWindow: {
                create: async () => ({ windowId: 100, initialTabIds: [8] }),
                remove: async () => {},
                ensureActiveTab: async () => 8,
              },
            });
            const ctx = await sessions.start("dialog-doc-open");
            const cdp = new ChromiumCdp(api, {
              idleDetachMs: 350,
              canControlDialog: () => true,
              onDocumentChanged: (tabId) => sessions.invalidateTabRefs(tabId),
            });
            stubInputClock(cdp);
            const runner = sessionCdpRunner(cdp, ctx.sessionId, () => sessions.has(ctx.sessionId));
            const tabObj = { id: 8, windowId: 100, active: true, url } as chrome.tabs.Tab;
            const tabsApi = { get: async () => tabObj, query: async () => [tabObj] };

            try {
              const observed = await handleSnapshot(
                sessions,
                { session_id: ctx.sessionId, tab_id: 8 },
                { cdp: runner, tabsApi },
              );
              if ("code" in observed) throw new Error(JSON.stringify(observed));
              const origRef = observed.text.match(/@(e\d+)/)?.[1];
              expect(origRef).toBeTruthy();
              const initialAttachment = cdp.getAttachmentId(8);

              // 1. Open an alert() while attached: Guard 4 keeps CDP attached past >500ms (>350ms idleDetachMs),
              // resolveDialog dismisses it cleanly, and then soft-detach + reattach preserves @e1!
              void runner.send(8, "Runtime.evaluate", {
                expression: "setTimeout(() => alert('live-alert'), 10)",
              });
              await expect.poll(() => cdp.pendingDialogs(8).length).toBe(1);
              await new Promise((r) => setTimeout(r, 500));
              expect(cdp.isAttached(8)).toBe(true);

              await cdp.resolveDialog(cdp.pendingDialogs(8)[0].id, true);
              await expect.poll(() => cdp.isAttached(8), { timeout: 3_000 }).toBe(false);

              // Click @e1 after soft-detach -> reattaches with preserved attachmentId!
              const clickRunner: typeof runner = new Proxy(runner, {
                get(target, prop, receiver) {
                  if (prop === "verifyPointerTarget") return pointerTargetValidator(runner);
                  const val = Reflect.get(target, prop, receiver);
                  return typeof val === "function" ? val.bind(target) : val;
                },
              });
              const clicked = await handleClick(
                sessions,
                { session_id: ctx.sessionId, tab_id: 8, ref: origRef! },
                { cdp: clickRunner, tabsApi, bypassOverlay: async () => {} },
              );
              expect(clicked).toMatchObject({ used_ref: origRef!, tab_id: 8 });
              expect(cdp.getAttachmentId(8)).toBe(initialAttachment);

              // 2. While soft-detached, replace DOM in-place via document.open()/document.write()
              // (frameId, loaderId, and url stay identical in Chrome!).
              // Both wait-for-element --state detached and click must reject stale @e1 as not_found (never satisfied: true)!
              await expect.poll(() => cdp.isAttached(8), { timeout: 3_000 }).toBe(false);
              await send(
                "Runtime.evaluate",
                {
                  expression:
                    "document.open(); document.write('<button id=\"after\">Replaced</button>'); document.close();",
                },
                monitorSession,
              );

              const staleWait = await handleWaitForElement(
                sessions,
                { session_id: ctx.sessionId, tab_id: 8, ref: origRef!, state: "detached" },
                { cdp: runner, tabsApi },
              );
              expect(staleWait).toMatchObject({ code: "not_found" });

              const staleClick = await handleClick(
                sessions,
                { session_id: ctx.sessionId, tab_id: 8, ref: origRef! },
                { cdp: clickRunner, tabsApi, bypassOverlay: async () => {} },
              );
              expect(staleClick).toMatchObject({ code: "not_found" });
              expect(cdp.getAttachmentId(8)).not.toBe(initialAttachment);
            } finally {
              cdp.dispose();
            }
          },
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    }, 60_000);

    it("survives cross-origin OOPIF soft-detach for visual @eN and --capture-id clicks, rejects document.open() & loaderId changes, and restores soft-detach after console/network/debug leases", async () => {
      const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (req.url === "/child") {
          res.end(`<!doctype html>
              <style>html,body{margin:0;padding:8px;font:14px sans-serif} canvas{display:block;border:1px solid #222}</style>
              <canvas id="oopif-canvas" aria-label="Signature Pad" width="160" height="60"></canvas>
              <button id="oopif-dom-btn" type="button">Submit Signature</button>
              <script>
                const canvas = document.getElementById('oopif-canvas');
                const ctx2d = canvas.getContext('2d');
                ctx2d.fillStyle = '#1d4ed8';
                ctx2d.fillRect(0, 0, 160, 60);
                window.canvasClicks = [];
                window.domClicks = 0;
                canvas.addEventListener('click', (e) => {
                  const r = canvas.getBoundingClientRect();
                  window.canvasClicks.push({ x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) });
                });
                document.getElementById('oopif-dom-btn').addEventListener('click', () => {
                  window.domClicks += 1;
                });
                console.log('oopif-ready');
              </script>`);
          return;
        }
        if (req.url === "/child-after-nav") {
          res.end(`<!doctype html>
              <canvas id="oopif-canvas" aria-label="Signature Pad" width="160" height="60"></canvas>
              <button id="oopif-dom-btn" type="button">Submit Signature</button>`);
          return;
        }
        const port = (server.address() as { port: number }).port;
        res.end(`<!doctype html>
            <style>body{margin:0;padding:12px} iframe{width:460px;height:220px;border:1px solid #ccc;display:block}</style>
            <iframe id="oopif" src="http://localhost:${port}/child"></iframe>`);
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as { port: number }).port;
      const hostUrl = `http://127.0.0.1:${port}/`;

      try {
        const { withChrome } = await import(
          new URL(
            "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );
        let forwardEvent: ((event: CdpEvent) => void) | undefined;
        await withChrome(
          {
            executable: process.env.BSK_TEST_CHROME,
            deviceScale: 1,
            zoom: 1,
            startupTimeout: 30_000,
            onEvent: (event: CdpEvent) => forwardEvent?.(event),
          },
          async (send: Send) => {
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
              url: hostUrl,
            });
            const { sessionId: monitorSession } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId, flatten: true },
            );
            const evalHost = async <T>(expression: string): Promise<T> => {
              const reply = await send<{ result: { value: T } }>(
                "Runtime.evaluate",
                { expression, returnByValue: true },
                monitorSession,
              );
              return reply.result.value;
            };

            let oopifTargetId = "";
            await expect
              .poll(async () => {
                const { targetInfos } = await send<{
                  targetInfos: { targetId: string; type: string; url: string }[];
                }>("Target.getTargets");
                const found = targetInfos.find(
                  (t) => t.type === "iframe" && t.url === `http://localhost:${port}/child`,
                );
                if (found) oopifTargetId = found.targetId;
                return Boolean(found);
              })
              .toBe(true);
            const { sessionId: monitorOopif } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId: oopifTargetId, flatten: true },
            );
            await expect
              .poll(async () => {
                const r = await send<{ result: { value: string } }>(
                  "Runtime.evaluate",
                  { expression: "document.readyState", returnByValue: true },
                  monitorOopif,
                );
                return r.result.value;
              })
              .toBe("complete");

            let activeRootSession = "";
            const childSessions = new Set<string>();
            const seenChildSessions: string[] = [];
            const eventListeners = new Set<CdpEventListener>();
            forwardEvent = (event) => {
              if (!activeRootSession) return;
              if (
                event.method === "Target.attachedToTarget" &&
                event.sessionId === activeRootSession
              ) {
                const sid = (event.params as { sessionId?: string } | undefined)?.sessionId;
                if (sid) {
                  childSessions.add(sid);
                  seenChildSessions.push(sid);
                }
              }
              if (event.sessionId === activeRootSession) {
                for (const fn of [...eventListeners]) fn({ tabId: 9 }, event.method, event.params);
              } else if (event.sessionId && childSessions.has(event.sessionId)) {
                for (const fn of [...eventListeners])
                  fn({ tabId: 9, sessionId: event.sessionId }, event.method, event.params);
              }
            };

            const api: CdpDebuggerApi = {
              attach: async () => {
                childSessions.clear();
                const reply = await send<{ sessionId: string }>("Target.attachToTarget", {
                  targetId,
                  flatten: true,
                });
                activeRootSession = reply.sessionId;
              },
              detach: async () => {
                const prev = activeRootSession;
                activeRootSession = "";
                childSessions.clear();
                if (prev) await send("Target.detachFromTarget", { sessionId: prev });
              },
              sendCommand: async (target, method, params) => {
                const sid = target.sessionId ?? activeRootSession;
                if (!sid) throw new Error("debugger detached");
                return send(method, params, sid);
              },
              onEvent: {
                addListener: (fn: CdpEventListener) => eventListeners.add(fn),
                removeListener: (fn: CdpEventListener) => eventListeners.delete(fn),
              } as unknown as CdpDebuggerApi["onEvent"],
              onDetach: {
                addListener() {},
                removeListener() {},
              } as unknown as CdpDebuggerApi["onDetach"],
            };

            const sessions = new SessionManager({
              agentWindow: {
                create: async () => ({ windowId: 100, initialTabIds: [9] }),
                remove: async () => {},
                ensureActiveTab: async () => 9,
              },
            });
            const ctx = await sessions.start("oopif-visual-and-leases");
            const cdp = new ChromiumCdp(api, {
              idleDetachMs: 350,
              canControlDialog: () => true,
              onDocumentChanged: (tabId) => sessions.invalidateTabRefs(tabId),
              onChildFramesInvalidated: (tabId, staleFrameIds) =>
                sessions.invalidateTabChildFrames(tabId, staleFrameIds),
            });
            stubInputClock(cdp);
            const runner = sessionCdpRunner(cdp, ctx.sessionId, () => sessions.has(ctx.sessionId));
            const tab = async () =>
              ({
                id: 9,
                windowId: 100,
                active: true,
                url: await evalHost<string>("location.href"),
              }) as chrome.tabs.Tab;
            const tabsApi = {
              get: tab,
              query: async () => [await tab()],
              sendMessage: async () => ({ ok: true }),
            };
            const prevChrome = (globalThis as { chrome?: unknown }).chrome;
            (globalThis as { chrome?: unknown }).chrome = { tabs: tabsApi };

            try {
              const waitForSoftDetach = async () => {
                await expect.poll(() => cdp.isAttached(9), { timeout: 3_000 }).toBe(false);
              };

              // --- Counterexample C: `console` / `network` + `debug start -> stop` lease recovery ---
              const consoleRes = await handleConsole(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9 },
                { cdp: runner, tabsApi },
              );
              expect(consoleRes).not.toHaveProperty("code");
              const networkRes = await handleNetwork(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9 },
                { cdp: runner, tabsApi },
              );
              expect(networkRes).not.toHaveProperty("code");
              // One-shot `console` / `network` reads MUST NOT permanently block soft-detach!
              await waitForSoftDetach();

              // `DebugManager` (`bsk debug start`) holds a tab-scoped `onEvent` lease blocking soft-detach;
              // `bsk debug stop` disposes the lease and restores soft-detach!
              const debugManager = new DebugManager(sessions, cdp, tabsApi);
              const debugRun = await debugManager.start(ctx.sessionId, 9, "lease-check");
              expect(debugRun.state).toBe("capturing");
              await new Promise((r) => setTimeout(r, 550));
              expect(cdp.isAttached(9)).toBe(true);

              const stoppedDebug = await debugManager.read({
                session_id: ctx.sessionId,
                action: "stop",
                run_id: debugRun.id,
              });
              expect(stoppedDebug.run?.state).toBe("stopped");
              await waitForSoftDetach();

              // --- Counterexample A: Cross-origin OOPIF DOM @eN + visual @eN + --capture-id across Soft-Detach ---
              const observed = await handleObserve(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9 },
                { cdp: runner, tabsApi },
              );
              if ("code" in observed) throw new Error(JSON.stringify(observed));
              const findObservedRef = (needle: string): string => {
                const line = observed.text.split("\n").find((l) => l.includes(needle));
                const match = line?.match(/@(e\d+)/);
                if (!match) throw new Error(`missing ref for "${needle}" in:\n${observed.text}`);
                return match[1];
              };
              const canvasRef = findObservedRef("Signature Pad");
              const domBtnRef = findObservedRef("Submit Signature");
              const canvasEntry = ctx.refStore.resolveEntry(canvasRef);
              expect(canvasEntry?.kind).toBe("visual-region");
              if (canvasEntry?.kind === "visual-region") {
                expect("cdpSessionId" in canvasEntry.candidate.document).toBe(false);
              }

              const captureApi = {
                ...tabsApi,
                captureVisibleTab: async () => {
                  const shot = await send<{ data: string }>(
                    "Page.captureScreenshot",
                    { format: "png" },
                    monitorSession,
                  );
                  return `data:image/png;base64,${shot.data}`;
                },
              };
              const capturedShot = await handleScreenshot(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9, ref: canvasRef },
                {
                  cdp: runner,
                  tabsApi,
                  captureApi,
                  sendToTab: async () => ({ ok: true }),
                },
              );
              if ("code" in capturedShot) throw new Error(JSON.stringify(capturedShot));
              expect(capturedShot.capture_id).toEqual(expect.any(String));
              const sessionsBeforeSoftDetach = seenChildSessions.length;

              // Trigger Soft-Detach -> OOPIF receives a brand-new internal CDP sessionId on reconnect!
              await waitForSoftDetach();
              const captureIdClicked = await handleClick(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 9,
                  ref: canvasRef,
                  capture_id: capturedShot.capture_id!,
                  image_x: Math.floor(capturedShot.width / 2),
                  image_y: Math.floor(capturedShot.height / 2),
                },
                { cdp: runner, tabsApi, bypassOverlay: async () => {} },
              );
              expect(captureIdClicked).toMatchObject({ used_ref: canvasRef, tab_id: 9 });
              expect(seenChildSessions.length).toBeGreaterThan(sessionsBeforeSoftDetach);

              // Trigger another Soft-Detach -> visual-region @eN screenshot + pure --capture-id coordinate click + DOM @eN click!
              await waitForSoftDetach();
              const secondCanvasShot = await handleScreenshot(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9, ref: canvasRef },
                {
                  cdp: runner,
                  tabsApi,
                  captureApi,
                  sendToTab: async () => ({ ok: true }),
                },
              );
              if ("code" in secondCanvasShot) throw new Error(JSON.stringify(secondCanvasShot));
              expect(secondCanvasShot.capture_id).toEqual(expect.any(String));

              await waitForSoftDetach();
              const secondCaptureClicked = await handleClick(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 9,
                  ref: canvasRef,
                  capture_id: secondCanvasShot.capture_id!,
                  image_x: Math.floor(secondCanvasShot.width / 2),
                  image_y: Math.floor(secondCanvasShot.height / 2),
                },
                { cdp: runner, tabsApi, bypassOverlay: async () => {} },
              );
              expect(secondCaptureClicked).toMatchObject({ used_ref: canvasRef, tab_id: 9 });

              await waitForSoftDetach();
              const domBtnClicked = await handleClick(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9, ref: domBtnRef },
                { cdp: runner, tabsApi, bypassOverlay: async () => {} },
              );
              expect(domBtnClicked).toMatchObject({ used_ref: domBtnRef, tab_id: 9 });

              const oopifCounts = await send<{
                result: { value: { canvas: number; dom: number } };
              }>(
                "Runtime.evaluate",
                {
                  expression: "({ canvas: window.canvasClicks.length, dom: window.domClicks })",
                  returnByValue: true,
                },
                monitorOopif,
              );
              expect(oopifCounts.result.value).toEqual({ canvas: 2, dom: 1 });

              // --- Counterexample B1: Same-loaderId `document.open()` inside cross-origin OOPIF ---
              const shotBeforeDocOpen = await handleScreenshot(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9, ref: canvasRef },
                {
                  cdp: runner,
                  tabsApi,
                  captureApi,
                  sendToTab: async () => ({ ok: true }),
                },
              );
              if ("code" in shotBeforeDocOpen) throw new Error(JSON.stringify(shotBeforeDocOpen));
              expect(shotBeforeDocOpen.capture_id).toEqual(expect.any(String));

              await waitForSoftDetach();
              await send(
                "Runtime.evaluate",
                {
                  expression:
                    'document.open(); document.write(\'<style>html,body{margin:0;padding:8px}</style><canvas id="oopif-canvas" aria-label="Signature Pad" width="160" height="60"></canvas><button id="oopif-dom-btn" type="button">Submit Signature</button><script>const c=document.getElementById("oopif-canvas").getContext("2d");c.fillStyle="#1d4ed8";c.fillRect(0,0,160,60);</script>\'); document.close();',
                },
                monitorOopif,
              );

              const staleCaptureClick = await handleClick(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 9,
                  ref: canvasRef,
                  capture_id: shotBeforeDocOpen.capture_id!,
                  image_x: 20,
                  image_y: 20,
                },
                { cdp: runner, tabsApi, bypassOverlay: async () => {} },
              );
              expect(staleCaptureClick).toMatchObject({
                code: "not_found",
                data: { reason: "visual_target_changed" },
              });

              const staleVisualShot = await handleScreenshot(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9, ref: canvasRef },
                {
                  cdp: runner,
                  tabsApi,
                  captureApi,
                  sendToTab: async () => ({ ok: true }),
                },
              );
              expect(staleVisualShot).toMatchObject({
                code: "not_found",
                data: { reason: "visual_target_changed" },
              });

              const staleDomAfterDocOpen = await handleClick(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9, ref: domBtnRef },
                { cdp: runner, tabsApi, bypassOverlay: async () => {} },
              );
              expect(staleDomAfterDocOpen).toMatchObject({ code: "not_found" });

              // --- Counterexample B2: Cross-origin OOPIF navigation changing `loaderId` ---
              const reobserved = await handleObserve(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9 },
                { cdp: runner, tabsApi },
              );
              if ("code" in reobserved) throw new Error(JSON.stringify(reobserved));
              const freshCanvasRef = reobserved.text
                .split("\n")
                .find((l) => l.includes("Signature Pad"))
                ?.match(/@(e\d+)/)?.[1];
              const freshDomBtnRef = reobserved.text
                .split("\n")
                .find((l) => l.includes("Submit Signature"))
                ?.match(/@(e\d+)/)?.[1];
              expect(freshCanvasRef).toBeTruthy();
              expect(freshDomBtnRef).toBeTruthy();
              const freshCanvasShot = await handleScreenshot(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9, ref: freshCanvasRef! },
                {
                  cdp: runner,
                  tabsApi,
                  captureApi,
                  sendToTab: async () => ({ ok: true }),
                },
              );
              if ("code" in freshCanvasShot) throw new Error(JSON.stringify(freshCanvasShot));

              await waitForSoftDetach();
              await evalHost(
                `document.getElementById('oopif').src = 'http://localhost:${port}/child-after-nav'`,
              );
              await expect
                .poll(async () => {
                  const { targetInfos } = await send<{
                    targetInfos: { type: string; url: string }[];
                  }>("Target.getTargets");
                  return targetInfos.some(
                    (t) =>
                      t.type === "iframe" && t.url === `http://localhost:${port}/child-after-nav`,
                  );
                })
                .toBe(true);

              const staleCaptureAfterNav = await handleClick(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 9,
                  ref: freshCanvasRef!,
                  capture_id: freshCanvasShot.capture_id!,
                  image_x: 20,
                  image_y: 20,
                },
                { cdp: runner, tabsApi, bypassOverlay: async () => {} },
              );
              expect(staleCaptureAfterNav).toMatchObject({
                code: "not_found",
                data: {
                  reason: expect.stringMatching(
                    /^(visual_capture_stale|visual_target_changed|ref_not_found)$/,
                  ),
                  effect_state: "none",
                },
              });

              const staleVisualAfterNav = await handleScreenshot(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9, ref: freshCanvasRef! },
                {
                  cdp: runner,
                  tabsApi,
                  captureApi,
                  sendToTab: async () => ({ ok: true }),
                },
              );
              expect(staleVisualAfterNav).toMatchObject({ code: "not_found" });

              const staleAfterNav = await handleClick(
                sessions,
                { session_id: ctx.sessionId, tab_id: 9, ref: freshDomBtnRef! },
                { cdp: runner, tabsApi, bypassOverlay: async () => {} },
              );
              expect(staleAfterNav).toMatchObject({ code: "not_found" });
            } finally {
              (globalThis as { chrome?: unknown }).chrome = prevChrome;
              cdp.dispose();
            }
          },
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    }, 60_000);
  },
);
