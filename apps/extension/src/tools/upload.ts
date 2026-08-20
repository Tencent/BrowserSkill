// Atomic file-chooser upload: arm interception before clicking, then attach
// daemon-staged files to the chooser node. No local path is accepted from an
// agent-facing call; staged_path is injected by the daemon.

import type { CdpTarget } from "@/browser-driver/frame-graph";
import type { SessionManager } from "@/session-manager/manager";
import type { ClickParams, RpcError, UploadParams, UploadResult } from "@/transport/types";
import { handleClick, type InteractionDeps } from "./interaction";
import {
  type CdpRunner,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
  sendToCdpTarget,
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let subscription: { dispose(): void } | undefined;
  let resolveChooser!: (value: {
    source: { tabId?: number; sessionId?: string };
    backendNodeId: number;
    mode?: string;
  }) => void;
  let rejectChooser!: (error: Error) => void;
  const chooser = new Promise<{
    source: { tabId?: number; sessionId?: string };
    backendNodeId: number;
    mode?: string;
  }>((resolve, reject) => {
    resolveChooser = resolve;
    rejectChooser = reject;
  });
  subscription = deps.cdp.onEvent((source, method, raw) => {
    if (method !== "Page.fileChooserOpened" || source.tabId !== target.tabId) return;
    if (cdpTarget.sessionId && source.sessionId !== cdpTarget.sessionId) return;
    const event = raw as { backendNodeId?: unknown; mode?: unknown };
    if (typeof event.backendNodeId !== "number") {
      rejectChooser(new Error("file chooser did not expose an input backendNodeId"));
      return;
    }
    resolveChooser({
      source,
      backendNodeId: event.backendNodeId,
      ...(typeof event.mode === "string" ? { mode: event.mode } : {}),
    });
  });
  timer = setTimeout(
    () => rejectChooser(new Error("file chooser did not open before timeout")),
    timeoutMs,
  );
  const onAbort = () => rejectChooser(new DOMException("aborted", "AbortError"));
  deps.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await sendToCdpTarget(deps.cdp, cdpTarget, "Page.setInterceptFileChooserDialog", {
      enabled: true,
    });
    const clickParams: ClickParams = {
      session_id: params.session_id,
      ref: params.ref,
      selector: params.selector,
      tab_id: params.tab_id,
      timeout_ms: params.timeout_ms,
    };
    const clicked = await handleClick(manager, clickParams, deps);
    if (isRpcError(clicked)) {
      void chooser.catch(() => undefined);
      return clicked;
    }
    const opened = await chooser;
    if (opened.mode === "selectSingle" && params.files.length !== 1) {
      return { code: "invalid_params", message: "file chooser accepts exactly one file" };
    }
    const sourceTarget: CdpTarget = {
      tabId: target.tabId,
      ...(opened.source.sessionId ? { sessionId: opened.source.sessionId } : {}),
    };
    await sendToCdpTarget(deps.cdp, sourceTarget, "DOM.setFileInputFiles", {
      files: params.files.map((file) => file.staged_path as string),
      backendNodeId: opened.backendNodeId,
    });
    return {
      tab_id: target.tabId,
      used_ref: clicked.used_ref,
      used_selector: clicked.used_selector,
      file_names: params.files.map((file) => file.name),
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { code: "cdp_failed", message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
    subscription?.dispose();
    deps.signal?.removeEventListener("abort", onAbort);
    try {
      await sendToCdpTarget(deps.cdp, cdpTarget, "Page.setInterceptFileChooserDialog", {
        enabled: false,
      });
    } catch {
      // Best-effort compensation; the target may have navigated/closed.
    }
  }
}
