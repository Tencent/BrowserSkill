import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import { captureRecordingObservation, type RegisteredObservation } from "./observation-capture";
import { RecordingStateRegistry } from "./state-registry";
import { matchObservationTarget, unmatchedTarget } from "./target-matcher";
import type { RecordingDraftStep, StepAnnotation, TargetedRecordingDraft } from "./types";

const DEFAULT_MAX_PAGE_TOKENS = 3_000;
const MIN_CAPTURE_INTERVAL_MS = 200;

export interface TabObservationCursor {
  lastSettled: RegisteredObservation | null;
  lastCaptureAt: number;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
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

function isTargeted(draft: RecordingDraftStep): draft is TargetedRecordingDraft {
  return draft.op !== "navigate" && draft.op !== "scroll";
}

export class RecordingObservationSession {
  readonly registry: RecordingStateRegistry;
  readonly cursor: TabObservationCursor;
  readonly annotations: StepAnnotation[];
  readonly #maxTokens: number;
  readonly #redactValues: boolean;

  constructor(
    options: {
      registry?: RecordingStateRegistry;
      cursor?: TabObservationCursor;
      annotations?: StepAnnotation[];
      maxTokens?: number;
      redactValues?: boolean;
    } = {},
  ) {
    this.registry = options.registry ?? new RecordingStateRegistry();
    this.cursor = options.cursor ?? { lastSettled: null, lastCaptureAt: 0 };
    this.annotations = options.annotations ?? [];
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_PAGE_TOKENS;
    this.#redactValues = options.redactValues ?? false;
  }

  async capture(
    cdp: CdpRunner,
    tabsApi: ChromeTabsApi,
    tabId: number,
    signal?: AbortSignal,
  ): Promise<RegisteredObservation> {
    const waitMs = Math.max(0, MIN_CAPTURE_INTERVAL_MS - (Date.now() - this.cursor.lastCaptureAt));
    if (waitMs > 0) await abortableDelay(waitMs, signal);
    if (signal?.aborted) throw new DOMException("observation aborted", "AbortError");
    const captured = await captureRecordingObservation({
      cdp,
      tabsApi,
      tabId,
      maxTokens: this.#maxTokens,
      redactValues: this.#redactValues,
      signal,
    });
    const state = this.registry.register({
      url: captured.url,
      title: captured.title,
      rawVomText: captured.vomText,
      truncated: captured.truncated,
    });
    const observation: RegisteredObservation = {
      stateId: state.id,
      rootFrameId: captured.rootFrameId,
      index: captured.index,
      url: captured.url,
    };
    this.cursor.lastSettled = observation;
    this.cursor.lastCaptureAt = Date.now();
    return observation;
  }

  bindDraft(draft: RecordingDraftStep, draftId: number, previousActionPending = false): void {
    const observation = this.cursor.lastSettled;
    if (isTargeted(draft)) {
      draft.matchedTarget = observation
        ? matchObservationTarget({
            observation,
            hint: draft.targetHint,
            fallback: draft.captureTarget,
          })
        : unmatchedTarget(draft.captureTarget);
    }
    if (!observation) return;

    const unmatched = isTargeted(draft) && draft.matchedTarget?.unmatched === true;
    if (previousActionPending && unmatched) return;
    draft.preStateId = observation.stateId;
    this.registry.markStep(observation.stateId, draftId);

    if (!isTargeted(draft) || !draft.matchedTarget?.ref) return;
    const ref = observation.index.ref(draft.matchedTarget.ref);
    if (!ref) return;
    this.annotations.push({
      draftId,
      op: draft.op,
      line: ref.line,
      stateId: observation.stateId,
      ...(draft.op === "fill" && !this.#redactValues
        ? { detail: JSON.stringify(draft.value) }
        : {}),
    });
  }
}
