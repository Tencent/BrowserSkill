// @vitest-environment node
// Opt in with BSK_NAV_CHROME. The shared harness owns its browser and profile.
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
interface FrameTree {
  frameTree: { frame: { id: string; loaderId: string } };
}

describe.skipIf(!process.env.BSK_NAV_CHROME)("real browser same-document navigation", () => {
  it("reuses the document for navigate, back and forward at every lifecycle checkpoint", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Navigation fixture</title><main>Same document</main>");
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
          const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url });
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
          const ready = () =>
            evaluate<boolean>(
              "document.readyState === 'complete' && document.title === 'Navigation fixture'",
            );
          for (let attempt = 0; attempt < 100 && !(await ready()); attempt += 1)
            await new Promise((resolve) => setTimeout(resolve, 20));
          expect(await ready(), "the initial document must finish loading").toBe(true);
          const initial = await send<FrameTree>("Page.getFrameTree", {}, sessionId);
          const manager = new SessionManager({
            agentWindow: {
              create: async () => ({ windowId: 100, initialTabIds: [4] }),
              ensureActiveTab: async () => 4,
              remove: async () => {},
            },
          });
          await manager.start("navigation");
          const cdp: CdpRunner = {
            send: <T>(_tabId: number, method: string, params?: object) =>
              send<T>(method, params, sessionId),
            onEvent: (listener) => {
              listeners.add(listener);
              return {
                dispose: () => {
                  listeners.delete(listener);
                },
              };
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
          for (const phase of ["commit", "domcontentloaded", "load", "networkidle"] as const) {
            const previousUrl = await evaluate<string>("location.href");
            const destination = `${url}#${phase}`;
            const params = { session_id: "navigation", wait_until: phase };
            for (const operation of ["navigate", "back", "forward"] as const) {
              const result =
                operation === "navigate"
                  ? await handleNavigate(manager, { ...params, url: destination }, deps)
                  : operation === "back"
                    ? await handleNavigateBack(manager, params, deps)
                    : await handleNavigateForward(manager, params, deps);
              expect(result, `${operation}/${phase}`).toMatchObject({
                reached: phase,
                final_url: operation === "back" ? previousUrl : destination,
              });
              const current = await send<FrameTree>("Page.getFrameTree", {}, sessionId);
              expect(current.frameTree.frame.loaderId).toBe(initial.frameTree.frame.loaderId);
              expect(listeners.size).toBe(0);
            }
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
