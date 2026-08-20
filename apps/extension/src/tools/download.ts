// One-click/one-file browser download capture. chrome.downloads events are
// browser-global, so a coordinator prevents two bsk sessions from racing.

import type { SessionManager } from "@/session-manager/manager";
import type { ClickParams, DownloadParams, DownloadResult, RpcError } from "@/transport/types";
import { handleClick, type InteractionDeps } from "./interaction";
import { enforceAgentWindow, isRpcError, lookupSession, resolveTargetTab } from "./shared";

export interface DownloadsApi {
  onCreated: chrome.events.Event<(item: chrome.downloads.DownloadItem) => void>;
  onChanged: chrome.events.Event<(delta: chrome.downloads.DownloadDelta) => void>;
  search(query: chrome.downloads.DownloadQuery): Promise<chrome.downloads.DownloadItem[]>;
  cancel(downloadId: number): Promise<void>;
}

const chromeDownloadsApi: DownloadsApi = {
  get onCreated() {
    return chrome.downloads.onCreated;
  },
  get onChanged() {
    return chrome.downloads.onChanged;
  },
  search: (query) => chrome.downloads.search(query),
  cancel: (id) => chrome.downloads.cancel(id),
};

let downloadActive = false;

export interface DownloadDeps extends InteractionDeps {
  downloads?: DownloadsApi;
}

export async function handleDownload(
  manager: SessionManager,
  params: DownloadParams,
  deps: DownloadDeps,
): Promise<DownloadResult | RpcError> {
  if (downloadActive) return { code: "invalid_params", message: "another bsk download is active" };
  downloadActive = true;
  const downloads = deps.downloads ?? chromeDownloadsApi;
  let capturedId: number | undefined;
  let createdListener: ((item: chrome.downloads.DownloadItem) => void) | undefined;
  let changedListener: ((delta: chrome.downloads.DownloadDelta) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ctx = lookupSession(manager, params, "download");
    if (isRpcError(ctx)) return ctx;
    const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
    if (isRpcError(target)) return target;
    const denied = enforceAgentWindow(ctx, target, "download");
    if (denied) return denied;
    if (!params.staging_path)
      return { code: "invalid_params", message: "download requires daemon staging" };
    const normalisePath = (path: string) => path.replaceAll("\\", "/");
    const normalisedStaging = normalisePath(params.staging_path);
    const stagingPrefix = normalisedStaging.endsWith("/")
      ? normalisedStaging
      : `${normalisedStaging}/`;
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<chrome.downloads.DownloadItem>((resolve, reject) => {
      rejectCompleted = reject;
      createdListener = (item) => {
        if (!normalisePath(item.filename).startsWith(stagingPrefix)) return;
        if (capturedId !== undefined && capturedId !== item.id) {
          reject(new Error("download trigger produced more than one file"));
          return;
        }
        capturedId = item.id;
        if (item.state === "complete") resolve(item);
      };
      changedListener = async (delta) => {
        if (capturedId === undefined || delta.id !== capturedId) return;
        if (delta.state?.current === "interrupted" || delta.error?.current) {
          reject(new Error(delta.error?.current ?? "download interrupted"));
          return;
        }
        if (delta.state?.current === "complete") {
          const [item] = await downloads.search({ id: delta.id });
          if (item) resolve(item);
          else reject(new Error("completed download disappeared"));
        }
      };
      downloads.onCreated.addListener(createdListener);
      downloads.onChanged.addListener(changedListener);
      timer = setTimeout(
        () => reject(new Error("download did not complete before timeout")),
        params.timeout_ms ?? 120_000,
      );
    });
    const onAbort = () => {
      if (capturedId !== undefined) void downloads.cancel(capturedId).catch(() => undefined);
      rejectCompleted(new DOMException("aborted", "AbortError"));
    };
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await deps.cdp.send(target.tabId, "Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: params.staging_path,
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
        void completed.catch(() => undefined);
        return clicked;
      }
      const item = await completed;
      return {
        tab_id: target.tabId,
        used_ref: clicked.used_ref,
        used_selector: clicked.used_selector,
        suggested_filename: item.filename.split(/[\\/]/).pop() ?? "download",
        byte_size: item.fileSize >= 0 ? item.fileSize : item.totalBytes,
        mime: item.mime || undefined,
        danger: item.danger,
        staged_path: item.filename,
      };
    } finally {
      deps.signal?.removeEventListener("abort", onAbort);
      try {
        await deps.cdp.send(target.tabId, "Page.setDownloadBehavior", { behavior: "default" });
      } catch {}
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { code: "cdp_failed", message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
    if (createdListener) downloads.onCreated.removeListener(createdListener);
    if (changedListener) downloads.onChanged.removeListener(changedListener);
    downloadActive = false;
  }
}
