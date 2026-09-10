// Upload orchestration: validate the session-scoped request, resolve its click
// target, then delegate the browser protocol transaction to the file-input
// transaction module.

import {
  type CaptureSuppressSendToTab,
  withExtensionOverlayHidden,
} from "@/lib/capture-suppress-bridge";
import type { SessionManager } from "@/session-manager/manager";
import type { RpcError, UploadParams, UploadResult } from "@/transport/types";
import { uploadThroughFileDrop } from "./file-drop-transaction";
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
  sendToTab?: CaptureSuppressSendToTab;
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
  const files = params.files.map((file) => file.staged_path as string);
  const mode = params.mode ?? "input";
  let usedRef = address.usedRef;
  let usedSelector = address.usedSelector;
  if (mode === "drop") {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    const transaction = await uploadThroughFileDrop({
      cdp: deps.cdp,
      actionTarget: address,
      files,
      timeoutMs,
      signal: deps.signal,
      withOverlayHidden: (operation) =>
        withExtensionOverlayHidden(target.tabId, operation, deps.sendToTab),
    });
    if (isRpcError(transaction)) return transaction;
  } else {
    const transaction = await uploadThroughActivatedFileInput({
      cdp: deps.cdp,
      actionTarget: address,
      files,
      timeoutMs,
      signal: deps.signal,
      trigger: () => clickResolvedTarget(ctx, address, {}, deps),
    });
    if (isRpcError(transaction)) return transaction;
    usedRef = transaction.click.used_ref;
    usedSelector = transaction.click.used_selector;
  }
  return {
    tab_id: target.tabId,
    used_ref: usedRef,
    used_selector: usedSelector,
    file_names: params.files.map((file) => file.name),
  };
}
