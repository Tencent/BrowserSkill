// @vitest-environment node
// Opt in with BSK_CLICK_CHROME; each test owns its browser, profile and HTTP server.
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggee, type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { prepareBackgroundExecution } from "../background-execution";
import { handleClick, handlePress } from "../interaction";
import { handleObserve } from "../observation";
import type { CdpRunner } from "../shared";
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

type CdpEventListener = (source: CdpDebuggee, method: string, params: unknown) => void;

describe.skipIf(!process.env.BSK_CLICK_CHROME)("real browser click readiness", () => {
  it("delivers hidden native input, preserves disabled semantics and restores visibility", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><button id="target">Click</button><a id="link" href="/next">Next</a>
        <form><button id="submit">Save</button></form><div style="height:5000px"></div>
        <script>window.keys=[];window.wheels=[];window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();submits++};document.addEventListener('keydown',e=>keys.push(e.isTrusted));document.addEventListener('wheel',e=>wheels.push(e.isTrusted),{passive:true});window.clicks=[];document.querySelector('#target').onclick=e=>clicks.push(e.isTrusted);</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const { withChrome } = await import(
        new URL(
          "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      let onEvent: ((event: CdpEvent) => void) | undefined;
      await withChrome(
        {
          executable: process.env.BSK_CLICK_CHROME,
          deviceScale: 1.5,
          zoom: 1,
          // A standalone CI job starts Chrome cold, before frontend work warms the runner.
          startupTimeout: 30_000,
          onEvent: (event: CdpEvent) => onEvent?.(event),
        },
        async (send: Send) => {
          const page = async (background: boolean) => {
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
              url,
              background,
            });
            const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId,
              flatten: true,
            });
            await send("Page.enable", {}, sessionId);
            const evaluate = async <T>(expression: string) => {
              const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
                "Runtime.evaluate",
                { expression, returnByValue: true },
                sessionId,
              );
              expect(reply.exceptionDetails).toBeUndefined();
              return reply.result.value;
            };
            for (let i = 0; i < 100; i++) {
              if (await evaluate("Array.isArray(window.clicks)")) break;
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(await evaluate("Array.isArray(window.clicks)")).toBe(true);
            return { targetId, sessionId, evaluate };
          };
          const foreground = await page(false);
          const manager = new SessionManager({
            agentWindow: {
              create: async () => ({ windowId: 100, initialTabIds: [] }),
              remove: async () => {},
              ensureActiveTab: async () => 4,
            },
          });
          const ctx = await manager.start("click-test");
          for (const mode of [
            "selector",
            "ref",
            "selector",
            "ref",
            "navigation",
            "press",
            "wheel",
            "wheel-scrolled",
            "foreground",
            "disabled-native",
            "disabled-fieldset",
            "disabled-aria",
          ] as const) {
            const hidden = mode !== "foreground";
            // Chrome's selected tab after closing a foreground target varies by
            // platform. Establish the fixture foreground before testing hidden input.
            if (hidden) await send("Page.bringToFront", {}, foreground.sessionId);
            const target = await page(hidden);
            expect(await target.evaluate("document.visibilityState")).toBe(
              hidden ? "hidden" : "visible",
            );
            const commands: { method: string; params?: object }[] = [];
            const cdp: CdpRunner = {
              send: async (_tabId, method, params) => {
                commands.push({ method, params });
                return (await send(method, params, target.sessionId)) as never;
              },
              getAttachmentId: () => target.sessionId,
            };
            const tab = { id: 4, windowId: 100, active: !hidden } as chrome.tabs.Tab;
            const tabsApi = { get: async () => tab, query: async () => [tab] };
            let action: { ref?: string; selector?: string } = {
              selector: mode === "navigation" ? "#link" : "#target",
            };
            if (mode === "ref") {
              const { root } = await send<{ root: { nodeId: number } }>(
                "DOM.getDocument",
                {},
                target.sessionId,
              );
              const { nodeId } = await send<{ nodeId: number }>(
                "DOM.querySelector",
                { nodeId: root.nodeId, selector: "#target" },
                target.sessionId,
              );
              const { node } = await send<{ node: { backendNodeId: number } }>(
                "DOM.describeNode",
                { nodeId },
                target.sessionId,
              );
              ctx.refStore.set("e1", node.backendNodeId, { tabId: 4 });
              action = { ref: "e1" };
            }
            if (mode === "wheel-scrolled") await target.evaluate("scrollTo(0,1000)");
            if (mode === "disabled-native")
              await target.evaluate("document.querySelector('#target').disabled = true");
            if (mode === "disabled-fieldset")
              await target.evaluate(
                "(() => { const group = document.createElement('fieldset'); group.disabled = true; document.body.prepend(group); group.append(document.querySelector('#target')); })()",
              );
            if (mode === "disabled-aria")
              await target.evaluate(
                "document.querySelector('#target').setAttribute('aria-disabled','true')",
              );
            const result =
              mode === "press"
                ? await handlePress(
                    manager,
                    { session_id: ctx.sessionId, tab_id: 4, selector: "#submit", key: "Enter" },
                    { cdp, tabsApi },
                  )
                : mode === "wheel" || mode === "wheel-scrolled"
                  ? await handleWheel(
                      manager,
                      { session_id: ctx.sessionId, tab_id: 4, delta_y: 300 },
                      { cdp, tabsApi },
                    )
                  : await handleClick(
                      manager,
                      { session_id: ctx.sessionId, tab_id: 4, ...action },
                      { cdp, tabsApi },
                    );
            expect(result, JSON.stringify(result)).not.toHaveProperty("message");
            expect(commands.some((c) => c.method === "Accessibility.getPartialAXTree")).toBe(false);
            if (mode === "navigation") {
              for (let i = 0; i < 100; i++) {
                if (
                  await target.evaluate(
                    "location.pathname === '/next' && document.readyState === 'complete'",
                  )
                )
                  break;
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
              expect(await target.evaluate("location.pathname")).toBe("/next");
            } else if (mode === "press") {
              expect(await target.evaluate("window.submits")).toBe(1);
              expect(await target.evaluate("window.keys")).toEqual([true]);
            } else if (mode === "wheel" || mode === "wheel-scrolled") {
              const startY = mode === "wheel-scrolled" ? 1000 : 0;
              for (
                let i = 0;
                i < 100 && !(await target.evaluate<boolean>("scrollY > " + startY));
                i++
              )
                await new Promise((resolve) => setTimeout(resolve, 20));
              expect(await target.evaluate<number>("scrollY")).toBeGreaterThan(startY);
              expect(await target.evaluate("window.wheels")).toEqual([true]);
            } else
              expect(await target.evaluate("window.clicks")).toEqual(
                mode === "disabled-native" || mode === "disabled-fieldset" ? [] : [true],
              );
            expect(await target.evaluate("document.visibilityState")).toBe(
              hidden ? "hidden" : "visible",
            );
            if (hidden)
              expect(await foreground.evaluate("document.visibilityState")).toBe("visible");
            else
              expect(commands.some((c) => c.method === "Emulation.setFocusEmulationEnabled")).toBe(
                false,
              );
            console.log(
              "CLICK-READINESS",
              JSON.stringify({
                mode,
                result,
                visibility: await target.evaluate("document.visibilityState"),
              }),
            );
            await send("Target.closeTarget", { targetId: target.targetId });
          }

          // Exercise production document invalidation with real Chrome events,
          // including a navigation control so a disconnected listener cannot pass.
          await send("Page.bringToFront", {}, foreground.sessionId);
          const target = await page(true);
          const listeners = new Set<CdpEventListener>();
          let documentUpdates = 0;
          onEvent = (event) => {
            if (event.sessionId !== target.sessionId) return;
            if (event.method === "DOM.documentUpdated") documentUpdates++;
            for (const listener of listeners) listener({ tabId: 4 }, event.method, event.params);
          };
          const readinessCommands: { method: string; elapsedMs?: number; state: string }[] = [];
          const api: CdpDebuggerApi = {
            // page() already attached the root debugger session.
            attach: async () => {},
            detach: async () => {
              await send("Target.detachFromTarget", { sessionId: target.sessionId });
            },
            sendCommand: async (debuggee, method, params) => {
              const call = { method, state: "pending", elapsedMs: undefined as number | undefined };
              readinessCommands.push(call);
              const started = performance.now();
              try {
                const result = await send(method, params, debuggee.sessionId ?? target.sessionId);
                call.state = "complete";
                return result;
              } catch (error) {
                call.state = "failed";
                throw error;
              } finally {
                call.elapsedMs = Math.round(performance.now() - started);
              }
            },
            onEvent: {
              addListener: (listener: CdpEventListener) => listeners.add(listener),
              removeListener: (listener: CdpEventListener) => listeners.delete(listener),
            } as unknown as CdpDebuggerApi["onEvent"],
            onDetach: {
              addListener: () => {},
              removeListener: () => {},
            } as unknown as CdpDebuggerApi["onDetach"],
          };
          let documentChanges = 0;
          const cdp = new ChromiumCdp(api, {
            onDocumentChanged: (tabId) => {
              documentChanges++;
              manager.invalidateTabRefs(tabId);
            },
          });
          try {
            await cdp.ensureAttached(4);
            // Subscribe explicitly: the snapshot-only observe path does not need
            // DOM events, but later selector operations may enable this domain.
            await cdp.send(4, "DOM.enable");
            const tab = { id: 4, windowId: 100, active: false, url } as chrome.tabs.Tab;
            const tabsApi = { get: async () => tab, query: async () => [tab] };
            // Model the controlled request boundary used by the real dispatcher.
            // The raw-runner cases above separately cover temporary hidden input.
            ctx.agentCreatedTabs.add(4);
            const prepare = (method: string) =>
              prepareBackgroundExecution(
                manager,
                {
                  id: "controlled-input",
                  method,
                  params: { session_id: ctx.sessionId, tab_id: 4 },
                },
                cdp,
                tabsApi,
                new AbortController().signal,
              );
            expect(await prepare("tool.observe")).toBeUndefined();
            const observed = await handleObserve(
              manager,
              { session_id: ctx.sessionId, tab_id: 4 },
              { cdp, tabsApi, conditionalSurfaceProbe: false },
            );
            expect(observed, JSON.stringify(observed)).not.toHaveProperty("code");
            const ref = [...ctx.refStore.entries()].find(
              ([, entry]) => entry.kind === "dom" && entry.name === "Click",
            )?.[0];
            expect(ref).toBeDefined();
            expect(documentChanges).toBe(0);
            expect(await prepare("tool.click")).toBeUndefined();
            readinessCommands.length = 0;
            const clicked = await handleClick(
              manager,
              { session_id: ctx.sessionId, tab_id: 4, ref: ref! },
              { cdp, tabsApi },
            );
            expect(
              clicked,
              JSON.stringify({ clicked, commands: readinessCommands }),
            ).not.toHaveProperty("code");
            expect(await target.evaluate("window.clicks")).toEqual([true]);
            expect(documentChanges).toBe(0);
            expect(ctx.refStore.resolve(ref!, { tabId: 4 })).not.toBeNull();
            await cdp.send(4, "Page.navigate", { url: `${url}/next` });
            await vi.waitFor(() => expect(documentUpdates).toBeGreaterThan(0), { timeout: 5000 });
            expect(documentChanges).toBeGreaterThan(0);
            expect(ctx.refStore.resolve(ref!, { tabId: 4 })).toBeNull();
            await vi.waitFor(
              async () => expect(await target.evaluate("document.readyState")).toBe("complete"),
              { timeout: 5000 },
            );

            // The controlled policy persists across calls and navigation. Ending
            // its owner must restore real focus, observed from another CDP session.
            expect(await target.evaluate("document.hasFocus()")).toBe(true);
            const observer = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: target.targetId,
              flatten: true,
            });
            await cdp.detachSession(ctx.sessionId);
            const focus = await send<{ result: { value: boolean } }>(
              "Runtime.evaluate",
              { expression: "document.hasFocus()", returnByValue: true },
              observer.sessionId,
            );
            expect(focus.result.value).toBe(false);
            expect(await foreground.evaluate("document.visibilityState")).toBe("visible");
          } finally {
            ctx.agentCreatedTabs.delete(4);
            cdp.dispose();
            onEvent = undefined;
            await send("Target.closeTarget", { targetId: target.targetId });
          }
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 90_000);
});
