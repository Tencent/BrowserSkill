// @vitest-environment node
// Opt in with BSK_TEST_CHROME; the harness owns an isolated browser/profile.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { type DownloadsApi, handleDownload } from "../download";
import { type CdpRunner, delegateCdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

async function browser(
  run: (send: Send, cdp: ChromiumCdp, sessionId: () => string) => Promise<void>,
) {
  const { withChrome } = await import(
    new URL(
      "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
      import.meta.url,
    ).href
  );
  await withChrome(
    {
      executable: process.env.BSK_TEST_CHROME,
      deviceScale: 1,
      zoom: 1,
      startupTimeout: 30_000,
    },
    async (send: Send) => {
      const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      let activeSession = "";
      const api: CdpDebuggerApi = {
        attach: async () => {
          const reply = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId,
            flatten: true,
          });
          activeSession = reply.sessionId;
        },
        detach: async () => {
          await send("Target.detachFromTarget", { sessionId: activeSession });
          activeSession = "";
        },
        sendCommand: async (_target, method, params) => send(method, params, activeSession),
        onEvent: { addListener() {}, removeListener() {} } as unknown as CdpDebuggerApi["onEvent"],
        onDetach: {
          addListener() {},
          removeListener() {},
        } as unknown as CdpDebuggerApi["onDetach"],
      };
      const cdp = new ChromiumCdp(api);
      try {
        await run(send, cdp, () => activeSession);
      } finally {
        await cdp.detach(7);
      }
    },
  );
}

function manager() {
  return new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
}
const tab = { id: 7, windowId: 100, active: true, url: "about:blank" } as chrome.tabs.Tab;
const tabsApi = { get: async () => tab, query: async () => [tab] };

