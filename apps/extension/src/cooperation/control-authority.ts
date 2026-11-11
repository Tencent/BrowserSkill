import type { RpcError } from "@/transport/types";

/** Checks ownership and human control without reading the renderer or validating
 * a DOM observation. Create before asynchronous preparation, then call at the
 * native effect boundary. A revoked guard cannot be reused after control returns.
 * Read-only operations and owned cleanup do not need a mutation guard. */
export interface ControlAuthority {
  controlGuard(sessionId: string, tabId: number): () => void;
}

export class ControlAuthorityError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(rpcError.message);
    this.name = "ControlAuthorityError";
  }
}
