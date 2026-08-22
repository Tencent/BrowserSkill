import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import type { StopReason, TraceV3 } from "@/transport/types";
import type { DocumentSettleScope } from "./document-settle";
import { RecordingObservationSession } from "./observation-session";
import { inferMissingPostStates, SettleController } from "./settle-controller";
import { RecordingStateRegistry } from "./state-registry";
import { buildTraceV3 } from "./trace-builder-v3";
import type { RecordingDraftStep, StepAnnotation } from "./types";

interface TabRecordingContext {
  session: RecordingObservationSession;
  settle: SettleController;
  initialCapture: PendingInitialCapture | null;
}

interface PendingInitialCapture {
  promise: Promise<void>;
  abort: AbortController;
}

export class RecordingObservationRuntime {
  readonly #cdp: CdpRunner;
  readonly #tabsApi: ChromeTabsApi;
  readonly #registry = new RecordingStateRegistry();
  readonly #annotations: StepAnnotation[] = [];
  readonly #contexts = new Map<number, TabRecordingContext>();
  readonly #maxTokens?: number;
  readonly #redactValues: boolean;

  constructor(input: {
    cdp: CdpRunner;
    tabsApi: ChromeTabsApi;
    maxTokens?: number;
    redactValues?: boolean;
  }) {
    this.#cdp = input.cdp;
    this.#tabsApi = input.tabsApi;
    this.#maxTokens = input.maxTokens;
    this.#redactValues = input.redactValues ?? false;
  }

  #context(tabId: number): TabRecordingContext {
    const existing = this.#contexts.get(tabId);
    if (existing) return existing;
    const session = new RecordingObservationSession({
      registry: this.#registry,
      annotations: this.#annotations,
      maxTokens: this.#maxTokens,
      redactValues: this.#redactValues,
    });
    const context: TabRecordingContext = {
      session,
      settle: new SettleController({
        session,
        cdp: this.#cdp,
        tabsApi: this.#tabsApi,
        tabId,
      }),
      initialCapture: null,
    };
    this.#contexts.set(tabId, context);
    return context;
  }

  async captureInitial(tabId: number): Promise<void> {
    const context = this.#context(tabId);
    if (context.session.cursor.lastSettled) return;
    if (context.initialCapture) return context.initialCapture.promise;

    const abort = new AbortController();
    let pending!: PendingInitialCapture;
    const promise = context.session.capture(this.#cdp, this.#tabsApi, tabId, abort.signal);
    pending = {
      abort,
      promise: promise
        .then(() => {})
        .finally(() => {
          if (context.initialCapture === pending) context.initialCapture = null;
        }),
    };
    context.initialCapture = pending;
    return pending.promise;
  }

  async processDraft(
    tabId: number,
    drafts: RecordingDraftStep[],
    draftIndex: number,
    scope?: DocumentSettleScope,
  ): Promise<void> {
    const draft = drafts[draftIndex];
    if (!draft) return;
    const context = this.#context(tabId);
    if (!context.session.cursor.lastSettled) {
      try {
        await this.captureInitial(tabId);
      } catch {
        // Post-action settle can still provide a usable state.
      }
    }
    context.session.bindDraft(draft, draftIndex + 1, context.settle.hasPending);
    context.settle.schedule(drafts, draftIndex, scope);
  }

  scheduleSettle(
    tabId: number,
    drafts: RecordingDraftStep[],
    draftIndex: number,
    scope?: DocumentSettleScope,
  ): void {
    this.#context(tabId).settle.schedule(drafts, draftIndex, scope);
  }

  clearRedirect(tabId: number): void {
    this.#contexts.get(tabId)?.settle.clearRedirect();
  }

  scheduleRedirect(tabId: number, drafts: RecordingDraftStep[], url: string): void {
    this.#context(tabId).settle.scheduleRedirect(drafts, url);
  }

  async flushRedirects(): Promise<void> {
    for (const context of this.#contexts.values()) await context.settle.flushRedirects();
  }

  async flush(): Promise<void> {
    await Promise.allSettled(
      [...this.#contexts.values()].flatMap((context) =>
        context.initialCapture ? [context.initialCapture.promise] : [],
      ),
    );
    await this.flushRedirects();
    for (const context of this.#contexts.values()) await context.settle.flush();
  }

  async settleTrailing(tabId: number, drafts: RecordingDraftStep[]): Promise<void> {
    const context = this.#context(tabId);
    if (context.initialCapture) await Promise.allSettled([context.initialCapture.promise]);
    if (!context.session.cursor.lastSettled) {
      try {
        await this.captureInitial(tabId);
      } catch {
        // The trace may remain observation-free when CDP is unavailable.
      }
    }
    await context.settle.settleTrailing(drafts);
    inferMissingPostStates(drafts);
  }

  cancel(): void {
    for (const context of this.#contexts.values()) {
      context.initialCapture?.abort.abort();
      context.settle.cancel();
    }
  }

  buildTrace(input: {
    drafts: RecordingDraftStep[];
    startedAt: string;
    purpose?: string;
    startUrl?: string;
    stoppedBy: StopReason;
    bskVersion: string;
  }): TraceV3 {
    return buildTraceV3({
      registry: this.#registry,
      drafts: input.drafts,
      annotations: this.#annotations,
      startedAt: input.startedAt,
      purpose: input.purpose,
      startUrl: input.startUrl,
      stoppedBy: input.stoppedBy,
      bskVersion: input.bskVersion,
      redactValues: this.#redactValues,
    });
  }
}
