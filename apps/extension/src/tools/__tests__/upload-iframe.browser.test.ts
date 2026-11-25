// @vitest-environment node
// Opt in with BSK_TEST_CHROME; exercises Layui-style hidden input[type=file]
// uploads and cross-frame --selector resolution across same-origin iframes and
// cross-origin OOPIFs (standalone + CooperationController) in real Chrome.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { checkExpectations } from "@/cooperation/action-checks";
import { CooperationController } from "@/cooperation/controller";
import type { CooperationFrames, FrameState } from "@/cooperation/types";
import { SessionManager } from "@/session-manager/manager";
import { uploadThroughActivatedFileInput } from "../file-input-transaction";
import { handleClick, handlePress } from "../interaction";
import { handleScreenshot } from "../observation";
import { handleRead } from "../read";
import { handleScrollTo } from "../scroll";
import { delegateCdpRunner, sessionCdpRunner } from "../shared";
import { handleUpload } from "../upload";
import { handleWaitForElement } from "../waits";
import { handleWheel } from "../wheel";

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

type CdpEventListener = Parameters<CdpDebuggerApi["onEvent"]["addListener"]>[0];

const stubInputClock = (cdp: ChromiumCdp) => {
  vi.spyOn(cdp, "prepareInputTimestamp").mockImplementation(async () => ({
    timestamp: Date.now(),
    nativeTimestamp: Date.now() / 1000,
    assertValid: () => {},
  }));
};

