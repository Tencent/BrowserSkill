import { isRpcError } from "@/tools/shared";
import type { ErrorCode, RpcError } from "@/transport/types";

/** Keep protocol codes and diagnostic data across thrown errors and worker IPC. */
export class VideoError extends Error implements RpcError {
  readonly code: ErrorCode;
  readonly data?: RpcError["data"];

  constructor(error: RpcError) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

export function videoError(error: unknown, fallback: ErrorCode = "cdp_failed"): RpcError {
  if (isRpcError(error))
    return { code: error.code, message: error.message, ...(error.data && { data: error.data }) };
  return { code: fallback, message: error instanceof Error ? error.message : String(error) };
}
