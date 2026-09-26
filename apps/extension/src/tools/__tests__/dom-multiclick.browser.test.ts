// @vitest-environment node
// Opt in with BSK_CLICK_CHROME; the harness owns an isolated browser/profile.
import { describe, expect, it } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { handleClick } from "../interaction";

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

describe.skipIf(!process.env.BSK_CLICK_CHROME)("DOM native click sequences", () => {
  it("DOM double click delivers both click events, as a native double click does", async () => {
    await browser(async (_send, cdp) => {
      const sessions = manager();
      const ctx = await sessions.start("double-click-audit");
      await cdp.send(7, "Runtime.evaluate", {
        expression: `
        document.body.innerHTML = '<button id="target" style="width:200px;height:100px">Open</button>';
        window.auditEvents = [];
        for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
          document.querySelector('#target').addEventListener(type, event => {
            auditEvents.push({type: event.type, detail: event.detail, trusted: event.isTrusted});
          });
        }
      `,
      });
      const result = await handleClick(
        sessions,
        {
          session_id: ctx.sessionId,
          tab_id: 7,
          selector: "#target",
          click_count: 2,
        },
        { cdp, tabsApi },
      );
      expect(result).not.toHaveProperty("code");
      const actual = await cdp.send<{ result: { value: unknown[] } }>(7, "Runtime.evaluate", {
        expression: "auditEvents",
        returnByValue: true,
      });
      // Positive control: a full CDP double-click sequence on the same element.
      await cdp.send(7, "Runtime.evaluate", { expression: "auditEvents = []" });
      for (const clickCount of [1, 2]) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.send(7, "Input.dispatchMouseEvent", {
            type,
            x: 50,
            y: 50,
            button: "left",
            clickCount,
          });
        }
      }
      const control = await cdp.send<{ result: { value: unknown[] } }>(7, "Runtime.evaluate", {
        expression: "auditEvents",
        returnByValue: true,
      });
      console.log(
        "DOUBLE_CLICK_PROOF",
        JSON.stringify({ actual: actual.result.value, control: control.result.value }),
      );
      expect(actual.result.value).toEqual(control.result.value);
    });
  }, 40_000);
});
