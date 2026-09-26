// @vitest-environment node
// Opt in with BSK_CLICK_CHROME; the harness owns an isolated browser/profile.
import { describe, expect, it } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { handleDownload } from "../download";
import type { CdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

async function browser(
  run: (send: Send, cdp: ChromiumCdp, sessionId: () => string) => Promise<void>,
) {
  const { withChrome } = await import(
    new URL(
      "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
      import.meta.url,
    ).href
  );
  await withChrome(
    {
      executable: process.env.BSK_CLICK_CHROME,
      deviceScale: 1,
      zoom: 1,
      startupTimeout: 30_000,
    },
    async (send: Send) => {
      const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      let activeSession = "";
      const api: CdpDebuggerApi = {
        attach: async () => {
          const reply = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId,
            flatten: true,
          });
          activeSession = reply.sessionId;
        },
        detach: async () => {
          await send("Target.detachFromTarget", { sessionId: activeSession });
          activeSession = "";
        },
        sendCommand: async (_target, method, params) => send(method, params, activeSession),
        onEvent: { addListener() {}, removeListener() {} } as unknown as CdpDebuggerApi["onEvent"],
        onDetach: {
          addListener() {},
          removeListener() {},
        } as unknown as CdpDebuggerApi["onDetach"],
      };
      const cdp = new ChromiumCdp(api);
      try {
        await run(send, cdp, () => activeSession);
      } finally {
        await cdp.detach(7);
      }
    },
  );
}

function manager() {
  return new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
}
const tab = { id: 7, windowId: 100, active: true, url: "about:blank" } as chrome.tabs.Tab;
const tabsApi = { get: async () => tab, query: async () => [tab] };

describe.skipIf(!process.env.BSK_CLICK_CHROME)("download effect metadata", () => {
  it("a cancelled export whose click reached the page reports an unknown effect", async () => {
    await browser(async (_send, cdp) => {
      const sessions = manager();
      const ctx = await sessions.start("download-effect");
      await cdp.send(7, "Runtime.evaluate", {
        expression: `
        document.body.innerHTML = '<button id="export" style="width:200px;height:100px">Export</button>';
        window.startedExports = 0;
        document.querySelector('#export').onclick = () => { window.startedExports++; };
      `,
      });
      const ac = new AbortController();
      const wrapped: CdpRunner = {
        send: (async (tabId: number, method: string, params?: object) => {
          const reply = await cdp.send(tabId, method, params);
          if (
            method === "Input.dispatchMouseEvent" &&
            (params as { type?: string })?.type === "mouseReleased"
          )
            ac.abort();
          return reply;
        }) as CdpRunner["send"],
        onEvent: () => ({ dispose() {} }),
      };
      const event = () => ({ addListener() {}, removeListener() {} });
      const downloads = {
        onCreated: event(),
        onChanged: event(),
        onDeterminingFilename: event(),
        search: async () => [],
        cancel: async () => {},
        removeFile: async () => {},
      };
      const result = await handleDownload(
        sessions,
        {
          session_id: ctx.sessionId,
          tab_id: 7,
          selector: "#export",
          browser_relative_dir: "BrowserSkill/audit",
          timeout_ms: 2000,
        },
        {
          cdp: wrapped,
          tabsApi,
          downloads,
          signal: ac.signal,
          navigationTargets: { onCreatedNavigationTarget: event() },
        },
      );
      const startedExports = (
        await cdp.send<{ result: { value: number } }>(7, "Runtime.evaluate", {
          expression: "startedExports",
          returnByValue: true,
        })
      ).result.value;
      console.log("DOWNLOAD_EFFECT_PROOF", JSON.stringify({ startedExports, result }));
      expect(startedExports).toBe(1);
      expect(result).toMatchObject({ data: { effect_state: "unknown" } });
    });
  }, 40_000);
});
