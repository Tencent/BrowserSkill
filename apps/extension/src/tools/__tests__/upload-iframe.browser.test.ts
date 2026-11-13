// @vitest-environment node
// Opt in with BSK_CLICK_CHROME; exercises Layui-style hidden input[type=file]
// uploads and cross-frame --selector resolution across same-origin iframes and
// cross-origin OOPIFs (standalone + CooperationController) in real Chrome.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggee, type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { CooperationController } from "@/cooperation/controller";
import type { CooperationFrames, FrameState } from "@/cooperation/types";
import { SessionManager } from "@/session-manager/manager";
import { handleClick } from "../interaction";
import { sessionCdpRunner } from "../shared";
import { handleUpload } from "../upload";
import { handleWaitForElement } from "../waits";

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

describe.skipIf(!process.env.BSK_CLICK_CHROME)(
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
            `<!doctype html><input class="oopif-layui-file" type="file" style="display:none">`,
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
            executable: process.env.BSK_CLICK_CHROME,
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
              onChildFramesRemapped: (tabId, remapped) =>
                sessions.remapTabChildFrames(tabId, remapped),
              onChildFramesInvalidated: (tabId, stale) => {
                sessions.invalidateTabChildFrames(tabId, stale);
                controller.invalidateChildFrames(tabId);
              },
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

              // 6. Cross-frame --selector sibling tools (wait-for-element & click) + strict ambiguity check.
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

              // 7. Cooperation frame-epoch safety: when the OOPIF navigates, child-frame --selector
              //    is refused with document_changed + effect_state: "none" until re-synchronized.
              oopifDoc = "doc-oopif-2";
              await evalHost(
                `document.getElementById('oopif-frame').src = 'http://localhost:${port}/oopif-next'`,
              );
              await expect
                .poll(async () => {
                  const { targetInfos } = await send<{
                    targetInfos: { type: string; url: string }[];
                  }>("Target.getTargets");
                  return targetInfos.some(
                    (t) => t.type === "iframe" && t.url === `http://localhost:${port}/oopif-next`,
                  );
                })
                .toBe(true);

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
            executable: process.env.BSK_CLICK_CHROME,
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
              onChildFramesRemapped: (tabId, remapped) =>
                sessions.remapTabChildFrames(tabId, remapped),
              onChildFramesInvalidated: (tabId, stale) => {
                sessions.invalidateTabChildFrames(tabId, stale);
                controller.invalidateChildFrames(tabId);
              },
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
  },
);
