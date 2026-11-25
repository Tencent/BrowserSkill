// @vitest-environment node
// Opt in with BSK_TEST_CHROME=/path/to/chrome; exercises full handleRecordStart -> real Chrome DOM + VOM -> handleRecordStop -> TraceV3.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type FrameDocumentInfo,
  rootEventSource,
  type TabEventSource,
  toFrameDocumentHandle,
} from "@/browser-driver/frame-handles";
import { RecordFrameCoordinator } from "@/lib/recording/frame-coordinator";
import { RECORD_PASSWORD_ATTRIBUTE } from "@/lib/sensitive-autocomplete";
import { SessionManager } from "@/session-manager/manager";
import { RECORD_DOCUMENT_ATTRIBUTE } from "@/shared/recording-document-identity";
import type { RecordStopResult, TraceV3 } from "@/transport/types";
import {
  attachRecordStepListener,
  clearRecordingForSession,
  handleRecordStart,
  handleRecordStop,
  type RecordDeps,
  resetBrowserObservationForTests,
} from "../record";
import { type CdpRunner, type ChromeTabsApi, createStubCdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

type CdpEventMessage = {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type EventHub<T extends (...args: never[]) => unknown> = {
  addListener(fn: T): void;
  removeListener(fn: T): void;
  emit(...args: Parameters<T>): void;
};

function createEventHub<T extends (...args: never[]) => unknown>(): EventHub<T> {
  const listeners = new Set<T>();
  return {
    addListener: (fn) => {
      listeners.add(fn);
    },
    removeListener: (fn) => {
      listeners.delete(fn);
    },
    emit: (...args) => {
      for (const fn of [...listeners]) fn(...args);
    },
  };
}

let browserSend: Send;
let frameAgentBundle: string;
let closeBrowser: (() => void) | undefined;
let browserRun: Promise<void> | undefined;
let server: Server;
let baseUrl = "";
const cdpEventListeners = new Set<(event: CdpEventMessage) => void>();
const pages = new Map<string, string>();

if (process.env.BSK_TEST_CHROME) {
  beforeAll(async () => {
    const built = await build({
      entryPoints: [
        fileURLToPath(new URL("../../content/recording/frame-agent.ts", import.meta.url)),
      ],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "RecordFrameAgentBundle",
      platform: "browser",
    });
    frameAgentBundle = built.outputFiles[0].text;

    server = createServer((req, res) => {
      const pathName = (req.url ?? "/").split("?")[0] ?? "/";
      const html = pages.get(pathName) ?? "<!doctype html><html><body>ok</body></html>";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    const { withChrome } = await import(
      new URL(
        "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
    const ready = Promise.withResolvers<Send>();
    const closed = Promise.withResolvers<void>();
    closeBrowser = () => closed.resolve();
    browserRun = withChrome(
      {
        executable: process.env.BSK_TEST_CHROME,
        deviceScale: 1,
        zoom: 1,
        onEvent(event: CdpEventMessage) {
          for (const listener of [...cdpEventListeners]) listener(event);
        },
      },
      async (send: Send) => {
        ready.resolve(send);
        await closed.promise;
      },
    );
    browserRun!.catch(ready.reject);
    browserSend = await ready.promise;
  }, 30_000);

  afterAll(async () => {
    closeBrowser?.();
    await browserRun;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
}

interface RecordingHarness {
  evaluate<T = unknown>(expression: string): Promise<T>;
  clickPoint(point: { x: number; y: number }): Promise<void>;
  clickSelector(selector: string): Promise<void>;
  insertText(text: string): Promise<void>;
  snapshotCount(): number;
  waitForSnapshotAfter(previous: number): Promise<void>;
  onPostStopSnapshot(hook: () => Promise<void>): void;
  stop(): Promise<TraceV3>;
  cancel(): void;
}

async function withRecordingHarness(
  route: string,
  html: string,
  run: (h: RecordingHarness) => Promise<void>,
): Promise<void> {
  pages.set(route, html);
  const url = `${baseUrl}${route}`;
  const TAB_ID = 42;
  const DOC_ID = `doc-${route}`;
  const SESSION_ID = "rec-pw-e2e";
  const send = browserSend;

  const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });

  const onConnect = createEventHub<(port: chrome.runtime.Port) => void>();
  const onMessage =
    createEventHub<
      (
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: unknown) => void,
      ) => unknown
    >();
  const tabsOnActivated = createEventHub<(info: chrome.tabs.TabActiveInfo) => void>();
  const tabsOnCreated = createEventHub<(tab: chrome.tabs.Tab) => void>();
  const tabsOnUpdated = createEventHub<(tabId: number, info: chrome.tabs.TabChangeInfo) => void>();
  const webNavOnCompleted =
    createEventHub<(details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => void>();
  const webNavOnCommitted =
    createEventHub<
      (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => void
    >();

  vi.stubGlobal("chrome", {
    runtime: { onConnect, onMessage },
    tabs: {
      onActivated: tabsOnActivated,
      onCreated: tabsOnCreated,
      onUpdated: tabsOnUpdated,
    },
    webNavigation: {
      onCompleted: webNavOnCompleted,
      onCommitted: webNavOnCommitted,
    },
  });

  let detachCoordinator: (() => void) | undefined;
  let detachStepListener: (() => void) | undefined;
  let removeCdpListener: (() => void) | undefined;

  try {
    const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await send("Page.bringToFront", {}, sessionId);
    await send("Page.enable", {}, sessionId);
    await send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Runtime.addBinding", { name: "__bskBridge" }, sessionId);

    const evaluate = async <T = unknown>(expression: string, awaitPromise = false): Promise<T> => {
      const reply = await send<{ result?: { value: T }; exceptionDetails?: unknown }>(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise },
        sessionId,
      );
      expect(reply.exceptionDetails).toBeUndefined();
      return reply.result?.value as T;
    };

    type TabCdpListener = (source: TabEventSource, method: string, params: unknown) => void;
    const tabCdpListeners = new Set<TabCdpListener>();
    const sender: chrome.runtime.MessageSender = {
      tab: { id: TAB_ID, active: true, windowId: 100 } as chrome.tabs.Tab,
      frameId: 0,
      documentId: DOC_ID,
    };

    const ports = new Map<
      number,
      {
        port: chrome.runtime.Port;
        onMsg: EventHub<(message: unknown) => void>;
        onDisc: EventHub<() => void>;
        disconnected: boolean;
      }
    >();

    const onCdpEvent = (event: CdpEventMessage) => {
      if (event.sessionId !== sessionId) return;
      if (event.method === "Runtime.bindingCalled" && event.params?.name === "__bskBridge") {
        const payload = JSON.parse(String(event.params.payload ?? "{}")) as {
          kind: string;
          portId?: number;
          name?: string;
          message?: unknown;
          callId?: number;
        };
        if (payload.kind === "port_connect" && typeof payload.portId === "number") {
          const portId = payload.portId;
          const onMsg = createEventHub<(message: unknown) => void>();
          const onDisc = createEventHub<() => void>();
          const entry = {
            onMsg,
            onDisc,
            disconnected: false,
            port: {
              name: payload.name ?? "",
              sender,
              onMessage: onMsg,
              onDisconnect: onDisc,
              postMessage(message: unknown) {
                if (entry.disconnected) throw new Error("port disconnected");
                void send(
                  "Runtime.evaluate",
                  {
                    expression: `window.__bskHost?.portMessage(${portId}, ${JSON.stringify(message)})`,
                  },
                  sessionId,
                ).catch(() => {});
              },
              disconnect() {
                if (entry.disconnected) return;
                entry.disconnected = true;
                void send(
                  "Runtime.evaluate",
                  { expression: `window.__bskHost?.portDisconnect(${portId})` },
                  sessionId,
                ).catch(() => {});
                onDisc.emit();
              },
            } as unknown as chrome.runtime.Port,
          };
          ports.set(portId, entry);
          onConnect.emit(entry.port);
        } else if (payload.kind === "port_post" && typeof payload.portId === "number") {
          ports.get(payload.portId)?.onMsg.emit(payload.message);
        } else if (payload.kind === "port_disconnect" && typeof payload.portId === "number") {
          const entry = ports.get(payload.portId);
          if (entry && !entry.disconnected) {
            entry.disconnected = true;
            entry.onDisc.emit();
          }
        } else if (payload.kind === "send_message" && typeof payload.callId === "number") {
          const callId = payload.callId;
          let replied = false;
          const reply = (value: unknown) => {
            if (replied) return;
            replied = true;
            void send(
              "Runtime.evaluate",
              {
                expression: `window.__bskHost?.messageReply(${callId}, ${JSON.stringify(value)})`,
              },
              sessionId,
            ).catch(() => {});
          };
          onMessage.emit(payload.message, sender, reply);
          if (!replied) reply(undefined);
        }
        return;
      }
      for (const listener of [...tabCdpListeners]) {
        listener(rootEventSource(TAB_ID), event.method, event.params);
      }
    };
    cdpEventListeners.add(onCdpEvent);
    removeCdpListener = () => cdpEventListeners.delete(onCdpEvent);

    const injectAndMountFrameAgent = async () => {
      await evaluate(`(() => {
        if (window.__bskHost) return;
        let nextPortId = 1;
        let nextCallId = 1;
        const ports = new Map();
        const pendingCalls = new Map();
        const messageListeners = new Set();
        const closedShadowMap = window.__bskClosedShadows || (window.__bskClosedShadows = new WeakMap());

        const makeListeners = () => {
          const set = new Set();
          return {
            set,
            addListener(fn) { set.add(fn); },
            removeListener(fn) { set.delete(fn); },
          };
        };

        window.__bskHost = {
          portMessage(portId, msg) {
            const p = ports.get(portId);
            if (!p || p.disconnected) return;
            for (const fn of [...p.onMessage.set]) fn(msg);
          },
          portDisconnect(portId) {
            const p = ports.get(portId);
            if (!p || p.disconnected) return;
            p.disconnected = true;
            for (const fn of [...p.onDisconnect.set]) fn();
          },
          messageReply(callId, value) {
            const resolve = pendingCalls.get(callId);
            if (!resolve) return;
            pendingCalls.delete(callId);
            resolve(value);
          },
          deliverStart(msg) {
            return new Promise((resolve) => {
              let settled = false;
              const sendResponse = (reply) => {
                if (settled) return;
                settled = true;
                resolve(reply);
              };
              for (const fn of [...messageListeners]) {
                fn(msg, {}, sendResponse);
              }
            });
          },
        };

        window.chrome = {
          dom: {
            openOrClosedShadowRoot(el) {
              return el.shadowRoot || closedShadowMap.get(el) || null;
            },
          },
          runtime: {
            onMessage: {
              addListener(fn) { messageListeners.add(fn); },
              removeListener(fn) { messageListeners.delete(fn); },
            },
            connect({ name }) {
              const portId = nextPortId++;
              const onMessage = makeListeners();
              const onDisconnect = makeListeners();
              const entry = { onMessage, onDisconnect, disconnected: false };
              ports.set(portId, entry);
              window.__bskBridge(JSON.stringify({ kind: "port_connect", portId, name }));
              return {
                name,
                onMessage,
                onDisconnect,
                postMessage(message) {
                  if (entry.disconnected) throw new Error("port disconnected");
                  window.__bskBridge(JSON.stringify({ kind: "port_post", portId, message }));
                },
                disconnect() {
                  if (entry.disconnected) return;
                  entry.disconnected = true;
                  window.__bskBridge(JSON.stringify({ kind: "port_disconnect", portId }));
                },
              };
            },
            sendMessage(message) {
              const callId = nextCallId++;
              return new Promise((resolve) => {
                pendingCalls.set(callId, resolve);
                window.__bskBridge(JSON.stringify({ kind: "send_message", callId, message }));
              });
            },
          },
        };

        ${frameAgentBundle}
        window.__bskDisposeAgent = RecordFrameAgentBundle.attachRecordFrameAgent();
      })()`);
    };

    const coordinator = new RecordFrameCoordinator({
      getAllFrames: async () => [{ frameId: 0, documentId: DOC_ID }],
      ensureInjected: async () => {
        await injectAndMountFrameAgent();
      },
      sendToDocument: async (_tabId, message) => {
        return evaluate(`window.__bskHost.deliverStart(${JSON.stringify(message)})`, true);
      },
    });
    detachCoordinator = coordinator.attach();

    const manager = new SessionManager({
      agentWindow: {
        create: async () => ({ windowId: 100, initialTabIds: [] }),
        remove: async () => {},
        ensureActiveTab: async () => TAB_ID,
      },
    });
    await manager.start(SESSION_ID);

    let snapshots = 0;
    let stopCompleted = false;
    let cleanupStarted = false;
    let postStopSnapshotHook: (() => Promise<void>) | undefined;
    const cdp: CdpRunner = createStubCdpRunner({
      send: async (_tabId, method, params) => {
        if (method === "DOMSnapshot.captureSnapshot" && stopCompleted && !cleanupStarted) {
          await postStopSnapshotHook?.();
        }
        const result = await send(method, params, sessionId);
        if (method === "DOMSnapshot.captureSnapshot") snapshots += 1;
        return result as never;
      },
      sendToFrame: (_handle, method, params) => cdp.send(TAB_ID, method, params),
      getAttachmentId: () => sessionId,
      getFrameDocuments: async () => {
        type FrameTree = {
          frame: { id: string; loaderId?: string; url?: string };
          childFrames?: FrameTree[];
        };
        const { frameTree } = await send<{ frameTree: FrameTree }>(
          "Page.getFrameTree",
          {},
          sessionId,
        );
        const frames: FrameDocumentInfo[] = [];
        const visit = async (tree: FrameTree, parentFrameId?: string) => {
          const owner = parentFrameId
            ? await send<{ backendNodeId: number }>(
                "DOM.getFrameOwner",
                { frameId: tree.frame.id },
                sessionId,
              )
            : undefined;
          const loaderId = tree.frame.loaderId ?? "";
          frames.push({
            handle: toFrameDocumentHandle(TAB_ID, { frameId: tree.frame.id, loaderId }),
            frameId: tree.frame.id,
            loaderId,
            parentFrameId,
            ownerBackendNodeId: owner?.backendNodeId,
            url: tree.frame.url,
            processKey: "root",
            isOutOfProcess: false,
          });
          for (const child of tree.childFrames ?? []) {
            await visit(child, tree.frame.id);
          }
        };
        await visit(frameTree);
        return { rootFrameId: frameTree.frame.id, frames };
      },
      getMainFrameHandle: async () => {
        const { frameTree } = await send<{
          frameTree: { frame: { id: string; loaderId?: string } };
        }>("Page.getFrameTree", {}, sessionId);
        return toFrameDocumentHandle(TAB_ID, {
          frameId: frameTree.frame.id,
          loaderId: frameTree.frame.loaderId ?? "",
        });
      },
      onEvent: (_tabId, listener) => {
        tabCdpListeners.add(listener);
        return {
          dispose: () => {
            tabCdpListeners.delete(listener);
          },
        };
      },
    });

    const tabsApi: ChromeTabsApi = {
      get: async () => {
        const meta = await evaluate<{ url: string; title: string }>(
          "({ url: location.href, title: document.title })",
        );
        return {
          id: TAB_ID,
          windowId: 100,
          active: true,
          status: "complete",
          url: meta.url,
          title: meta.title,
        } as chrome.tabs.Tab;
      },
      query: async () => [await tabsApi.get(TAB_ID)],
    };

    const trackedCoordinator: NonNullable<RecordDeps["frameCoordinator"]> = {
      begin: (...args) => coordinator.begin(...args),
      armTab: (...args) => coordinator.armTab(...args),
      sourceFor: (...args) => coordinator.sourceFor(...args),
      stop: async (requestId) => {
        const ok = await coordinator.stop(requestId);
        if (ok) stopCompleted = true;
        return ok;
      },
      cleanup: async (requestId) => {
        cleanupStarted = true;
        await coordinator.cleanup(requestId);
      },
      cancel: (requestId) => coordinator.cancel(requestId),
    };

    const deps: RecordDeps = {
      tabsApi,
      cdp,
      frameCoordinator: trackedCoordinator,
      sendToTab: async () => ({ ok: true }),
    };
    detachStepListener = attachRecordStepListener(deps);

    const started = await handleRecordStart(
      manager,
      { session_id: SESSION_ID, url, purpose: "password redaction e2e" },
      deps,
    );
    expect(started).toEqual({ tab_id: TAB_ID, recording: true });

    const clickPoint = async (point: { x: number; y: number }) => {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send(
          "Input.dispatchMouseEvent",
          { type, x: point.x, y: point.y, button: "left", clickCount: 1 },
          sessionId,
        );
      }
    };

    const clickSelector = async (selector: string) => {
      const point = await evaluate<{ x: number; y: number }>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      await clickPoint(point);
    };

    const insertText = async (text: string) => {
      await send("Input.insertText", { text }, sessionId);
    };

    const stop = async (): Promise<TraceV3> => {
      const stopped = await handleRecordStop(manager, { session_id: SESSION_ID }, deps);
      expect(stopped).not.toHaveProperty("code");
      return (stopped as RecordStopResult).trace;
    };

    const waitForSnapshotAfter = async (previous: number) => {
      await expect.poll(() => snapshots, { timeout: 5_000 }).toBeGreaterThan(previous);
    };

    const cancel = () => {
      clearRecordingForSession(SESSION_ID, deps);
    };

    await run({
      evaluate,
      clickPoint,
      clickSelector,
      insertText,
      snapshotCount: () => snapshots,
      waitForSnapshotAfter,
      onPostStopSnapshot: (hook) => {
        postStopSnapshotHook = hook;
      },
      stop,
      cancel,
    });
  } finally {
    detachStepListener?.();
    detachCoordinator?.();
    removeCdpListener?.();
    resetBrowserObservationForTests();
    vi.unstubAllGlobals();
    await send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

describe.skipIf(!process.env.BSK_TEST_CHROME)(
  "record password redaction lifecycle (real Chrome)",
  () => {
    it("redacts revealed light-DOM password (including unlabelled input) in trailing VOM and cleans up DOM markers after stop", async () => {
      const secret = "SECRET_PASS_123";
      const unlabelledSecret = "SECRET_UNLABELLED_456";
      const html = `<!doctype html><html><head><title>Login</title></head><body>
      <form>
        <label for="user">Username</label>
        <input id="user" type="text" autocomplete="off" />
        <label for="pw">Password</label>
        <input id="pw" type="password" autocomplete="off" />
        <input id="unlabelled-pw" type="password" autocomplete="off" />
        <button id="toggle" type="button">Show password</button>
      </form>
      <script>
        document.getElementById('toggle').addEventListener('click', () => {
          document.getElementById('pw').type = 'text';
          document.getElementById('unlabelled-pw').type = 'text';
        });
      </script>
    </body></html>`;

      await withRecordingHarness("/light-dom", html, async (h) => {
        await h.clickSelector("#user");
        await h.insertText("alice");
        await h.clickSelector("#pw");
        await h.insertText(secret);
        await h.clickSelector("#unlabelled-pw");
        await h.insertText(unlabelledSecret);
        await h.clickSelector("#toggle");

        expect(await h.evaluate<string>("document.querySelector('#pw').type")).toBe("text");
        expect(await h.evaluate<string>("document.querySelector('#pw').value")).toBe(secret);
        expect(await h.evaluate<string>("document.querySelector('#unlabelled-pw').type")).toBe(
          "text",
        );

        let markersPresentDuringTrailingSnapshot = false;
        h.onPostStopSnapshot(async () => {
          const present = await h.evaluate<boolean>(
            `document.querySelector('#pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)}) && document.querySelector('#unlabelled-pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)})`,
          );
          if (present) markersPresentDuringTrailingSnapshot = true;
        });

        const trace = await h.stop();

        // Proves trailing DOMSnapshot ran strictly after frameCoordinator.stop() and before cleanup().
        expect(markersPresentDuringTrailingSnapshot).toBe(true);
        expect(trace.states.length).toBeGreaterThanOrEqual(2);
        const fills = trace.steps.filter((step) => step.op === "fill");
        expect(fills).toHaveLength(3);
        expect(fills[0]).toMatchObject({ target: { name: "Username" }, value: "alice" });
        expect(fills[1]).toMatchObject({
          target: { name: "Password" },
          value: "***",
          redacted: true,
        });
        expect(fills[2]).toMatchObject({ value: "***", redacted: true });

        const serialized = JSON.stringify(trace);
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain(unlabelledSecret);
        // Positive control: trailing VOM truly captures normal text input values while redacting both revealed passwords.
        const trailingBody = trace.states[trace.states.length - 1]!.body;
        expect(trailingBody).toContain("alice");
        expect(trailingBody).toContain("Password");
        expect(trailingBody).not.toContain(secret);
        expect(trailingBody).not.toContain(unlabelledSecret);

        // Post-stop DOM markers and observers are cleanly removed.
        expect(
          await h.evaluate<boolean>(
            `document.querySelector('#pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)}) || document.querySelector('#unlabelled-pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)})`,
          ),
        ).toBe(false);
        expect(
          await h.evaluate<boolean>(
            `document.documentElement.hasAttribute(${JSON.stringify(RECORD_DOCUMENT_ATTRIBUTE)})`,
          ),
        ).toBe(false);
        await h.evaluate(`(() => {
        const pw = document.querySelector('#pw');
        pw.type = 'password';
        pw.type = 'text';
      })()`);
        expect(
          await h.evaluate<boolean>(
            `document.querySelector('#pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)})`,
          ),
        ).toBe(false);
      });
    }, 30_000);

    it("flushes unblurred revealed password fill redacted without leaking into trailing VOM", async () => {
      const secret = "SECRET_UNBLURRED_789";
      const html = `<!doctype html><html><head><title>Unblurred Login</title></head><body>
      <form>
        <label for="pw">Password</label>
        <input id="pw" type="password" autocomplete="off" />
      </form>
    </body></html>`;

      await withRecordingHarness("/unblurred-stop", html, async (h) => {
        await h.clickSelector("#pw");
        await h.insertText(secret);
        // Reveal password while input remains focused (no blur before stop).
        await h.evaluate("document.querySelector('#pw').type = 'text'");
        expect(
          await h.evaluate<boolean>("document.activeElement === document.querySelector('#pw')"),
        ).toBe(true);

        const trace = await h.stop();

        expect(trace.states.length).toBeGreaterThanOrEqual(2);
        const fills = trace.steps.filter((step) => step.op === "fill");
        expect(fills).toHaveLength(1);
        expect(fills[0]).toMatchObject({ value: "***", redacted: true });

        const serialized = JSON.stringify(trace);
        expect(serialized).not.toContain(secret);
        expect(trace.states.some((state) => state.body.includes("Password"))).toBe(true);

        expect(
          await h.evaluate<boolean>(
            `document.querySelector('#pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)})`,
          ),
        ).toBe(false);
        expect(
          await h.evaluate<boolean>(
            `document.documentElement.hasAttribute(${JSON.stringify(RECORD_DOCUMENT_ATTRIBUTE)})`,
          ),
        ).toBe(false);
      });
    }, 30_000);

    it("redacts revealed passwords in pre-existing, dynamic, lazily-attached, and closed Shadow DOM components", async () => {
      const openSecret = "SECRET_SHADOW_OPEN_111";
      const dynamicSecret = "SECRET_SHADOW_DYN_222";
      const lazySecret = "SECRET_SHADOW_LAZY_444";
      const closedSecret = "SECRET_SHADOW_CLOSED_333";

      const html = `<!doctype html><html><head><title>Shadow Login</title></head><body>
      <div id="open-host"></div>
      <div id="lazy-host"></div>
      <div id="closed-host"></div>
      <button id="mount-dyn" type="button">Open dynamic login</button>
      <script>
        window.__bskClosedShadows = new WeakMap();

        const openRoot = document.getElementById('open-host').attachShadow({ mode: 'open' });
        openRoot.innerHTML =
          '<input id="open-pw" type="password" autocomplete="off" aria-label="Open Shadow Password" />' +
          '<button id="open-toggle" type="button">Show open</button>';
        openRoot.getElementById('open-toggle').addEventListener('click', () => {
          openRoot.getElementById('open-pw').type = 'text';
        });

        const closedHost = document.getElementById('closed-host');
        const closedRoot = closedHost.attachShadow({ mode: 'closed' });
        window.__bskClosedShadows.set(closedHost, closedRoot);
        closedRoot.innerHTML =
          '<input id="closed-pw" type="password" autocomplete="off" aria-label="Closed Shadow Password" />' +
          '<button id="closed-toggle" type="button">Show closed</button>';
        closedRoot.getElementById('closed-toggle').addEventListener('click', () => {
          closedRoot.getElementById('closed-pw').type = 'text';
        });
        window.__closedRoot = closedRoot;

        document.getElementById('mount-dyn').addEventListener('click', () => {
          const dynHost = document.createElement('div');
          dynHost.id = 'dyn-host';
          const dynRoot = dynHost.attachShadow({ mode: 'open' });
          dynRoot.innerHTML =
            '<input id="dyn-pw" type="password" autocomplete="off" aria-label="Dynamic Shadow Password" />' +
            '<button id="dyn-toggle" type="button">Show dynamic</button>';
          dynRoot.getElementById('dyn-toggle').addEventListener('click', () => {
            dynRoot.getElementById('dyn-pw').type = 'text';
          });
          document.body.appendChild(dynHost);

          // Also lazily attach a ShadowRoot onto the pre-existing #lazy-host (no childList mutation on document).
          const lazyRoot = document.getElementById('lazy-host').attachShadow({ mode: 'open' });
          lazyRoot.innerHTML =
            '<input id="lazy-pw" type="password" autocomplete="off" aria-label="Lazy Shadow Password" />' +
            '<button id="lazy-toggle" type="button">Show lazy</button>';
          lazyRoot.getElementById('lazy-toggle').addEventListener('click', () => {
            lazyRoot.getElementById('lazy-pw').type = 'text';
          });
        });
      </script>
    </body></html>`;

      await withRecordingHarness("/shadow-dom", html, async (h) => {
        const centerOf = (expr: string) =>
          h.evaluate<{ x: number; y: number }>(`(() => {
          const r = (${expr}).getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`);

        // 1. Pre-existing open ShadowRoot
        await h.clickPoint(
          await centerOf(
            "document.querySelector('#open-host').shadowRoot.querySelector('#open-pw')",
          ),
        );
        await h.insertText(openSecret);
        await h.clickPoint(
          await centerOf(
            "document.querySelector('#open-host').shadowRoot.querySelector('#open-toggle')",
          ),
        );

        // 2. Dynamically mounted + lazily-attached open ShadowRoots (triggered by user click)
        const beforeMount = h.snapshotCount();
        await h.clickSelector("#mount-dyn");
        await h.waitForSnapshotAfter(beforeMount);

        await h.clickPoint(
          await centerOf("document.querySelector('#dyn-host').shadowRoot.querySelector('#dyn-pw')"),
        );
        await h.insertText(dynamicSecret);
        await h.clickPoint(
          await centerOf(
            "document.querySelector('#dyn-host').shadowRoot.querySelector('#dyn-toggle')",
          ),
        );

        await h.clickPoint(
          await centerOf(
            "document.querySelector('#lazy-host').shadowRoot.querySelector('#lazy-pw')",
          ),
        );
        await h.insertText(lazySecret);
        await h.clickPoint(
          await centerOf(
            "document.querySelector('#lazy-host').shadowRoot.querySelector('#lazy-toggle')",
          ),
        );

        // 3. Closed ShadowRoot
        await h.clickPoint(await centerOf("window.__closedRoot.querySelector('#closed-pw')"));
        await h.insertText(closedSecret);
        await h.clickPoint(await centerOf("window.__closedRoot.querySelector('#closed-toggle')"));

        // Confirm all four are visibly type="text" with their plaintext values before stop.
        const typesAndValues = await h.evaluate<Array<[string, string]>>(`([
        [document.querySelector('#open-host').shadowRoot.querySelector('#open-pw').type,
         document.querySelector('#open-host').shadowRoot.querySelector('#open-pw').value],
        [document.querySelector('#dyn-host').shadowRoot.querySelector('#dyn-pw').type,
         document.querySelector('#dyn-host').shadowRoot.querySelector('#dyn-pw').value],
        [document.querySelector('#lazy-host').shadowRoot.querySelector('#lazy-pw').type,
         document.querySelector('#lazy-host').shadowRoot.querySelector('#lazy-pw').value],
        [window.__closedRoot.querySelector('#closed-pw').type,
         window.__closedRoot.querySelector('#closed-pw').value],
      ])`);
        expect(typesAndValues).toEqual([
          ["text", openSecret],
          ["text", dynamicSecret],
          ["text", lazySecret],
          ["text", closedSecret],
        ]);

        const trace = await h.stop();

        expect(trace.states.length).toBeGreaterThanOrEqual(2);
        const fills = trace.steps.filter((step) => step.op === "fill");
        expect(
          fills.map((step) => ({
            name: step.target?.name,
            value: step.value,
            redacted: step.redacted,
          })),
        ).toEqual([
          { name: "Open Shadow Password", value: "***", redacted: true },
          { name: "Dynamic Shadow Password", value: "***", redacted: true },
          { name: "Lazy Shadow Password", value: "***", redacted: true },
          { name: "Closed Shadow Password", value: "***", redacted: true },
        ]);

        const serialized = JSON.stringify(trace);
        expect(serialized).not.toContain(openSecret);
        expect(serialized).not.toContain(dynamicSecret);
        expect(serialized).not.toContain(lazySecret);
        expect(serialized).not.toContain(closedSecret);
        expect(trace.states.some((state) => state.body.includes("Open Shadow Password"))).toBe(
          true,
        );
        expect(trace.states.some((state) => state.body.includes("Dynamic Shadow Password"))).toBe(
          true,
        );
        expect(trace.states.some((state) => state.body.includes("Lazy Shadow Password"))).toBe(
          true,
        );
        expect(trace.states.some((state) => state.body.includes("Closed Shadow Password"))).toBe(
          true,
        );

        // All Shadow DOM markers and observers are cleaned up after stop.
        const residualAttrs = await h.evaluate<boolean[]>(`([
        document.querySelector('#open-host').shadowRoot.querySelector('#open-pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)}),
        document.querySelector('#dyn-host').shadowRoot.querySelector('#dyn-pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)}),
        document.querySelector('#lazy-host').shadowRoot.querySelector('#lazy-pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)}),
        window.__closedRoot.querySelector('#closed-pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)}),
        document.documentElement.hasAttribute(${JSON.stringify(RECORD_DOCUMENT_ATTRIBUTE)}),
      ])`);
        expect(residualAttrs).toEqual([false, false, false, false, false]);

        // Toggling again after stop proves ShadowRoot observers were disconnected.
        await h.evaluate(`(() => {
        for (const el of [
          document.querySelector('#open-host').shadowRoot.querySelector('#open-pw'),
          document.querySelector('#dyn-host').shadowRoot.querySelector('#dyn-pw'),
          document.querySelector('#lazy-host').shadowRoot.querySelector('#lazy-pw'),
          window.__closedRoot.querySelector('#closed-pw'),
        ]) {
          el.type = 'password';
          el.type = 'text';
        }
      })()`);
        const postToggleAttrs = await h.evaluate<boolean[]>(`([
        document.querySelector('#open-host').shadowRoot.querySelector('#open-pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)}),
        document.querySelector('#dyn-host').shadowRoot.querySelector('#dyn-pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)}),
        document.querySelector('#lazy-host').shadowRoot.querySelector('#lazy-pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)}),
        window.__closedRoot.querySelector('#closed-pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)}),
      ])`);
        expect(postToggleAttrs).toEqual([false, false, false, false]);
      });
    }, 30_000);

    it("cleans up password markers and observers when recording is cancelled", async () => {
      const html = `<!doctype html><html><head><title>Cancel Login</title></head><body>
      <input id="pw" type="password" autocomplete="off" aria-label="Password" />
      <button id="toggle" type="button">Show</button>
      <script>
        document.getElementById('toggle').addEventListener('click', () => {
          document.getElementById('pw').type = 'text';
        });
      </script>
    </body></html>`;

      await withRecordingHarness("/cancel-cleanup", html, async (h) => {
        await h.clickSelector("#pw");
        await h.insertText("SECRET_CANCEL_999");
        await h.clickSelector("#toggle");

        expect(
          await h.evaluate<boolean>(
            `document.querySelector('#pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)})`,
          ),
        ).toBe(true);

        h.cancel();

        await expect
          .poll(() =>
            h.evaluate<boolean>(
              `document.querySelector('#pw').hasAttribute(${JSON.stringify(RECORD_PASSWORD_ATTRIBUTE)}) || document.documentElement.hasAttribute(${JSON.stringify(RECORD_DOCUMENT_ATTRIBUTE)})`,
            ),
          )
          .toBe(false);
      });
    }, 30_000);
  },
);
