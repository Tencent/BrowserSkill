// Central RpcError builders with stable `data.reason` values for CLI
// rendering. Extension handlers attach reasons here; human-facing copy
// lives in bsk-cli `render_error.rs`.

import type { ErrorCode, RpcError, RpcErrorData, RpcErrorReason } from "@/transport/types";

export type { RpcErrorData, RpcErrorReason };

export function rpcError(
  code: ErrorCode,
  reason: RpcErrorReason,
  message: string,
  extra?: Record<string, unknown>,
): RpcError {
  const data: RpcErrorData = { reason, ...extra };
  return { code, message, data };
}
