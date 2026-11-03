// @vitest-environment node
// Opt in with BSK_WINDOW_CHROME; the browser, profile and extension are isolated.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner, ChromeTabsApi } from "../shared";
import { handleWindowResize, type WindowResizeApi } from "../window";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

async function poll<T>(read: () => Promise<T | undefined | false>): Promise<T> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Window resize browser fixture timed out");
}

describe.skipIf(!process.env.BSK_WINDOW_CHROME)("window resize in a real browser", () => {
  it("detects an inactive tab and a pinned viewport without claiming success", async () => {
    const extension = await mkdtemp(path.join(tmpdir(), "bsk-resize-extension-"));
    await writeFile(
      path.join(extension, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "BrowserSkill resize test",
        version: "1.0",
        permissions: ["tabs", "debugger"],
        background: { service_worker: "resize-test-worker.js" },
      }),
    );
    await writeFile(
      path.join(extension, "resize-test-worker.js"),
      "chrome.runtime.onInstalled.addListener(() => {});",
    );
    await writeFile(
      path.join(extension, "probe.html"),
      "<!doctype html><title>Resize probe</title>",
    );
    try {
      const { withChrome } = await import(
        new URL(
          "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      await withChrome(
        {
          executable: process.env.BSK_WINDOW_CHROME,
          deviceScale: 1,
          zoom: 1,
          extensionPath: extension,
          extensionViaCdp: true,
          headless: process.env.BSK_WINDOW_HEADFUL !== "1",
        },
        async (send: Send) => {
          const worker = await poll(async () =>
            (
              await send<{ targetInfos: { targetId: string; type: string; url: string }[] }>(
                "Target.getTargets",
              )
            ).targetInfos.find(
              (target) =>
                target.type === "service_worker" && target.url.endsWith("/resize-test-worker.js"),
            ),
          );
          // A page in this extension gives Runtime.evaluate a stable, privileged
          // context while the service worker is starting or being suspended.
          const origin = worker.url.split("/").slice(0, 3).join("/");
          const probe = await send<{ targetId: string }>("Target.createTarget", {
            url: `${origin}/probe.html`,
            background: true,
          });
          const session = (
            await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: probe.targetId,
              flatten: true,
            })
          ).sessionId;
          const evaluate = async <T>(expression: string): Promise<T> => {
            const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, awaitPromise: true, returnByValue: true },
              session,
            );
            if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
            return reply.result.value;
          };
          const extensionId = worker.url.split("/")[2];
          await poll(() =>
            evaluate<boolean>(
              `globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)} && !!globalThis.chrome?.windows?.create && !!globalThis.chrome?.debugger?.attach`,
            ),
          );
          const fixture = "data:text/html,<title>Resize fixture</title><h1>Resize fixture</h1>";
          const created = await evaluate<chrome.windows.Window>(
            `chrome.windows.create(${JSON.stringify({ url: fixture, focused: false, width: 900, height: 700 })})`,
          );
          const windowId = created.id!;
          await evaluate(`chrome.windows.update(${windowId},{left:0,top:0,width:900,height:700})`);
          const original = await poll(async () => {
            const tabs = await evaluate<chrome.tabs.Tab[]>(
              `chrome.tabs.query({windowId:${windowId}})`,
            );
            return tabs.find((tab) => tab.status === "complete" && typeof tab.id === "number");
          });
          const tabId = original.id!;
          await evaluate(`chrome.debugger.attach({tabId:${tabId}},"1.3")`);
          const windows: WindowResizeApi = {
            get: (id) => evaluate(`chrome.windows.get(${id})`),
            update: (id, bounds) =>
              evaluate(`chrome.windows.update(${id},${JSON.stringify(bounds)})`),
          };
          const tabs: ChromeTabsApi = {
            get: (id) => evaluate(`chrome.tabs.get(${id})`),
            query: (query) => evaluate(`chrome.tabs.query(${JSON.stringify(query)})`),
          };
          const cdp: CdpRunner = {
            send: (id, method, params) =>
              evaluate(
                `chrome.debugger.sendCommand({tabId:${id}},${JSON.stringify(method)},${JSON.stringify(params ?? {})})`,
              ),
          };
          const manager = new SessionManager({
            agentWindow: {
              create: async () => ({ windowId, initialTabIds: [tabId] }),
              ensureActiveTab: async () => tabId,
              remove: async () => {},
            },
          });
          await manager.start("agent");
          const deps = { windows, tabs, cdp };
          const before = await windows.get(windowId);
          await evaluate(
            `chrome.tabs.create({windowId:${windowId},url:${JSON.stringify(fixture)},active:true})`,
          );
          expect(
            await handleWindowResize(
              manager,
              { session_id: "agent", tab_id: tabId, width: 1100, height: 800 },
              deps,
            ),
          ).toMatchObject({ data: { reason: "window_resize_inactive_tab", effect_state: "none" } });
          const afterInactive = await windows.get(windowId);
          expect({ width: afterInactive.width, height: afterInactive.height }).toEqual({
            width: before.width,
            height: before.height,
          });

          await evaluate(`chrome.tabs.update(${tabId},{active:true})`);
          expect(
            await handleWindowResize(
              manager,
              { session_id: "agent", tab_id: tabId, width: 1100, height: 800 },
              deps,
            ),
          ).toEqual({ window_id: windowId, width: 1100, height: 800 });
          await cdp.send(tabId, "Emulation.setDeviceMetricsOverride", {
            width: 825,
            height: 687,
            deviceScaleFactor: 0,
            mobile: false,
          });
          await poll(async () => {
            const metrics = await cdp.send<{ cssLayoutViewport?: { clientWidth?: number } }>(
              tabId,
              "Page.getLayoutMetrics",
            );
            return metrics.cssLayoutViewport?.clientWidth === 825;
          });
          const params = { session_id: "agent", tab_id: tabId, width: 900, height: 700 };
          expect(await handleWindowResize(manager, params, deps)).toMatchObject({
            data: { reason: "window_resize_viewport_unchanged", effect_state: "committed" },
          });
          expect(await handleWindowResize(manager, params, deps)).toMatchObject({
            data: { reason: "window_resize_viewport_unchanged", effect_state: "none" },
          });
        },
      );
    } finally {
      await rm(extension, { recursive: true, force: true });
    }
  }, 45_000);
});
