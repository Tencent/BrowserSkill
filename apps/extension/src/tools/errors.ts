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
