// @vitest-environment node
// Runs production dispatch against an isolated Chrome profile and synthetic form.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { DebugManager } from "@/debug/manager";
import { SessionManager } from "@/session-manager/manager";
import type { FrameHandler, Transport } from "@/transport/transport";
import type { ObserveResult, ProtocolFrame, ResponseFrame } from "@/transport/types";
import type { BatchResult } from "../batch";
import { ToolDispatcher } from "../dispatcher";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

async function browser(
  run: (
    call: <T>(method: string, params: object) => Promise<T>,
    cdp: ChromiumCdp,
    traced: string[],
  ) => Promise<void>,
) {
  const { withChrome } = await import(
    new URL(
      "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
      import.meta.url,
    ).href
  );
  await withChrome(
    { executable: process.env.BSK_CLICK_CHROME, deviceScale: 1, zoom: 1, startupTimeout: 30_000 },
    async (send: Send) => {
      const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      let activeSession = "";
      const api: CdpDebuggerApi = {
        attach: async () => {
          activeSession = (
            await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
          ).sessionId;
        },
        detach: async () => {
          await send("Target.detachFromTarget", { sessionId: activeSession });
        },
        sendCommand: async (_target, method, params) => send(method, params, activeSession),
        onEvent: { addListener() {}, removeListener() {} } as unknown as CdpDebuggerApi["onEvent"],
        onDetach: {
          addListener() {},
          removeListener() {},
        } as unknown as CdpDebuggerApi["onDetach"],
      };
      const cdp = new ChromiumCdp(api);
      const tab = { id: 7, windowId: 100, active: true, url: "about:blank" };
      vi.stubGlobal("chrome", {
        tabs: { get: async () => tab, query: async () => [tab], sendMessage: async () => ({}) },
      });
      const sessions = new SessionManager({
        agentWindow: {
          create: async () => ({ windowId: 100, initialTabIds: [7] }),
          remove: async () => {},
          ensureActiveTab: async () => 7,
        },
      });
      await sessions.start("batch-browser");
      let listener: FrameHandler | undefined;
      let sequence = 0;
      const pending = new Map<string, (frame: ResponseFrame) => void>();
      const transport: Transport = {
        state: "connected",
        connect: async () => {},
        disconnect: async () => {},
        onMessage: (handler) => {
          listener = handler;
          return {
            dispose: () => {
              listener = undefined;
            },
          };
        },
        onConnectionStateChange: () => ({ dispose() {} }),
        send: (frame: ProtocolFrame) => {
          if ("id" in frame) pending.get(frame.id)?.(frame as ResponseFrame);
        },
      };
      const traced: string[] = [];
      const debug = {
        before: async (request: { method: string }) => {
          traced.push(request.method);
        },
        after() {},
        dispose() {},
      } as unknown as DebugManager;
      const dispatcher = new ToolDispatcher({ transport, sessions, cdp, debug });
      dispatcher.start();
      const call = <T>(method: string, params: object): Promise<T> =>
        new Promise((resolve, reject) => {
          const id = `call-${++sequence}`;
          pending.set(id, (frame) => {
            pending.delete(id);
            if ("error" in frame) reject(new Error(JSON.stringify(frame.error)));
            else resolve(frame.result as T);
          });
          listener?.({ id, method, params: { session_id: "batch-browser", ...params } });
        });
      try {
        await run(call, cdp, traced);
      } finally {
        dispatcher.stop();
        await cdp.detach(7);
      }
    },
  );
}

async function form(cdp: ChromiumCdp, replaceSelect: boolean) {
  await cdp.send(7, "Runtime.evaluate", {
    expression: `
    document.body.innerHTML = '<form><label>Company<input id="company"></label><label>Contact<input id="contact"></label><label>Industry<select id="industry"><option value="">Choose</option><option value="software">Software</option></select></label><button>Submit form</button></form><p id="result"></p>';
    window.submissions = [];
    document.querySelector('form').onsubmit = event => {
      event.preventDefault();
      submissions.push({company: company.value, contact: contact.value, industry: industry.value, trusted: event.isTrusted});
      document.querySelector('#result').textContent = 'FORM-SAVED';
    };
    if (${replaceSelect}) contact.oninput = () => { const old = document.querySelector('#industry'); old.replaceWith(old.cloneNode(true)); };
  `,
  });
}

function ref(observation: ObserveResult, role: string, label: string): string {
  const match = observation.text.match(new RegExp(`(@e\\d+) ${role} "${label}(?: \\[[^"]*\\])?"`));
  if (!match) throw new Error(`Missing ${label}: ${observation.text}`);
  return match[1];
}

function steps(observation: ObserveResult) {
  return [
    { action: "fill", target: ref(observation, "textbox", "Company"), value: "Example company" },
    { action: "fill", target: ref(observation, "textbox", "Contact"), value: "Alice" },
    { action: "select", target: ref(observation, "combobox", "Industry"), values: ["software"] },
    { action: "click", target: ref(observation, "button", "Submit form") },
  ];
}

async function submissions(cdp: ChromiumCdp) {
  return (
    await cdp.send<{ result: { value: unknown[] } }>(7, "Runtime.evaluate", {
      expression: "submissions",
      returnByValue: true,
    })
  ).result.value;
}

afterEach(() => vi.unstubAllGlobals());

describe.skipIf(!process.env.BSK_CLICK_CHROME)("batch browser recovery", () => {
  it("submits once using native interactions and does not replay a repeated request", async () => {
    await browser(async (call, cdp, traced) => {
      await form(cdp, false);
      const observation = await call<ObserveResult>("tool.observe", {});
      const plan = {
        request_id: "submit-once",
        observation_id: observation.observation_id,
        steps: steps(observation),
      };
      const result = await call<BatchResult>("tool.batch", plan);
      expect(result.status, JSON.stringify(result)).toBe("completed");
      expect(result.observation?.text).toContain("FORM-SAVED");
      expect(await call("tool.batch", plan)).toEqual(result);
      expect(
        traced.filter((method) => ["tool.fill", "tool.select", "tool.click"].includes(method)),
      ).toEqual(["tool.fill", "tool.fill", "tool.select", "tool.click"]);
      expect(await submissions(cdp)).toEqual([
        { company: "Example company", contact: "Alice", industry: "software", trusted: true },
      ]);
    });
  }, 60_000);

  it("finishes through single actions after a dynamic page breaks the batch", async () => {
    await browser(async (call, cdp) => {
      await form(cdp, true);
      const observation = await call<ObserveResult>("tool.observe", {});
      const result = await call<BatchResult>("tool.batch", {
        request_id: "recover",
        observation_id: observation.observation_id,
        steps: steps(observation),
      });
      expect(result.status).toBe("stopped");
      expect(result.steps.map((step) => step.status)).toEqual([
        "completed",
        "completed",
        "not_run",
        "not_run",
      ]);
      expect(await submissions(cdp)).toEqual([]);
      const fresh = result.observation ?? (await call<ObserveResult>("tool.observe", {}));
      await call("tool.select", { ref: ref(fresh, "combobox", "Industry"), values: ["software"] });
      await call("tool.click", { ref: ref(fresh, "button", "Submit form") });
      expect(await submissions(cdp)).toEqual([
        { company: "Example company", contact: "Alice", industry: "software", trusted: true },
      ]);
      expect((await call<ObserveResult>("tool.observe", {})).text).toContain("FORM-SAVED");
    });
  }, 60_000);
});
