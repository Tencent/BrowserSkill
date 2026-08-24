import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import { type DocumentSettleScope, waitForDocumentSettled } from "./document-settle";
import { RecordingObservationSession } from "./observation-session";
import type { RecordingDraftStep } from "./types";

interface PendingSettle {
  abort: AbortController;
  scope: DocumentSettleScope;
}

interface PendingRedirect {
  url: string;
  abort: AbortController;
}

const CAPTURE_RETRY_DELAY_MS = 250;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "AbortError"
  );
}

export function inferMissingPostStates(drafts: RecordingDraftStep[]): void {
  for (let index = 0; index < drafts.length - 1; index += 1) {
    const draft = drafts[index];
    const next = drafts[index + 1];
    if (draft && next && !draft.postStateId && next.preStateId) {
      draft.postStateId = next.preStateId;
    }
  }
}

export class SettleController {
  readonly #session: RecordingObservationSession;
  readonly #cdp: CdpRunner;
  readonly #tabsApi: ChromeTabsApi;
  readonly #tabId: number;
  readonly #rootScope: DocumentSettleScope;
  readonly #pending = new Map<number, PendingSettle>();
  #queue = Promise.resolve();
  #pendingRedirect: PendingRedirect | null = null;
  #redirectQueue = Promise.resolve();

  constructor(input: {
    session: RecordingObservationSession;
    cdp: CdpRunner;
    tabsApi: ChromeTabsApi;
    tabId: number;
  }) {
    this.#session = input.session;
    this.#cdp = input.cdp;
    this.#tabsApi = input.tabsApi;
    this.#tabId = input.tabId;
    this.#rootScope = { target: { tabId: input.tabId } };
  }

  get hasPending(): boolean {
    return this.#pending.size > 0 || this.#pendingRedirect !== null;
  }

  async #captureWithRetry(signal?: AbortSignal) {
    try {
      return await this.#session.capture(this.#cdp, this.#tabsApi, this.#tabId, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      await delay(CAPTURE_RETRY_DELAY_MS, signal);
      return this.#session.capture(this.#cdp, this.#tabsApi, this.#tabId, signal);
    }
  }

  schedule(
    drafts: RecordingDraftStep[],
    draftIndex: number,
    scope: DocumentSettleScope = this.#rootScope,
  ): void {
    if (scope.target.tabId !== this.#tabId) {
      throw new Error(
        `settle scope tab ${scope.target.tabId} does not belong to tab ${this.#tabId}`,
      );
    }
    const landing = drafts[draftIndex]?.preStateId;
    for (const [index, pending] of this.#pending) {
      if (index >= draftIndex) continue;
      pending.abort.abort();
      this.#pending.delete(index);
      if (landing && drafts[index] && !drafts[index].postStateId) {
        drafts[index].postStateId = landing;
      }
    }

    this.#pending.get(draftIndex)?.abort.abort();
    const pending = { abort: new AbortController(), scope };
    this.#pending.set(draftIndex, pending);
    const task = async () => {
      if (pending.abort.signal.aborted) return;
      try {
        const outcome = await waitForDocumentSettled(this.#cdp, pending.scope, {
          signal: pending.abort.signal,
        });
        if (outcome === "cancelled") return;
        const observation = await this.#captureWithRetry(pending.abort.signal);
        if (!pending.abort.signal.aborted && drafts[draftIndex]) {
          drafts[draftIndex].postStateId = observation.stateId;
        }
      } catch (error) {
        if (!isAbortError(error)) {
          console.warn(
            `[bsk record] post-action observation failed for step ${draftIndex + 1}`,
            error,
          );
        }
      } finally {
        if (this.#pending.get(draftIndex) === pending) this.#pending.delete(draftIndex);
      }
    };
    this.#queue = this.#queue.then(task, task).catch(() => {});
  }

  cancel(): void {
    for (const pending of this.#pending.values()) pending.abort.abort();
    this.#pending.clear();
    this.clearRedirect();
  }

  async flush(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      const current = this.#queue;
      await current;
      if (current === this.#queue) return;
    }
    console.warn("[bsk record] settle queue kept growing; using completed observations");
  }

  async settleTrailing(drafts: RecordingDraftStep[]): Promise<void> {
    const trailing: RecordingDraftStep[] = [];
    for (let index = drafts.length - 1; index >= 0; index -= 1) {
      const draft = drafts[index];
      if (!draft || draft.postStateId) break;
      trailing.push(draft);
    }
    if (trailing.length === 0) return;
    try {
      const observation = await this.#captureWithRetry();
      for (const draft of trailing) draft.postStateId = observation.stateId;
    } catch (error) {
      console.warn("[bsk record] final observation at stop failed", error);
    }
  }

  clearRedirect(): void {
    this.#pendingRedirect?.abort.abort();
    this.#pendingRedirect = null;
  }

  scheduleRedirect(drafts: RecordingDraftStep[], url: string): void {
    this.#pendingRedirect?.abort.abort();
    const pending: PendingRedirect = { url, abort: new AbortController() };
    this.#pendingRedirect = pending;
    const task = () => this.#settleRedirect(drafts, pending);
    this.#redirectQueue = this.#redirectQueue.then(task, task).catch(() => {});
  }

  async #settleRedirect(drafts: RecordingDraftStep[], pending: PendingRedirect): Promise<void> {
    const outcome = await waitForDocumentSettled(this.#cdp, this.#rootScope, {
      signal: pending.abort.signal,
    });
    if (outcome === "cancelled" || this.#pendingRedirect !== pending) return;

    let finalUrl = pending.url;
    try {
      finalUrl = (await this.#tabsApi.get(this.#tabId)).url || finalUrl;
    } catch {
      // The navigation event URL remains the best available destination.
    }
    if (this.#pendingRedirect !== pending) return;
    this.#pendingRedirect = null;
    if (
      !finalUrl ||
      finalUrl === "about:blank" ||
      this.#session.cursor.lastSettled?.url === finalUrl
    ) {
      return;
    }

    const last = drafts[drafts.length - 1];
    if (last?.op === "navigate" && last.url === finalUrl) {
      if (!last.postStateId) this.schedule(drafts, drafts.length - 1);
      await this.flush();
      return;
    }

    const draft: RecordingDraftStep = {
      op: "navigate",
      url: finalUrl,
      pageUrl: finalUrl,
      cause: "browser",
      transitionQualifiers: ["server_redirect"],
      preStateId: this.#session.cursor.lastSettled?.stateId,
    };
    drafts.push(draft);
    const draftIndex = drafts.length - 1;
    if (draft.preStateId) this.#session.registry.markStep(draft.preStateId, draftIndex + 1);
    this.schedule(drafts, draftIndex);
    await this.flush();
  }

  async flushRedirects(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      const current = this.#redirectQueue;
      await current;
      if (current === this.#redirectQueue) return;
    }
    console.warn("[bsk record] redirect queue kept growing; using the final completed landing");
  }
}
