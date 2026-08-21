// Transaction-scoped capture for one web download. Chrome owns the actual
// download and writes only beneath its Downloads root; BrowserSkill supplies a
// daemon-minted relative directory and reports the completed absolute path
// back to the daemon for validated import.

import type { CdpTarget } from "@/browser-driver/frame-graph";
import type { ClickResult, RpcError } from "@/transport/types";
import { type CdpRunner, isRpcError } from "./shared";

type DeterminingFilenameListener = (
  item: chrome.downloads.DownloadItem,
  suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
) => void | true;

interface ListenerEvent<T> {
  addListener(listener: T): void;
  removeListener(listener: T): void;
}

export interface DownloadsApi {
  onCreated: ListenerEvent<(item: chrome.downloads.DownloadItem) => void>;
  onChanged: ListenerEvent<(delta: chrome.downloads.DownloadDelta) => void>;
  onDeterminingFilename: ListenerEvent<DeterminingFilenameListener>;
  search(query: chrome.downloads.DownloadQuery): Promise<chrome.downloads.DownloadItem[]>;
  cancel(downloadId: number): Promise<void>;
}

export const chromeDownloadsApi: DownloadsApi = {
  get onCreated() {
    return chrome.downloads.onCreated;
  },
  get onChanged() {
    return chrome.downloads.onChanged;
  },
  get onDeterminingFilename() {
    return chrome.downloads.onDeterminingFilename;
  },
  search: (query) => chrome.downloads.search(query),
  cancel: (id) => chrome.downloads.cancel(id),
};

export interface DownloadCaptureOptions {
  cdp: CdpRunner;
  target: CdpTarget;
  downloads: DownloadsApi;
  browserRelativeDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  trigger(): Promise<ClickResult | RpcError>;
}

export interface DownloadCaptureResult {
  click: ClickResult;
  item: chrome.downloads.DownloadItem;
}

function safeBasename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop()?.trim();
  return basename && basename !== "." && basename !== ".." ? basename : "download";
}

function captureError(message: string): RpcError {
  return {
    code: "cdp_failed",
    message,
    data: { reason: "download_capture_failed" },
  };
}

function sameTarget(source: { tabId?: number; sessionId?: string }, target: CdpTarget): boolean {
  return source.tabId === target.tabId && source.sessionId === target.sessionId;
}

function matchesIntent(
  item: chrome.downloads.DownloadItem,
  intent: { url: string; suggestedFilename: string },
): boolean {
  const urlMatches = item.url === intent.url || item.finalUrl === intent.url;
  return urlMatches && safeBasename(item.filename) === safeBasename(intent.suggestedFilename);
}

export async function captureBrowserDownload(
  options: DownloadCaptureOptions,
): Promise<DownloadCaptureResult | RpcError> {
  let capturedId: number | undefined;
  let intent: { url: string; suggestedFilename: string } | undefined;
  const createdItems = new Map<number, chrome.downloads.DownloadItem>();
  let settled = false;
  let succeeded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCompletion!: (error: Error) => void;
  let resolveCompletion!: (item: chrome.downloads.DownloadItem) => void;

  const completion = new Promise<chrome.downloads.DownloadItem>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectCompletion(error);
  };
  const complete = (item: chrome.downloads.DownloadItem) => {
    if (settled) return;
    settled = true;
    resolveCompletion(item);
  };
  const claim = (item: chrome.downloads.DownloadItem): boolean => {
    if (capturedId === undefined) {
      capturedId = item.id;
      return true;
    }
    if (capturedId === item.id) return true;
    void options.downloads.cancel(item.id).catch(() => undefined);
    fail(new Error("download trigger produced more than one file"));
    return false;
  };

  const determiningListener: DeterminingFilenameListener = (item, suggest) => {
    try {
      if (!intent || !matchesIntent(item, intent) || !claim(item)) {
        suggest();
        return;
      }
      suggest({
        filename: `${options.browserRelativeDir}/${safeBasename(intent.suggestedFilename)}`,
        conflictAction: "overwrite",
      });
      const created = createdItems.get(item.id);
      if (created?.state === "complete") complete(created);
    } catch (err) {
      suggest();
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  };
  const createdListener = (item: chrome.downloads.DownloadItem) => {
    createdItems.set(item.id, item);
    if (capturedId !== item.id) return;
    if (item.state === "interrupted") {
      fail(new Error(item.error ?? "download interrupted"));
    } else if (item.state === "complete") {
      complete(item);
    }
  };
  const changedListener = async (delta: chrome.downloads.DownloadDelta) => {
    if (capturedId === undefined || delta.id !== capturedId || settled) return;
    if (delta.state?.current === "interrupted" || delta.error?.current) {
      fail(new Error(delta.error?.current ?? "download interrupted"));
      return;
    }
    if (delta.state?.current === "complete") {
      try {
        const [item] = await options.downloads.search({ id: delta.id });
        if (item) complete(item);
        else fail(new Error("completed download disappeared"));
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };
  const onAbort = () => {
    fail(new DOMException("aborted", "AbortError"));
  };
  const cdpSubscription = options.cdp.onEvent?.((source, method, raw) => {
    if (method !== "Page.downloadWillBegin" || !sameTarget(source, options.target)) return;
    const event = raw as { url?: unknown; suggestedFilename?: unknown };
    if (typeof event.url !== "string" || typeof event.suggestedFilename !== "string") return;
    if (intent) {
      fail(new Error("download trigger produced more than one browser download intent"));
      return;
    }
    intent = { url: event.url, suggestedFilename: event.suggestedFilename };
  });
  if (!cdpSubscription) {
    return captureError("CDP download intent subscription unavailable");
  }

  options.downloads.onDeterminingFilename.addListener(determiningListener);
  options.downloads.onCreated.addListener(createdListener);
  options.downloads.onChanged.addListener(changedListener);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(
    () => fail(new Error("download did not complete before timeout")),
    options.timeoutMs,
  );

  try {
    const triggered = await options.trigger();
    if (isRpcError(triggered)) {
      void completion.catch(() => undefined);
      return triggered;
    }
    const item = await completion;
    succeeded = true;
    return { click: triggered, item };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return captureError(err instanceof Error ? err.message : String(err));
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    if (!succeeded && capturedId !== undefined) {
      await options.downloads.cancel(capturedId).catch(() => undefined);
    }
    options.signal?.removeEventListener("abort", onAbort);
    options.downloads.onDeterminingFilename.removeListener(determiningListener);
    options.downloads.onCreated.removeListener(createdListener);
    options.downloads.onChanged.removeListener(changedListener);
    cdpSubscription.dispose();
  }
}
