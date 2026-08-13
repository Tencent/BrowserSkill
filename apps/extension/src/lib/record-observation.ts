import type { RenderedRef } from "@browser-skill/vom";
import { formatObservationFile, type ObservationAnnotation } from "@/lib/format-observation-file";
import { fallbackDescriptor, matchTarget } from "@/lib/match-target";
import { waitForPageSettled } from "@/lib/page-settled";
import {
  CAPTURE_RETRY_DELAY_MS,
  DEFAULT_MAX_PAGE_TOKENS,
  OBSERVATION_MIN_INTERVAL_MS,
} from "@/lib/record-constants";
import { registerObservation, type StateRegistryEntry } from "@/lib/trace-reducer";
import { captureVomObservation } from "@/tools/capture-vom-observation";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import type { CapturedNode } from "@/tools/vom/capture";
import type { DraftTraceStep, Step, StopReason, Trace, TraceState } from "@/transport/types";
import { reduceTraceSteps, resolveTraceStartUrl } from "./trace-reducer";

export interface LastSettledObservation {
  stateId: string;
  captured: CapturedNode[];
  refs: RenderedRef[];
  url: string;
  title?: string;
  vomText: string;
}

/** A post-action observation that has been queued but not yet written down. */
interface PendingSettle {
  draftIndex: number;
  /** Set when a newer action has already decided where this step landed. */
  cancelled: boolean;
}

/** Latest URL in an in-flight redirect chain awaiting coalesce + settle. */
export interface PendingRedirectLanding {
  url: string;
  /** Bumped on every hop so an in-flight `waitForPageSettled` can cancel. */
  generation: number;
}

export interface RecordingObservationState {
  stateRegistry: Map<string, StateRegistryEntry>;
  lastSettled: LastSettledObservation | null;
  maxPageTokens: number;
  redactValues: boolean;
  lastCaptureAtMs: number;
  /**
   * Tail of the settle chain. Observations run one at a time so that a slow
   * capture can never land after a faster one and report the pages out of the
   * order the user visited them.
   */
  settleQueue: Promise<void>;
  /** Queued and in-flight settles, by draft index, so newer actions can supersede them. */
  settles: Map<number, PendingSettle>;
  stepAnnotations: Map<number, ObservationAnnotation[]>;
  /**
   * OAuth / server redirects are coalesced here: intermediate hops only update
   * `url`+`generation`, and one `navigate` is emitted after the page settles.
   */
  pendingRedirect: PendingRedirectLanding | null;
  redirectFlushQueue: Promise<void>;
}

