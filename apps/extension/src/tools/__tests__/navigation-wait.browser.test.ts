// @vitest-environment node
// Opt in with BSK_TEST_CHROME. The shared harness owns its browser and profile.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "../shared";
import { handleWaitForNavigation } from "../waits";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type Listener = Parameters<NonNullable<CdpRunner["onEvent"]>>[1];
interface CdpEvent {
  sessionId?: string;
  method: string;
  params?: object;
}

const START_PAGE = `<!doctype html><title>Start</title>
<button id="delayed" onclick="setTimeout(() => { location.href = '/next'; }, 120)">Delayed</button>
<a id="link" href="/next">Next</a>
<a id="redirect" href="/callback">Redirect</a>
<a id="hash" href="#section">Hash</a>
<button id="noop">No navigation</button>
<div id="section">Section</div>`;

describe.skipIf(!process.env.BSK_TEST_CHROME)("real browser wait_for_navigation", () => {
  it("waits for scheduled, in-flight, client-redirected and same-document navigations", async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      if (request.url === "/callback") {
        response.end(
          "<!doctype html><title>Callback</title><script>location.replace('/next')</script>",
        );
        return;
      }
      if (request.url === "/next") {
        // Longer than navigationStartGraceMs (300ms) so in-flight detection is required.
        setTimeout(() => response.end("<!doctype html><title>Next</title>Next"), 500);
        return;
      }
      response.end(START_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    let sessionId: string | undefined;
    let pendingUrl: string | undefined;
    const listeners = new Set<Listener>();
    try {
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
          onEvent: (event: CdpEvent) => {
            if (!sessionId || event.sessionId !== sessionId) return;
            const p = (event.params ?? {}) as {
              url?: string;
              navigationType?: string;
              frame?: { parentId?: string };
            };
            if (
              event.method === "Page.frameStartedNavigating" &&
              p.navigationType !== "sameDocument" &&
              p.navigationType !== "historySameDocument"
            ) {
              pendingUrl = p.url;
            } else if (
              (event.method === "Page.frameNavigated" && !p.frame?.parentId) ||
              event.method === "Page.frameStoppedLoading"
            ) {
              pendingUrl = undefined;
            }
            for (const listener of [...listeners])
              listener({ tabId: 4 }, event.method, event.params);
          },
        },
        async (send: Send) => {
          const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
            url: "about:blank",
          });
          ({ sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId,
            flatten: true,
          }));
          await send("Page.enable", {}, sessionId);
          const evaluate = async <T>(expression: string): Promise<T> => {
            const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, returnByValue: true },
              sessionId,
            );
            expect(reply.exceptionDetails).toBeUndefined();
            return reply.result.value;
          };
          const load = async () => {
            pendingUrl = undefined;
            await send("Page.navigate", { url }, sessionId);
            await expect
              .poll(() =>
                evaluate("document.title === 'Start' && document.readyState === 'complete'"),
              )
              .toBe(true);
            pendingUrl = undefined;
          };
          const manager = new SessionManager({
            agentWindow: {
              create: async () => ({ windowId: 100, initialTabIds: [4] }),
              ensureActiveTab: async () => 4,
              remove: async () => {},
            },
          });
          await manager.start("wait-nav");
          const cdp: CdpRunner = {
            send: <T>(_tabId: number, method: string, params?: object) =>
              send<T>(method, params, sessionId),
            onEvent: (_tabId, listener) => {
              listeners.add(listener);
              return { dispose: () => void listeners.delete(listener) };
            },
          };
          const tab = async () =>
            ({
              id: 4,
              windowId: 100,
              active: true,
              url: await evaluate<string>("location.href"),
              ...(pendingUrl ? { pendingUrl } : {}),
            }) as chrome.tabs.Tab;
          const deps = {
            cdp,
            tabsApi: { get: tab, query: async () => [await tab()] },
            navigationStartGraceMs: 300,
          };
          const wait = (waitUntil: "load" | "networkidle" = "load", graceMs = 300) =>
            handleWaitForNavigation(
              manager,
              { session_id: "wait-nav", wait_until: waitUntil, timeout_ms: 5_000 },
              { ...deps, navigationStartGraceMs: graceMs },
            );

          for (const trigger of ["#delayed", "#link", "#redirect"]) {
            await load();
            await evaluate(`document.querySelector(${JSON.stringify(trigger)}).click(), true`);
            const result = await wait();
            expect(result, trigger).toMatchObject({ reached: "load" });
            expect(await evaluate("location.pathname"), trigger).toBe("/next");
            expect(await evaluate("document.readyState"), trigger).toBe("complete");
            expect(listeners.size).toBe(0);
          }

          for (const phase of ["load", "networkidle"] as const) {
            await load();
            const hashStart = Date.now();
            const hashWait = wait(phase, 2_000);
            setTimeout(() => {
              void evaluate("document.querySelector('#hash').click(), true");
            }, 60);
            expect(await hashWait, `hash/${phase}`).toMatchObject({ reached: phase });
            expect(Date.now() - hashStart, `hash/${phase}`).toBeLessThan(1_200);
            expect(await evaluate("location.hash"), `hash/${phase}`).toBe("#section");
            expect(listeners.size).toBe(0);
          }

          await load();
          await evaluate("document.querySelector('#delayed').click(), true");
          expect(await wait("networkidle", 300)).toMatchObject({ reached: "networkidle" });
          expect(await evaluate("location.pathname")).toBe("/next");
          expect(listeners.size).toBe(0);

          for (const phase of ["load", "networkidle"] as const) {
            await load();
            await evaluate("document.querySelector('#noop').click(), true");
            const started = Date.now();
            expect(await wait(phase, 300), `noop/${phase}`).toMatchObject({ reached: phase });
            expect(Date.now() - started, `noop/${phase}`).toBeLessThan(2_000);
            expect(await evaluate("location.pathname")).toBe("/");
            expect(listeners.size).toBe(0);
          }
        },
      );
    } finally {
      listeners.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 60_000);
});
