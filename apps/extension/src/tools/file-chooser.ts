// One file-chooser transaction for an upload. Chrome's extension debugger
// bridge may leave a command pending indefinitely, so every state-changing
// command is bounded and an uncertain target is detached before returning.

import type { CdpTarget } from "@/browser-driver/frame-graph";
import type { ClickResult, RpcError } from "@/transport/types";
import { type CdpRunner, isRpcError, sendToCdpTarget } from "./shared";

const CLEANUP_TIMEOUT_MS = 1_000;

type ChooserPhase = "enable_events" | "trigger" | "await_event" | "set_files";

interface FileChooserOpened {
  source: { tabId?: number; sessionId?: string };
  backendNodeId?: number;
  mode?: string;
}

export interface FileChooserUploadOptions {
  cdp: CdpRunner;
  target: CdpTarget;
  files: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  trigger(timeoutMs: number): Promise<ClickResult | RpcError>;
}

export interface FileChooserUploadResult {
  click: ClickResult;
  mode?: string;
}

class BoundedWaitError extends Error {
  constructor(
    readonly kind: "timeout" | "aborted",
    message: string,
  ) {
    super(message);
  }
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function waitBounded<T>(
  promise: Promise<T>,
  deadline: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<T> {
  const remaining = remainingMs(deadline);
  if (signal?.aborted) throw new BoundedWaitError("aborted", "file chooser operation aborted");
  if (remaining === 0) throw new BoundedWaitError("timeout", timeoutMessage);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BoundedWaitError("timeout", timeoutMessage)), remaining);
    if (signal) {
      onAbort = () => reject(new BoundedWaitError("aborted", "file chooser operation aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, boundary]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function chooserError(
  code: RpcError["code"],
  message: string,
  reason: "file_chooser_control_failed" | "file_chooser_not_opened",
  phase: ChooserPhase,
): RpcError {
  return { code, message, data: { reason, phase } };
}

function sameTarget(source: FileChooserOpened["source"], target: CdpTarget): boolean {
  return source.tabId === target.tabId && source.sessionId === target.sessionId;
}

async function resetTarget(cdp: CdpRunner, tabId: number): Promise<void> {
  if (!cdp.detach) return;
  try {
    await waitBounded(
      cdp.detach(tabId),
      Date.now() + CLEANUP_TIMEOUT_MS,
      undefined,
      "CDP detach timed out",
    );
  } catch {
    // The target may already have detached or closed.
  }
}

export async function uploadThroughFileChooser(
  options: FileChooserUploadOptions,
): Promise<FileChooserUploadResult | RpcError> {
  const deadline = Date.now() + options.timeoutMs;
  let resolveOpened!: (value: FileChooserOpened) => void;
  const opened = new Promise<FileChooserOpened>((resolve) => {
    resolveOpened = resolve;
  });
  const subscription = options.cdp.onEvent?.((source, method, raw) => {
    if (method !== "Page.fileChooserOpened" || !sameTarget(source, options.target)) return;
    const event = raw as { backendNodeId?: unknown; mode?: unknown };
    resolveOpened({
      source,
      ...(typeof event.backendNodeId === "number" ? { backendNodeId: event.backendNodeId } : {}),
      ...(typeof event.mode === "string" ? { mode: event.mode } : {}),
    });
  });
  if (!subscription) {
    return { code: "unsupported", message: "CDP event subscription unavailable" };
  }

  let eventsEnabled = false;
  let targetStateUnknown = false;
  let outcome: FileChooserUploadResult | RpcError;
  let aborted: BoundedWaitError | undefined;
  try {
    try {
      await waitBounded(
        sendToCdpTarget(options.cdp, options.target, "Page.enable", {
          enableFileChooserOpenedEvent: true,
        }),
        deadline,
        options.signal,
        "enabling file chooser events timed out",
      );
      eventsEnabled = true;
    } catch (err) {
      if (err instanceof BoundedWaitError) {
        targetStateUnknown = true;
        if (err.kind === "aborted") throw err;
        outcome = chooserError(
          "timeout",
          err.message,
          "file_chooser_control_failed",
          "enable_events",
        );
      } else {
        outcome = chooserError(
          "cdp_failed",
          err instanceof Error ? err.message : String(err),
          "file_chooser_control_failed",
          "enable_events",
        );
      }
      return outcome;
    }

    let click: ClickResult | RpcError;
    try {
      click = await waitBounded(
        options.trigger(remainingMs(deadline)),
        deadline,
        options.signal,
        "upload trigger timed out",
      );
    } catch (err) {
      if (err instanceof BoundedWaitError) {
        targetStateUnknown = true;
        if (err.kind === "aborted") throw err;
        return chooserError("timeout", err.message, "file_chooser_control_failed", "trigger");
      }
      return chooserError(
        "cdp_failed",
        err instanceof Error ? err.message : String(err),
        "file_chooser_control_failed",
        "trigger",
      );
    }
    if (isRpcError(click)) return click;

    let chooser: FileChooserOpened;
    try {
      chooser = await waitBounded(
        opened,
        deadline,
        options.signal,
        "upload trigger did not open a file chooser",
      );
    } catch (err) {
      if (err instanceof BoundedWaitError && err.kind === "aborted") throw err;
      return chooserError(
        "timeout",
        err instanceof Error ? err.message : String(err),
        "file_chooser_not_opened",
        "await_event",
      );
    }

    if (chooser.backendNodeId === undefined) {
      return {
        code: "unsupported",
        message: "this file chooser is not backed by an input element",
        data: {
          reason: "unsupported_file_chooser",
          chooser_kind: "non_input",
          manual_fallback_available: true,
        },
      };
    }
    if (chooser.mode === "selectSingle" && options.files.length !== 1) {
      return { code: "invalid_params", message: "file chooser accepts exactly one file" };
    }

    try {
      await waitBounded(
        sendToCdpTarget(options.cdp, options.target, "DOM.setFileInputFiles", {
          files: options.files,
          backendNodeId: chooser.backendNodeId,
        }),
        deadline,
        options.signal,
        "setting file input files timed out",
      );
    } catch (err) {
      if (err instanceof BoundedWaitError) {
        targetStateUnknown = true;
        if (err.kind === "aborted") throw err;
        return chooserError("timeout", err.message, "file_chooser_control_failed", "set_files");
      }
      return chooserError(
        "cdp_failed",
        err instanceof Error ? err.message : String(err),
        "file_chooser_control_failed",
        "set_files",
      );
    }
    outcome = { click, ...(chooser.mode ? { mode: chooser.mode } : {}) };
  } catch (err) {
    if (err instanceof BoundedWaitError && err.kind === "aborted") aborted = err;
    else throw err;
    outcome = { code: "cancelled", message: "file chooser operation aborted" };
  } finally {
    subscription.dispose();
    if (targetStateUnknown) {
      await resetTarget(options.cdp, options.target.tabId);
    } else if (eventsEnabled) {
      try {
        await waitBounded(
          sendToCdpTarget(options.cdp, options.target, "Page.enable", {
            enableFileChooserOpenedEvent: false,
          }),
          Date.now() + CLEANUP_TIMEOUT_MS,
          undefined,
          "restoring file chooser events timed out",
        );
      } catch {
        await resetTarget(options.cdp, options.target.tabId);
      }
    }
  }
  if (aborted) {
    const error = new DOMException(aborted.message, "AbortError");
    throw error;
  }
  return outcome;
}
