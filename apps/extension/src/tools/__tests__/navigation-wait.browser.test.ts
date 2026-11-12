// @vitest-environment node
// Opt in with BSK_NAV_CHROME. The shared harness owns its browser and profile.
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
type Listener = Parameters<NonNullable<CdpRunner["onEvent"]>>[0];
interface CdpEvent {
  sessionId?: string;
  method: string;
  params?: object;
}

const START_PAGE = `<!doctype html><title>Start</title>
<button id="delayed" onclick="setTimeout(() => { location.href = '/next'; }, 600)">Delayed</button>
<a id="link" href="/next">Next</a>
<button id="noop">No navigation</button>`;

describe.skipIf(!process.env.BSK_NAV_CHROME)("real browser wait_for_navigation", () => {
  it("waits for scheduled and in-flight navigations instead of the settled page", async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      if (request.url === "/next") {
        // Keep the successor in flight for a moment so the old page stays complete.
        setTimeout(() => response.end("<!doctype html><title>Next</title>Next"), 150);
        return;
      }
      response.end(START_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    let sessionId: string | undefined;
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
          executable: process.env.BSK_NAV_CHROME,
          deviceScale: 1,
          zoom: 1,
          startupTimeout: 30_000,
          onEvent: (event: CdpEvent) => {
            if (sessionId && event.sessionId === sessionId)
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
            await send("Page.navigate", { url }, sessionId);
            await expect
              .poll(() =>
                evaluate("document.title === 'Start' && document.readyState === 'complete'"),
              )
              .toBe(true);
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
            onEvent: (listener) => {
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
            }) as chrome.tabs.Tab;
          const deps = { cdp, tabsApi: { get: tab, query: async () => [await tab()] } };
          const wait = () =>
            handleWaitForNavigation(
              manager,
              { session_id: "wait-nav", wait_until: "load", timeout_ms: 5_000 },
              deps,
            );

          for (const trigger of ["#delayed", "#link"]) {
            await load();
            await evaluate(`document.querySelector(${JSON.stringify(trigger)}).click(), true`);
            const result = await wait();
            expect(result, trigger).toMatchObject({ reached: "load" });
            expect(await evaluate("location.pathname"), trigger).toBe("/next");
            expect(await evaluate("document.readyState"), trigger).toBe("complete");
            expect(listeners.size).toBe(0);
          }

          await load();
          await evaluate("document.querySelector('#noop').click(), true");
          const started = Date.now();
          expect(await wait()).toMatchObject({ reached: "load" });
          expect(Date.now() - started).toBeLessThan(4_000);
          expect(await evaluate("location.pathname")).toBe("/");
          expect(listeners.size).toBe(0);
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
