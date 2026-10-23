import type { CdpDispatchGuard } from "@/browser-driver/chromium-cdp";
import type { CdpTarget } from "@/browser-driver/frame-graph";
import { shareScreencasts } from "@/browser-driver/screencast-coordinator";
import type { CdpRunner } from "@/tools/shared";
import type { InputExpectation } from "./types";

interface ActionGuard {
  prepare?: (input?: InputExpectation) => Promise<void>;
  dispatch?: (startsInput: boolean, method: string) => void;
  verifyPointerTarget?: CdpRunner["verifyPointerTarget"];
  beginDomMutation?: CdpRunner["beginDomMutation"];
  /** User-supplied evaluate is opaque; internal readiness probes remain read-only. */
  scriptedEffect?: boolean;
}

/** Request-scoped input leases and a final fence at native dispatch. */
export function guardedRunner<T extends CdpRunner>(cdp: T, options: ActionGuard = {}): T {
  const { prepare, dispatch, verifyPointerTarget, beginDomMutation } = options;
  const leases = new Map<string, string | undefined>();
  const attachments = new Map<number, string | undefined>();
  const cleanupSend = <R>(target: CdpTarget, method: string, params?: object) => {
    if (!["Runtime.callFunctionOn", "Runtime.releaseObjectGroup"].includes(method))
      throw new Error("Resource cleanup cannot dispatch page input");
    if (!attachments.has(target.tabId)) throw new Error("No resources owned on this tab");
    return cdp.sendGuarded
      ? cdp.sendGuarded<R>(target, method, params, { attachmentId: attachments.get(target.tabId) })
      : target.sessionId && cdp.sendToTarget
        ? cdp.sendToTarget<R>(target, method, params)
        : cdp.send<R>(target.tabId, method, params);
  };
  const resourceCleanup: CdpRunner = {
    send: (tabId, method, params) => cleanupSend({ tabId }, method, params),
    sendToTarget: cleanupSend,
  };
  const send = async (
    target: CdpTarget,
    method: string,
    params?: object,
    guard?: CdpDispatchGuard,
  ) => {
    const p = params as Record<string, unknown> | undefined;
    const mouse = method === "Input.dispatchMouseEvent";
    const key = method === "Input.dispatchKeyEvent";
    const focus = method === "Emulation.setFocusEmulationEnabled";
    const drag = method === "Input.dispatchDragEvent";
    const chooser = method === "Page.setInterceptFileChooserDialog";
    const identity = `${target.tabId}:${target.sessionId ?? ""}:${chooser ? "chooser" : drag ? "drag" : focus ? "focus" : mouse ? "mouse:" + String(p?.button) : "key:" + String(p?.key)}`;
    const release =
      ((mouse && p?.type === "mouseReleased") ||
        (key && p?.type === "keyUp") ||
        (focus && p?.enabled === false) ||
        (chooser && p?.enabled === false) ||
        (drag && p?.type === "dragCancel")) &&
      leases.has(identity);
    const input: InputExpectation | undefined =
      method === "Input.dispatchMouseEvent" && p?.type === "mousePressed"
        ? { type: "pointerdown", x: Number(p.x), y: Number(p.y) }
        : method === "Input.dispatchMouseEvent" && p?.type === "mouseWheel"
          ? { type: "wheel", x: Number(p.x), y: Number(p.y) }
          : method === "Input.dispatchKeyEvent" &&
              ["keyDown", "rawKeyDown"].includes(String(p?.type))
            ? // Native editor commands omit the key; Chromium emits an empty DOM key.
              { type: "keydown", key: String(p?.key ?? "") }
            : undefined;
    if (input) {
      input.timestamp = Date.now();
      params = { ...params, timestamp: input.timestamp / 1000 };
    }
    const effect =
      method.startsWith("Input.") ||
      method === "Runtime.callFunctionOn" ||
      (method === "Runtime.evaluate" && options.scriptedEffect === true) ||
      method === "DOM.setFileInputFiles" ||
      chooser ||
      method === "DOM.focus" ||
      method === "DOM.scrollIntoViewIfNeeded" ||
      method.startsWith("Emulation.") ||
      [
        "Page.navigate",
        "Page.navigateToHistoryEntry",
        "Page.reload",
        "Page.handleJavaScriptDialog",
      ].includes(method);
    if (!prepare && effect && !["Runtime.callFunctionOn", "Runtime.evaluate"].includes(method))
      throw new Error("Shared-tab observation cannot dispatch browser input");
    if (effect && !release) await prepare?.(input);
    const check = () => {
      if (effect && !release)
        dispatch?.(
          !!input || method === "Input.insertText" || method === "DOM.setFileInputFiles" || drag,
          method,
        );
      if (!attachments.has(target.tabId))
        attachments.set(target.tabId, cdp.getAttachmentId?.(target.tabId));
      guard?.onDispatch?.();
      if (
        input?.type === "pointerdown" ||
        input?.type === "keydown" ||
        (focus && p?.enabled === true) ||
        (chooser && p?.enabled === true) ||
        (drag && p?.type === "dragEnter")
      )
        leases.set(identity, cdp.getAttachmentId?.(target.tabId));
      if (release) leases.delete(identity);
    };
    if (cdp.sendGuarded)
      return cdp.sendGuarded(target, method, params, {
        ...guard,
        ...(release ? { signal: undefined, attachmentId: leases.get(identity) } : {}),
        onDispatch: check,
      });
    // Test/adaptor runners must provide the same synchronous pre-send check.
    check();
    return target.sessionId && cdp.sendToTarget
      ? cdp.sendToTarget(target, method, params)
      : cdp.send(target.tabId, method, params);
  };
  const runner = new Proxy(cdp, {
    get(target, key, receiver) {
      if (key === "handleDialog") {
        const handle = target.handleDialog?.bind(target);
        return handle
          ? async (tabId: number, id: string, accept: boolean, text?: string) => {
              if (!prepare) throw new Error("Shared-tab observation cannot answer dialogs");
              await prepare();
              dispatch?.(true, "Page.handleJavaScriptDialog");
              return handle(tabId, id, accept, text);
            }
          : undefined;
      }
      if (key === "resourceCleanup") return resourceCleanup;
      if (key === "runBrowserMutation")
        return async <R>(operation: () => Promise<R>): Promise<R> => {
          if (!prepare) throw new Error("Shared-tab observation cannot mutate the browser");
          await beginDomMutation?.();
          await prepare();
          dispatch?.(true, "Browser.mutate");
          return operation();
        };
      if (key === "beginDomMutation") return beginDomMutation;
      if (key === "verifyPointerTarget") return verifyPointerTarget;
      if (
        key === "acquireBackgroundExecution" ||
        key === "ownsBackgroundExecution" ||
        key === "restoreBackgroundExecution"
      )
        return undefined;
      if (key === "send")
        return (tabId: number, method: string, params?: object) => send({ tabId }, method, params);
      if (key === "sendToTarget" || key === "sendGuarded") return send;
      const value = Reflect.get(target, key);
      // Typed emulation helpers call this.send; keep those sends behind the same fence.
      if (
        [
          "setDeviceMetricsOverride",
          "clearDeviceMetricsOverride",
          "setUserAgentOverride",
          "setTouchEmulationEnabled",
        ].includes(String(key))
      )
        return typeof value === "function" ? value.bind(receiver) : value;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  shareScreencasts(cdp, runner);
  return runner;
}
