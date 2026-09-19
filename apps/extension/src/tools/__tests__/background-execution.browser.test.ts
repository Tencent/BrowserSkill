// @vitest-environment node
// BSK_BACKGROUND_CHROME=/path/to/chrome runs against an isolated headed browser.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { prepareBackgroundExecution } from "../background-execution";
import { handleClick } from "../interaction";
import { handleSnapshot } from "../observation";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
const html = `<!doctype html><title>Background fixture</title>
<button id="run" disabled>Loading application</button><output id="result"></output>
<script>
window.framesRun = 0;
window.initialHidden = document.hidden;
function tick() { window.framesRun++; requestAnimationFrame(tick); }
requestAnimationFrame(tick);
requestAnimationFrame(() => requestAnimationFrame(() => {
 document.querySelector('#run').disabled = false;
 document.querySelector('#run').textContent = 'Run background task';
}));
document.querySelector('#run').onclick = () => requestAnimationFrame(() => {
 document.querySelector('#result').textContent = 'Background task complete';
});
</script>`;

// The adapter uses the real production driver over an isolated CDP transport.
// chrome.tabs.active/window focus assertions still require the extension suite.
describe.skipIf(!process.env.BSK_BACKGROUND_CHROME)(
  "background automation browser regression",
  () => {
    it("recovers an existing hidden page and completes snapshot/input/snapshot without selecting it", async () => {
      const server = createServer((_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(html);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      const url = `http://127.0.0.1:${address.port}`;
      try {
        const { withChrome } = await import(
          new URL(
            "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );
        await withChrome(
          {
            executable: process.env.BSK_BACKGROUND_CHROME,
            deviceScale: 1,
            zoom: 1,
            headless: false,
          },
          async (send: Send) => {
            const { targetInfos } = await send<{
              targetInfos: { targetId: string; type: string }[];
            }>("Target.getTargets");
            const control = targetInfos.find((target) => target.type === "page")!;
            const controlSession = (
              await send<{ sessionId: string }>("Target.attachToTarget", {
                targetId: control.targetId,
                flatten: true,
              })
            ).sessionId;
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
              url,
              background: true,
            });
            let sessionId = "";
            const calls: string[] = [];
            const listeners = new Set<(source: chrome.debugger.Debuggee, reason: string) => void>();
            const api: CdpDebuggerApi = {
              attach: async () => {
                sessionId = (
                  await send<{ sessionId: string }>("Target.attachToTarget", {
                    targetId,
                    flatten: true,
                  })
                ).sessionId;
              },
              detach: async () => {
                await send("Target.detachFromTarget", { sessionId });
                for (const listener of listeners) listener({ tabId: 7 }, "canceled_by_user");
              },
              sendCommand: async (_target, method, params) => {
                calls.push(method);
                return send(method, params, sessionId);
              },
              onEvent: {
                addListener: () => {},
                removeListener: () => {},
              } as unknown as CdpDebuggerApi["onEvent"],
              onDetach: {
                addListener: (fn: (source: chrome.debugger.Debuggee, reason: string) => void) =>
                  listeners.add(fn),
                removeListener: (fn: (source: chrome.debugger.Debuggee, reason: string) => void) =>
                  listeners.delete(fn),
              } as unknown as CdpDebuggerApi["onDetach"],
            };
            const cdp = new ChromiumCdp(api);
            const evaluate = async (expression: string, sid = sessionId) => {
              const reply = await send<{ result: { value: unknown }; exceptionDetails?: unknown }>(
                "Runtime.evaluate",
                { expression, returnByValue: true },
                sid,
              );
              expect(reply.exceptionDetails).toBeUndefined();
              return reply.result.value;
            };
            const waitFor = async (predicate: () => Promise<boolean>) => {
              const deadline = Date.now() + 5000;
              while (!(await predicate())) {
                if (Date.now() > deadline) throw new Error("Fixture condition timed out");
                await new Promise((resolve) => setTimeout(resolve, 30));
              }
            };
            try {
              await cdp.ensureAttached(7);
              await waitFor(async () => (await evaluate("document.readyState")) === "complete");
              await new Promise((resolve) => setTimeout(resolve, 500));
              expect(await evaluate("({hidden:document.hidden, frames:window.framesRun})")).toEqual(
                { hidden: true, frames: 0 },
              );
              const controlBefore = await evaluate(
                "({hidden:document.hidden,focus:document.hasFocus()})",
                controlSession,
              );
              const manager = new SessionManager({
                agentWindow: {
                  create: async () => ({ windowId: 100, initialTabIds: [] }),
                  remove: async () => {},
                  ensureActiveTab: async () => 1,
                },
              });
              const ctx = await manager.start("agent");
              ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 1 });
              const tabsApi = {
                get: async () => ({ id: 7, windowId: 100, active: false, url }) as chrome.tabs.Tab,
                query: async () => [] as chrome.tabs.Tab[],
              };
              expect(
                await prepareBackgroundExecution(
                  manager,
                  { id: "r", method: "tool.snapshot", params: { session_id: "agent", tab_id: 7 } },
                  cdp,
                  tabsApi,
                  new AbortController().signal,
                ),
              ).toBeUndefined();
              await waitFor(
                async () => (await evaluate("document.querySelector('#run').disabled")) === false,
              );
              const snapshot = await handleSnapshot(
                manager,
                { session_id: "agent", tab_id: 7 },
                { cdp, tabsApi },
              );
              expect(snapshot).not.toHaveProperty("code");
              expect(JSON.stringify(snapshot)).toContain("Run background task");
              const click = await handleClick(
                manager,
                { session_id: "agent", tab_id: 7, selector: "#run" },
                { cdp, tabsApi },
              );
              expect(click).not.toHaveProperty("code");
              await waitFor(
                async () =>
                  (await evaluate("document.querySelector('#result').textContent")) ===
                  "Background task complete",
              );
              expect(
                JSON.stringify(
                  await handleSnapshot(
                    manager,
                    { session_id: "agent", tab_id: 7 },
                    { cdp, tabsApi },
                  ),
                ),
              ).toContain("Background task complete");
              // Reattach must restore policy; subsequent navigation starts visible.
              await cdp.detach(7);
              await cdp.send(7, "Page.navigate", { url: `${url}/next` });
              await waitFor(
                async () =>
                  (await evaluate(
                    "document.readyState === 'complete' && location.pathname === '/next'",
                  )) === true,
              );
              expect(await evaluate("window.initialHidden")).toBe(false);
              expect(
                await evaluate(
                  "({hidden:document.hidden,focus:document.hasFocus()})",
                  controlSession,
                ),
              ).toEqual(controlBefore);
              expect(calls).not.toContain("Page.bringToFront");
              cdp.trackSessionTab("reader", 7);
              await cdp.releaseSessionTab("agent", 7);
              expect(await evaluate("document.hidden")).toBe(true);
              const frames = await evaluate("window.framesRun");
              await new Promise((resolve) => setTimeout(resolve, 300));
              expect(await evaluate("window.framesRun")).toBe(frames);
            } finally {
              await cdp.detachAll();
              cdp.dispose();
            }
          },
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }, 45_000);
  },
);