describe.skipIf(!process.env.BSK_TEST_CHROME)("download effect metadata", () => {
  it("a cancelled export whose click reached the page reports an unknown effect", async () => {
    await browser(async (_send, cdp) => {
      const sessions = manager();
      const ctx = await sessions.start("download-effect");
      await cdp.send(7, "Runtime.evaluate", {
        expression: `
        document.body.innerHTML = '<button id="export" style="width:200px;height:100px">Export</button>';
        window.startedExports = 0;
        document.querySelector('#export').onclick = () => { window.startedExports++; };
      `,
      });
      const ac = new AbortController();
      const wrapped: CdpRunner = delegateCdpRunner(cdp, {
        send: (async (tabId: number, method: string, params?: object) => {
          const reply = await cdp.send(tabId, method, params);
          if (
            method === "Input.dispatchMouseEvent" &&
            (params as { type?: string })?.type === "mouseReleased"
          )
            ac.abort();
          return reply;
        }) as CdpRunner["send"],
        onEvent: () => ({ dispose() {} }),
      });
      const event = () => ({ addListener() {}, removeListener() {} });
      const downloads = {
        onCreated: event(),
        onChanged: event(),
        onDeterminingFilename: event(),
        search: async () => [],
        cancel: async () => {},
        removeFile: async () => {},
      };
      const result = await handleDownload(
        sessions,
        {
          session_id: ctx.sessionId,
          tab_id: 7,
          selector: "#export",
          browser_relative_dir: "BrowserSkill/audit",
          timeout_ms: 2000,
        },
        {
          cdp: wrapped,
          tabsApi,
          downloads,
          signal: ac.signal,
          navigationTargets: { onCreatedNavigationTarget: event() },
        },
      );
      const startedExports = (
        await cdp.send<{ result: { value: number } }>(7, "Runtime.evaluate", {
          expression: "startedExports",
          returnByValue: true,
        })
      ).result.value;
      console.log("DOWNLOAD_EFFECT_PROOF", JSON.stringify({ startedExports, result }));
      expect(startedExports).toBe(1);
      expect(result).toMatchObject({ data: { effect_state: "unknown" } });
    });
  }, 40_000);

  it("attributes downloads triggered via hidden same-origin iframe, form target iframe, and cross-origin CDN iframe in real Chrome", async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/export-same")) {
        res.writeHead(200, {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="same-report.csv"',
        });
        res.end("a,b\n1,2\n");
        return;
      }
      if (req.url?.startsWith("/export-cdn")) {
        res.writeHead(200, {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="cdn-report.csv"',
        });
        res.end("x,y\n3,4\n");
        return;
      }
      if (req.url === "/cdn-oopif") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><script>
          window.addEventListener('message', (e) => {
            if (e.data === 'download') window.location.href = '/export-cdn';
          });
        </script>`);
        return;
      }
      const port = (server.address() as { port: number }).port;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <button id="btn-same" style="width:160px;height:40px">Same Iframe</button>
        <button id="btn-form" style="width:160px;height:40px">Form CDN Iframe</button>
        <button id="btn-oopif" style="width:160px;height:40px">Preexisting OOPIF</button>
        <iframe name="hidden-form-target" style="display:none"></iframe>
        <form id="cdn-form" target="hidden-form-target" action="http://localhost:${port}/export-cdn" method="GET"></form>
        <iframe id="cdn-oopif" src="http://localhost:${port}/cdn-oopif" style="width:200px;height:60px"></iframe>
        <script>
          document.getElementById('btn-same').onclick = () => {
            const f = document.createElement('iframe');
            f.style.display = 'none';
            f.src = '/export-same';
            document.body.appendChild(f);
          };
          document.getElementById('btn-form').onclick = () => {
            document.getElementById('cdn-form').submit();
          };
          document.getElementById('btn-oopif').onclick = () => {
            document.getElementById('cdn-oopif').contentWindow.postMessage('download', '*');
          };
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
      type CdpEvent = { sessionId?: string; method: string; params?: Record<string, unknown> };
      type CdpListener = Parameters<CdpDebuggerApi["onEvent"]["addListener"]>[0];
      let forward: ((event: CdpEvent) => void) | undefined;

      await withChrome(
        {
          executable: process.env.BSK_TEST_CHROME,
          deviceScale: 1,
          zoom: 1,
          startupTimeout: 30_000,
          onEvent: (event: CdpEvent) => forward?.(event),
        },
        async (send: Send) => {
          const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
            url: hostUrl,
          });
          // Prevent Chrome from writing files to the host filesystem; CDP still
          // emits real `Page.downloadWillBegin` with the real frameId/sessionId.
          await send("Browser.setDownloadBehavior", { behavior: "deny" });

          let activeRoot = "";
          const childSessions = new Set<string>();
          const listeners = new Set<CdpListener>();
          const onCreatedListeners = new Set<(item: chrome.downloads.DownloadItem) => void>();
          const onChangedListeners = new Set<(delta: chrome.downloads.DownloadDelta) => void>();
          const onDeterminingListeners = new Set<
            (
              item: chrome.downloads.DownloadItem,
              suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
            ) => void | true
          >();
          let nextDownloadId = 100;
          const completed = new Map<number, chrome.downloads.DownloadItem>();

          const triggerChromeDownloadApi = (url: string, suggestedFilename: string) => {
            const id = ++nextDownloadId;
            const initial = {
              id,
              url,
              finalUrl: url,
              filename: suggestedFilename,
              state: "in_progress",
              fileSize: -1,
              totalBytes: 8,
            } as chrome.downloads.DownloadItem;
            const finish = (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => {
              const routedPath = suggestion?.filename
                ? `/downloads/${suggestion.filename}`
                : `/downloads/default/${suggestedFilename}`;
              const done = {
                ...initial,
                filename: routedPath,
                state: "complete",
                fileSize: 8,
              } as chrome.downloads.DownloadItem;
              completed.set(id, done);
              for (const fn of [...onCreatedListeners]) fn(done);
            };
            const listenersList = [...onDeterminingListeners];
            if (listenersList.length === 0) {
              finish(undefined);
              return;
            }
            for (const fn of listenersList) {
              fn(initial, finish);
            }
          };

          forward = (event) => {
            if (!activeRoot) return;
            if (event.method === "Target.attachedToTarget" && event.sessionId === activeRoot) {
              const sid = event.params?.sessionId as string | undefined;
              if (sid) childSessions.add(sid);
            }
            if (event.sessionId === activeRoot) {
              for (const fn of [...listeners]) fn({ tabId: 7 }, event.method, event.params);
            } else if (event.sessionId && childSessions.has(event.sessionId)) {
              for (const fn of [...listeners])
                fn({ tabId: 7, sessionId: event.sessionId }, event.method, event.params);
            }
            if (event.method === "Page.downloadWillBegin") {
              const url = String(event.params?.url ?? "");
              const name = String(event.params?.suggestedFilename ?? "file.bin");
              setTimeout(() => triggerChromeDownloadApi(url, name), 10);
            }
          };

          const api: CdpDebuggerApi = {
            attach: async () => {
              childSessions.clear();
              const reply = await send<{ sessionId: string }>("Target.attachToTarget", {
                targetId,
                flatten: true,
              });
              activeRoot = reply.sessionId;
            },
            detach: async () => {
              if (activeRoot) await send("Target.detachFromTarget", { sessionId: activeRoot });
              activeRoot = "";
              childSessions.clear();
            },
            sendCommand: async (target, method, params) =>
              send(method, params, target.sessionId ?? activeRoot),
            onEvent: {
              addListener: (fn: CdpListener) => listeners.add(fn),
              removeListener: (fn: CdpListener) => listeners.delete(fn),
            } as unknown as CdpDebuggerApi["onEvent"],
            onDetach: {
              addListener() {},
              removeListener() {},
            } as unknown as CdpDebuggerApi["onDetach"],
          };

          const cdp = new ChromiumCdp(api);
          const downloads: DownloadsApi = {
            onCreated: {
              addListener: (fn) => onCreatedListeners.add(fn),
              removeListener: (fn) => onCreatedListeners.delete(fn),
            },
            onChanged: {
              addListener: (fn) => onChangedListeners.add(fn),
              removeListener: (fn) => onChangedListeners.delete(fn),
            },
            onDeterminingFilename: {
              addListener: (fn) => onDeterminingListeners.add(fn),
              removeListener: (fn) => onDeterminingListeners.delete(fn),
            },
            search: async ({ id }) =>
              id !== undefined && completed.has(id) ? [completed.get(id)!] : [],
            cancel: async () => {},
            removeFile: async () => {},
          };
          const navEvent = { addListener() {}, removeListener() {} };
          const pageTab = { id: 7, windowId: 100, active: true, url: hostUrl } as chrome.tabs.Tab;
          const pageTabsApi = { get: async () => pageTab, query: async () => [pageTab] };

          try {
            const sessions = manager();
            const ctx = await sessions.start("download-iframe-e2e");
            // Wait for main page and cross-origin OOPIF to finish loading via a
            // separate monitor session so `cdp` starts completely cold (no prior
            // observe or getFrameDocuments call).
            const { sessionId: monitorSession } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId, flatten: true },
            );
            await expect
              .poll(async () => {
                const reply = await send<{ result: { value: string } }>(
                  "Runtime.evaluate",
                  { expression: "document.readyState", returnByValue: true },
                  monitorSession,
                );
                return reply.result.value;
              })
              .toBe("complete");
            await expect
              .poll(async () => {
                const { targetInfos } = await send<{
                  targetInfos: { type: string; url: string }[];
                }>("Target.getTargets");
                return targetInfos.some(
                  (t) => t.type === "iframe" && t.url === `http://localhost:${port}/cdn-oopif`,
                );
              })
              .toBe(true);
            await send("Target.detachFromTarget", { sessionId: monitorSession });

            // Run the pre-existing cross-origin OOPIF case FIRST on a cold CDP
            // attachment before any frame discovery has happened.
            for (const [selector, dir, expectedName] of [
              ["#btn-oopif", "BrowserSkill/oopif-cdn", "cdn-report.csv"],
              ["#btn-form", "BrowserSkill/form-cdn", "cdn-report.csv"],
              ["#btn-same", "BrowserSkill/same-iframe", "same-report.csv"],
            ] as const) {
              const res = await handleDownload(
                sessions,
                {
                  session_id: ctx.sessionId,
                  tab_id: 7,
                  selector,
                  browser_relative_dir: dir,
                  timeout_ms: 5_000,
                },
                {
                  cdp,
                  tabsApi: pageTabsApi,
                  downloads,
                  navigationTargets: { onCreatedNavigationTarget: navEvent },
                },
              );
              expect(res, `download via ${selector}: ${JSON.stringify(res)}`).toMatchObject({
                tab_id: 7,
                suggested_filename: expectedName,
                browser_path: `/downloads/${dir}/${expectedName}`,
              });
            }
          } finally {
            await cdp.detach(7);
          }
        },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 45_000);
});
