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

describe.skipIf(!process.env.BSK_CLICK_CHROME)("download trigger retirement", () => {
  it.each([
    "mouseMoved",
    "mousePressed",
  ])("never resumes native input after cancellation at %s", async (heldType) => {
    await browser(async (_send, cdp) => {
      const sessions = manager();
      const ctx = await sessions.start("download-retire");
      await cdp.send(7, "Runtime.evaluate", {
        expression: `
        document.body.innerHTML = '<button id="export" style="width:200px;height:100px">Export</button>';
        window.startedExports = 0;
        document.querySelector('#export').onclick = () => { window.startedExports++; };
      `,
      });
      const abort = new AbortController();
      let release!: (reply: unknown) => void;
      let reached!: () => void;
      const ready = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const reply = new Promise((resolve) => {
        release = resolve;
      });
      const inputs: string[] = [];
      const wrapped: CdpRunner = {
        send: (async (tabId: number, method: string, params?: object) => {
          const value = await cdp.send(tabId, method, params);
          if (method === "Input.dispatchMouseEvent") {
            const type = (params as { type: string }).type;
            inputs.push(type);
            if (type === heldType) {
              reached();
              await reply;
            }
          }
          return value;
        }) as CdpRunner["send"],
        detach: cdp.detach.bind(cdp),
        getAttachmentId: cdp.getAttachmentId.bind(cdp),
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
      const pending = handleDownload(
        sessions,
        {
          session_id: ctx.sessionId,
          tab_id: 7,
          selector: "#export",
          browser_relative_dir: "BrowserSkill/retire",
          timeout_ms: 2_000,
        },
        {
          cdp: wrapped,
          tabsApi,
          downloads,
          signal: abort.signal,
          navigationTargets: { onCreatedNavigationTarget: event() },
        },
      );
      try {
        await ready;
        abort.abort();
        const result = await pending;
        expect(result).toHaveProperty("code");
        const count = async () =>
          (
            await cdp.send<{ result: { value: number } }>(7, "Runtime.evaluate", {
              expression: "startedExports",
              returnByValue: true,
            })
          ).result.value;
        const expected = heldType === "mousePressed" ? 1 : 0;
        expect(await count()).toBe(expected);
        const before = [...inputs];
        release({});
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await count()).toBe(expected);
        expect(inputs).toEqual(before);
        expect(inputs).toEqual(
          heldType === "mousePressed"
            ? ["mouseMoved", "mousePressed", "mouseReleased"]
            : ["mouseMoved"],
        );
      } finally {
        release({});
        await pending;
      }
    });
  }, 40_000);
});
