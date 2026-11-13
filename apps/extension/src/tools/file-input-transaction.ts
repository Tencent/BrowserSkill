// One upload transaction with an explicit browser-side commit boundary.
// Chrome interception prevents a native chooser from escaping automation;
// chooser events and a frame-scoped DOM probe are independent input-location
// signals, so event delivery is not required for standard file inputs.

import type { ClickResult, RpcError, TransferEffectState } from "@/transport/types";
import { transferError } from "./errors";
import type { ResolvedActionTarget } from "./interaction";
import { type CdpRunner, isRpcError, sendToCdpTarget } from "./shared";
import { BoundedWaitError, remainingMs, waitBounded } from "./transfer-transaction";

const CLEANUP_TIMEOUT_MS = 1_000;
const ACTIVATION_GRACE_MS = 1_000;
const PROBE_INTERVAL_MS = 20;

type UploadPhase =
  | "arm_interception"
  | "arm_input_probe"
  | "trigger"
  | "resolve_input"
  | "set_files"
  | "cleanup";

interface RuntimeReply {
  result?: { value?: unknown; objectId?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

interface ChooserEvent {
  frameId?: string;
  backendNodeId?: number;
  mode?: "selectSingle" | "selectMultiple";
}

export interface FileInputTransactionOptions {
  cdp: CdpRunner;
  actionTarget: ResolvedActionTarget;
  files: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  trigger(): Promise<ClickResult | RpcError>;
  cleanupTrigger?(deadline: number): Promise<void>;
}

export interface FileInputTransactionResult {
  click?: ClickResult;
  multiple: boolean;
}

function runtimeError(reply: RuntimeReply, fallback: string): Error | null {
  if (!reply.exceptionDetails) return null;
  return new Error(
    reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? fallback,
  );
}

function transferFailure(
  code: RpcError["code"],
  reason: "file_input_probe_failed" | "file_input_not_activated" | "set_file_input_failed",
  message: string,
  effectState: TransferEffectState,
  phase: UploadPhase,
): RpcError {
  return transferError(code, reason, message, { effectState, phase });
}

function enrichFailure(
  error: RpcError,
  effectState: TransferEffectState,
  phase: UploadPhase,
): RpcError {
  return {
    ...error,
    data: { ...error.data, effect_state: effectState, phase },
  };
}

function sameTarget(
  source: { tabId?: number; sessionId?: string },
  target: { tabId: number; sessionId?: string },
): boolean {
  return source.tabId === target.tabId && source.sessionId === target.sessionId;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await waitBounded(
    new Promise((resolve) => setTimeout(resolve, ms)),
    Date.now() + ms + 1,
    signal,
    "upload activation probe timed out",
  );
}

async function callOnTrigger<T = RuntimeReply>(
  options: FileInputTransactionOptions,
  objectId: string,
  functionDeclaration: string,
  args: unknown[],
  returnByValue: boolean,
): Promise<T> {
  return sendToCdpTarget<T>(options.cdp, options.actionTarget.cdpTarget, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue,
    awaitPromise: false,
  });
}

export async function uploadThroughActivatedFileInput(
  options: FileInputTransactionOptions,
): Promise<FileInputTransactionResult | RpcError> {
  const deadline = Date.now() + options.timeoutMs;
  const rawTarget = options.actionTarget.cdpTarget;
  let target = options.cdp.resolveTarget?.(rawTarget) ?? rawTarget;
  let resolvedOptions =
    target === rawTarget
      ? options
      : { ...options, actionTarget: { ...options.actionTarget, cdpTarget: target } };
  const objectGroup = `bsk-upload-${crypto.randomUUID()}`;
  const stateKey = `__bskUpload_${crypto.randomUUID().replaceAll("-", "")}`;
  const chooserEvents: ChooserEvent[] = [];
  let interceptionArmed = false;
  let probeArmed = false;
  let triggerObjectId: string | undefined;
  let releaseTabAttachment: (() => void) | undefined;
  let chooserSubscription: { dispose(): void } | undefined;
  let outcome: FileInputTransactionResult | RpcError = transferFailure(
    "protocol_error",
    "file_input_probe_failed",
    "upload transaction ended without an outcome",
    "none",
    "cleanup",
  );

  try {
    releaseTabAttachment = options.cdp.retainTabAttachment?.(rawTarget.tabId);
    chooserSubscription = options.cdp.onEvent?.((source, method, raw) => {
      const expectedTarget = options.cdp.resolveTarget?.(target) ?? target;
      if (method !== "Page.fileChooserOpened" || !sameTarget(source, expectedTarget)) return;
      const event = raw as ChooserEvent;
      chooserEvents.push(event);
    });

    try {
      if (rawTarget.sessionId && options.cdp.reconcileSoftDetachedFrames) {
        await waitBounded(
          options.cdp.reconcileSoftDetachedFrames(rawTarget.tabId),
          deadline,
          options.signal,
          "reconciling upload frame target timed out",
        );
        target = options.cdp.resolveTarget?.(rawTarget) ?? rawTarget;
        resolvedOptions =
          target === rawTarget
            ? options
            : { ...options, actionTarget: { ...options.actionTarget, cdpTarget: target } };
      }
      if (target.sessionId) {
        await waitBounded(
          sendToCdpTarget(options.cdp, target, "Page.enable", {}),
          deadline,
          options.signal,
          "enabling frame Page domain timed out",
        );
      }
      await waitBounded(
        sendToCdpTarget(options.cdp, target, "Page.setInterceptFileChooserDialog", {
          enabled: true,
        }),
        deadline,
        options.signal,
        "arming native file chooser interception timed out",
      );
      interceptionArmed = true;
    } catch (err) {
      outcome = transferFailure(
        err instanceof BoundedWaitError ? "timeout" : "cdp_failed",
        "file_input_probe_failed",
        err instanceof Error ? err.message : String(err),
        "none",
        "arm_interception",
      );
      return outcome;
    }

    const commitFiles = async (
      backendNodeId: number,
      multiple: boolean,
      click?: ClickResult,
    ): Promise<FileInputTransactionResult | RpcError> => {
      if (!multiple && options.files.length !== 1) {
        return enrichFailure(
          { code: "invalid_params", message: "file input accepts exactly one file" },
          "none",
          "resolve_input",
        );
      }
      try {
        await waitBounded(
          sendToCdpTarget(options.cdp, target, "DOM.setFileInputFiles", {
            files: options.files,
            backendNodeId,
          }),
          deadline,
          options.signal,
          "setting file input files timed out",
        );
      } catch (err) {
        return transferFailure(
          err instanceof BoundedWaitError ? "timeout" : "cdp_failed",
          "set_file_input_failed",
          err instanceof Error ? err.message : String(err),
          "unknown",
          "set_files",
        );
      }
      return { ...(click ? { click } : {}), multiple };
    };

    let directInput: { direct?: string; multiple?: boolean } | undefined;
    try {
      const resolved = await waitBounded(
        sendToCdpTarget<{ object?: { objectId?: string } }>(
          options.cdp,
          target,
          "DOM.resolveNode",
          {
            backendNodeId: options.actionTarget.backendNodeId,
            objectGroup,
          },
        ),
        deadline,
        options.signal,
        "resolving upload trigger timed out",
      );
      triggerObjectId = resolved.object?.objectId;
      if (!triggerObjectId) throw new Error("DOM.resolveNode returned no trigger objectId");

      const armed = await waitBounded(
        callOnTrigger<RuntimeReply>(
          resolvedOptions,
          triggerObjectId,
          `function(key) {
            if (this.nodeType === 1 && this.localName === "input" && this.type === "file") {
              if (!this.isConnected) return { direct: "detached" };
              if (
                this.matches(":disabled") ||
                this.getAttribute("aria-disabled") === "true" ||
                Boolean(this.closest("[inert]"))
              ) {
                return { direct: "disabled" };
              }
              return { direct: "ready", multiple: this.multiple === true };
            }
            const doc = this.ownerDocument;
            const owner = doc.defaultView;
            if (!owner) return false;
            const state = { inputs: [], listener: null };
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
            return true;
          }`,
          [stateKey],
          true,
        ),
        deadline,
        options.signal,
        "arming frame-scoped file input probe timed out",
      );
      const armError = runtimeError(armed, "failed to arm file input probe");
      if (armError) throw armError;
      if (armed.result?.value && typeof armed.result.value === "object") {
        directInput = armed.result.value as { direct?: string; multiple?: boolean };
      } else if (armed.result?.value === true) {
        probeArmed = true;
      } else {
        throw new Error("file input probe did not arm");
      }
    } catch (err) {
      outcome = transferFailure(
        err instanceof BoundedWaitError ? "timeout" : "cdp_failed",
        "file_input_probe_failed",
        err instanceof Error ? err.message : String(err),
        "none",
        "arm_input_probe",
      );
      return outcome;
    }

    if (directInput) {
      if (directInput.direct === "detached") {
        outcome = {
          code: "not_found",
          message: "The action target was removed from its document",
          data: { reason: "target_detached", effect_state: "none", phase: "resolve_input" },
        };
        return outcome;
      }
      if (directInput.direct === "disabled") {
        outcome = {
          code: "invalid_params",
          message: "upload requires an enabled input[type=file]",
          data: { reason: "target_disabled", effect_state: "none", phase: "resolve_input" },
        };
        return outcome;
      }
      outcome = await commitFiles(
        options.actionTarget.backendNodeId,
        directInput.multiple === true,
      );
      return outcome;
    }

    let click: ClickResult | RpcError;
    try {
      click = await waitBounded(
        options.trigger(),
        deadline,
        options.signal,
        "upload trigger timed out",
      );
    } catch (err) {
      outcome = transferFailure(
        err instanceof BoundedWaitError ? "timeout" : "cdp_failed",
        "file_input_probe_failed",
        err instanceof Error ? err.message : String(err),
        "none",
        "trigger",
      );
      return outcome;
    }
    if (isRpcError(click)) {
      outcome = enrichFailure(click, "none", "trigger");
      return outcome;
    }

    try {
      const activationDeadline = Math.min(deadline, Date.now() + ACTIVATION_GRACE_MS);
      let summary: { count: number; multiple: boolean } = { count: 0, multiple: false };
      while (Date.now() < activationDeadline) {
        if (chooserEvents.length > 0) break;
        const reply = await callOnTrigger<RuntimeReply>(
          resolvedOptions,
          triggerObjectId,
          `function(key) {
            const state = this.ownerDocument.defaultView?.[key];
            return state
              ? { count: state.inputs.length, multiple: state.inputs[0]?.multiple === true }
              : { count: 0, multiple: false };
          }`,
          [stateKey],
          true,
        );
        const summaryError = runtimeError(reply, "failed to inspect activated file input");
        if (summaryError) throw summaryError;
        const value = reply.result?.value as { count?: unknown; multiple?: unknown } | undefined;
        summary = {
          count: typeof value?.count === "number" ? value.count : 0,
          multiple: value?.multiple === true,
        };
        if (summary.count > 0) break;
        await delay(Math.min(PROBE_INTERVAL_MS, remainingMs(activationDeadline)), options.signal);
      }

      if (chooserEvents.length > 1) {
        outcome = transferFailure(
          "unsupported",
          "file_input_not_activated",
          "upload trigger activated more than one file chooser",
          "none",
          "resolve_input",
        );
        return outcome;
      }

      const chooser = chooserEvents[0];
      let backendNodeId: number | undefined;
      let multiple = summary.multiple;
      if (chooser) {
        if (typeof chooser.backendNodeId !== "number") {
          outcome = transferFailure(
            "unsupported",
            "file_input_not_activated",
            "upload trigger invoked a non-input file picker",
            "none",
            "resolve_input",
          );
          return outcome;
        }
        backendNodeId = chooser.backendNodeId;
        multiple = chooser.mode === "selectMultiple";
      } else {
        if (summary.count !== 1) {
          outcome = transferFailure(
            "unsupported",
            "file_input_not_activated",
            summary.count === 0
              ? "upload trigger did not activate an input[type=file]"
              : "upload trigger activated more than one input[type=file]",
            "none",
            "resolve_input",
          );
          return outcome;
        }
        const input = await callOnTrigger<RuntimeReply>(
          resolvedOptions,
          triggerObjectId,
          `function(key) { return this.ownerDocument.defaultView?.[key]?.inputs[0]; }`,
          [stateKey],
          false,
        );
        const inputError = runtimeError(input, "failed to resolve activated file input object");
        if (inputError) throw inputError;
        if (!input.result?.objectId) throw new Error("activated file input returned no objectId");
        const described = await sendToCdpTarget<{ node?: { backendNodeId?: number } }>(
          options.cdp,
          target,
          "DOM.describeNode",
          { objectId: input.result.objectId },
        );
        backendNodeId = described.node?.backendNodeId;
        if (typeof backendNodeId !== "number") {
          throw new Error("DOM.describeNode returned no file input backendNodeId");
        }
      }

      outcome = await commitFiles(backendNodeId, multiple, click);
      return outcome;
    } catch (err) {
      outcome = transferFailure(
        err instanceof BoundedWaitError ? "timeout" : "cdp_failed",
        "file_input_probe_failed",
        err instanceof Error ? err.message : String(err),
        "none",
        "resolve_input",
      );
      return outcome;
    }
  } finally {
    try {
      chooserSubscription?.dispose();
      let cleanupFailed = false;
      if (options.cleanupTrigger) {
        const cleanupDeadline = Date.now() + CLEANUP_TIMEOUT_MS;
        try {
          await waitBounded(
            options.cleanupTrigger(cleanupDeadline),
            cleanupDeadline,
            undefined,
            "upload trigger cleanup timed out",
          );
        } catch {
          cleanupFailed = true;
        }
      }
      if (probeArmed && triggerObjectId) {
        try {
          await waitBounded(
            callOnTrigger(
              { ...resolvedOptions, cdp: options.cdp.resourceCleanup ?? options.cdp },
              triggerObjectId,
              `function(key) {
                const owner = this.ownerDocument.defaultView;
                const state = owner?.[key];
                if (state?.listener) this.ownerDocument.removeEventListener("click", state.listener, true);
                if (owner) delete owner[key];
              }`,
              [stateKey],
              true,
            ),
            Date.now() + CLEANUP_TIMEOUT_MS,
            undefined,
            "cleaning file input probe timed out",
          );
        } catch {
          cleanupFailed = true;
        }
      }
      if (interceptionArmed) {
        try {
          await waitBounded(
            sendToCdpTarget(options.cdp, target, "Page.setInterceptFileChooserDialog", {
              enabled: false,
              cancel: true,
            }),
            Date.now() + CLEANUP_TIMEOUT_MS,
            undefined,
            "disabling file chooser interception timed out",
          );
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        await waitBounded(
          sendToCdpTarget(options.cdp, target, "Runtime.releaseObjectGroup", { objectGroup }),
          Date.now() + CLEANUP_TIMEOUT_MS,
          undefined,
          "releasing upload object group timed out",
        );
      } catch {
        cleanupFailed = true;
      }

      const effect = isRpcError(outcome)
        ? (outcome.data?.effect_state as TransferEffectState | undefined)
        : "committed";
      if (effect === "unknown" || cleanupFailed) {
        await options.cdp.detach?.(target.tabId);
      }
      if (cleanupFailed && isRpcError(outcome)) {
        outcome.data = { ...outcome.data, cleanup_state: "failed" };
      }
    } finally {
      releaseTabAttachment?.();
    }
  }
}
