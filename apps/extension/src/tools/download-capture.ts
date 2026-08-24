// Order-independent coordinator for one browser download. CDP supplies the
// exact target/frame intent while chrome.downloads supplies the download id
// and filename routing hook; neither event is assumed to arrive first.

import type { CdpTarget } from "@/browser-driver/frame-graph";
import type { ClickResult, RpcError, TransferEffectState } from "@/transport/types";
import { transferError } from "./errors";
import { type CdpRunner, isRpcError } from "./shared";

const CORRELATION_GRACE_MS = 750;
const UNIQUE_SETTLE_MS = 50;
const SIZE_POLL_MS = 250;

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
  removeFile(downloadId: number): Promise<void>;
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
  removeFile: (id) => chrome.downloads.removeFile(id),
};

export interface DownloadCaptureOptions {
  cdp: CdpRunner;
  target: CdpTarget;
  expectedFrameId?: string;
  downloads: DownloadsApi;
  browserRelativeDir: string;
  maxByteSize?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  trigger(): Promise<ClickResult | RpcError>;
}

export interface DownloadCaptureResult {
  click: ClickResult;
  item: chrome.downloads.DownloadItem;
}

interface DownloadIntent {
  url: string;
  suggestedFilename: string;
  frameId?: string;
}

interface DownloadCandidate {
  item: chrome.downloads.DownloadItem;
  suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void;
  suggested: boolean;
  graceTimer: ReturnType<typeof setTimeout>;
}

function safeBasename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop()?.trim();
  return basename && basename !== "." && basename !== ".." ? basename : "download";
}

function sameTarget(source: { tabId?: number; sessionId?: string }, target: CdpTarget): boolean {
  return source.tabId === target.tabId && source.sessionId === target.sessionId;
}

function matchesIntent(item: chrome.downloads.DownloadItem, intent: DownloadIntent): boolean {
  const urlMatches = item.url === intent.url || item.finalUrl === intent.url;
  return urlMatches && safeBasename(item.filename) === safeBasename(intent.suggestedFilename);
}

function knownSize(item: chrome.downloads.DownloadItem): number | undefined {
  if (item.fileSize >= 0) return item.fileSize;
  if (item.totalBytes >= 0) return item.totalBytes;
  return undefined;
}

function captureError(
  message: string,
  effectState: TransferEffectState,
  phase: string,
  cleanupFailed = false,
): RpcError {
  return transferError("cdp_failed", "download_capture_failed", message, {
    effectState,
    phase,
    ...(cleanupFailed ? { cleanupState: "failed" } : {}),
  });
}

async function cleanupClaimedDownload(downloads: DownloadsApi, downloadId: number): Promise<void> {
  const lookup = async () => (await downloads.search({ id: downloadId }))[0];
  const item = await lookup();
  if (!item || item.state === "interrupted") return;
  if (item.state === "complete") {
    await downloads.removeFile(downloadId);
    return;
  }

  try {
    await downloads.cancel(downloadId);
  } catch (cancelError) {
    // Completion can win the race after the lookup but before cancellation.
    // Reconcile against Chrome's authoritative state before declaring cleanup
    // failed so every terminal state has one explicit cleanup path.
    const reconciled = await lookup();
    if (!reconciled || reconciled.state === "interrupted") return;
    if (reconciled.state === "complete") {
      await downloads.removeFile(downloadId);
      return;
    }
    throw cancelError;
  }
}

