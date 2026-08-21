// Upload orchestration: validate the session-scoped request, resolve its click
// target, then delegate the browser protocol transaction to the file-input
// transaction module.

import type { SessionManager } from "@/session-manager/manager";
import type { RpcError, UploadParams, UploadResult } from "@/transport/types";
import { uploadThroughActivatedFileInput } from "./file-input-transaction";
import { clickResolvedTarget, type InteractionDeps, resolveActionTarget } from "./interaction";
import {
  type CdpRunner,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface UploadDeps extends InteractionDeps {
  cdp: CdpRunner;
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
  if (
    params.files.length === 0 ||
    params.files.length > 20 ||
    params.files.some((file) => !file.staged_path)
  ) {
    return { code: "invalid_params", message: "upload requires daemon-staged files" };
  }
  const address = await resolveActionTarget(deps.cdp, ctx, target, params, "upload");
  if (isRpcError(address)) return address;
  const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const transaction = await uploadThroughActivatedFileInput({
    cdp: deps.cdp,
    actionTarget: address,
    files: params.files.map((file) => file.staged_path as string),
    timeoutMs,
    signal: deps.signal,
    trigger: () => clickResolvedTarget(ctx, address, {}, deps),
  });
  if (isRpcError(transaction)) return transaction;
  return {
    tab_id: target.tabId,
    used_ref: transaction.click.used_ref,
    used_selector: transaction.click.used_selector,
    file_names: params.files.map((file) => file.name),
  };
}
