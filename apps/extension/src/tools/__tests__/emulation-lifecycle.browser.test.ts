// @vitest-environment node
// Opt in with BSK_CLICK_CHROME; the harness owns an isolated browser/profile.
import { describe, expect, it } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { handleEmulate, resetEmulateStatesForTests } from "../emulate";

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

describe.skipIf(!process.env.BSK_CLICK_CHROME)("emulation lifecycle", () => {
  it("a new session's viewport-only emulation does not restore the previous owner's UA or touch state", async () => {
    resetEmulateStatesForTests();
    try {
      await browser(async (_send, cdp) => {
        const sessions = manager();
        const first = await sessions.start("emulate-first");
        const read = async () =>
          (
            await cdp.send<{ result: { value: { ua: string; touch: number } } }>(
              7,
              "Runtime.evaluate",
              {
                expression: "({ua: navigator.userAgent, touch: navigator.maxTouchPoints})",
                returnByValue: true,
              },
            )
          ).result.value;
        const original = await read();
        const firstReply = await handleEmulate(
          sessions,
          {
            session_id: first.sessionId,
            tab_id: 7,
            overrides: {
              width: 390,
              height: 844,
              mobile: true,
              device_scale_factor: 3,
              user_agent: "BSK-AUDIT-OLD-SESSION",
              touch: true,
              max_touch_points: 5,
            },
          },
          { cdp, tabsApi },
        );
        expect(firstReply).not.toHaveProperty("code");
        expect((await read()).ua).toBe("BSK-AUDIT-OLD-SESSION");
        // This is the production return-tab cleanup path. The Chrome tab survives.
        await cdp.releaseSessionTab(first.sessionId, 7);
        await sessions.stop(first.sessionId);
        const afterReturn = await read();
        expect(afterReturn).toEqual(original);
        const second = await sessions.start("emulate-second");
        const secondReply = await handleEmulate(
          sessions,
          { session_id: second.sessionId, tab_id: 7, overrides: { width: 1200, height: 800 } },
          { cdp, tabsApi },
        );
        expect(secondReply).not.toHaveProperty("code");
        const afterSecond = await read();
        console.log(
          "EMULATION_PROOF",
          JSON.stringify({ original, afterReturn, afterSecond, secondReply }),
        );
        expect(afterSecond).toEqual(original);
      });
    } finally {
      resetEmulateStatesForTests();
    }
  }, 40_000);
});
