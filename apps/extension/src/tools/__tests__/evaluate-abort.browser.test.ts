// @vitest-environment node
// Opt in with BSK_TEST_CHROME; exercises top-level ToolDispatcher + CooperationController
// + ChromiumCdp against real Chrome for evaluate AbortSignal cancellation, session recovery,
// zero unhandled rejections, and native JS dialog non-regression.

import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { CooperationController } from "@/cooperation/controller";
import type { FrameState } from "@/cooperation/types";
import { SessionManager } from "@/session-manager/manager";
import type { Transport } from "@/transport/transport";
import type { ProtocolFrame, ResponseFrame } from "@/transport/types";
import { ToolDispatcher } from "../dispatcher";

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

type CdpEventListener = Parameters<CdpDebuggerApi["onEvent"]["addListener"]>[0];
type CdpDetachListener = Parameters<CdpDebuggerApi["onDetach"]["addListener"]>[0];

function fakeTransport() {
  const sent: ProtocolFrame[] = [];
  let listener: ((frame: ProtocolFrame) => void) | null = null;
  const transport: Transport = {
    state: "connected",
    connect: async () => {},
    disconnect: async () => {},
    send(frame) {
      sent.push(frame);
    },
    onMessage(handler) {
      listener = handler;
      return {
        dispose() {
          if (listener === handler) listener = null;
        },
      };
    },
    onConnectionStateChange() {
      return { dispose() {} };
    },
  };
  const deliver = (frame: ProtocolFrame) => {
    listener?.(frame);
  };
  const waitForResponse = async (id: string, timeoutMs = 10_000): Promise<ResponseFrame> => {
    let found: ResponseFrame | undefined;
    await expect
      .poll(
        () => {
          found = sent.find((frame): frame is ResponseFrame => "id" in frame && frame.id === id);
          return Boolean(found);
        },
        { timeout: timeoutMs },
      )
      .toBe(true);
    return found!;
  };
  return { transport, sent, deliver, waitForResponse };
}

