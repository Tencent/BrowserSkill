// One upload transaction, independent of Page.fileChooserOpened delivery.
// A transaction-scoped DOM listener records the file input actually activated
// by the requested click and cancels its native default action. File System
// Access picker entry points are replaced only for the same transaction, so a
// non-input picker fails promptly without opening an OS dialog.

import type { CdpTarget } from "@/browser-driver/frame-graph";
import type { ClickResult, RpcError } from "@/transport/types";
import { type CdpRunner, isRpcError, sendToCdpTarget } from "./shared";

const CLEANUP_TIMEOUT_MS = 1_000;

type UploadPhase = "arm_input_probe" | "trigger" | "resolve_input" | "set_files";

interface RuntimeReply {
  result?: {
    value?: unknown;
    objectId?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
}

export interface FileInputTransactionOptions {
  cdp: CdpRunner;
  target: CdpTarget;
  files: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  trigger(timeoutMs: number): Promise<ClickResult | RpcError>;
}

export interface FileInputTransactionResult {
  click: ClickResult;
  multiple: boolean;
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
  if (signal?.aborted) throw new BoundedWaitError("aborted", "upload transaction aborted");
  if (remaining === 0) throw new BoundedWaitError("timeout", timeoutMessage);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BoundedWaitError("timeout", timeoutMessage)), remaining);
    if (signal) {
      onAbort = () => reject(new BoundedWaitError("aborted", "upload transaction aborted"));
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

function uploadError(
  code: RpcError["code"],
  message: string,
  reason: "file_input_probe_failed" | "file_input_not_activated" | "set_file_input_failed",
  phase: UploadPhase,
): RpcError {
  return { code, message, data: { reason, phase } };
}

function runtimeError(reply: RuntimeReply, fallback: string): Error | null {
  if (!reply.exceptionDetails) return null;
  return new Error(
    reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? fallback,
  );
}

export async function uploadThroughActivatedFileInput(
  options: FileInputTransactionOptions,
): Promise<FileInputTransactionResult | RpcError> {
  const deadline = Date.now() + options.timeoutMs;
  const objectGroup = `bsk-upload-${crypto.randomUUID()}`;
  const stateKey = `__bskUpload_${crypto.randomUUID().replaceAll("-", "")}`;
  const stateKeyLiteral = JSON.stringify(stateKey);
  let probeAttempted = false;

  try {
    try {
      probeAttempted = true;
      const armed = await waitBounded(
        sendToCdpTarget<RuntimeReply>(options.cdp, options.target, "Runtime.evaluate", {
          expression: `(() => {
            const key = ${stateKeyLiteral};
            const owner = globalThis;
            const doc = document;
            const state = { inputs: [], listener: null, pickerCalls: [], pickers: [] };
            Object.defineProperty(owner, key, { value: state, configurable: true });
            state.listener = event => {
              const path = typeof event.composedPath === "function" ? event.composedPath() : [];
              const candidate = path[0] || event.target;
              if (candidate && candidate.nodeType === 1 &&
                  candidate.localName === "input" && candidate.type === "file") {
                if (!state.inputs.includes(candidate)) state.inputs.push(candidate);
                event.preventDefault();
              }
            };
            doc.addEventListener("click", state.listener, true);
            const win = doc.defaultView;
            for (const name of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) {
              if (!win || typeof win[name] !== "function") continue;
              const hadOwn = Object.prototype.hasOwnProperty.call(win, name);
              const descriptor = Object.getOwnPropertyDescriptor(win, name);
              state.pickers.push({ name, hadOwn, descriptor });
              Object.defineProperty(win, name, {
                configurable: true,
                enumerable: descriptor?.enumerable ?? true,
                writable: true,
                value: () => {
                  state.pickerCalls.push(name);
                  return Promise.reject(
                    new DOMException("Picker intercepted by BrowserSkill", "AbortError")
                  );
                },
              });
            }
            return true;
          })()`,
          objectGroup,
          returnByValue: true,
        }),
        deadline,
        options.signal,
        "arming file input probe timed out",
      );
      const armError = runtimeError(armed, "failed to arm file input probe");
      if (armError) throw armError;
    } catch (err) {
      if (err instanceof BoundedWaitError && err.kind === "aborted") throw err;
      return uploadError(
        err instanceof BoundedWaitError ? "timeout" : "cdp_failed",
        err instanceof Error ? err.message : String(err),
        "file_input_probe_failed",
        "arm_input_probe",
      );
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
      if (err instanceof BoundedWaitError && err.kind === "aborted") throw err;
      return uploadError(
        err instanceof BoundedWaitError ? "timeout" : "cdp_failed",
        err instanceof Error ? err.message : String(err),
        "file_input_probe_failed",
        "trigger",
      );
    }
    if (isRpcError(click)) return click;

    try {
      const summary = await waitBounded(
        sendToCdpTarget<RuntimeReply>(options.cdp, options.target, "Runtime.evaluate", {
          expression: `(() => {
            const s = globalThis[${stateKeyLiteral}];
            return s
              ? { count: s.inputs.length, multiple: s.inputs[0]?.multiple === true,
                  pickerCall: s.pickerCalls[0] }
              : { count: 0, multiple: false };
          })()`,
          returnByValue: true,
        }),
        deadline,
        options.signal,
        "resolving activated file input timed out",
      );
      const summaryError = runtimeError(summary, "failed to inspect activated file input");
      if (summaryError) throw summaryError;
      const value = summary.result?.value as
        | { count?: unknown; multiple?: unknown; pickerCall?: unknown }
        | undefined;
      const count = typeof value?.count === "number" ? value.count : 0;
      const multiple = value?.multiple === true;
      if (typeof value?.pickerCall === "string") {
        return uploadError(
          "unsupported",
          `upload trigger invoked ${value.pickerCall} instead of an input[type=file]`,
          "file_input_not_activated",
          "resolve_input",
        );
      }
      if (count !== 1) {
        return uploadError(
          "unsupported",
          count === 0
            ? "upload trigger did not activate an input[type=file]"
            : "upload trigger activated more than one input[type=file]",
          "file_input_not_activated",
          "resolve_input",
        );
      }
      if (!multiple && options.files.length !== 1) {
        return { code: "invalid_params", message: "file input accepts exactly one file" };
      }

      const input = await waitBounded(
        sendToCdpTarget<RuntimeReply>(options.cdp, options.target, "Runtime.evaluate", {
          expression: `globalThis[${stateKeyLiteral}]?.inputs[0]`,
          objectGroup,
          returnByValue: false,
        }),
        deadline,
        options.signal,
        "resolving activated file input object timed out",
      );
      const inputError = runtimeError(input, "failed to resolve activated file input object");
      if (inputError) throw inputError;
      const inputObjectId = input.result?.objectId;
      if (!inputObjectId) throw new Error("activated file input returned no objectId");

      const described = await waitBounded(
        sendToCdpTarget<{ node?: { backendNodeId?: number } }>(
          options.cdp,
          options.target,
          "DOM.describeNode",
          { objectId: inputObjectId },
        ),
        deadline,
        options.signal,
        "describing activated file input timed out",
      );
      const backendNodeId = described.node?.backendNodeId;
      if (typeof backendNodeId !== "number") {
        throw new Error("DOM.describeNode returned no file input backendNodeId");
      }

      try {
        await waitBounded(
          sendToCdpTarget(options.cdp, options.target, "DOM.setFileInputFiles", {
            files: options.files,
            backendNodeId,
          }),
          deadline,
          options.signal,
          "setting file input files timed out",
        );
      } catch (err) {
        if (err instanceof BoundedWaitError && err.kind === "aborted") throw err;
        return uploadError(
          err instanceof BoundedWaitError ? "timeout" : "cdp_failed",
          err instanceof Error ? err.message : String(err),
          "set_file_input_failed",
          "set_files",
        );
      }
      return { click, multiple };
    } catch (err) {
      if (err instanceof BoundedWaitError && err.kind === "aborted") throw err;
      return uploadError(
        err instanceof BoundedWaitError ? "timeout" : "cdp_failed",
        err instanceof Error ? err.message : String(err),
        "file_input_probe_failed",
        "resolve_input",
      );
    }
  } catch (err) {
    if (err instanceof BoundedWaitError && err.kind === "aborted") {
      return { code: "cancelled", message: "upload transaction aborted" };
    }
    throw err;
  } finally {
    if (probeAttempted) {
      try {
        await waitBounded(
          sendToCdpTarget(options.cdp, options.target, "Runtime.evaluate", {
            expression: `(() => {
              const key = ${stateKeyLiteral};
              const state = globalThis[key];
              if (state?.listener) {
                document.removeEventListener("click", state.listener, true);
              }
              const win = document.defaultView;
              if (win) {
                for (const picker of state?.pickers || []) {
                  try {
                    if (picker.hadOwn && picker.descriptor) {
                      Object.defineProperty(win, picker.name, picker.descriptor);
                    } else {
                      delete win[picker.name];
                    }
                  } catch {}
                }
              }
              delete globalThis[key];
            })()`,
          }),
          Date.now() + CLEANUP_TIMEOUT_MS,
          undefined,
          "cleaning file input probe timed out",
        );
      } catch {
        // Navigation may have invalidated the object; its document is gone too.
      }
    }
    try {
      await waitBounded(
        sendToCdpTarget(options.cdp, options.target, "Runtime.releaseObjectGroup", {
          objectGroup,
        }),
        Date.now() + CLEANUP_TIMEOUT_MS,
        undefined,
        "releasing upload object group timed out",
      );
    } catch {}
  }
}
