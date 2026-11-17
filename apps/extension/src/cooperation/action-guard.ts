import type { CdpDispatchGuard } from "@/browser-driver/chromium-cdp";
import {
  type FrameDocumentHandle,
  type FrameNodeHandle,
  toRootFrameHandle,
} from "@/browser-driver/frame-handles";
import {
  NativeInputClockError,
  type NativeInputTimestamp,
} from "@/browser-driver/native-input-clock";
import { type CdpRunner, delegateCdpRunner } from "@/tools/shared";
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

const STRIPPED_BACKGROUND_EXECUTION_KEYS = new Set<PropertyKey>([
  "acquireBackgroundExecution",
  "ownsBackgroundExecution",
  "restoreBackgroundExecution",
]);

const BOUND_EMULATION_METHODS = new Set<PropertyKey>([
  "setDeviceMetricsOverride",
  "clearDeviceMetricsOverride",
  "setUserAgentOverride",
  "setTouchEmulationEnabled",
]);

const RESOURCE_CLEANUP_METHODS = new Set([
  "Runtime.callFunctionOn",
  "Runtime.releaseObjectGroup",
  "Runtime.releaseObject",
]);

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
  const cleanupSendFrame = <R>(
    handle: FrameDocumentHandle | FrameNodeHandle,
    method: string,
    params?: object,
    guard?: CdpDispatchGuard,
  ) => {
    if (!RESOURCE_CLEANUP_METHODS.has(method))
      throw new Error("Resource cleanup cannot dispatch page input");
    if (!attachments.has(handle.tabId))
      return Promise.reject(new Error("No resources owned on this tab"));
    return cdp.sendToFrame<R>(handle, method, params, {
      ...guard,
      allowReattach: false,
      attachmentId: attachments.get(handle.tabId),
    });
  };
  const resourceCleanup: CdpRunner = delegateCdpRunner(
    cdp,
    {
      send: <R>(tabId: number, method: string, params?: object) =>
        cleanupSendFrame<R>(toRootFrameHandle(tabId), method, params),
      sendToFrame: cleanupSendFrame,
    },
    { omit: STRIPPED_BACKGROUND_EXECUTION_KEYS },
  );
  const sendToFrame = async <R = unknown>(
    handle: FrameDocumentHandle | FrameNodeHandle,
    method: string,
    params?: object,
    guard?: CdpDispatchGuard,
  ): Promise<R> => {
    const { tabId } = handle;
    const leaseScope = handle.frameId ? `frame:${handle.frameId}` : "";
    const p = params as Record<string, unknown> | undefined;
    const mouse = method === "Input.dispatchMouseEvent";
    const key = method === "Input.dispatchKeyEvent";
    const focus = method === "Emulation.setFocusEmulationEnabled";
    const drag = method === "Input.dispatchDragEvent";
    const cancelDrag = method === "Input.cancelDragging";
    const chooser = method === "Page.setInterceptFileChooserDialog";
    const identity = `${tabId}:${leaseScope}:${cancelDrag ? "mouse:left" : chooser ? "chooser" : drag ? "drag" : focus ? "focus" : mouse ? "mouse:" + String(p?.button) : "key:" + String(p?.key)}`;
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
      if (!attachments.has(tabId)) attachments.set(tabId, cdp.getAttachmentId(tabId));
      guard?.onDispatch?.();
      if (
        input?.type === "pointerdown" ||
        input?.type === "keydown" ||
        (focus && p?.enabled === true) ||
        (chooser && p?.enabled === true) ||
        (drag && p?.type === "dragEnter")
      )
        leases.set(identity, cdp.getAttachmentId(tabId));
      if (release && !cancelDrag) leases.delete(identity);
    };
    const sendNative = () =>
      cdp.sendToFrame<R>(handle, method, params, {
        ...guard,
        ...(release ? { signal: undefined, attachmentId: leases.get(identity) } : {}),
        onDispatch: check,
      });
    try {
      if (input && input.type !== "beforeinput") {
        timing = await cdp.prepareInputTimestamp();
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
          await sendToFrame(handle, method, up)
            .catch(() => cdp.detach(tabId, attachment))
            .catch(() => {});
        }
      }
      throw error;
    } finally {
      if (input?.type === "beforeinput") await options.finishInput?.(input);
    }
  };
  return delegateCdpRunner(
    cdp,
    {
      resourceCleanup,
      runBrowserMutation: async <R>(operation: () => Promise<R>): Promise<R> => {
        if (!prepare) throw new Error("Shared-tab observation cannot mutate the browser");
        await prepare(undefined, "Browser.mutate");
        dispatch?.(true, "Browser.mutate");
        return operation();
      },
      beginDomMutation,
      verifyPointerTarget,
      ...(detach ? { detach } : {}),
      send: <R = unknown>(tabId: number, method: string, params?: object, signal?: AbortSignal) =>
        sendToFrame<R>(toRootFrameHandle(tabId), method, params, signal ? { signal } : undefined),
      sendToFrame,
    },
    {
      omit: STRIPPED_BACKGROUND_EXECUTION_KEYS,
      bindReceiver: BOUND_EMULATION_METHODS,
    },
  );
}