describe.skipIf(!process.env.BSK_TEST_CHROME)(
  "real browser iframe + hidden input[type=file] (Layui-style) upload & cross-frame selector",
  () => {
    it("uploads via visible trigger @ref and direct hidden input[type=file] --selector across same-origin iframes and cross-origin OOPIFs", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "bsk-upload-iframe-"));
      const fileA = join(tempDir, "invoice-a.pdf");
      const fileB = join(tempDir, "invoice-b.pdf");
      writeFileSync(fileA, "PDF-CONTENT-A");
      writeFileSync(fileB, "PDF-CONTENT-B");

      const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (req.url === "/same-origin-frame") {
          res.end(`<!doctype html>
              <style>html,body{margin:0;padding:8px;font:14px sans-serif}</style>
              <div class="dup-across-frames">Same-origin slot</div>
              <button type="button" class="layui-btn" id="same-layui-btn">上传合同</button>
              <input class="layui-upload-file" id="same-layui-file" type="file" name="file" style="display: none !important">
              <script>
                window.sameBtnClicks = 0;
                window.sameUploads = [];
                const btn = document.getElementById('same-layui-btn');
                const inp = document.getElementById('same-layui-file');
                btn.addEventListener('click', () => {
                  window.sameBtnClicks += 1;
                  inp.click();
                });
                inp.addEventListener('change', () => {
                  window.sameUploads.push(Array.from(inp.files, f => f.name + ':' + f.size));
                });
              </script>`);
          return;
        }
        if (req.url === "/oopif-frame") {
          res.end(`<!doctype html>
              <style>html,body{margin:0;padding:8px;font:14px sans-serif}</style>
              <button type="button" class="layui-btn" id="oopif-layui-btn">上传凭证</button>
              <input class="layui-upload-file oopif-layui-file" id="oopif-layui-file" type="file" style="display: none !important">
              <button type="button" id="oopif-detached-btn">动态选择器上传</button>
              <input id="oopif-disabled-file" type="file" disabled style="display: none !important">
              <button type="button" id="oopif-action-btn">确认归档</button>
              <script>
                window.oopifBtnClicks = 0;
                window.oopifActionClicks = 0;
                window.oopifUploads = [];
                window.oopifDetachedUploads = [];
                const btn = document.getElementById('oopif-layui-btn');
                const inp = document.getElementById('oopif-layui-file');
                btn.addEventListener('click', () => {
                  window.oopifBtnClicks += 1;
                  inp.click();
                });
                inp.addEventListener('change', () => {
                  window.oopifUploads.push(Array.from(inp.files, f => f.name + ':' + f.size));
                });
                document.getElementById('oopif-detached-btn').addEventListener('click', () => {
                  const temp = document.createElement('input');
                  temp.type = 'file';
                  temp.addEventListener('change', () => {
                    window.oopifDetachedUploads.push(Array.from(temp.files, f => f.name + ':' + f.size));
                  });
                  temp.click();
                });
                document.getElementById('oopif-action-btn').addEventListener('click', () => {
                  window.oopifActionClicks += 1;
                });
              </script>`);
          return;
        }
        if (req.url === "/oopif-next") {
          res.end(
            `<!doctype html><div id="oopif-next-ready">Next Frame Ready</div><input class="oopif-layui-file" type="file" style="display:none">`,
          );
          return;
        }
        const port = (server.address() as { port: number }).port;
        res.end(`<!doctype html>
            <style>
              body{margin:0;padding:10px;font:14px sans-serif}
              iframe{width:460px;height:140px;border:1px solid #ccc;display:block;margin-top:8px}
            </style>
            <div class="dup-across-frames">Host slot</div>
            <button type="button" id="host-cross-frame-upload">宿主代点子框上传</button>
            <iframe id="same-frame" src="/same-origin-frame"></iframe>
            <iframe id="oopif-frame" src="http://localhost:${port}/oopif-frame"></iframe>
            <script>
              document.getElementById('host-cross-frame-upload').addEventListener('click', () => {
                document.getElementById('same-frame').contentDocument.getElementById('same-layui-file').click();
              });
            </script>`);
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

            await expect
              .poll(() =>
                evalHost<boolean>(
                  "document.readyState === 'complete' && document.getElementById('same-frame')?.contentDocument?.readyState === 'complete'",
                ),
              )
              .toBe(true);

            let oopifTargetId = "";
            await expect
              .poll(async () => {
                const { targetInfos } = await send<{
                  targetInfos: { targetId: string; type: string; url: string }[];
                }>("Target.getTargets");
                const found = targetInfos.find(
                  (t) => t.type === "iframe" && t.url === `http://localhost:${port}/oopif-frame`,
                );
                if (found) oopifTargetId = found.targetId;
                return Boolean(found);
              })
              .toBe(true);
            const { sessionId: monitorOopif } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId: oopifTargetId, flatten: true },
            );
            const evalOopif = async <T>(expression: string): Promise<T> => {
              const reply = await send<{ result: { value: T } }>(
                "Runtime.evaluate",
                { expression, returnByValue: true },
                monitorOopif,
              );
              return reply.result.value;
            };
            await expect.poll(() => evalOopif<string>("document.readyState")).toBe("complete");

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
            const ctx = await sessions.start("upload-iframe-e2e");

            const hostFrame: FrameState = {
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
            let oopifDoc = "doc-oopif-1";
            const controller = new CooperationController({
              sessions,
              readFrames: async (): Promise<CooperationFrames> => ({
                frames: new Map([
                  [0, structuredClone(hostFrame)],
                  [2, { ...structuredClone(hostFrame), document: oopifDoc }],
                ]),
                gaps: [],
              }),
              resumeFrames: async () => {},
              changed: () => {},
            });

            const cdp = new ChromiumCdp(api, {
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
              // Hidden display:none file inputs are excluded from VOM refs; visible buttons are present.
              expect(syncReply.observation.text).not.toContain("layui-upload-file");

              const findRef = (label: string): string => {
                const line = syncReply.observation.text.split("\n").find((l) => l.includes(label));
                const match = line?.match(/@(e\d+)/);
                if (!match) {
                  throw new Error(`missing ref for "${label}" in:\n${syncReply.observation.text}`);
                }
                return match[1];
              };
              const hostCrossBtnRef = findRef("宿主代点子框上传");
              const sameBtnRef = findRef("上传合同");
              const oopifBtnRef = findRef("上传凭证");
              const oopifDetachedBtnRef = findRef("动态选择器上传");

              const runCoopUpload = (id: string, params: Record<string, unknown>) => {
                const req = {
                  id,
                  method: "tool.upload",
                  params: {
                    session_id: ctx.sessionId,
                    tab_id: 4,
                    context_id: syncReply.context_id,
                    ...params,
                  },
                };
                return controller.run(req, runner, signal, (guarded, opSignal) =>
                  handleUpload(sessions, req.params as never, {
                    cdp: guarded,
                    tabsApi,
                    signal: opSignal,
                    bypassOverlay: async () => {},
                    sendToTab: async () => ({ ok: true }),
                  }),
                );
              };

              const runCoopClick = (id: string, params: Record<string, unknown>) => {
                const req = {
                  id,
                  method: "tool.click",
                  params: {
                    session_id: ctx.sessionId,
                    tab_id: 4,
                    context_id: syncReply.context_id,
                    ...params,
                  },
                };
                return controller.run(req, runner, signal, (guarded, opSignal) =>
                  handleClick(sessions, req.params as never, {
                    cdp: guarded,
                    tabsApi,
                    signal: opSignal,
                    bypassOverlay: async () => {},
                  }),
                );
              };

              // 1. Same-origin iframe Layui upload via visible button @ref (through CooperationController).
              const sameViaRef = await runCoopUpload("up-same-ref", {
                ref: sameBtnRef,
                files: [{ transfer_id: "tx-1", name: "invoice-a.pdf", staged_path: fileA }],
              });
              expect(sameViaRef).toMatchObject({
                tab_id: 4,
                used_ref: sameBtnRef,
                file_names: ["invoice-a.pdf"],
              });
              expect(
                await evalHost<unknown>(
                  "document.getElementById('same-frame').contentWindow.sameUploads",
                ),
              ).toEqual([["invoice-a.pdf:13"]]);
              expect(
                await evalHost<number>(
                  "document.getElementById('same-frame').contentWindow.sameBtnClicks",
                ),
              ).toBe(1);

              // 2. Same-origin iframe direct upload to display:none input[type=file] via --selector
              //    even while the tab is occluded/hidden in the background (skips withInputReady & click!).
              const { targetId: foregroundBlankId } = await send<{ targetId: string }>(
                "Target.createTarget",
                { url: "about:blank" },
              );
              await send("Target.activateTarget", { targetId: foregroundBlankId });
              await expect.poll(() => evalHost<string>("document.visibilityState")).toBe("hidden");

              const sameViaSelector = await runCoopUpload("up-same-sel", {
                selector: "#same-layui-file",
                files: [{ transfer_id: "tx-2", name: "invoice-b.pdf", staged_path: fileB }],
              });
              expect(sameViaSelector).toMatchObject({
                tab_id: 4,
                used_selector: "#same-layui-file",
                file_names: ["invoice-b.pdf"],
              });
              expect(
                await evalHost<unknown>(
                  "document.getElementById('same-frame').contentWindow.sameUploads",
                ),
              ).toEqual([["invoice-a.pdf:13"], ["invoice-b.pdf:13"]]);
              expect(
                await evalHost<number>(
                  "document.getElementById('same-frame').contentWindow.sameBtnClicks",
                ),
              ).toBe(1);

              await send("Target.closeTarget", { targetId: foregroundBlankId });
              await send("Target.activateTarget", { targetId });
              await expect.poll(() => evalHost<string>("document.visibilityState")).toBe("visible");

              // 3. Same-origin cross-frame trigger: button in host frame clicks hidden input in child iframe.
              const crossFrameUpload = await handleUpload(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  ref: hostCrossBtnRef,
                  files: [{ transfer_id: "tx-3", name: "invoice-a.pdf", staged_path: fileA }],
                },
                {
                  cdp: runner,
                  tabsApi,
                  bypassOverlay: async () => {},
                  sendToTab: async () => ({ ok: true }),
                },
              );
              expect(crossFrameUpload).toMatchObject({
                tab_id: 4,
                used_ref: hostCrossBtnRef,
                file_names: ["invoice-a.pdf"],
              });
              expect(
                await evalHost<unknown>(
                  "document.getElementById('same-frame').contentWindow.sameUploads",
                ),
              ).toEqual([["invoice-a.pdf:13"], ["invoice-b.pdf:13"], ["invoice-a.pdf:13"]]);

              // 4. Cross-origin OOPIF Layui upload via visible button @ref AND via detached dynamic input[type=file].
              const oopifViaRef = await runCoopUpload("up-oopif-ref", {
                ref: oopifBtnRef,
                files: [{ transfer_id: "tx-4", name: "invoice-a.pdf", staged_path: fileA }],
              });
              expect(oopifViaRef).toMatchObject({
                tab_id: 4,
                used_ref: oopifBtnRef,
                file_names: ["invoice-a.pdf"],
              });
              expect(await evalOopif<unknown>("window.oopifUploads")).toEqual([
                ["invoice-a.pdf:13"],
              ]);
              expect(await evalOopif<number>("window.oopifBtnClicks")).toBe(1);

              const oopifDetached = await handleUpload(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  ref: oopifDetachedBtnRef,
                  files: [{ transfer_id: "tx-5", name: "invoice-b.pdf", staged_path: fileB }],
                },
                {
                  cdp: runner,
                  tabsApi,
                  bypassOverlay: async () => {},
                  sendToTab: async () => ({ ok: true }),
                },
              );
              expect(oopifDetached).toMatchObject({
                tab_id: 4,
                used_ref: oopifDetachedBtnRef,
                file_names: ["invoice-b.pdf"],
              });
              expect(await evalOopif<unknown>("window.oopifDetachedUploads")).toEqual([
                ["invoice-b.pdf:13"],
              ]);

              // 5. Cross-origin OOPIF direct upload to display:none input[type=file] via --selector
              //    (without clicking, plus single-file multiple check & disabled check).
              const oopifMultiErr = await handleUpload(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  selector: "input.oopif-layui-file",
                  files: [
                    { transfer_id: "tx-6a", name: "invoice-a.pdf", staged_path: fileA },
                    { transfer_id: "tx-6b", name: "invoice-b.pdf", staged_path: fileB },
                  ],
                },
                { cdp: runner, tabsApi },
              );
              expect(oopifMultiErr).toMatchObject({
                code: "invalid_params",
                message: "file input accepts exactly one file",
                data: { effect_state: "none", phase: "resolve_input" },
              });

              const oopifDisabledErr = await handleUpload(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  selector: "#oopif-disabled-file",
                  files: [{ transfer_id: "tx-7", name: "invoice-a.pdf", staged_path: fileA }],
                },
                { cdp: runner, tabsApi },
              );
              expect(oopifDisabledErr).toMatchObject({
                code: "invalid_params",
                data: { reason: "target_disabled", effect_state: "none" },
              });

              const oopifViaSelector = await runCoopUpload("up-oopif-sel", {
                selector: "input.oopif-layui-file",
                files: [{ transfer_id: "tx-8", name: "invoice-b.pdf", staged_path: fileB }],
              });
              expect(oopifViaSelector).toMatchObject({
                tab_id: 4,
                used_selector: "input.oopif-layui-file",
                file_names: ["invoice-b.pdf"],
              });
              expect(await evalOopif<unknown>("window.oopifUploads")).toEqual([
                ["invoice-a.pdf:13"],
                ["invoice-b.pdf:13"],
              ]);
              expect(await evalOopif<number>("window.oopifBtnClicks")).toBe(1);

              // 6. Cross-frame --selector sibling tools (wait-for-element, scroll-to, wheel, click) + strict ambiguity check.
              const waited = await handleWaitForElement(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  selector: "input.oopif-layui-file",
                  state: "attached",
                },
                { cdp: runner, tabsApi },
              );
              expect(waited).toMatchObject({
                satisfied: true,
                attached: true,
                visible: false,
                used_selector: "input.oopif-layui-file",
              });

              const scrolledOopif = await handleScrollTo(
                sessions,
                { session_id: ctx.sessionId, tab_id: 4, selector: "#oopif-action-btn" },
                { cdp: runner, tabsApi },
              );
              expect(scrolledOopif).toMatchObject({
                tab_id: 4,
                used_selector: "#oopif-action-btn",
                width: expect.any(Number),
                height: expect.any(Number),
              });

              const wheeledOopif = await handleWheel(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  selector: "#oopif-action-btn",
                  delta_y: 40,
                },
                { cdp: runner, tabsApi, bypassOverlay: async () => {} },
              );
              expect(wheeledOopif).toMatchObject({
                tab_id: 4,
                used_selector: "#oopif-action-btn",
                delta_y: 40,
              });

              const clickedOopif = await handleClick(
                sessions,
                { session_id: ctx.sessionId, tab_id: 4, selector: "#oopif-action-btn" },
                { cdp: runner, tabsApi, bypassOverlay: async () => {} },
              );
              expect(clickedOopif).toMatchObject({
                tab_id: 4,
                used_selector: "#oopif-action-btn",
              });
              expect(await evalOopif<number>("window.oopifActionClicks")).toBe(1);

              const dupAmbiguous = await runCoopClick("ambiguous-across-frames", {
                selector: ".dup-across-frames",
              });
              expect(dupAmbiguous).toMatchObject({
                code: "invalid_params",
                message: expect.stringContaining("selector matched 2 elements"),
                data: { phase: "target", effect_state: "none" },
              });

              // 7. Mid-poll child-frame navigation resilience + Cooperation frame-epoch safety:
              //    `wait-for-element --selector` survives OOPIF navigation, while stale context
              //    is refused with document_changed + effect_state: "none" until re-synchronized.
              const waitAcrossNav = handleWaitForElement(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  selector: "#oopif-next-ready",
                  state: "visible",
                  poll_ms: 20,
                  timeout_ms: 8_000,
                },
                { cdp: runner, tabsApi },
              );
              await new Promise((resolve) => setTimeout(resolve, 40));
              oopifDoc = "doc-oopif-2";
              await evalHost(
                `document.getElementById('oopif-frame').src = 'http://localhost:${port}/oopif-next'`,
              );
              expect(await waitAcrossNav).toMatchObject({
                satisfied: true,
                attached: true,
                visible: true,
                used_selector: "#oopif-next-ready",
              });

              const staleChildSelector = await runCoopUpload("stale-oopif-sel", {
                selector: "input.oopif-layui-file",
                files: [{ transfer_id: "tx-9", name: "invoice-a.pdf", staged_path: fileA }],
              });
              expect(staleChildSelector).toMatchObject({
                code: "permission_denied",
                data: { reason: "document_changed", effect_state: "none" },
              });
            } finally {
              (globalThis as { chrome?: unknown }).chrome = prevChrome;
              await cdp.detachAll();
            }
          },
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(tempDir, { recursive: true, force: true });
      }
    }, 60_000);

    it("keeps main-doc and healthy-iframe --selector actions fast and non-blocking when another OOPIF renderer is hung", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "bsk-upload-hung-oopif-"));
      const fileA = join(tempDir, "contract.pdf");
      writeFileSync(fileA, "PDF-HUNG-OOPIF");

      const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (req.url === "/same-origin-frame") {
          res.end(`<!doctype html>
              <div class="dup-across-frames">Same slot</div>
              <input class="layui-upload-file" id="same-layui-file" type="file" style="display: none !important">
              <script>
                window.sameUploads = [];
                const inp = document.getElementById('same-layui-file');
                inp.addEventListener('change', () => {
                  window.sameUploads.push(Array.from(inp.files, f => f.name + ':' + f.size));
                });
              </script>`);
          return;
        }
        if (req.url === "/healthy-oopif") {
          res.end(`<!doctype html>
              <button type="button" id="healthy-oopif-btn">Healthy OOPIF</button>
              <script>
                window.healthyClicks = 0;
                document.getElementById('healthy-oopif-btn').addEventListener('click', () => {
                  window.healthyClicks += 1;
                });
              </script>`);
          return;
        }
        if (req.url === "/hung-oopif") {
          // Isolate hung.localhost into its own dedicated renderer process.
          res.setHeader("Origin-Agent-Cluster", "?1");
          res.end(`<!doctype html><div id="hung-marker">Hung OOPIF</div>`);
          return;
        }
        const port = (server.address() as { port: number }).port;
        res.end(`<!doctype html>
            <style>body{margin:0;padding:10px}iframe{width:320px;height:100px;display:block}</style>
            <div class="dup-across-frames">Host slot</div>
            <button type="button" id="host-action-btn">Host Action</button>
            <iframe id="same-frame" src="/same-origin-frame"></iframe>
            <iframe id="healthy-oopif" src="http://localhost:${port}/healthy-oopif"></iframe>
            <iframe id="hung-oopif" src="http://hung.localhost:${port}/hung-oopif"></iframe>
            <script>
              window.hostClicks = 0;
              document.getElementById('host-action-btn').addEventListener('click', () => {
                window.hostClicks += 1;
              });
            </script>`);
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
            await expect
              .poll(() =>
                evalHost<boolean>(
                  "document.readyState === 'complete' && document.getElementById('same-frame')?.contentDocument?.readyState === 'complete'",
                ),
              )
              .toBe(true);

            const findTarget = async (url: string) => {
              let target = "";
              await expect
                .poll(async () => {
                  const { targetInfos } = await send<{
                    targetInfos: { targetId: string; type: string; url: string }[];
                  }>("Target.getTargets");
                  const found = targetInfos.find((t) => t.type === "iframe" && t.url === url);
                  if (found) target = found.targetId;
                  return Boolean(found);
                })
                .toBe(true);
              return target;
            };
            const healthyTargetId = await findTarget(`http://localhost:${port}/healthy-oopif`);
            const hungTargetId = await findTarget(`http://hung.localhost:${port}/hung-oopif`);
            const { sessionId: monitorHealthy } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId: healthyTargetId, flatten: true },
            );
            const { sessionId: monitorHung } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId: hungTargetId, flatten: true },
            );
            const evalTarget = async <T>(sessionId: string, expression: string): Promise<T> => {
              const reply = await send<{ result: { value: T } }>(
                "Runtime.evaluate",
                { expression, returnByValue: true },
                sessionId,
              );
              return reply.result.value;
            };
            await expect
              .poll(() => evalTarget<string>(monitorHealthy, "document.readyState"))
              .toBe("complete");
            await expect
              .poll(() => evalTarget<string>(monitorHung, "document.readyState"))
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
            const ctx = await sessions.start("hung-oopif-e2e");
            const hostFrame: FrameState = {
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
                frames: new Map([
                  [0, structuredClone(hostFrame)],
                  [2, { ...structuredClone(hostFrame), document: "doc-healthy" }],
                  [3, { ...structuredClone(hostFrame), document: "doc-hung" }],
                ]),
                gaps: [],
              }),
              resumeFrames: async () => {},
              changed: () => {},
            });
            const cdp = new ChromiumCdp(api, {
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
                url: hostUrl,
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
              // Establish target-policy cooperation sync BEFORE freezing the hung OOPIF renderer.
              const syncReply = (await controller.command(
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  action: "sync",
                  control_policy: "target",
                },
                runner,
                signal,
              )) as { context_id: string };
              expect(syncReply.context_id).toBeTruthy();

              // Deadlock ONLY the hung.localhost OOPIF renderer thread.
              void send(
                "Runtime.evaluate",
                { expression: "setTimeout(() => { while (true) {} }, 0)" },
                monitorHung,
              ).catch(() => {});
              await new Promise((resolve) => setTimeout(resolve, 50));

              const runCoop = (
                id: string,
                method: "tool.click" | "tool.upload",
                params: Record<string, unknown>,
              ) => {
                const req = {
                  id,
                  method,
                  params: {
                    session_id: ctx.sessionId,
                    tab_id: 4,
                    context_id: syncReply.context_id,
                    ...params,
                  },
                };
                return controller.run(req, runner, signal, (guarded, opSignal) =>
                  method === "tool.upload"
                    ? handleUpload(sessions, req.params as never, {
                        cdp: guarded,
                        tabsApi,
                        signal: opSignal,
                        bypassOverlay: async () => {},
                        sendToTab: async () => ({ ok: true }),
                      })
                    : handleClick(sessions, req.params as never, {
                        cdp: guarded,
                        tabsApi,
                        signal: opSignal,
                        bypassOverlay: async () => {},
                      }),
                );
              };

              // 1. Main-doc --selector click succeeds despite hung OOPIF (bounded <= ~2s on first call).
              const t1 = performance.now();
              const hostClick1 = await runCoop("host-click-1", "tool.click", {
                selector: "#host-action-btn",
              });
              expect(hostClick1).toMatchObject({ tab_id: 4, used_selector: "#host-action-btn" });
              expect(await evalHost<number>("window.hostClicks")).toBe(1);
              expect(performance.now() - t1).toBeLessThan(5_000);

              // 2. Subsequent main-doc --selector click skips the gated hung OOPIF immediately!
              const t2 = performance.now();
              const hostClick2 = await runCoop("host-click-2", "tool.click", {
                selector: "#host-action-btn",
              });
              expect(hostClick2).toMatchObject({ tab_id: 4, used_selector: "#host-action-btn" });
              expect(await evalHost<number>("window.hostClicks")).toBe(2);
              expect(performance.now() - t2).toBeLessThan(1_000);

              // 3. Direct hidden input[type=file] --selector upload in same-origin iframe succeeds.
              const sameUpload = await runCoop("same-upload", "tool.upload", {
                selector: "#same-layui-file",
                files: [{ transfer_id: "tx-hung-1", name: "contract.pdf", staged_path: fileA }],
              });
              expect(sameUpload).toMatchObject({
                tab_id: 4,
                used_selector: "#same-layui-file",
                file_names: ["contract.pdf"],
              });
              expect(
                await evalHost<unknown>(
                  "document.getElementById('same-frame').contentWindow.sameUploads",
                ),
              ).toEqual([["contract.pdf:14"]]);

              // 4. Cross-origin healthy OOPIF wait-for-element + click succeed without blocking on hung OOPIF.
              const waited = await handleWaitForElement(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  selector: "#healthy-oopif-btn",
                  state: "visible",
                  timeout_ms: 4_000,
                },
                { cdp: runner, tabsApi },
              );
              expect(waited).toMatchObject({
                satisfied: true,
                attached: true,
                visible: true,
                used_selector: "#healthy-oopif-btn",
              });
              const healthyClick = await runCoop("healthy-oopif-click", "tool.click", {
                selector: "#healthy-oopif-btn",
              });
              expect(healthyClick).toMatchObject({
                tab_id: 4,
                used_selector: "#healthy-oopif-btn",
              });
              expect(await evalTarget<number>(monitorHealthy, "window.healthyClicks")).toBe(1);

              // 5. Cross-frame ambiguity check still fails fast under target policy.
              const dupErr = await runCoop("dup-with-hung", "tool.click", {
                selector: ".dup-across-frames",
              });
              expect(dupErr).toMatchObject({
                code: "invalid_params",
                message: expect.stringContaining("selector matched 2 elements"),
                data: { phase: "target", effect_state: "none" },
              });
            } finally {
              (globalThis as { chrome?: unknown }).chrome = prevChrome;
              await cdp.detachAll();
            }
          },
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(tempDir, { recursive: true, force: true });
      }
    }, 60_000);

    it("verifies read redaction/RefStore preservation, file-input timeout cleanup, OOPIF drop occlusion, press keyUp, unborrowed screenshot no-scroll, and ARIA checked in real Chrome", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "bsk-pr4-e2e-"));
      const fileA = join(tempDir, "drop-note.txt");
      writeFileSync(fileA, "DROP-CONTENT");

      const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (req.url === "/drop-oopif") {
          res.end(`<!doctype html>
            <style>html,body{margin:0;padding:0}</style>
            <div id="drop-zone" style="width:240px;height:140px;background:#eef">Drop Here</div>
            <script>
              window.droppedFiles = [];
              const z = document.getElementById('drop-zone');
              z.addEventListener('dragover', (e) => e.preventDefault());
              z.addEventListener('drop', (e) => {
                e.preventDefault();
                window.droppedFiles.push(Array.from(e.dataTransfer.files, (f) => f.name));
              });
            </script>`);
          return;
        }
        const port = (server.address() as { port: number }).port;
        res.end(`<!doctype html>
          <style>body{margin:0;padding:12px;font:14px sans-serif}</style>
          <main id="csrf-card">
            <form>
              <input type="hidden" name="csrf" value="tok_secret_123">
              <input type="password" name="pw" value="hunter2">
              <button type="button" id="card-action">Order #42 — Paid</button>
            </form>
            <button type="button" id="aria-switch" role="switch" aria-checked="true">Enabled</button>
            <div id="aria-cb" role="checkbox" aria-checked="false" tabindex="0">Unchecked</div>
            <input id="native-file" type="file">
            <button type="button" id="file-trigger">Choose</button>
          </main>
          <div style="position:relative;width:240px;height:140px;margin-top:8px">
            <iframe id="drop-frame" src="http://localhost:${port}/drop-oopif" style="width:240px;height:140px;border:0;display:block"></iframe>
            <div id="parent-modal" style="position:absolute;inset:0;background:rgba(0,0,0,0.4);z-index:10">Modal</div>
          </div>
          <div style="height:2400px"></div>
          <button type="button" id="far-below">Far Below</button>
          <script>
            window.keyEvents = [];
            window.addEventListener('keydown', (e) => window.keyEvents.push('down:' + e.key));
            window.addEventListener('keyup', (e) => window.keyEvents.push('up:' + e.key));
          </script>`);
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
            const cdp = new ChromiumCdp(api);
            stubInputClock(cdp);
            const sessions = new SessionManager({
              agentWindow: {
                create: async () => ({ windowId: 100, initialTabIds: [4] }),
                remove: async () => {},
                ensureActiveTab: async () => 4,
              },
            });
            const ctx = await sessions.start("pr4-e2e");
            const tab = { id: 4, windowId: 100, active: true, url: hostUrl } as chrome.tabs.Tab;
            const tabsApi = { get: async () => tab, query: async () => [tab] };
            const evalHost = async <T>(expression: string): Promise<T> => {
              const r = await cdp.send<{ result: { value: T } }>(4, "Runtime.evaluate", {
                expression,
                returnByValue: true,
              });
              return r.result.value;
            };

            try {
              await expect.poll(() => evalHost<string>("document.readyState")).toBe("complete");
              let oopifTargetId = "";
              await expect
                .poll(async () => {
                  const { targetInfos } = await send<{
                    targetInfos: { targetId: string; type: string; url: string }[];
                  }>("Target.getTargets");
                  const found = targetInfos.find(
                    (t) => t.type === "iframe" && t.url === `http://localhost:${port}/drop-oopif`,
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

              // 1. P1 #23 & #24: read container with hidden/password inputs returns full text,
              // preserves existing rowAnchor/name in RefStore, and does not mutate RefStore on max_bytes failure.
              const doc = await cdp.send<{ root: { nodeId: number } }>(4, "DOM.getDocument");
              const btnNode = await cdp.send<{ nodeId: number }>(4, "DOM.querySelector", {
                nodeId: doc.root.nodeId,
                selector: "#card-action",
              });
              const { node: btnDesc } = await cdp.send<{ node: { backendNodeId: number } }>(
                4,
                "DOM.describeNode",
                { nodeId: btnNode.nodeId },
              );
              const graph = await cdp.getFrameDocuments(4);
              const rootDoc = graph.frames.find((f) => f.frameId === graph.rootFrameId)!;
              ctx.refStore.enableStableRefs();
              const observedRef = ctx.refStore.allocateRef({
                tabId: 4,
                frameId: rootDoc.frameId,
                loaderId: rootDoc.loaderId,
                backendNodeId: btnDesc.backendNodeId,
                name: "Order #42",
                rowAnchor: "row-42",
              });
              ctx.refStore.set(observedRef, btnDesc.backendNodeId, {
                tabId: 4,
                frameId: rootDoc.frameId,
                loaderId: rootDoc.loaderId,
                name: "Order #42",
                rowAnchor: "row-42",
              });

              const readOk = await handleRead(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  selector: "#csrf-card",
                  fields: [{ key: "text", read: "text" }],
                },
                { cdp, tabsApi },
              );
              expect(readOk).toMatchObject({
                items: [{ values: { text: expect.stringContaining("Order #42") }, redacted: [] }],
              });

              const readWithRef = await handleRead(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  selector: "#card-action",
                  fields: [{ key: "label", read: "text" }],
                },
                { cdp, tabsApi },
              );
              expect(readWithRef).toMatchObject({
                items: [{ ref: `@${observedRef}`, values: { label: "Order #42 — Paid" } }],
              });
              expect(ctx.refStore.resolveEntry(observedRef)).toMatchObject({
                kind: "dom",
                name: "Order #42",
                rowAnchor: "row-42",
              });

              await evalHost(
                `document.getElementById('aria-switch').dataset.big = 'x'.repeat(2000)`,
              );
              const sizeBeforeFail = ctx.refStore.size();
              const readTooBig = await handleRead(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  selector: "#aria-switch",
                  fields: [{ key: "big", read: "attribute", attribute: "data-big" }],
                  max_bytes: 1024,
                },
                { cdp, tabsApi },
              );
              expect(readTooBig).toMatchObject({
                code: "unsupported",
                data: { reason: "read_limit", effect_state: "none" },
              });
              expect(ctx.refStore.size()).toBe(sizeBeforeFail);
              expect(ctx.refStore.resolve("e3")).toBeNull();

              // 2. P1 #25: timed-out file-input probe arming cleans up its capture-phase listener
              // so subsequent clicks on <input type="file"> are NOT prevented.
              const triggerDoc = await cdp.send<{ root: { nodeId: number } }>(4, "DOM.getDocument");
              const triggerNode = await cdp.send<{ nodeId: number }>(4, "DOM.querySelector", {
                nodeId: triggerDoc.root.nodeId,
                selector: "#file-trigger",
              });
              const { node: triggerDesc } = await cdp.send<{ node: { backendNodeId: number } }>(
                4,
                "DOM.describeNode",
                { nodeId: triggerNode.nodeId },
              );
              let delayedArm = false;
              const slowArmCdp = delegateCdpRunner(cdp, {
                sendToFrame: (async (handle, method, params, guard) => {
                  if (
                    !delayedArm &&
                    method === "Runtime.callFunctionOn" &&
                    String(
                      (params as { functionDeclaration?: string })?.functionDeclaration,
                    ).includes("addEventListener")
                  ) {
                    delayedArm = true;
                    // Run the real arming script in Chrome, then stall past the timeout!
                    await cdp.sendToFrame(handle, method, params, guard);
                    return new Promise<never>(() => {});
                  }
                  return cdp.sendToFrame(handle, method, params, guard);
                }) as typeof cdp.sendToFrame,
              });
              const armTimeout = await uploadThroughActivatedFileInput({
                cdp: slowArmCdp,
                actionTarget: {
                  tab: { tabId: 4, windowId: 100, active: true },
                  backendNodeId: triggerDesc.backendNodeId,
                  handle: {
                    tabId: 4,
                    frameId: rootDoc.frameId,
                    loaderId: rootDoc.loaderId,
                    backendNodeId: triggerDesc.backendNodeId,
                  },
                },
                files: [fileA],
                timeoutMs: 60,
                trigger: async () => ({ tab_id: 4, x: 10, y: 10 }),
              });
              expect(armTimeout).toMatchObject({
                code: "timeout",
                data: { reason: "file_input_probe_failed", effect_state: "none" },
              });
              // Dispatch a real click event on #native-file: if the capture probe leaked,
              // `dispatchEvent` would return `false` (`defaultPrevented === true`).
              expect(
                await evalHost<boolean>(
                  "document.getElementById('native-file').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))",
                ),
              ).toBe(true);

              // 3. P1 #26: handlePress releases keyUp in finally when char dispatch fails in real Chrome.
              const failCharCdp = delegateCdpRunner(cdp, {
                sendToFrame: (async (handle, method, params, guard) => {
                  if (
                    method === "Input.dispatchKeyEvent" &&
                    (params as { type?: string })?.type === "char"
                  ) {
                    throw new Error("simulated char failure");
                  }
                  return cdp.sendToFrame(handle, method, params, guard);
                }) as typeof cdp.sendToFrame,
              });
              const pressFail = await handlePress(
                sessions,
                { session_id: ctx.sessionId, tab_id: 4, key: "a" },
                { cdp: failCharCdp, tabsApi },
              );
              expect(pressFail).toMatchObject({ code: "cdp_failed" });
              expect(await evalHost<string[]>("window.keyEvents")).toEqual(["down:a", "up:a"]);

              // 4. P1 #27: OOPIF drop target occluded by #parent-modal fails closed, then succeeds unoccluded.
              const blockedDrop = await handleUpload(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  selector: "#drop-zone",
                  mode: "drop",
                  files: [{ transfer_id: "tx-drop-1", name: "drop-note.txt", staged_path: fileA }],
                },
                { cdp, tabsApi },
              );
              expect(blockedDrop).toMatchObject({
                code: "permission_denied",
                data: { reason: "file_drop_target_unavailable", effect_state: "none" },
              });
              const evalDropOopif = async <T>(expression: string): Promise<T> => {
                const r = await send<{ result: { value: T } }>(
                  "Runtime.evaluate",
                  { expression, returnByValue: true },
                  monitorOopif,
                );
                return r.result.value;
              };
              expect(await evalDropOopif<string[][]>("window.droppedFiles")).toEqual([]);

              await evalHost("document.getElementById('parent-modal').remove()");
              const okDrop = await handleUpload(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 4,
                  selector: "#drop-zone",
                  mode: "drop",
                  files: [{ transfer_id: "tx-drop-2", name: "drop-note.txt", staged_path: fileA }],
                },
                { cdp, tabsApi },
              );
              expect(okDrop).toMatchObject({ tab_id: 4, file_names: ["drop-note.txt"] });
              expect(await evalDropOopif<string[][]>("window.droppedFiles")).toEqual([
                ["drop-note.txt"],
              ]);

              // 5. P1 #30: unborrowed user tab screenshot --ref NEVER scrolls window.scrollY.
              const farDoc = await cdp.send<{ root: { nodeId: number } }>(4, "DOM.getDocument");
              const farNode = await cdp.send<{ nodeId: number }>(4, "DOM.querySelector", {
                nodeId: farDoc.root.nodeId,
                selector: "#far-below",
              });
              const { node: farDesc } = await cdp.send<{ node: { backendNodeId: number } }>(
                4,
                "DOM.describeNode",
                { nodeId: farNode.nodeId },
              );
              ctx.refStore.set("e9", farDesc.backendNodeId, {
                tabId: 4,
                frameId: rootDoc.frameId,
                loaderId: rootDoc.loaderId,
              });
              const unborrowedTab = {
                id: 4,
                windowId: 200,
                active: true,
                url: hostUrl,
              } as chrome.tabs.Tab;
              const unborrowedTabsApi = {
                get: async () => unborrowedTab,
                query: async () => [unborrowedTab],
              };
              const unborrowedShot = await handleScreenshot(
                sessions,
                { session_id: ctx.sessionId, tab_id: 4, ref: "@e9" },
                {
                  cdp,
                  tabsApi: unborrowedTabsApi,
                  captureApi: { ...unborrowedTabsApi, captureVisibleTab: vi.fn() },
                },
              );
              expect(unborrowedShot).toMatchObject({
                code: "permission_denied",
                data: { reason: "element_not_visible" },
              });
              expect(await evalHost<number>("window.scrollY")).toBe(0);

              // Visible ref on unborrowed tab still captures cleanly with scrollY === 0.
              const visibleShot = await handleScreenshot(
                sessions,
                { session_id: ctx.sessionId, tab_id: 4, ref: "@e1" },
                {
                  cdp,
                  tabsApi: unborrowedTabsApi,
                  captureApi: { ...unborrowedTabsApi, captureVisibleTab: vi.fn() },
                },
              );
              expect(visibleShot).toMatchObject({ tab_id: 4, format: "png" });
              expect(await evalHost<number>("window.scrollY")).toBe(0);

              // 6. P2-2: ARIA checked expectations in real Chrome.
              expect(
                await checkExpectations(cdp, ctx, { tabId: 4, windowId: 100, active: true }, [
                  { target: "#aria-switch", field: "checked", equals: true },
                  { target: "#aria-cb", field: "checked", equals: false },
                ]),
              ).toBeUndefined();
              expect(
                await checkExpectations(cdp, ctx, { tabId: 4, windowId: 100, active: true }, [
                  { target: "#aria-switch", field: "checked", equals: false },
                ]),
              ).toMatchObject({ code: "permission_denied", data: { actual: true } });
            } finally {
              await cdp.detachAll();
            }
          },
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(tempDir, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
