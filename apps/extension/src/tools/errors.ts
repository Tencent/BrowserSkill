// Central RpcError builders with stable `data.reason` values for CLI
// rendering. Extension handlers attach reasons here; human-facing copy
// lives in bsk-cli `render_error.rs`.

import type {
  ErrorCode,
  RpcError,
  RpcErrorData,
  RpcErrorReason,
  TransferCleanupState,
  TransferEffectState,
} from "@/transport/types";

export type { RpcErrorData, RpcErrorReason };

/** Chrome checks the whole tab's frame tree, including other extensions' frames. */
export function isCdpExtensionAccessDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Cannot access a chrome-extension:// URL of different extension");
}

/** Preserve more specific reasons, especially file-transfer outcome/cleanup details. */
export function classifyCdpError(error: RpcError): RpcError {
  if (
    error.code !== "cdp_failed" ||
    error.data?.reason ||
    !isCdpExtensionAccessDenied(error.message)
  ) {
    return error;
  }
  return {
    ...error,
    data: { ...error.data, reason: "cdp_extension_access_denied" },
  };
}

export function cdpError(error: unknown): RpcError {
  return classifyCdpError({
    code: "cdp_failed",
    message: error instanceof Error ? error.message : String(error),
  });
}

export interface TransferErrorOptions {
  effectState: TransferEffectState;
  phase: string;
  cleanupState?: TransferCleanupState;
}

export function rpcError(
  code: ErrorCode,
  reason: RpcErrorReason,
  message: string,
  extra?: Record<string, unknown>,
): RpcError {
  const data: RpcErrorData = { reason, ...extra };
  return { code, message, data };
}

export function transferError(
  code: ErrorCode,
  reason: RpcErrorReason,
  message: string,
  options: TransferErrorOptions,
): RpcError {
  return rpcError(code, reason, message, {
    effect_state: options.effectState,
    phase: options.phase,
    ...(options.cleanupState ? { cleanup_state: options.cleanupState } : {}),
  });
}
