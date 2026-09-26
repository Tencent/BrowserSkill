// @vitest-environment node
// Opt in with BSK_CLICK_CHROME; each test owns its browser, profile and HTTP server.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggee, type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { ControlOverlay } from "@/content/ControlOverlay";
import {
  INPUT_PASSTHROUGH,
  INPUT_PASSTHROUGH_TTL_MS,
  type InputPassthroughSendToTab,
} from "@/lib/input-passthrough-bridge";
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
          const cdpCommands: { method: string; elapsedMs?: number; state: string }[] = [];
          const api: CdpDebuggerApi = {
            // page() already attached the root debugger session.
            attach: async () => {},
            detach: async () => {
              await send("Target.detachFromTarget", { sessionId: target.sessionId });
            },
            sendCommand: async (debuggee, method, params) => {
              const call = { method, state: "pending", elapsedMs: undefined as number | undefined };
              cdpCommands.push(call);
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
            expect(cdp.ownsBackgroundExecution(ctx.sessionId, 4)).toBe(true);
            cdpCommands.length = 0;
            const clicked = await handleClick(
              manager,
              { session_id: ctx.sessionId, tab_id: 4, ref: ref! },
              { cdp, tabsApi },
            );
            expect(clicked, JSON.stringify({ clicked, commands: cdpCommands })).not.toHaveProperty(
              "code",
            );
            expect(await target.evaluate("window.clicks")).toEqual([true]);
            expect(
              cdpCommands.some(
                (command) =>
                  command.method === "Emulation.setFocusEmulationEnabled" ||
                  command.method === "Page.captureScreenshot",
              ),
            ).toBe(false);
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
            expect(cdp.ownsBackgroundExecution(ctx.sessionId, 4)).toBe(false);
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

  it("preserves hover and visible controls while scoped passthrough clears closed shadow click targets", async () => {
    const { withChrome } = await import(
      new URL(
        "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
    const css = readFileSync(new URL("../../content/overlay.css", import.meta.url), "utf8");
    // Run the actual content-side controller in the browser, including its lease bookkeeping.
    const moduleUrl = (source: string) =>
      `data:text/javascript;base64,${Buffer.from(
        ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
        }).outputText,
      ).toString("base64")}`;
    const bridgeUrl = moduleUrl(
      readFileSync(new URL("../../lib/input-passthrough-bridge.ts", import.meta.url), "utf8"),
    );
    const controllerUrl = moduleUrl(
      readFileSync(new URL("../../content/input-passthrough.ts", import.meta.url), "utf8").replace(
        '"@/lib/input-passthrough-bridge"',
        JSON.stringify(bridgeUrl),
      ),
    );
    await withChrome(
      { executable: process.env.BSK_CLICK_CHROME, deviceScale: 1, zoom: 1, startupTimeout: 30_000 },
      async (send: Send) => {
        const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
          url: "about:blank",
        });
        const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const local: Send = (method, params) => send(method, params, sessionId);
        const evaluate = async <T>(expression: string) => {
          const reply = await local<{ result: { value: T }; exceptionDetails?: unknown }>(
            "Runtime.evaluate",
            {
              expression,
              returnByValue: true,
              awaitPromise: true,
            },
          );
          expect(reply.exceptionDetails).toBeUndefined();
          return reply.result.value;
        };
        await local("Page.bringToFront");
        await local("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 757,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await evaluate(`(async () => { document.body.innerHTML = '<style>#target:hover { background: rgb(1, 2, 3); }</style><button id="target" style="position:fixed;width:80px;height:30px">Page action</button>';
          window.clicks=[]; window.stops=0; window.pageEvents=[];
          document.querySelector('#target').onclick=e=>clicks.push(e.isTrusted);
          for (const type of ['mouseover','mousedown','mouseup','click']) document.querySelector('#target').addEventListener(type,e=>pageEvents.push({type,trusted:e.isTrusted,hover:getComputedStyle(e.currentTarget).backgroundColor==='rgb(1, 2, 3)'}));
          window.overlay=document.createElement('browser-skill-overlay');
          overlay.setAttribute('data-bsk-overlay',''); overlay.setAttribute('data-bsk-overlay-surface','');
          document.documentElement.append(overlay);
          window.overlayRoot=overlay.attachShadow({mode:'closed'});
          window.passthroughController=(await import(${JSON.stringify(controllerUrl)})).createInputPassthroughController(()=>overlay); })()`);
        const manager = new SessionManager({
          agentWindow: {
            create: async () => ({ windowId: 100, initialTabIds: [] }),
            remove: async () => {},
            ensureActiveTab: async () => 4,
          },
        });
        const ctx = await manager.start("overlay-click");
        const tab = { id: 4, windowId: 100, active: true } as chrome.tabs.Tab;
        const tabsApi = { get: async () => tab, query: async () => [tab] };
        const mouse: string[] = [];
        const cdp: CdpRunner = {
          send: async (_tabId, method, params) => {
            if (method === "Input.dispatchMouseEvent") {
              mouse.push((params as { type: string }).type);
              expect(await evaluate("getComputedStyle(overlay).display")).toBe("block");
              expect(
                await evaluate(
                  "getComputedStyle(overlayRoot.querySelector('[data-slot=control-overlay-pill]')).opacity",
                ),
              ).toBe("1");
              expect(await evaluate("overlay.hasAttribute('data-bsk-capture-hidden')")).toBe(false);
            }
            return (await local(method, params)) as never;
          },
        };
        const phases: string[] = [];
        const sendInputPassthrough: InputPassthroughSendToTab = async (_tabId, message) => {
          phases.push(message.phase);
          return evaluate(
            `new Promise(resolve=>passthroughController.handleMessage(${JSON.stringify(message)},resolve))`,
          );
        };
        const bypassOverlay = async (_tabId: number, enabled: boolean) => {
          await evaluate(`window.bypassCount += ${enabled ? 1 : -1};
            overlay.toggleAttribute('data-bsk-overlay-blocking',bypassCount===0);
            overlayRoot.querySelector('[data-slot="control-overlay-blocker"]').style.pointerEvents=bypassCount>0?'none':'auto';`);
        };
        // A retained hover bypass leaves the pill interactive even though the host is transparent.
        for (const automationBypass of [false, true]) {
          const markup = renderToStaticMarkup(
            createElement(ControlOverlay, {
              visible: true,
              interrupting: false,
              automationBypass,
              onInterrupt: () => {},
            }),
          );
          await evaluate(`window.bypassCount=${automationBypass ? 1 : 0}; overlay.toggleAttribute('data-bsk-overlay-blocking', ${!automationBypass});
            overlayRoot.innerHTML = ${JSON.stringify(`<style>${css}</style>`)} + ${JSON.stringify(markup)};
            // Static markup starts before the component's reveal effect; model its settled state.
            for (const control of overlayRoot.querySelectorAll('[data-slot^="control-overlay"]')) control.style.opacity='1';
            overlayRoot.querySelector('[data-slot="control-overlay-stop-all"]').addEventListener('click',()=>stops++);`);
          await evaluate(
            "Object.assign(document.querySelector('#target').style,{left:'20px',top:'20px'})",
          );
          phases.length = 0;
          const clear = await handleClick(
            manager,
            { session_id: ctx.sessionId, selector: "#target" },
            { cdp, tabsApi, sendInputPassthrough, bypassOverlay },
          );
          expect(clear).not.toHaveProperty("code");
          expect(phases).toEqual([]);
          expect(await evaluate("bypassCount")).toBe(automationBypass ? 1 : 0);
          for (const slot of ["control-overlay-pill", "control-overlay-stop-all"]) {
            const point = await evaluate<{ x: number; y: number }>(`(() => {
              const r=overlayRoot.querySelector('[data-slot="${slot}"]').getBoundingClientRect();
              const x=${slot === "control-overlay-pill" ? "r.x+25" : "r.x+r.width/2"}, y=r.y+r.height/2;
              Object.assign(document.querySelector('#target').style,{left:(x-40)+'px',top:(y-15)+'px'});
              clicks=[]; stops=0; return {x,y};
            })()`);
            expect(
              await evaluate(`document.elementFromPoint(${point.x},${point.y})===overlay`),
            ).toBe(true);
            const nativeClick = async () => {
              for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
                await local("Input.dispatchMouseEvent", {
                  type,
                  ...point,
                  button: "left",
                  clickCount: 1,
                });
              }
            };
            await nativeClick(); // Reproduce the interception before using the fixed click path.
            expect(await evaluate("clicks")).toEqual([]);
            await local("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
            await evaluate("stops=0; pageEvents=[]");
            phases.length = 0;
            const { root } = await local<{ root: { nodeId: number } }>("DOM.getDocument");
            const { nodeId } = await local<{ nodeId: number }>("DOM.querySelector", {
              nodeId: root.nodeId,
              selector: "#target",
            });
            const { node } = await local<{ node: { backendNodeId: number } }>("DOM.describeNode", {
              nodeId,
            });
            ctx.refStore.set("e1", node.backendNodeId, { tabId: 4 });
            mouse.length = 0;
            const result = await handleClick(
              manager,
              {
                session_id: ctx.sessionId,
                ...(automationBypass ? { ref: "e1" } : { selector: "#target" }),
              },
              { cdp, tabsApi, sendInputPassthrough, bypassOverlay },
            );
            expect(result, JSON.stringify(result)).not.toHaveProperty("code");
            expect(await evaluate("clicks")).toEqual([true]);
            expect(phases).toEqual(["begin", "end"]);
            expect(await evaluate("pageEvents")).toEqual(
              ["mouseover", "mousedown", "mouseup", "click"].map((type) => ({
                type,
                trusted: true,
                hover: true,
              })),
            );
            expect(await evaluate("bypassCount")).toBe(automationBypass ? 1 : 0);
            expect(await evaluate("getComputedStyle(overlay).display")).toBe("block");
            expect(await evaluate("overlay.hasAttribute('data-bsk-input-passthrough')")).toBe(
              false,
            );
            expect(await evaluate("stops")).toBe(0);
            expect(mouse).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
            expect(await evaluate("overlay.hasAttribute('data-bsk-capture-hidden')")).toBe(false);
            expect(
              await evaluate(`document.elementFromPoint(${point.x},${point.y})===overlay`),
            ).toBe(true);
            if (slot === "control-overlay-stop-all") {
              await nativeClick();
              expect(await evaluate("stops")).toBe(1);
              expect(await evaluate("clicks")).toEqual([true]);
            }
            mouse.length = 0;
            const blocked = await handleClick(
              manager,
              { session_id: ctx.sessionId, selector: "#target" },
              {
                cdp,
                tabsApi,
                bypassOverlay,
                sendInputPassthrough: async () => {
                  throw new Error("Content script unavailable");
                },
              },
            );
            expect(blocked).toMatchObject({
              code: "cdp_failed",
              data: { reason: "input_not_ready", effect_state: "none" },
            });
            expect(mouse).toEqual([]);
            expect(await evaluate("clicks")).toEqual([true]);
          }
          // Other extension controls stay hit-testable even while a click lease is active.
          await evaluate(
            `(() => { const extra=document.createElement('div'); extra.innerHTML='<button id="other" style="position:fixed;left:20px;top:20px;width:80px;height:30px;pointer-events:auto">Help or recording control</button>'; overlayRoot.append(extra); })()`,
          );
          await evaluate(
            "Object.assign(document.querySelector('#target').style,{left:'20px',top:'20px'})",
          );
          mouse.length = 0;
          const protectedControl = await handleClick(
            manager,
            { session_id: ctx.sessionId, selector: "#target" },
            { cdp, tabsApi, sendInputPassthrough, bypassOverlay },
          );
          expect(protectedControl).toHaveProperty("data.reason", "input_not_ready");
          expect(mouse).toEqual([]);
          await sendInputPassthrough(4, {
            type: INPUT_PASSTHROUGH,
            phase: "begin",
            id: "css-check",
          });
          expect(await evaluate("overlayRoot.elementFromPoint(40,30).id")).toBe("other");
          expect(await evaluate("getComputedStyle(overlay).display")).toBe("block");
          await evaluate(`(() => { const replacement=document.createElement('browser-skill-overlay');
            for(const attr of overlay.attributes) replacement.setAttribute(attr.name,attr.value);
            const replacementRoot=replacement.attachShadow({mode:'closed'});
            replacementRoot.innerHTML=overlayRoot.innerHTML;
            overlay.replaceWith(replacement); overlay=replacement; overlayRoot=replacementRoot;
            passthroughController.onHostMounted(overlay); })()`);
          expect(await evaluate("overlay.hasAttribute('data-bsk-input-passthrough')")).toBe(true);
          await sendInputPassthrough(4, { type: INPUT_PASSTHROUGH, phase: "end", id: "css-check" });
          expect(await evaluate("overlay.hasAttribute('data-bsk-input-passthrough')")).toBe(false);
        }
        // Losing end must restore the user's Stop button without another background message.
        const stopPoint = await evaluate<{ x: number; y: number }>(`(() => {
          const stop=overlayRoot.querySelector('[data-slot="control-overlay-stop-all"]');
          stop.addEventListener('click',()=>stops++);
          const r=stop.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
          Object.assign(document.querySelector('#target').style,{left:(x-40)+'px',top:(y-15)+'px'});
          stops=0; clicks=[]; return {x,y};
        })()`);
        await sendInputPassthrough(4, { type: INPUT_PASSTHROUGH, phase: "begin", id: "lost-end" });
        expect(await evaluate(`document.elementFromPoint(${stopPoint.x},${stopPoint.y}).id`)).toBe(
          "target",
        );
        await expect
          .poll(() => evaluate("overlay.hasAttribute('data-bsk-input-passthrough')"), {
            timeout: INPUT_PASSTHROUGH_TTL_MS + 3_000,
          })
          .toBe(false);
        expect(await evaluate("passthroughController.pendingCount")).toBe(0);
        expect(
          await evaluate(`document.elementFromPoint(${stopPoint.x},${stopPoint.y})===overlay`),
        ).toBe(true);
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
          await local("Input.dispatchMouseEvent", {
            type,
            ...stopPoint,
            button: "left",
            clickCount: 1,
          });
        }
        expect(await evaluate("stops")).toBe(1);
        expect(await evaluate("clicks")).toEqual([]);
        expect(await evaluate("getComputedStyle(overlay).display")).toBe("block");
      },
    );
  }, 30_000);
});
