// @vitest-environment node
// Each run owns its Chromium profile; no user's browser is accessed.
import { describe, expect, it } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { WaitForElementResult } from "@/transport/types";
import type { CdpRunner } from "../shared";
import { handleWaitForElement } from "../waits";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

describe.skipIf(!process.env.BSK_CLICK_CHROME)("real browser element waits", () => {
  it("observes delayed results, masks and node removal in foreground and background tabs", async () => {
    const { withChrome } = await import(
      new URL(
        "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
    await withChrome(
      { executable: process.env.BSK_CLICK_CHROME, deviceScale: 1, zoom: 1 },
      async (send: Send) => {
        const manager = new SessionManager({
          agentWindow: {
            create: async () => ({ windowId: 100, initialTabIds: [] }),
            remove: async () => {},
            ensureActiveTab: async () => 4,
          },
        });
        const ctx = await manager.start("wait-browser");
        try {
          for (const background of [false, true]) {
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
              url: "about:blank",
              background,
            });
            const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId,
              flatten: true,
            });
            const cdp: CdpRunner = {
              send: (_tabId, method, params) => send(method, params, sessionId),
            };
            const tab = { id: 4, windowId: 100, active: !background } as chrome.tabs.Tab;
            const deps = { cdp, tabsApi: { get: async () => tab, query: async () => [tab] } };
            const evaluate = async <T>(expression: string) => {
              const reply = await cdp.send<{ result: { value: T }; exceptionDetails?: unknown }>(
                4,
                "Runtime.evaluate",
                { expression, returnByValue: true },
              );
              expect(reply.exceptionDetails).toBeUndefined();
              return reply.result.value;
            };
            expect(await evaluate("document.visibilityState")).toBe(
              background ? "hidden" : "visible",
            );
            await evaluate(
              `document.body.innerHTML = '<button id="result" style="display:none">Result</button><div id="mask" style="position:fixed;inset:0;background:gray">Loading</div>'`,
            );
            const wait = async (
              selector: string,
              state: "visible" | "hidden" | "detached",
              timeout_ms = 3000,
            ) => {
              const result = await handleWaitForElement(
                manager,
                { session_id: ctx.sessionId, selector, state, timeout_ms },
                deps,
              );
              expect(result).not.toHaveProperty("code");
              return result as WaitForElementResult;
            };
            expect(await wait("#absent", "detached")).toMatchObject({
              satisfied: true,
              attached: false,
            });
            expect(await wait("#absent", "hidden")).toMatchObject({
              satisfied: true,
              attached: false,
              visible: false,
            });
            await evaluate(
              `setTimeout(() => { document.querySelector('#result').style.display = ''; document.querySelector('#mask').remove(); }, 100)`,
            );
            expect(await wait("#result", "visible")).toMatchObject({
              satisfied: true,
              attached: true,
              visible: true,
            });
            expect(await wait("#mask", "detached")).toMatchObject({
              satisfied: true,
              attached: false,
            });

            // Two table masks: a broad selector only checks the first match.
            // Scope waits to the table whose request is still running.
            await evaluate(`document.body.insertAdjacentHTML('beforeend',
              '<section id="idle-panel"><div class="el-loading-mask" style="display:none">Idle</div></section>' +
              '<section id="orders-panel"><div class="el-loading-mask">Loading</div></section>')`);
            expect(await wait(".el-loading-mask", "hidden")).toMatchObject({
              satisfied: true,
              attached: true,
              visible: false,
            });
            const mask = "#orders-panel .el-loading-mask";
            expect(await wait(mask, "hidden", 100)).toMatchObject({
              satisfied: false,
              attached: true,
              visible: true,
            });

            // v-loading retains the node and hides it with v-show (display:none).
            await evaluate(
              `setTimeout(() => { document.querySelector('${mask}').style.display = 'none'; }, 100)`,
            );
            expect(await wait(mask, "hidden")).toMatchObject({
              satisfied: true,
              attached: true,
              visible: false,
            });
            expect(await wait(mask, "detached", 100)).toMatchObject({
              satisfied: false,
              attached: true,
              visible: false,
            });

            // Loading.service removes the node after its leave transition.
            await evaluate(`document.querySelector('${mask}').style.display = '';
              setTimeout(() => document.querySelector('${mask}').remove(), 100)`);
            expect(await wait(mask, "hidden")).toMatchObject({
              satisfied: true,
              attached: false,
              visible: false,
            });

            // Visibility alone does not promise that an element is enabled or unoccluded.
            await evaluate(
              `document.querySelector('#result').disabled = true; document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0;background:gray"></div>')`,
            );
            expect(await wait("#result", "visible")).toMatchObject({
              satisfied: true,
              visible: true,
            });
            await evaluate(`document.querySelector('#result').style.visibility = 'hidden'`);
            expect(await wait("#result", "hidden")).toMatchObject({
              satisfied: true,
              attached: true,
              visible: false,
            });

            const { root } = await cdp.send<{ root: { nodeId: number } }>(4, "DOM.getDocument");
            const { nodeId } = await cdp.send<{ nodeId: number }>(4, "DOM.querySelector", {
              nodeId: root.nodeId,
              selector: "#result",
            });
            const { node } = await cdp.send<{ node: { backendNodeId: number } }>(
              4,
              "DOM.describeNode",
              { nodeId },
            );
            ctx.refStore.set("e1", node.backendNodeId, { tabId: 4 });
            await evaluate(`document.querySelector('#result').remove()`);
            expect(
              await handleWaitForElement(
                manager,
                { session_id: ctx.sessionId, ref: "@e1", state: "detached", timeout_ms: 100 },
                deps,
              ),
            ).toMatchObject({ satisfied: true, attached: false, used_ref: "e1" });
            expect(
              await handleWaitForElement(
                manager,
                { session_id: ctx.sessionId, ref: "@e1", state: "hidden", timeout_ms: 100 },
                deps,
              ),
            ).toMatchObject({ satisfied: true, attached: false, visible: false, used_ref: "e1" });
            expect(
              await handleWaitForElement(
                manager,
                { session_id: ctx.sessionId, ref: "@e999", state: "detached" },
                deps,
              ),
            ).toMatchObject({ code: "not_found", data: { reason: "ref_not_found" } });
            expect(await evaluate("document.visibilityState")).toBe(
              background ? "hidden" : "visible",
            );
            if (background) await send("Target.closeTarget", { targetId });
          }
        } finally {
          await manager.stop(ctx.sessionId);
        }
      },
    );
  }, 30_000);
});
