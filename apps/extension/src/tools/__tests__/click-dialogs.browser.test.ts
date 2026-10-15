// @vitest-environment node
// Opt in with BSK_CLICK_CHROME. Owns an isolated browser/profile and local page.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { handleDialog, pendingDialogError } from "../dialogs";
import { handleNavigate } from "../navigation";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type Listener = (
  source: { tabId: number; sessionId?: string },
  method: string,
  params: unknown,
) => void;

async function browser(
  run: (
    cdp: ChromiumCdp,
    url: string,
    sessions: SessionManager,
    tabs: {
      get(): Promise<chrome.tabs.Tab>;
      query(): Promise<chrome.tabs.Tab[]>;
    },
  ) => Promise<void>,
  auto = true,
) {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><title>Dialog regression</title><button style="width:150px;height:80px">Activate</button>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const { withChrome } = await import(
    new URL(
      "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
      import.meta.url,
    ).href
  );
  const listeners = new Set<Listener>();
  let attached = "";
  try {
    await withChrome(
      {
        executable: process.env.BSK_CLICK_CHROME,
        deviceScale: 1,
        zoom: 1,
        onEvent: (event: { sessionId?: string; method: string; params: unknown }) => {
          if (!attached || !event.sessionId) return;
          const source = {
            tabId: 7,
            ...(event.sessionId === attached ? {} : { sessionId: event.sessionId }),
          };
          for (const listener of listeners) listener(source, event.method, event.params);
        },
      },
      async (send: Send) => {
        const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url });
        const api: CdpDebuggerApi = {
          attach: async () => {
            attached = (
              await send<{ sessionId: string }>("Target.attachToTarget", {
                targetId,
                flatten: true,
              })
            ).sessionId;
          },
          detach: async () => {
            await send("Target.detachFromTarget", { sessionId: attached });
            attached = "";
          },
          sendCommand: (target, method, params) =>
            send(method, params, target.sessionId ?? attached),
          onEvent: {
            addListener: (listener: Listener) => listeners.add(listener),
            removeListener: (listener: Listener) => listeners.delete(listener),
          } as unknown as CdpDebuggerApi["onEvent"],
          onDetach: {
            addListener() {},
            removeListener() {},
          } as unknown as CdpDebuggerApi["onDetach"],
        };
        const cdp = new ChromiumCdp(api, { shouldAutoAcceptDialog: () => auto });
        const sessions = new SessionManager({
          agentWindow: {
            create: async () => ({ windowId: 100, initialTabIds: [7] }),
            remove: async () => {},
            ensureActiveTab: async () => 7,
          },
        });
        await sessions.start("dialogs");
        const tab = { id: 7, windowId: 100, active: true, url } as chrome.tabs.Tab;
        const tabs = { get: async () => tab, query: async () => [tab] };
        try {
          await cdp.ensureAttached(7);
          await vi.waitFor(async () =>
            expect(await read(cdp, "!!document.querySelector('button')")).toBe(true),
          );
          await run(cdp, url, sessions, tabs);
        } finally {
          await cdp.detach(7);
          cdp.dispose();
        }
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function read(cdp: ChromiumCdp, expression: string) {
  return (
    await cdp.send<{ result: { value: unknown } }>(7, "Runtime.evaluate", {
      expression,
      returnByValue: true,
    })
  ).result.value;
}

describe.skipIf(!process.env.BSK_CLICK_CHROME)("native JavaScript dialog control", () => {
  it("lets a sequential agent inspect, cancel and accept confirm without replaying the action", async () => {
    await browser(async (cdp, _url, sessions, tabs) => {
      for (const action of ["dismiss", "accept"] as const) {
        await expect(
          read(cdp, "window.calls=(window.calls||0)+1;window.answer=confirm('Proceed?')"),
        ).rejects.toThrow("dialog is pending");
        expect(
          await pendingDialogError(sessions, { session_id: "dialogs" }, cdp, tabs),
        ).toMatchObject({ data: { reason: "dialog_pending", dialog: { type: "confirm" } } });
        const status = await handleDialog(
          sessions,
          { session_id: "dialogs", action: "status" },
          cdp,
          tabs,
        );
        expect(status).toMatchObject({ pending: { type: "confirm", message: "Proceed?" } });
        expect(
          await handleDialog(sessions, { session_id: "dialogs", action }, cdp, tabs),
        ).toMatchObject({ pending: null, execution_pending: false });
        expect(await read(cdp, "window.answer")).toBe(action === "accept");
      }
      expect(await read(cdp, "window.calls")).toBe(2);
    });
  }, 30_000);

  it("supports prompt defaults, custom Unicode text, empty text and cancellation", async () => {
    await browser(async (cdp, _url, sessions, tabs) => {
      for (const [action, text, expected] of [
        ["accept", undefined, "anonymous"],
        ["accept", "阿尔托莉雅\nAda", "阿尔托莉雅\nAda"],
        ["accept", "", ""],
        ["dismiss", undefined, null],
      ] as const) {
        await expect(read(cdp, "window.answer=prompt('Name?', 'anonymous')")).rejects.toThrow(
          "dialog is pending",
        );
        const result = await handleDialog(
          sessions,
          { session_id: "dialogs", action, prompt_text: text },
          cdp,
          tabs,
        );
        expect(result).toMatchObject({ pending: null, execution_pending: false });
        expect(await read(cdp, "window.answer")).toBe(expected);
      }
    });
  }, 30_000);

  it("preserves the second dialog from the same script", async () => {
    await browser(async (cdp) => {
      await expect(
        read(cdp, "window.first=confirm('First?');window.second=prompt('Second?', 'default')"),
      ).rejects.toThrow("dialog is pending");
      await cdp.handleDialog(7, cdp.pendingDialog(7)!.id, true);
      await vi.waitFor(() => expect(cdp.pendingDialog(7)?.message).toBe("Second?"));
      await cdp.handleDialog(7, cdp.pendingDialog(7)!.id, true, "chosen");
      expect(await read(cdp, "[window.first,window.second]")).toEqual([true, "chosen"]);
    });
  }, 30_000);

  it("can keep a beforeunload page open, then explicitly leave it", async () => {
    await browser(async (cdp, url, sessions, tabs) => {
      await cdp.send(7, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 30,
        y: 30,
        button: "left",
        clickCount: 1,
      });
      await cdp.send(7, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 30,
        y: 30,
        button: "left",
        clickCount: 1,
      });
      await read(cdp, "window.onbeforeunload=()=>true;1");
      for (const accept of [false, true]) {
        const reply = await handleNavigate(
          sessions,
          { session_id: "dialogs", url: `${url}next`, timeout_ms: 10000 },
          { cdp, tabsApi: tabs },
        );
        expect(reply).toHaveProperty("code", "cdp_failed");
        await vi.waitFor(() => expect(cdp.pendingDialog(7)?.type).toBe("beforeunload"));
        await cdp.handleDialog(7, cdp.pendingDialog(7)!.id, accept);
        await vi.waitFor(async () =>
          expect(await read(cdp, "location.href")).toBe(accept ? `${url}next` : url),
        );
      }
    }, false);
  }, 30_000);

  it("auto-accepts alert by default and honors the opt-out", async () => {
    await browser(async (cdp) => {
      expect(await read(cdp, "alert('Automatic');42")).toBe(42);
      expect(cdp.dialogsSince(7, 0)).toMatchObject([{ type: "alert", handled: "accepted" }]);
    });
    await browser(async (cdp) => {
      await expect(read(cdp, "alert('Manual');window.finished=true")).rejects.toThrow(
        "dialog is pending",
      );
      await cdp.handleDialog(7, cdp.pendingDialog(7)!.id, true);
      expect(await read(cdp, "window.finished")).toBe(true);
    }, false);
  }, 30_000);

  it("releases a mouse press blocked by a dialog without replaying the click", async () => {
    await browser(async (cdp) => {
      await read(
        cdp,
        `window.clicks=0;const button=document.querySelector('button');button.onmousedown=()=>{window.answer=confirm('Down?')};button.onclick=()=>window.clicks++;1`,
      );
      const point = { x: 30, y: 30, button: "left", clickCount: 1 };
      await expect(
        cdp.send(7, "Input.dispatchMouseEvent", { type: "mousePressed", ...point }),
      ).rejects.toThrow("dialog is pending");
      // The tool's finally block sends one release even though the renderer is blocked.
      await expect(
        cdp.send(7, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point }),
      ).rejects.toThrow("dialog is pending");
      await cdp.handleDialog(7, cdp.pendingDialog(7)!.id, false);
      // Chrome cancels the click sequence when its mousedown opens a modal.
      expect(await read(cdp, "[window.answer,window.clicks]")).toEqual([false, 0]);
      await read(cdp, "document.querySelector('button').onmousedown=null;1");
      await cdp.send(7, "Input.dispatchMouseEvent", { type: "mousePressed", ...point });
      await cdp.send(7, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
      expect(await read(cdp, "window.clicks")).toBe(1);
    });
  }, 30_000);
});
