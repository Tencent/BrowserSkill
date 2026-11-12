import type { CdpDispatchGuard } from "@/browser-driver/chromium-cdp";
import type { CdpTarget } from "@/browser-driver/frame-graph";
import {
  NativeInputClockError,
  type NativeInputTimestamp,
} from "@/browser-driver/native-input-clock";
import { shareScreencasts } from "@/browser-driver/screencast-coordinator";
import type { CdpRunner } from "@/tools/shared";
import type { InputExpectation } from "./types";

interface ActionGuard {
  onInputClockError?: (error: NativeInputClockError) => void;
  prepare?: (input?: InputExpectation, method?: string) => Promise<void>;
  finishInput?: (input: InputExpectation) => Promise<void>;
  dispatch?: (startsInput: boolean, method: string) => void;
  verifyPointerTarget?: CdpRunner["verifyPointerTarget"];
  beginDomMutation?: CdpRunner["beginDomMutation"];
  detach?: CdpRunner["detach"];
  /** User-supplied evaluate is opaque; internal readiness probes remain read-only. */
  scriptedEffect?: boolean;
}

/**
 * True when a CDP step is an internal preparation, focus, geometry, or isolated-world
 * helper call that cannot synthesize renderer `event.isTrusted === true` input events.
 * Native `Input.*` dispatches (`input !== undefined`), user-supplied scripts
 * (`scriptedEffect`), file-input/chooser mutations, drag-enter, and browser navigations
 * are excluded and must still arm or refresh cooperation frames.
 */
export function isInternalActionStep(
  input: InputExpectation | undefined,
  method: string | undefined,
  scriptedEffect = false,
): boolean {
  if (input !== undefined || scriptedEffect || !method) return false;
  return ![
    "DOM.setFileInputFiles",
    "Page.setInterceptFileChooserDialog",
    "Input.dispatchDragEvent",
    "Page.navigate",
    "Page.navigateToHistoryEntry",
    "Page.reload",
    "Browser.mutate",
  ].includes(method);
}

/** Request-scoped input leases and a final fence at native dispatch. */
export function guardedRunner<T extends CdpRunner>(cdp: T, options: ActionGuard = {}): T {
  const { prepare, dispatch, verifyPointerTarget, beginDomMutation, detach } = options;
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
    const cancelDrag = method === "Input.cancelDragging";
    const chooser = method === "Page.setInterceptFileChooserDialog";
    const identity = `${target.tabId}:${target.sessionId ?? ""}:${cancelDrag ? "mouse:left" : chooser ? "chooser" : drag ? "drag" : focus ? "focus" : mouse ? "mouse:" + String(p?.button) : "key:" + String(p?.key)}`;
    const release =
      (cancelDrag ||
        (mouse && p?.type === "mouseReleased") ||
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
              ["keyDown", "rawKeyDown", "char"].includes(String(p?.type))
            ? // Native editor commands omit the key; Chromium emits an empty DOM key.
              {
                type: p?.type === "char" ? "keypress" : "keydown",
                key: String(p?.key ?? ""),
                ...(p?.type === "keyDown" && typeof p.text === "string" && p.text.length > 0
                  ? { keypress: true }
                  : {}),
              }
            : method === "Input.insertText"
              ? { type: "beforeinput", text: String(p?.text ?? ""), id: crypto.randomUUID() }
              : undefined;
    let timing: NativeInputTimestamp | undefined;
    const effect =
      method.startsWith("Input.") ||
      method === "Runtime.callFunctionOn" ||
      (method === "Runtime.evaluate" && options.scriptedEffect === true) ||
      method === "DOM.setFileInputFiles" ||
      chooser ||
      method === "DOM.focus" ||
      method === "DOM.scrollIntoViewIfNeeded" ||
      method.startsWith("Emulation.") ||
      ["Page.navigate", "Page.navigateToHistoryEntry", "Page.reload"].includes(method);
    if (!prepare && effect && !["Runtime.callFunctionOn", "Runtime.evaluate"].includes(method))
      throw new Error("Shared-tab observation cannot dispatch browser input");
    const check = () => {
      timing?.assertValid();
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
      if (release && !cancelDrag) leases.delete(identity);
    };
    const sendNative = () => {
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
    try {
      if (input && input.type !== "beforeinput") {
        timing = await cdp.prepareInputTimestamp?.();
        input.timestamp = timing?.timestamp ?? Date.now();
        params = { ...params, timestamp: timing?.nativeTimestamp ?? input.timestamp / 1000 };
      }
      // Geometry must be sampled after a browsing gesture has settled, too.
      if ((effect && !release) || method === "DOM.getBoxModel") await prepare?.(input, method);
      return await sendNative();
    } catch (error) {
      if (error instanceof NativeInputClockError) {
        options.onInputClockError?.(error);
        // A clock change can refuse char/keypress after rawKeyDown succeeded.
        // Retire that owned key without another clock check or permission grant.
        if (key && leases.has(identity)) {
          const attachment = leases.get(identity);
          const up: Record<string, unknown> = { type: "keyUp" };
          for (const field of [
            "key",
            "code",
            "windowsVirtualKeyCode",
            "nativeVirtualKeyCode",
            "modifiers",
            "location",
          ])
            if (p?.[field] !== undefined) up[field] = p[field];
          await send(target, method, up)
            .catch(() => cdp.detach?.(target.tabId, attachment))
            .catch(() => {});
        }
      }
      throw error;
    } finally {
      if (input?.type === "beforeinput") await options.finishInput?.(input);
    }
  };
  const runner = new Proxy(cdp, {
    get(target, key, receiver) {
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
      if (key === "detach" && detach) return detach;
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
