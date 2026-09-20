// @vitest-environment node
// Owns an isolated browser and fixture; never freezes a user's tab.
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { type DebugCdp, DebugManager } from "../manager";

it.skipIf(!process.env.BSK_CLICK_CHROME)(
  "bounds pre-reads on a frozen renderer and restores manual capture after late hooks",
  async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><button style="width:200px;height:60px">Manual capture</button>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { withChrome } = await import(
        new URL(
          "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      let listener: Parameters<NonNullable<DebugCdp["onEvent"]>>[0] | undefined;
      await withChrome(
        {
          executable: process.env.BSK_CLICK_CHROME,
          deviceScale: 1,
          zoom: 1,
          startupTimeout: 30000,
          onEvent: (event: { method: string; params?: object }) =>
            listener?.({ tabId: 7 }, event.method, event.params),
        },
        async (send: (method: string, params?: object, sessionId?: string) => Promise<any>) => {
          const { targetId } = await send("Target.createTarget", { url: "about:blank" });
          const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
          const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
          await send("Page.enable", {}, sessionId);
          await send("Runtime.enable", {}, sessionId);
          await send("Page.navigate", { url }, sessionId);
          await send("Runtime.evaluate", { expression: "document.readyState" }, sessionId);
          const sessions = new SessionManager({
            agentWindow: {
              create: async () => ({ windowId: 100, initialTabIds: [7] }),
              remove: async () => {},
              ensureActiveTab: async () => 7,
            },
          });
          (await sessions.start("s1")).agentCreatedTabs.add(7);
          const hooks: object[] = [];
          const cdp = {
            sendAttached: (_target: unknown, method: string, params?: { expression?: string }) => {
              if (method === "Runtime.evaluate" && params?.expression?.includes(".agent(true,"))
                hooks.push(params);
              return send(method, params, sessionId);
            },
            ensureNetworkCapture: async () => {
              await send("Network.enable", {}, sessionId);
            },
            onEvent: (fn: typeof listener) => {
              listener = fn;
              return {
                dispose() {
                  listener = undefined;
                },
              };
            },
          } as unknown as DebugCdp;
          const tabs = {
            get: async () => ({ id: 7, windowId: 100, url }) as chrome.tabs.Tab,
            query: async () => [{ id: 7 } as chrome.tabs.Tab],
          };
          const manager = new DebugManager(sessions, cdp, tabs);
          try {
            await manager.start("s1", 7);
            await send(
              "Runtime.evaluate",
              { expression: "setTimeout(()=>{while(true){}},50);true" },
              sessionId,
            );
            await new Promise((resolve) => setTimeout(resolve, 150));
            const before = Date.now();
            const ticket = await manager.before({
              id: "nav",
              method: "tool.navigate",
              params: { session_id: "s1", tab_id: 7 },
            });
            expect(Date.now() - before).toBeLessThan(1800);
            expect(ticket).toBeDefined();
            manager.after(ticket);
            expect((await send("Browser.getVersion")).product).toContain("Chrome");
          } finally {
            await send("Runtime.terminateExecution", {}, sessionId);
          }
          try {
            // Re-deliver the obsolete enable after the disable and its admission deadline.
            // It must not suppress subsequent genuine user input.
            await send("Runtime.evaluate", { expression: "true" }, sessionId);
            expect(hooks).toHaveLength(1);
            await send("Runtime.evaluate", hooks[0], sessionId);
            await send(
              "Input.dispatchMouseEvent",
              { type: "mousePressed", x: 40, y: 30, button: "left", clickCount: 1 },
              sessionId,
            );
            await send(
              "Input.dispatchMouseEvent",
              { type: "mouseReleased", x: 40, y: 30, button: "left", clickCount: 1 },
              sessionId,
            );
            await send("Runtime.evaluate", { expression: "true" }, sessionId);
            await new Promise((resolve) => setTimeout(resolve, 50));
            const result = await manager.read({ session_id: "s1", action: "operations" });
            expect(
              result.operations?.some(
                (operation) =>
                  operation.source === "human" && operation.target === "Manual capture",
              ),
            ).toBe(true);
          } finally {
            manager.dispose();
          }
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  15000,
);
