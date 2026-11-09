// @vitest-environment node
// Opt in with BSK_NAV_CHROME. The shared harness owns its browser and profile.
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { handleNavigate, handleNavigateBack, handleNavigateForward } from "../navigation";
import { handleRead } from "../read";
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
  it("revokes passive-read refs after loaded-tab SPA routes, including a fresh attachment", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<title>Loaded route</title><button id="action">Act</button><iframe srcdoc="Child"></iframe>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    let sessionId: string | undefined;
    type DriverListener = Parameters<CdpDebuggerApi["onEvent"]["addListener"]>[0];
    const listeners = new Set<DriverListener>();
    const routes: string[] = [];
    let rootNavigations = 0;
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
            if (!sessionId || event.sessionId !== sessionId) return;
            const frame = (event.params as { frame?: { parentId?: string } } | undefined)?.frame;
            if (
              ["Page.frameNavigated", "Page.documentOpened"].includes(event.method) &&
              frame &&
              !frame.parentId
            )
              rootNavigations++;
            if (event.method === "Page.navigatedWithinDocument")
              routes.push((event.params as { frameId: string }).frameId);
            for (const listener of listeners) listener({ tabId: 4 }, event.method, event.params);
          },
        },
        async (send: Send) => {
          const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url });
          const attach = async () => {
            ({ sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId,
              flatten: true,
            }));
          };
          const detach = async () => {
            const old = sessionId;
            sessionId = undefined;
            await send("Target.detachFromTarget", { sessionId: old });
          };
          const evaluate = async <T>(expression: string): Promise<T> => {
            const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, returnByValue: true },
              sessionId,
            );
            expect(reply.exceptionDetails).toBeUndefined();
            return reply.result.value;
          };
          const wait = async (ready: () => Promise<boolean>) => {
            for (let i = 0; i < 100; i++) {
              if (await ready()) return;
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error("route fixture did not become ready");
          };
          // Finish the document before the driver's debugger attachment, so
          // Page.enable cannot establish its root via a new navigation event.
          await attach();
          await wait(() =>
            evaluate("document.readyState === 'complete' && document.title === 'Loaded route'"),
          );
          await detach();
          const manager = new SessionManager({
            agentWindow: {
              create: async () => ({ windowId: 100, initialTabIds: [4] }),
              ensureActiveTab: async () => 4,
              remove: async () => {},
            },
          });
          const context = await manager.start("reader");
          const cdp = new ChromiumCdp(
            {
              attach,
              detach,
              sendCommand: (_target, method, params) => send(method, params, sessionId),
              onEvent: {
                addListener: (listener: DriverListener) => listeners.add(listener),
                removeListener: (listener: DriverListener) => listeners.delete(listener),
              } as unknown as CdpDebuggerApi["onEvent"],
              onDetach: {
                addListener: () => {},
                removeListener: () => {},
              } as unknown as CdpDebuggerApi["onDetach"],
            },
            { onDocumentChanged: (tabId) => context.refStore.invalidateTab(tabId) },
          );
          const graph = vi.spyOn(cdp, "getFrameGraph");
          const tab = async () => {
            const { targetInfo } = await send<{ targetInfo: { url: string } }>(
              "Target.getTargetInfo",
              { targetId },
            );
            return {
              id: 4,
              windowId: 100,
              active: true,
              url: targetInfo.url,
            } as chrome.tabs.Tab;
          };
          const deps = { cdp, tabsApi: { get: tab, query: async () => [await tab()] } };
          try {
            for (let round = 0; round < 2; round++) {
              await cdp.ensureAttached(4);
              const first = await handleRead(
                manager,
                { session_id: "reader", selector: "#action" },
                deps,
              );
              if ("code" in first) throw new Error(JSON.stringify(first));
              expect(rootNavigations).toBe(0);
              const ref = first.items[0].ref;
              const node = context.refStore.resolve(ref, { tabId: 4 });
              expect(node).not.toBeNull();
              const routeCount = routes.length;
              await evaluate(
                `document.querySelector('iframe').contentWindow.location.hash = '#child-${round}'`,
              );
              await wait(async () => routes.length > routeCount);
              expect(context.refStore.resolve(ref, { tabId: 4 })).toBe(node);
              await evaluate("history.pushState({}, '', '/other'); history.pushState({}, '', '/')");
              await wait(async () => context.refStore.resolve(ref, { tabId: 4 }) === null);
              expect(await evaluate("location.href")).toBe(url);
              expect(await handleRead(manager, { session_id: "reader", ref }, deps)).toMatchObject({
                code: "not_found",
              });
              const fresh = await handleRead(
                manager,
                { session_id: "reader", selector: "#action" },
                deps,
              );
              if ("code" in fresh) throw new Error(JSON.stringify(fresh));
              expect(context.refStore.resolve(fresh.items[0].ref, { tabId: 4 })).toBe(node);
              expect(graph).not.toHaveBeenCalled();
              await cdp.detach(4);
            }
          } finally {
            await cdp.detachAll();
            cdp.dispose();
            await manager.stop("reader");
          }
        },
      );
    } finally {
      listeners.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

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