export function createObservationState(options?: {
  maxPageTokens?: number;
  redactValues?: boolean;
}): RecordingObservationState {
  return {
    stateRegistry: new Map(),
    lastSettled: null,
    maxPageTokens: options?.maxPageTokens ?? DEFAULT_MAX_PAGE_TOKENS,
    redactValues: options?.redactValues ?? false,
    lastCaptureAtMs: 0,
    settleQueue: Promise.resolve(),
    settles: new Map(),
    stepAnnotations: new Map(),
    pendingRedirect: null,
    redirectFlushQueue: Promise.resolve(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTabMeta(
  tabsApi: ChromeTabsApi,
  tabId: number,
): Promise<{ url: string; title?: string }> {
  try {
    const tab = await tabsApi.get(tabId);
    return { url: tab.url ?? "about:blank", title: tab.title };
  } catch {
    return { url: "about:blank" };
  }
}

export async function captureAndRegisterObservation(
  obs: RecordingObservationState,
  cdp: CdpRunner,
  tabId: number,
  tabsApi: ChromeTabsApi,
  urlOverride?: string,
): Promise<LastSettledObservation> {
  const now = Date.now();
  const waitMs = Math.max(0, OBSERVATION_MIN_INTERVAL_MS - (now - obs.lastCaptureAtMs));
  if (waitMs > 0) await sleep(waitMs);

  const { url, title } = urlOverride
    ? { url: urlOverride, title: undefined }
    : await readTabMeta(tabsApi, tabId);
  const meta = urlOverride ? await readTabMeta(tabsApi, tabId) : { url, title };
  const resolvedTitle = title ?? meta.title;

  const rendered = await captureVomObservation(cdp, tabId, url, {
    maxTokens: obs.maxPageTokens,
    redactValues: obs.redactValues,
    conditionalSurfaceProbe: false,
  });

  const stateId = registerObservation(obs.stateRegistry, {
    url,
    title: resolvedTitle,
    rawVomText: rendered.text,
    truncated: rendered.truncated,
  });

  obs.lastCaptureAtMs = Date.now();
  const settled: LastSettledObservation = {
    stateId,
    captured: rendered.captured,
    refs: rendered.refs,
    url,
    title: resolvedTitle,
    vomText: rendered.text,
  };
  obs.lastSettled = settled;
  return settled;
}

/**
 * Bind a draft to the page it was performed on: origin state, geometric target
 * match, and the inline annotation. All three read the *current* observation,
 * which is only the page the user acted on while the draft is still fresh —
 * once the action settles, `lastSettled` is the destination page instead.
 */
export function applyTargetMatching(
  obs: RecordingObservationState,
  draft: DraftTraceStep,
  stepId: number,
): void {
  if (!obs.lastSettled) {
    // Initial observation can fail or race the first action. Keep whatever
    // the content script captured so the exported step is still teachable.
    if ("target" in draft && "captureTarget" in draft) {
      draft.target = fallbackDescriptor(draft.captureTarget);
    }
    rememberStepAnnotation(obs, stepId, draft);
    return;
  }
  draft.preStateId = obs.lastSettled.stateId;

  if ("target" in draft) {
    draft.target =
      "geometry" in draft && draft.geometry
        ? matchTarget({
            geometry: draft.geometry,
            captured: obs.lastSettled.captured,
            refs: obs.lastSettled.refs,
            fallback: draft.captureTarget,
          })
        : // No geometry to match on, but the capture still knew what the user
          // touched — keep that instead of an anonymous unmatched target.
          fallbackDescriptor(draft.captureTarget);
  }
  rememberStepAnnotation(obs, stepId, draft);
}

function fillDetailForDraft(
  obs: RecordingObservationState,
  draft: DraftTraceStep,
): string | undefined {
  if (obs.redactValues) return undefined;
  if (draft.op === "fill") return JSON.stringify(draft.value);
  return undefined;
}

function refLineForDraft(
  obs: RecordingObservationState,
  draft: DraftTraceStep,
): number | undefined {
  if (!("target" in draft) || !obs.lastSettled) return undefined;
  const targetRef = draft.target?.ref;
  if (!targetRef) return undefined;
  return obs.lastSettled.refs.find((r) => r.ref === targetRef)?.line;
}

function rememberStepAnnotation(
  obs: RecordingObservationState,
  stepId: number,
  draft: DraftTraceStep,
): void {
  const line = refLineForDraft(obs, draft);
  if (line === undefined || draft.op === "navigate" || draft.op === "scroll") return;
  if (!draft.preStateId) return;
  const ann: ObservationAnnotation = {
    stepId,
    op: draft.op,
    line,
    stateId: draft.preStateId,
    detail: fillDetailForDraft(obs, draft),
  };
  const bucket = obs.stepAnnotations.get(line) ?? [];
  bucket.push(ann);
  obs.stepAnnotations.set(line, bucket);
}

/** Record the step under the page it was performed on, not the one it led to. */
export function rememberStepOnPage(
  obs: RecordingObservationState,
  draft: DraftTraceStep,
  stepId: number,
): void {
  const stateId = draft.preStateId;
  if (!stateId) return;
  const entry = obs.stateRegistry.get(stateId);
  if (entry && !entry.stepsHere.includes(stepId)) {
    entry.stepsHere.push(stepId);
  }
}

/** Drop an in-flight redirect coalesce (e.g. a real navigate superseded it). */
export function clearPendingRedirectLanding(obs: RecordingObservationState): void {
  obs.pendingRedirect = null;
}

function enqueueRedirectFlush(obs: RecordingObservationState, task: () => Promise<void>): void {
  obs.redirectFlushQueue = obs.redirectFlushQueue.then(task, task).catch(() => {});
}

/**
 * Remember a redirect hop and schedule a settle-then-emit of a single navigate
 * to the final URL. Later hops only bump `generation` / replace `url`.
 */
export function scheduleRedirectLandingFlush(
  obs: RecordingObservationState,
  steps: DraftTraceStep[],
  cdp: CdpRunner,
  tabId: number,
  tabsApi: ChromeTabsApi,
  url: string,
  options: { cancelled?: () => boolean } = {},
): void {
  const generation = (obs.pendingRedirect?.generation ?? 0) + 1;
  obs.pendingRedirect = { url, generation };
  enqueueRedirectFlush(obs, () =>
    coalesceRedirectLanding(obs, steps, cdp, tabId, tabsApi, options),
  );
}

/**
 * Drain any coalesced redirect so the next action matches against the real
 * landing page. Safe to call when nothing is pending.
 */
export async function flushPendingRedirectLanding(
  obs: RecordingObservationState,
  steps: DraftTraceStep[],
  cdp: CdpRunner | undefined,
  tabId: number,
  tabsApi: ChromeTabsApi,
  options: { cancelled?: () => boolean } = {},
): Promise<void> {
  if (obs.pendingRedirect && cdp) {
    enqueueRedirectFlush(obs, () =>
      coalesceRedirectLanding(obs, steps, cdp, tabId, tabsApi, options),
    );
  }
  await obs.redirectFlushQueue;
}

/**
 * Wait until the redirect chain stops changing the document, then emit one
 * `navigate` (cause `browser`) to the tab's final URL and settle its observation.
 */
async function coalesceRedirectLanding(
  obs: RecordingObservationState,
  steps: DraftTraceStep[],
  cdp: CdpRunner,
  tabId: number,
  tabsApi: ChromeTabsApi,
  options: { cancelled?: () => boolean },
): Promise<void> {
  while (obs.pendingRedirect) {
    if (options.cancelled?.()) {
      obs.pendingRedirect = null;
      return;
    }

    const snap = obs.pendingRedirect;
    const outcome = await waitForPageSettled(cdp, tabId, {
      cancelled: () =>
        !!options.cancelled?.() ||
        obs.pendingRedirect === null ||
        obs.pendingRedirect.generation !== snap.generation,
    });

    if (options.cancelled?.()) {
      obs.pendingRedirect = null;
      return;
    }
    // A newer hop cancelled this wait — loop and settle against the latest URL.
    if (outcome === "cancelled") continue;
    if (!obs.pendingRedirect || obs.pendingRedirect.generation !== snap.generation) {
      continue;
    }

    const finalUrl = (await readTabMeta(tabsApi, tabId)).url || snap.url;
    obs.pendingRedirect = null;

    if (!finalUrl || finalUrl === "about:blank") return;
    if (obs.lastSettled?.url === finalUrl) return;

    const last = steps[steps.length - 1];
    if (last?.op === "navigate" && last.url === finalUrl) {
      if (!last.postStateId) {
        const draftIndex = steps.length - 1;
        scheduleDraftSettle(obs, draftIndex, draftIndex + 1, cdp, tabId, tabsApi, steps);
        await obs.settleQueue;
      }
      return;
    }

    if (outcome === "timeout") {
      console.debug(
        `[bsk record] redirect landing still changing after settle budget; ` +
          `recording navigate to ${finalUrl}`,
      );
    }

    const draft: DraftTraceStep = {
      op: "navigate",
      url: finalUrl,
      page_url: finalUrl,
      cause: "browser",
      preStateId: obs.lastSettled?.stateId,
    };
    steps.push(draft);
    const draftIndex = steps.length - 1;
    const stepId = draftIndex + 1;
    rememberStepOnPage(obs, draft, stepId);
    scheduleDraftSettle(obs, draftIndex, stepId, cdp, tabId, tabsApi, steps);
    // Callers that flush before the next action need `lastSettled` to already
    // be the landing page so target matching does not use the pre-redirect view.
    await obs.settleQueue;
    return;
  }
}

/**
 * A capture that lands mid-navigation fails on a destroyed execution context.
 * That is transient, so give it one more chance before the step has to fall
 * back to a stale state.
 */
async function captureWithRetry(
  obs: RecordingObservationState,
  cdp: CdpRunner,
  tabId: number,
  tabsApi: ChromeTabsApi,
  urlOverride?: string,
): Promise<LastSettledObservation> {
  try {
    return await captureAndRegisterObservation(obs, cdp, tabId, tabsApi, urlOverride);
  } catch (err) {
    console.debug("[bsk record] observation failed, retrying once", err);
    await sleep(CAPTURE_RETRY_DELAY_MS);
    return captureAndRegisterObservation(obs, cdp, tabId, tabsApi, urlOverride);
  }
}

export async function settleDraftObservation(
  obs: RecordingObservationState,
  cdp: CdpRunner,
  tabId: number,
  tabsApi: ChromeTabsApi,
  steps: DraftTraceStep[],
  draftIndex: number,
  pending?: PendingSettle,
): Promise<void> {
  const cancelled = () => pending?.cancelled === true;
  const outcome = await waitForPageSettled(cdp, tabId, { cancelled });
  if (outcome === "cancelled") return;
  if (outcome === "timeout") {
    console.debug(
      `[bsk record] step ${draftIndex + 1} was still changing the page after the settle ` +
        "budget; observing it as it stands",
    );
  }

  const started = steps[draftIndex];
  if (!started) return;

  // The URL attached to the draft may only be an intermediate redirect hop.
  // Once the page is settled, register the capture against live tab metadata.
  const settled = await captureWithRetry(obs, cdp, tabId, tabsApi);
  // The observation still counts as the latest view of the page even when this
  // step no longer wants it — the next action will start from it.
  if (cancelled()) return;
  // Re-read the slot: a navigation observed while the capture ran may have
  // rewritten this draft, and the observation belongs to whatever occupies the
  // slot now — writing to the object we started with would strand it.
  const draft = steps[draftIndex] ?? started;
  draft.postStateId = settled.stateId;
}

/**
 * Recover landing states from the shape of the recording itself: wherever the
 * next action was performed is, by definition, where the previous one landed.
 * Only the immediately following draft counts — a later one would claim a page
 * that several unobserved actions away, which is worse than admitting we saw
 * no change.
 */
export function inferMissingPostStates(steps: DraftTraceStep[]): void {
  for (let i = 0; i < steps.length - 1; i += 1) {
    const draft = steps[i];
    const next = steps[i + 1];
    if (!draft || !next || draft.postStateId || !next.preStateId) continue;
    draft.postStateId = next.preStateId;
    console.debug(
      `[bsk record] step ${i + 1} (${draft.op}) had no post-action observation; ` +
        `using where step ${i + 2} started (${next.preStateId})`,
    );
  }
}

/**
 * Last chance for the closing actions of a recording. Stopping right after the
 * final action is normal, and so is that action navigating away, so take one
 * final look at the page. Only trailing drafts may claim it: an earlier step
 * did not land on whatever the user happens to be looking at when they stop.
 */
export async function settleUnsettledDrafts(
  obs: RecordingObservationState,
  cdp: CdpRunner,
  tabId: number,
  tabsApi: ChromeTabsApi,
  steps: DraftTraceStep[],
): Promise<void> {
  const trailing: DraftTraceStep[] = [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const draft = steps[i];
    if (!draft || draft.postStateId) break;
    trailing.push(draft);
  }
  if (trailing.length === 0) return;

  let settled: LastSettledObservation;
  try {
    settled = await captureWithRetry(obs, cdp, tabId, tabsApi);
  } catch (err) {
    console.warn("[bsk record] final observation at stop failed", err);
    return;
  }
  for (const draft of trailing) draft.postStateId = settled.stateId;
  console.debug(
    `[bsk record] settled ${trailing.length} trailing step(s) against the page at stop ` +
      `(${settled.stateId} ${settled.url})`,
  );
}

/**
 * Performing a new action ends the previous one: the page the user reached for
 * is, by definition, where the earlier step left them. Taking the landing from
 * the newer step also keeps the trace monotonic — a capture that finished late
 * would otherwise credit an earlier step with a page that only exists because
 * of the newer action.
 */
function supersedeEarlierSettles(
  obs: RecordingObservationState,
  draftIndex: number,
  steps: DraftTraceStep[],
): void {
  const landing = steps[draftIndex]?.preStateId;
  for (const [index, pending] of obs.settles) {
    if (index >= draftIndex) continue;
    pending.cancelled = true;
    obs.settles.delete(index);

    const draft = steps[index];
    if (!draft || draft.postStateId) continue;
    if (!landing) continue;
    draft.postStateId = landing;
    console.debug(
      `[bsk record] step ${index + 1} (${draft.op}) was still settling when step ` +
        `${draftIndex + 1} started; landing it on ${landing}`,
    );
  }
}

export function scheduleDraftSettle(
  obs: RecordingObservationState,
  draftIndex: number,
  stepId: number,
  cdp: CdpRunner,
  tabId: number,
  tabsApi: ChromeTabsApi,
  steps: DraftTraceStep[],
): void {
  supersedeEarlierSettles(obs, draftIndex, steps);

  // Rescheduling the same step (a navigation showed up after the action)
  // replaces the pending observation rather than racing it.
  const superseded = obs.settles.get(draftIndex);
  if (superseded) superseded.cancelled = true;

  const pending: PendingSettle = { draftIndex, cancelled: false };
  obs.settles.set(draftIndex, pending);

  enqueueSettle(obs, async () => {
    if (pending.cancelled) return;
    try {
      await settleDraftObservation(obs, cdp, tabId, tabsApi, steps, draftIndex, pending);
    } catch (err) {
      // Recoverable: stop-time repair still gives the step a landing page.
      const op = steps[draftIndex]?.op ?? "?";
      console.warn(`[bsk record] post-action observation failed for step ${stepId} (${op})`, err);
    } finally {
      if (obs.settles.get(draftIndex) === pending) obs.settles.delete(draftIndex);
    }
  });
}

function enqueueSettle(obs: RecordingObservationState, task: () => Promise<void>): void {
  obs.settleQueue = obs.settleQueue.then(task, task).catch(() => {});
}

export function cancelPendingSettles(obs: RecordingObservationState): void {
  for (const pending of obs.settles.values()) pending.cancelled = true;
  obs.settles.clear();
}

/** Bound the drain loop so a self-rescheduling settle cannot block stop. */
const MAX_SETTLE_FLUSH_ROUNDS = 10;

/**
 * Drain settle work before exporting, including work queued while draining —
 * a navigation observed during the last capture schedules another one, and
 * the trace would drop it if stop did not wait.
 */
export async function flushPendingSettles(obs: RecordingObservationState): Promise<void> {
  for (let round = 0; round < MAX_SETTLE_FLUSH_ROUNDS; round += 1) {
    const drained = obs.settleQueue;
    await drained;
    if (obs.settleQueue === drained) return;
  }
  console.warn("[bsk record] settle queue kept growing at stop; exporting what has been observed");
}

function finalizeStateBodies(
  entries: StateRegistryEntry[],
  annotationsByState: Map<string, ObservationAnnotation[]>,
  stepIdByDraftId: Map<number, number>,
  idByOldId: Map<string, string>,
): TraceState[] {
  return entries.map((entry) => {
    const id = idByOldId.get(entry.id) ?? entry.id;
    const body = formatObservationFile({
      stateId: id,
      url: entry.url,
      title: entry.title,
      stepsHere: remapStepIds(entry.stepsHere, stepIdByDraftId),
      body: entry.rawVomText,
      annotations: annotationsByState.get(entry.id) ?? [],
    });
    return {
      id,
      url: entry.url,
      ...(entry.title ? { title: entry.title } : {}),
      body,
      ...(entry.truncated ? { truncated: true } : {}),
    };
  });
}

/** Draft ids only become step ids after collapsing and filtering. */
function remapStepIds(draftIds: number[], stepIdByDraftId: Map<number, number>): number[] {
  const mapped = new Set<number>();
  for (const draftId of draftIds) {
    const stepId = stepIdByDraftId.get(draftId);
    if (stepId !== undefined) mapped.add(stepId);
  }
  return [...mapped].sort((a, b) => a - b);
}

function collectAnnotationsByState(
  obs: RecordingObservationState,
  stepIdByDraftId: Map<number, number>,
): Map<string, ObservationAnnotation[]> {
  const byState = new Map<string, ObservationAnnotation[]>();
  for (const anns of obs.stepAnnotations.values()) {
    for (const ann of anns) {
      const stepId = stepIdByDraftId.get(ann.stepId);
      if (stepId === undefined) continue;
      const bucket = byState.get(ann.stateId) ?? [];
      bucket.push({ ...ann, stepId });
      byState.set(ann.stateId, bucket);
    }
  }
  return byState;
}

/**
 * Keep only the pages the published steps point at. Redirect hops and
 * mid-load captures land in the registry too, and shipping them would invite
 * a reader to treat a page the flow merely passed through as a real stop.
 * With no steps at all the first observation is the whole artifact, so it
 * stays.
 */
function selectPublishedStates(
  registry: Map<string, StateRegistryEntry>,
  steps: Step[],
): StateRegistryEntry[] {
  const entries = [...registry.values()];
  if (steps.length === 0) return entries.slice(0, 1);
  const referenced = new Set<string>();
  for (const step of steps) {
    referenced.add(step.state);
    referenced.add(step.result.state);
  }
  return entries.filter((entry) => referenced.has(entry.id));
}

export function buildTraceV3(input: {
  obs: RecordingObservationState;
  steps: DraftTraceStep[];
  startedAt: string;
  purpose?: string;
  startUrl?: string;
  stoppedBy: StopReason;
  bskVersion: string;
}): Trace {
  const { steps, stepIdByDraftId } = reduceTraceSteps(input.steps, input.obs.stateRegistry);
  const published = selectPublishedStates(input.obs.stateRegistry, steps);
  // Renumber so the shipped dictionary reads s1..sN without holes where the
  // dropped captures used to be.
  const idByOldId = new Map(published.map((entry, index) => [entry.id, `s${index + 1}`]));
  for (const step of steps) {
    step.state = idByOldId.get(step.state) ?? step.state;
    step.result.state = idByOldId.get(step.result.state) ?? step.result.state;
  }
  const annotationsByState = collectAnnotationsByState(input.obs, stepIdByDraftId);
  const states = finalizeStateBodies(published, annotationsByState, stepIdByDraftId, idByOldId);
  const startUrl = resolveTraceStartUrl(input.steps, input.startUrl, states);
  return {
    version: 3,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    recorded_at: new Date().toISOString(),
    started_at: input.startedAt,
    stopped_by: input.stoppedBy,
    entry: { start_url: startUrl },
    recorder: { bsk: input.bskVersion, vom: 1 },
    states,
    steps,
  };
}
