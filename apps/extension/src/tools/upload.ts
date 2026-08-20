// Upload orchestration: validate the session-scoped request, resolve its click
// target, then delegate the browser protocol transaction to file-chooser.ts.

import type { CdpTarget } from "@/browser-driver/frame-graph";
import type { SessionManager } from "@/session-manager/manager";
import type { ClickParams, RpcError, UploadParams, UploadResult } from "@/transport/types";
import { uploadThroughFileChooser } from "./file-chooser";
import { handleClick, type InteractionDeps } from "./interaction";
import {
  type CdpRunner,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";
import { resolveSnapshotRef } from "./snapshot-ref";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface UploadDeps extends InteractionDeps {
  cdp: CdpRunner;
}

function chooserTarget(
  params: UploadParams,
  tabId: number,
  manager: SessionManager,
): CdpTarget | RpcError {
  const ctx = manager.get(params.session_id);
  if (!ctx) return { code: "not_found", message: `session ${params.session_id} unknown` };
  if (params.ref) {
    const ref = resolveSnapshotRef(ctx, params.ref, tabId);
    if (isRpcError(ref)) return ref;
    return { tabId, ...(ref.cdpSessionId ? { sessionId: ref.cdpSessionId } : {}) };
  }
  return { tabId };
}

export async function handleUpload(
  manager: SessionManager,
  params: UploadParams,
  deps: UploadDeps,
): Promise<UploadResult | RpcError> {
  const ctx = lookupSession(manager, params, "upload");
  if (isRpcError(ctx)) return ctx;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "upload");
  if (denied) return denied;
  if (!deps.cdp?.onEvent)
    return { code: "unsupported", message: "CDP event subscription unavailable" };
  if (
    params.files.length === 0 ||
    params.files.length > 20 ||
    params.files.some((file) => !file.staged_path)
  ) {
    return { code: "invalid_params", message: "upload requires daemon-staged files" };
  }
  const cdpTarget = chooserTarget(params, target.tabId, manager);
  if (isRpcError(cdpTarget)) return cdpTarget;
  const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const transaction = await uploadThroughFileChooser({
    cdp: deps.cdp,
    target: cdpTarget,
    files: params.files.map((file) => file.staged_path as string),
    timeoutMs,
    signal: deps.signal,
    trigger: (remaining) => {
      const clickParams: ClickParams = {
        session_id: params.session_id,
        ref: params.ref,
        selector: params.selector,
        tab_id: params.tab_id,
        timeout_ms: Math.max(1, remaining),
      };
      return handleClick(manager, clickParams, deps);
    },
  });
  if (isRpcError(transaction)) return transaction;
  return {
    tab_id: target.tabId,
    used_ref: transaction.click.used_ref,
    used_selector: transaction.click.used_selector,
    file_names: params.files.map((file) => file.name),
  };
}