function stubChromeForTab(tabId: number, windowId: number, url: string) {
  const tab = {
    id: tabId,
    windowId,
    active: true,
    url,
    status: "complete",
  } as chrome.tabs.Tab;
  vi.stubGlobal("chrome", {
    runtime: { lastError: undefined },
    tabs: {
      get: vi.fn(async () => ({ ...tab })),
      query: vi.fn(async () => [{ ...tab }]),
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
    windows: {
      get: vi.fn(async () => ({ id: windowId, focused: true, state: "normal" })),
      update: vi.fn(async () => ({ id: windowId, focused: true, state: "normal" })),
    },
  });
}

function makeFrameState(url: string, revision = 0): FrameState {
  return {
    document: "doc-root",
    url,
    focusIsDocument: true,
    revision,
    structure: 0,
    human: 0,
    busy: false,
    editing: false,
    lastInput: 0,
    fields: [],
    events: [],
  };
}

function createChromeBridge(send: Send, targetId: string, tabId: number) {
  let activeRootSession = "";
  const childSessions = new Set<string>();
  const eventListeners = new Set<CdpEventListener>();
  const detachListeners = new Set<CdpDetachListener>();

  const onEvent = (event: CdpEvent) => {
    if (!activeRootSession) return;
    if (event.method === "Target.attachedToTarget" && event.sessionId === activeRootSession) {
      const sid = (event.params as { sessionId?: string } | undefined)?.sessionId;
      if (sid) childSessions.add(sid);
    }
    if (event.sessionId === activeRootSession) {
      for (const fn of [...eventListeners]) fn({ tabId }, event.method, event.params);
    } else if (event.sessionId && childSessions.has(event.sessionId)) {
      for (const fn of [...eventListeners])
        fn({ tabId, sessionId: event.sessionId }, event.method, event.params);
    }
  };

  const api: CdpDebuggerApi = {
    attach: async () => {
      childSessions.clear();
      const reply = await send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      activeRootSession = reply.sessionId;
    },
    detach: async () => {
      const prev = activeRootSession;
      activeRootSession = "";
      childSessions.clear();
      if (prev) {
        await send("Target.detachFromTarget", { sessionId: prev }).catch(() => {});
        for (const fn of [...detachListeners]) fn({ tabId }, "canceled_by_user");
      }
    },
    sendCommand: async (target, method, params) => {
      const sid = target.sessionId ?? activeRootSession;
      if (!sid) throw new Error("debugger detached");
      return send(method, params, sid);
    },
    onEvent: {
      addListener: (fn: CdpEventListener) => eventListeners.add(fn),
      removeListener: (fn: CdpEventListener) => eventListeners.delete(fn),
    } as unknown as CdpDebuggerApi["onEvent"],
    onDetach: {
      addListener: (fn: CdpDetachListener) => detachListeners.add(fn),
      removeListener: (fn: CdpDetachListener) => detachListeners.delete(fn),
    } as unknown as CdpDebuggerApi["onDetach"],
  };

  return { api, onEvent };
}

describe.skipIf(!process.env.BSK_TEST_CHROME)(
  "real browser evaluate AbortSignal cancellation and session recovery",
  () => {
    it("unblocks hanging evaluate on cancel, releases activeDialogOperations, recovers click/observe/evaluate, and avoids unhandled rejections", async () => {
      const server = createServer((_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html>
          <meta charset="utf-8">
          <title>Evaluate Abort Fixture</title>
          <main>
            <button id="action-btn" type="button">Run Action</button>
          </main>
          <script>
            window.__clicks = 0;
            document.getElementById("action-btn").addEventListener("click", () => {
              window.__clicks += 1;
            });
          </script>`);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      try {
        const { withChrome } = await import(
          new URL(
            "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );

        let forwardEvent: ((event: CdpEvent) => void) | undefined;
        await withChrome(
          {
            executable: process.env.BSK_TEST_CHROME,
            deviceScale: 1,
            zoom: 1,
            startupTimeout: 30_000,
            onEvent: (event: CdpEvent) => forwardEvent?.(event),
          },
          async (send: Send) => {
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url });
            const { sessionId: monitorSession } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId, flatten: true },
            );
            const evalHost = async <T>(expression: string): Promise<T> => {
              const reply = await send<{ result?: { value?: T } }>(
                "Runtime.evaluate",
                { expression, returnByValue: true },
                monitorSession,
              );
              return reply.result?.value as T;
            };
            await expect.poll(() => evalHost<string>("document.readyState")).toBe("complete");

            const tabId = 4;
            const windowId = 100;
            stubChromeForTab(tabId, windowId, url);

            const bridge = createChromeBridge(send, targetId, tabId);
            forwardEvent = bridge.onEvent;
            const cdp = new ChromiumCdp(bridge.api);
            vi.spyOn(cdp, "prepareInputTimestamp").mockImplementation(async () => ({
              timestamp: Date.now(),
              nativeTimestamp: Date.now() / 1000,
              assertValid: () => {},
            }));

            const sessions = new SessionManager({
              agentWindow: {
                create: async () => ({ windowId, initialTabIds: [tabId] }),
                remove: async () => {},
                ensureActiveTab: async () => tabId,
              },
            });
            await sessions.start("eval-abort");

            const cooperation = new CooperationController({
              sessions,
              readFrames: async (_tabId, _input, _lease, _repairs, _hidden, _timeoutMs, signal) => {
                signal?.throwIfAborted();
                return { frames: new Map([[0, makeFrameState(url)]]), gaps: [] };
              },
              resumeFrames: async () => {},
              changed: () => {},
            });
            cooperation.startSession("eval-abort");

            let abortNextDebugBefore = false;
            const { transport, deliver, waitForResponse } = fakeTransport();
            let dispatcher!: ToolDispatcher;
            dispatcher = new ToolDispatcher({
              transport,
              sessions,
              cooperation,
              cdp,
              debug: {
                before: async (req: { id: string }) => {
                  if (abortNextDebugBefore) {
                    abortNextDebugBefore = false;
                    dispatcher.inflightAbortControllers.get(req.id)?.abort();
                  }
                  return undefined;
                },
                after: () => {},
                dispose: () => {},
              } as never,
            });
            dispatcher.start();

            try {
              // 1. Sync cooperation context (target policy, matching production default).
              deliver({
                id: "sync-1",
                method: "tool.cooperate",
                params: {
                  session_id: "eval-abort",
                  tab_id: tabId,
                  action: "sync",
                  control_policy: "target",
                },
              });
              const sync1 = await waitForResponse("sync-1");
              expect("result" in sync1).toBe(true);
              const ctx1 = (sync1 as { result: { context_id: string } }).result.context_id;

              // 2. Pre-dispatch cancel must report effect_state: "none" and never execute JS.
              abortNextDebugBefore = true;
              deliver({
                id: "eval-pre-cancel",
                operation_id: "op-pre-cancel",
                method: "tool.evaluate",
                params: {
                  session_id: "eval-abort",
                  tab_id: tabId,
                  expression: "window.__preCancelRan = true",
                  unverified: true,
                  context_id: ctx1,
                },
              });
              const preCancelResp = await waitForResponse("eval-pre-cancel");
              expect(preCancelResp).toMatchObject({
                id: "eval-pre-cancel",
                error: {
                  code: "cancelled",
                  data: {
                    reason: "cancelled_before_dispatch",
                    dispatched: false,
                    effect_state: "none",
                    phase: "precondition",
                  },
                },
              });
              expect(await evalHost("window.__preCancelRan ?? null")).toBeNull();

              // 3. Dispatch a hanging `new Promise(() => {})` evaluate with operation_id.
              deliver({
                id: "eval-hang",
                operation_id: "op-hang",
                method: "tool.evaluate",
                params: {
                  session_id: "eval-abort",
                  tab_id: tabId,
                  expression: "window.__hangStarted = true; new Promise(() => {})",
                  unverified: true,
                  context_id: ctx1,
                },
              });
              await expect
                .poll(() => evalHost<boolean>("Boolean(window.__hangStarted)"))
                .toBe(true);

              // Cancel the hanging RPC (simulating daemon timeout or user cancel).
              deliver({
                id: "cancel-hang",
                method: "cancel",
                params: { rpc_id: "eval-hang" },
              });
              const cancelAck = await waitForResponse("cancel-hang");
              expect(cancelAck).toEqual({ id: "cancel-hang", result: { cancelled: true } });

              const hangResp = await waitForResponse("eval-hang");
              expect(hangResp).toMatchObject({
                id: "eval-hang",
                error: {
                  code: "cancelled",
                  data: {
                    effect_state: "unknown",
                    phase: "execution",
                    tab_id: tabId,
                  },
                },
              });

              // 4. Same session immediately recovers: observe, cooperate sync, click, evaluate.
              deliver({
                id: "observe-after",
                operation_id: "op-observe-after",
                method: "tool.observe",
                params: { session_id: "eval-abort", tab_id: tabId },
              });
              const observeResp = await waitForResponse("observe-after");
              expect("result" in observeResp).toBe(true);
              expect((observeResp as { result: { text: string } }).result.text).toContain(
                "Run Action",
              );

              deliver({
                id: "sync-2",
                method: "tool.cooperate",
                params: { session_id: "eval-abort", tab_id: tabId, action: "sync" },
              });
              const sync2 = await waitForResponse("sync-2");
              expect("result" in sync2).toBe(true);
              const ctx2 = (sync2 as { result: { context_id: string } }).result.context_id;

              deliver({
                id: "click-after",
                operation_id: "op-click-after",
                method: "tool.click",
                params: {
                  session_id: "eval-abort",
                  tab_id: tabId,
                  selector: "#action-btn",
                  context_id: ctx2,
                },
              });
              const clickResp = await waitForResponse("click-after");
              expect("result" in clickResp).toBe(true);
              expect(await evalHost<number>("window.__clicks")).toBe(1);

              deliver({
                id: "eval-after",
                operation_id: "op-eval-after",
                method: "tool.evaluate",
                params: {
                  session_id: "eval-abort",
                  tab_id: tabId,
                  expression: "1 + 1",
                  unverified: true,
                  context_id: ctx2,
                },
              });
              const evalAfterResp = await waitForResponse("eval-after");
              expect(evalAfterResp).toMatchObject({
                id: "eval-after",
                result: { ok: true, tab_id: tabId, value: 2 },
              });

              // 5. Direct ChromiumCdp.send(..., signal) also aborts in-flight without poisoning the tab.
              const directAc = new AbortController();
              const directPromise = cdp.send(
                tabId,
                "Runtime.evaluate",
                {
                  expression: "window.__directStarted = true; new Promise(() => {})",
                  awaitPromise: true,
                  returnByValue: true,
                },
                directAc.signal,
              );
              await expect
                .poll(() => evalHost<boolean>("Boolean(window.__directStarted)"))
                .toBe(true);
              directAc.abort();
              await expect(directPromise).rejects.toMatchObject({ name: "AbortError" });
              await expect(
                cdp.send(tabId, "Runtime.evaluate", { expression: "2 + 3", returnByValue: true }),
              ).resolves.toMatchObject({ result: { value: 5 } });

              // Detach and close the target so Chrome rejects both abandoned Runtime.evaluate calls.
              await cdp.detach(tabId);
              await send("Target.closeTarget", { targetId }).catch(() => {});
              await new Promise((resolve) => setTimeout(resolve, 100));
              expect(unhandled).toEqual([]);
            } finally {
              dispatcher.stop();
              cdp.dispose();
              vi.unstubAllGlobals();
            }
          },
        );
      } finally {
        process.off("unhandledRejection", onUnhandled);
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 60_000);

    it("preserves native JS dialog flow (DialogPending) and clears pending dialogs cleanly on cancel", async () => {
      const server = createServer((_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><meta charset="utf-8"><title>Dialog Fixture</title><p>Ready</p>`);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

      try {
        const { withChrome } = await import(
          new URL(
            "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );

        let forwardEvent: ((event: CdpEvent) => void) | undefined;
        await withChrome(
          {
            executable: process.env.BSK_TEST_CHROME,
            deviceScale: 1,
            zoom: 1,
            startupTimeout: 30_000,
            onEvent: (event: CdpEvent) => forwardEvent?.(event),
          },
          async (send: Send) => {
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url });
            const tabId = 7;
            const windowId = 107;
            stubChromeForTab(tabId, windowId, url);

            const bridge = createChromeBridge(send, targetId, tabId);
            forwardEvent = bridge.onEvent;
            const cdp = new ChromiumCdp(bridge.api);
            const sessions = new SessionManager({
              agentWindow: {
                create: async () => ({ windowId, initialTabIds: [tabId] }),
                remove: async () => {},
                ensureActiveTab: async () => tabId,
              },
            });
            await sessions.start("eval-dialog");

            const { transport, sent, deliver, waitForResponse } = fakeTransport();
            const dispatcher = new ToolDispatcher({ transport, sessions, cdp });
            dispatcher.start();

            const waitForDialog = async (operationId: string) => {
              let dialogId = "";
              await expect
                .poll(() => {
                  const ev = sent.find(
                    (frame) =>
                      "event" in frame &&
                      frame.event === "dialog.changed" &&
                      (frame.payload as { operation_id?: string; dialog?: { id?: string } | null })
                        ?.operation_id === operationId &&
                      Boolean((frame.payload as { dialog?: { id?: string } | null })?.dialog?.id),
                  );
                  if (ev && "payload" in ev) {
                    dialogId = (ev.payload as { dialog: { id: string } }).dialog.id;
                  }
                  return Boolean(dialogId);
                })
                .toBe(true);
              return dialogId;
            };

            try {
              // 1. Native confirm() stays open until explicitly accepted via tool.dialog_accept.
              deliver({
                id: "eval-confirm",
                operation_id: "op-confirm",
                method: "tool.evaluate",
                params: {
                  session_id: "eval-dialog",
                  tab_id: tabId,
                  expression: "confirm('proceed?')",
                },
              });
              const confirmDialogId = await waitForDialog("op-confirm");
              await new Promise((resolve) => setTimeout(resolve, 300));
              expect(sent.some((f) => "id" in f && f.id === "eval-confirm")).toBe(false);

              deliver({
                id: "accept-confirm",
                method: "tool.dialog_accept",
                params: { session_id: "eval-dialog", dialog_id: confirmDialogId },
              });
              expect("result" in (await waitForResponse("accept-confirm"))).toBe(true);
              expect(await waitForResponse("eval-confirm")).toMatchObject({
                id: "eval-confirm",
                result: { ok: true, tab_id: tabId, value: true },
              });

              // 2. Cancelling a chained-dialog evaluate dismisses every dialog before replying.
              deliver({
                id: "eval-confirm-cancel",
                operation_id: "op-confirm-cancel",
                method: "tool.evaluate",
                params: {
                  session_id: "eval-dialog",
                  tab_id: tabId,
                  expression: "confirm('cancel first?'); prompt('cancel second?')",
                },
              });
              await waitForDialog("op-confirm-cancel");

              deliver({
                id: "cancel-confirm",
                method: "cancel",
                params: { rpc_id: "eval-confirm-cancel" },
              });
              expect(await waitForResponse("cancel-confirm")).toEqual({
                id: "cancel-confirm",
                result: { cancelled: true },
              });
              expect(await waitForResponse("eval-confirm-cancel")).toMatchObject({
                id: "eval-confirm-cancel",
                error: {
                  code: "cancelled",
                  data: {
                    effect_state: "unknown",
                    phase: "execution",
                    tab_id: tabId,
                  },
                },
              });

              // Dialog status is immediately empty and the next operation succeeds.
              deliver({
                id: "dialog-status-after",
                method: "tool.dialog_status",
                params: { session_id: "eval-dialog" },
              });
              expect(await waitForResponse("dialog-status-after")).toMatchObject({
                id: "dialog-status-after",
                result: { session_id: "eval-dialog", dialogs: [] },
              });

              deliver({
                id: "eval-after-dialog-cancel",
                operation_id: "op-after-dialog-cancel",
                method: "tool.evaluate",
                params: {
                  session_id: "eval-dialog",
                  tab_id: tabId,
                  expression: "40 + 2",
                },
              });
              expect(await waitForResponse("eval-after-dialog-cancel")).toMatchObject({
                id: "eval-after-dialog-cancel",
                result: { ok: true, tab_id: tabId, value: 42 },
              });
            } finally {
              dispatcher.stop();
              cdp.dispose();
              vi.unstubAllGlobals();
            }
          },
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 60_000);
  },
);