export async function captureBrowserDownload(
  options: DownloadCaptureOptions,
): Promise<DownloadCaptureResult | RpcError> {
  let click: ClickResult | undefined;
  let intent: DownloadIntent | undefined;
  let capturedId: number | undefined;
  let settled = false;
  let succeeded = false;
  let failureResult: RpcError | undefined;
  let uniquenessTimer: ReturnType<typeof setTimeout> | undefined;
  let operationTimer: ReturnType<typeof setTimeout> | undefined;
  let sizePoll: ReturnType<typeof setInterval> | undefined;
  const candidates = new Map<number, DownloadCandidate>();
  const createdItems = new Map<number, chrome.downloads.DownloadItem>();

  let resolveCompletion!: (item: chrome.downloads.DownloadItem) => void;
  let rejectCompletion!: (error: Error) => void;
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
    const size = knownSize(item);
    if (size !== undefined && options.maxByteSize !== undefined && size > options.maxByteSize) {
      fail(new Error(`download exceeds transfer limit ${options.maxByteSize}`));
      return;
    }
    settled = true;
    resolveCompletion(item);
  };
  const suggestDefault = (candidate: DownloadCandidate) => {
    if (candidate.suggested) return;
    candidate.suggested = true;
    candidate.suggest();
  };
  const matchingCandidates = (): DownloadCandidate[] => {
    const currentIntent = intent;
    return currentIntent
      ? [...candidates.values()].filter(
          (candidate) => !candidate.suggested && matchesIntent(candidate.item, currentIntent),
        )
      : [];
  };

  const claimUnique = () => {
    uniquenessTimer = undefined;
    if (settled || capturedId !== undefined || !intent) return;
    const matches = matchingCandidates();
    if (matches.length !== 1) {
      if (matches.length > 1) {
        for (const candidate of matches) suggestDefault(candidate);
        fail(new Error("download attribution is ambiguous"));
      }
      return;
    }
    const candidate = matches[0];
    candidate.suggested = true;
    clearTimeout(candidate.graceTimer);
    capturedId = candidate.item.id;
    candidate.suggest({
      filename: `${options.browserRelativeDir}/${safeBasename(intent.suggestedFilename)}`,
      conflictAction: "overwrite",
    });
    const size = knownSize(candidate.item);
    if (size !== undefined && options.maxByteSize !== undefined && size > options.maxByteSize) {
      fail(new Error(`download exceeds transfer limit ${options.maxByteSize}`));
      return;
    }
    const created = createdItems.get(candidate.item.id);
    if (created?.state === "interrupted") {
      fail(new Error(created.error ?? "download interrupted"));
    } else if (created?.state === "complete") {
      complete(created);
    }
  };
  const reconcile = () => {
    if (settled || capturedId !== undefined || !intent) return;
    const matches = matchingCandidates();
    if (matches.length > 1) {
      for (const candidate of matches) suggestDefault(candidate);
      fail(new Error("download attribution is ambiguous"));
      return;
    }
    if (matches.length === 1 && !uniquenessTimer) {
      uniquenessTimer = setTimeout(claimUnique, UNIQUE_SETTLE_MS);
    }
  };

  const determiningListener: DeterminingFilenameListener = (item, suggest) => {
    const candidate: DownloadCandidate = {
      item,
      suggest,
      suggested: false,
      graceTimer: setTimeout(() => {
        suggestDefault(candidate);
        candidates.delete(item.id);
        if (intent && matchesIntent(item, intent) && capturedId === undefined) {
          fail(new Error("download correlation grace elapsed before unique attribution"));
        }
      }, CORRELATION_GRACE_MS),
    };
    candidates.set(item.id, candidate);
    reconcile();
    return true;
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
  const onAbort = () => fail(new DOMException("aborted", "AbortError"));
  const cdpSubscription = options.cdp.onEvent?.((source, method, raw) => {
    if (method !== "Page.downloadWillBegin" || !sameTarget(source, options.target)) return;
    const event = raw as { url?: unknown; suggestedFilename?: unknown; frameId?: unknown };
    if (typeof event.url !== "string" || typeof event.suggestedFilename !== "string") return;
    if (options.expectedFrameId && event.frameId !== options.expectedFrameId) {
      fail(new Error("download originated from a different frame"));
      return;
    }
    if (intent) {
      fail(new Error("download trigger produced more than one browser download intent"));
      return;
    }
    intent = {
      url: event.url,
      suggestedFilename: event.suggestedFilename,
      ...(typeof event.frameId === "string" ? { frameId: event.frameId } : {}),
    };
    reconcile();
  });
  if (!cdpSubscription) {
    return captureError("CDP download intent subscription unavailable", "none", "arm");
  }

  options.downloads.onDeterminingFilename.addListener(determiningListener);
  options.downloads.onCreated.addListener(createdListener);
  options.downloads.onChanged.addListener(changedListener);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  operationTimer = setTimeout(
    () => fail(new Error("download did not complete before timeout")),
    options.timeoutMs,
  );
  sizePoll = setInterval(() => {
    if (capturedId === undefined || settled || options.maxByteSize === undefined) return;
    void options.downloads
      .search({ id: capturedId })
      .then(([item]) => {
        if (!item || settled) return;
        if (item.bytesReceived > (options.maxByteSize as number)) {
          fail(new Error(`download exceeds transfer limit ${options.maxByteSize}`));
        }
      })
      .catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
  }, SIZE_POLL_MS);

  try {
    const triggered = await options.trigger();
    if (isRpcError(triggered)) {
      void completion.catch(() => undefined);
      const effect: TransferEffectState =
        capturedId !== undefined ? "committed" : intent ? "unknown" : "none";
      failureResult = {
        ...triggered,
        data: { ...triggered.data, effect_state: effect, phase: "trigger" },
      };
      return failureResult;
    }
    click = triggered;
    const item = await completion;
    succeeded = true;
    return { click, item };
  } catch (err) {
    const effect: TransferEffectState =
      capturedId !== undefined ? "committed" : click ? "unknown" : "none";
    failureResult = captureError(
      err instanceof Error ? err.message : String(err),
      effect,
      capturedId !== undefined ? "download" : "attribution",
    );
    return failureResult;
  } finally {
    settled = true;
    if (operationTimer) clearTimeout(operationTimer);
    if (uniquenessTimer) clearTimeout(uniquenessTimer);
    if (sizePoll) clearInterval(sizePoll);
    options.signal?.removeEventListener("abort", onAbort);
    options.downloads.onDeterminingFilename.removeListener(determiningListener);
    options.downloads.onCreated.removeListener(createdListener);
    options.downloads.onChanged.removeListener(changedListener);
    cdpSubscription.dispose();
    for (const candidate of candidates.values()) {
      clearTimeout(candidate.graceTimer);
      if (candidate.item.id !== capturedId) suggestDefault(candidate);
    }
    if (!succeeded && capturedId !== undefined) {
      try {
        await cleanupClaimedDownload(options.downloads, capturedId);
      } catch {
        if (failureResult?.data) failureResult.data.cleanup_state = "failed";
      }
    }
  }
}
