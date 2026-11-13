// @vitest-environment node
// Opt in with BSK_CLICK_CHROME; the harness owns an isolated browser/profile.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleClick, handleHover } from "../interaction";
import { handleObserve, handleSnapshot } from "../observation";
import type { CdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

describe.skipIf(!process.env.BSK_CLICK_CHROME)("click listener observations", () => {
  it.each([
    { name: "snapshot", observe: handleSnapshot },
    { name: "observe", observe: handleObserve },
  ])("$name exposes current dynamic menu items without inline handlers", async ({ observe }) => {
    const { withChrome } = await import(
      new URL(
        "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
    await withChrome(
      { executable: process.env.BSK_CLICK_CHROME, deviceScale: 1, zoom: 1 },
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
            { expression, returnByValue: true, awaitPromise: true },
          );
          expect(reply.exceptionDetails).toBeUndefined();
          return reply.result.value;
        };
        const cdp: CdpRunner = {
          send: (_tabId, method, params) => local(method, params),
          sendToTarget: (_target, method, params) => local(method, params),
          getAttachmentId: () => sessionId,
          getFrameGraph: async () => {
            const { frameTree } = await local<{ frameTree: { frame: { id: string } } }>(
              "Page.getFrameTree",
            );
            return {
              rootFrameId: frameTree.frame.id,
              frames: [{ frameId: frameTree.frame.id, target: { tabId: 4 } }],
            };
          },
        };
        const manager = new SessionManager({
          agentWindow: {
            create: async () => ({ windowId: 100, initialTabIds: [4] }),
            remove: async () => {},
            ensureActiveTab: async () => 4,
          },
        });
        const ctx = await manager.start("click-listener-observation");
        const tab = { id: 4, windowId: 100, active: true, url: "about:blank" } as chrome.tabs.Tab;
        const deps = { cdp, tabsApi: { get: async () => tab, query: async () => [tab] } };
        const params = { session_id: ctx.sessionId };
        const read = async () => {
          const result = await observe(manager, params, deps);
          if (!("text" in result)) throw new Error(JSON.stringify(result));
          return result.text;
        };
        const ref = (text: string, label: string) =>
          text
            .split("\n")
            .find((line) => line.includes(`"${label}"`) && /@e\d+/.test(line))
            ?.match(/@e\d+/)?.[0];

        await evaluate(`
          document.body.innerHTML = '<button id="open">Open menu</button><div id="menu"></div>';
          window.clicks = [];
          window.recordClick = event => clicks.push({ id: event.currentTarget.id, trusted: event.isTrusted });
          document.addEventListener('click', () => {});
          document.querySelector('#open').addEventListener('click', async () => {
            await Promise.resolve();
            document.querySelector('#menu').innerHTML = \`
              <div id="custom-div">Div action</div>
              <ul>
                <li id="custom-li">List action</li>
                <li id="pointer-li" style="cursor:pointer">Pointer action</li>
                <li id="decorative" style="cursor:pointer">Section label</li>
                <li id="semantic" role="menuitem">Semantic action</li>
              </ul>
              <div id="disabled" aria-disabled="true">Disabled action</div>
              <div id="hidden" hidden>Hidden action</div>
              <div id="inert" inert>Inert action</div>
              <div inert><div id="inert-child">Inert child action</div></div>
              <div hidden><div id="hidden-child">Hidden child action</div></div>
              <div aria-hidden="true"><div id="aria-hidden-child">ARIA hidden child action</div></div>
              <div id="transparent" style="pointer-events:none">Transparent action</div>
              <div id="wrapper" aria-label="Wrapper action"><button id="native">Native action</button></div>
            \`;
            for (const id of ['custom-div', 'custom-li', 'pointer-li', 'semantic', 'disabled', 'hidden', 'inert', 'inert-child', 'hidden-child', 'aria-hidden-child', 'transparent', 'wrapper', 'native']) {
              document.getElementById(id).addEventListener('click', recordClick);
            }
          });
        `);
        const before = await read();
        expect(ref(before, "Div action")).toBeUndefined();
        const open = ref(before, "Open menu");
        expect(open, before).toBeDefined();
        expect(await handleClick(manager, { ...params, ref: open }, deps)).not.toHaveProperty(
          "code",
        );
        await expect.poll(() => evaluate("!!document.querySelector('#custom-li')")).toBe(true);
        const after = await read();
        const actions = [
          "Div action",
          "List action",
          "Pointer action",
          "Semantic action",
          "Native action",
        ];
        for (const label of actions) expect(ref(after, label), after).toBeDefined();
        for (const label of [
          "Section label",
          "Disabled action",
          "Hidden action",
          "Inert action",
          "Inert child action",
          "Hidden child action",
          "ARIA hidden child action",
          "Transparent action",
          "Wrapper action",
        ]) {
          expect(ref(after, label), after).toBeUndefined();
        }
        const firstNode = ctx.refStore.resolve(ref(after, "Div action")!);
        for (const label of actions.slice(0, 4)) {
          expect(
            await handleClick(manager, { ...params, ref: ref(after, label) }, deps),
          ).not.toHaveProperty("code");
        }
        expect(await evaluate("clicks")).toEqual([
          { id: "custom-div", trusted: true },
          { id: "custom-li", trusted: true },
          { id: "pointer-li", trusted: true },
          { id: "semantic", trusted: true },
        ]);

        await evaluate(
          "document.querySelector('#custom-div').removeEventListener('click', recordClick)",
        );
        expect(ref(await read(), "Div action")).toBeUndefined();
        await evaluate(`
          const previous = document.querySelector('#custom-div');
          const replacement = previous.cloneNode(true);
          replacement.addEventListener('click', recordClick);
          previous.replaceWith(replacement);
        `);
        const refreshed = ref(await read(), "Div action");
        expect(refreshed).toBeDefined();
        expect(ctx.refStore.resolve(refreshed!)).not.toBe(firstNode);
        expect(await handleClick(manager, { ...params, ref: refreshed }, deps)).not.toHaveProperty(
          "code",
        );
        expect(await evaluate("clicks.at(-1)")).toEqual({ id: "custom-div", trusted: true });

        // showModal escapes an inert ancestor; its live AX nodes must remain actionable.
        await evaluate(`
          const container = document.createElement('div');
          container.inert = true;
          container.innerHTML = '<dialog><div id="modal-item">Modal action</div></dialog>';
          document.body.append(container);
          document.querySelector('#modal-item').addEventListener('click', recordClick);
          container.querySelector('dialog').showModal();
        `);
        const modal = ref(await read(), "Modal action");
        expect(modal).toBeDefined();
        expect(await handleClick(manager, { ...params, ref: modal }, deps)).not.toHaveProperty(
          "code",
        );
        expect(await evaluate("clicks.at(-1)")).toEqual({ id: "modal-item", trusted: true });
      },
    );
  }, 30_000);

  it("exposes independent menuitem refs for nested multi-level dynamic popups across observe and snapshot", async () => {
    const { withChrome } = await import(
      new URL(
        "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
    const nestedMenuHtml = readFileSync(
      new URL(
        "../../../../../evals/browser/skills/browserskill-release-test/assets/fixtures/nested-menu.html",
        import.meta.url,
      ),
      "utf8",
    );
    await withChrome(
      { executable: process.env.BSK_CLICK_CHROME, deviceScale: 1, zoom: 1 },
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
            { expression, returnByValue: true, awaitPromise: true },
          );
          expect(reply.exceptionDetails).toBeUndefined();
          return reply.result.value;
        };
        await local("Page.enable");
        await local("Page.bringToFront");
        const cdp: CdpRunner = {
          send: (_tabId, method, params) => local(method, params),
          sendToTarget: (_target, method, params) => local(method, params),
          getAttachmentId: () => sessionId,
          getFrameGraph: async () => {
            const { frameTree } = await local<{ frameTree: { frame: { id: string } } }>(
              "Page.getFrameTree",
            );
            return {
              rootFrameId: frameTree.frame.id,
              frames: [{ frameId: frameTree.frame.id, target: { tabId: 4 } }],
            };
          },
        };
        const manager = new SessionManager({
          agentWindow: {
            create: async () => ({ windowId: 100, initialTabIds: [4] }),
            remove: async () => {},
            ensureActiveTab: async () => 4,
          },
        });
        const ctx = await manager.start("nested-menu-observation");
        const tab = { id: 4, windowId: 100, active: true, url: "about:blank" } as chrome.tabs.Tab;
        const deps = { cdp, tabsApi: { get: async () => tab, query: async () => [tab] } };
        const params = { session_id: ctx.sessionId };
        const menuitemRef = (text: string, exactName: string) =>
          text
            .split("\n")
            .map((line) => line.trim())
            .find((line) => {
              const match = line.match(/^(@e\d+)\s+menuitem\s+"([^"]+)"$/);
              if (!match) return false;
              const cleaned = match[2].replace(/ \[(?:has-submenu|expanded)\]$/, "");
              return cleaned === exactName;
            })
            ?.match(/^@e\d+/)?.[0];

        await evaluate(
          `document.open(); document.write(${JSON.stringify(nestedMenuHtml)}); document.close();`,
        );
        const initial = await handleObserve(manager, params, deps);
        if (!("text" in initial)) throw new Error(JSON.stringify(initial));
        expect(menuitemRef(initial.text, "Audit export")).toBeUndefined();
        expect(menuitemRef(initial.text, "Report history")).toBeUndefined();

        const workspaceRef = menuitemRef(initial.text, "Workspace");
        expect(workspaceRef, initial.text).toBeDefined();
        expect(
          await handleHover(manager, { ...params, ref: workspaceRef }, deps),
        ).not.toHaveProperty("code");
        await expect
          .poll(() => evaluate("!document.querySelector('#workspace-popper').hidden"))
          .toBe(true);

        const level1 = await handleObserve(manager, params, deps);
        if (!("text" in level1)) throw new Error(JSON.stringify(level1));
        expect(menuitemRef(level1.text, "Audit export")).toBeUndefined();
        expect(menuitemRef(level1.text, "Report history")).toBeUndefined();

        const advancedRef = menuitemRef(level1.text, "Advanced");
        expect(advancedRef, level1.text).toBeDefined();
        expect(
          await handleHover(manager, { ...params, ref: advancedRef }, deps),
        ).not.toHaveProperty("code");
        await expect
          .poll(() => evaluate("!document.querySelector('#advanced-popper').hidden"))
          .toBe(true);

        const observed = await handleObserve(manager, params, deps);
        const snapshotted = await handleSnapshot(manager, params, deps);
        if (!("text" in observed) || !("text" in snapshotted)) {
          throw new Error(JSON.stringify({ observed, snapshotted }));
        }
        for (const text of [observed.text, snapshotted.text]) {
          const auditRef = menuitemRef(text, "Audit export");
          const historyRef = menuitemRef(text, "Report history");
          expect(auditRef, text).toBeDefined();
          expect(historyRef, text).toBeDefined();
          expect(auditRef).not.toBe(historyRef);
          expect(text, text).not.toMatch(/@e\d+\s+button\b/);
        }

        const clickTargetRef = menuitemRef(observed.text, "Audit export")!;
        expect(
          await handleClick(manager, { ...params, ref: clickTargetRef }, deps),
        ).not.toHaveProperty("code");
        expect(
          await evaluate("document.querySelector('#menu-selection-receipt').textContent"),
        ).toBe("Selected audit");

        // React 18 root event-delegated dropdown mounted inside a cursor: pointer combobox:
        // inline trigger skin stays folded while popup pointer-only items get distinct @eN refs.
        await evaluate(`
          document.body.innerHTML = \`
            <div id="root">
              <div id="combo" role="combobox" aria-label="报表类型" aria-expanded="true" style="position:relative;width:220px;padding:8px;cursor:pointer">
                <span id="trigger-skin">全部报表</span>
                <div id="popup" style="position:absolute;top:40px;left:0;width:220px;cursor:default;background:#fff">
                  <div class="dropdown-item" data-item="export" style="padding:8px;cursor:pointer">导出报表</div>
                  <div class="dropdown-item" data-item="history" style="padding:8px;cursor:pointer">历史记录</div>
                </div>
              </div>
              <output id="delegated-receipt">None</output>
            </div>
          \`;
          document.getElementById("root").addEventListener("click", (e) => {
            const item = e.target.closest("[data-item]");
            if (item) document.getElementById("delegated-receipt").textContent = item.dataset.item;
          });
        `);
        const delegatedObs = await handleObserve(manager, params, deps);
        const delegatedSnap = await handleSnapshot(manager, params, deps);
        if (!("text" in delegatedObs) || !("text" in delegatedSnap)) {
          throw new Error(JSON.stringify({ delegatedObs, delegatedSnap }));
        }
        const buttonRef = (text: string, exactName: string) =>
          text
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.match(/^@e\d+\s+button\s+"([^"]+)"$/)?.[1] === exactName)
            ?.match(/^@e\d+/)?.[0];
        for (const text of [delegatedObs.text, delegatedSnap.text]) {
          expect(buttonRef(text, "全部报表"), text).toBeUndefined();
          const exportRef = buttonRef(text, "导出报表");
          const histRef = buttonRef(text, "历史记录");
          expect(exportRef, text).toBeDefined();
          expect(histRef, text).toBeDefined();
          expect(exportRef).not.toBe(histRef);
        }
        expect(
          await handleClick(
            manager,
            { ...params, ref: buttonRef(delegatedObs.text, "导出报表") },
            deps,
          ),
        ).not.toHaveProperty("code");
        expect(await evaluate("document.querySelector('#delegated-receipt').textContent")).toBe(
          "export",
        );
      },
    );
  }, 30_000);
});
