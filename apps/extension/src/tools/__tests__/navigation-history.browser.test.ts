// @vitest-environment node
// Opt in with BSK_TEST_CHROME. The shared harness owns its browser and profile.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleNavigate, handleNavigateBack, handleNavigateForward } from "../navigation";
import type { CdpRunner } from "../shared";

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

describe.skipIf(!process.env.BSK_TEST_CHROME)("real browser history navigation", () => {
  it("completes back and forward at load when Chrome restores from the back/forward cache", async () => {
    // No Cache-Control: no-store, so both documents are bfcache eligible.
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>${request.url}</title><main>${request.url}</main>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let sessionId: string | undefined;
    const listeners = new Set<Listener>();
    const restores: string[] = [];
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
            const params = event.params as { type?: string; frame?: { url?: string } };
            if (event.method === "Page.frameNavigated" && params.type === "BackForwardCacheRestore")
              restores.push(new URL(params.frame?.url ?? origin).pathname);
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
            const reply = await send<{ result: { value: T } }>(
              "Runtime.evaluate",
              { expression, returnByValue: true },
              sessionId,
            );
            return reply.result.value;
          };
          const manager = new SessionManager({
            agentWindow: {
              create: async () => ({ windowId: 100, initialTabIds: [4] }),
              ensureActiveTab: async () => 4,
              remove: async () => {},
            },
          });
          await manager.start("history");
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
          const deps = {
            cdp,
            tabsApi: { get: tab, query: async () => [await tab()] },
            defaultTimeoutMs: 5_000,
          };
          const settledParams = { session_id: "history", wait_until: "networkidle" } as const;
          for (const path of ["/a", "/b"])
            expect(
              await handleNavigate(manager, { ...settledParams, url: origin + path }, deps),
            ).toMatchObject({ reached: "networkidle" });

          const expectedRestores: string[] = [];
          for (const waitUntil of ["commit", "domcontentloaded", "load", "networkidle"] as const) {
            const params = { session_id: "history", wait_until: waitUntil };
            const back = await handleNavigateBack(manager, params, deps);
            expect(back, `back/${waitUntil}`).toMatchObject({
              reached: waitUntil,
              final_url: `${origin}/a`,
            });
            const forward = await handleNavigateForward(manager, params, deps);
            expect(forward, `forward/${waitUntil}`).toMatchObject({
              reached: waitUntil,
              final_url: `${origin}/b`,
            });
            expectedRestores.push("/a", "/b");
          }
          // The regression only covers restores; fail loudly if Chrome stopped using bfcache.
          expect(restores).toEqual(expectedRestores);
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
