import { CdpReadTimeoutError } from "@/browser-driver/command-deadline";
import {
  type FrameDocumentGraph,
  type FrameDocumentInfo,
  type FrameProcessBoundary,
  frameProcessBoundary,
  frameProcessIdentityKey,
  omitFrameDocumentSubtrees,
  rootProcessBoundary,
  toFrameDocumentHandle,
  type UnavailableFrameDocument,
} from "@/browser-driver/frame-handles";
import { cssViewport, GeometryContext } from "../geometry/frame-context";
import { type CdpRunner, cdpRunnerForFrame } from "../shared";
import { collectOverlayExcludedBackendIds } from "./capture";
import {
  isCaptureTerminalError as isCaptureAbort,
  throwIfAborted as throwCaptureAborted,
} from "./capture-abort";
import { verifyDocumentIdentity } from "./document-identity";
import type { CapturedSceneInput, DocumentIdentity } from "./facts";
import { buildDocumentIndex, type CaptureIssue, type ObservationFacts } from "./facts";
import { enrichFormControlStates } from "./form-capture";
import {
  buildFrameDocuments,
  type FrameAxBatch,
  type FrameDocument,
  type FrameOwnedAxNode,
} from "./frame-document";
import {
  finalizeDocumentHiddenExclusions,
  type PreparedFrameDocument,
  prepareSnapshot,
  projectSnapshot,
} from "./normalize";
import {
  BASIC_SNAPSHOT,
  describeSnapshotFrames,
  type SnapshotReply,
  VISUAL_SNAPSHOT,
} from "./snapshot";

interface TargetBatch<T extends FrameOwnedAxNode> {
  process: FrameProcessBoundary;
  frames: FrameDocumentInfo[];
  snapshotAttachmentId?: string;
  documents: PreparedFrameDocument[];
  ax: FrameAxBatch<T>[];
  fallbackExcluded: Set<number>;
  snapshotFrameIds?: Set<string>;
  rootFrameId?: string;
}

/**
 * Stable message for an observation whose root document identity could
 * not be (re)verified. `observation.ts` matches on this marker to detect
 * the anti-debugging reload loop, where a site reloads itself as soon
 * as the debugger attaches (GitHub issues #454 and #465).
 */
export const OBSERVE_IDENTITY_CHANGED =
  "observation document identity changed or could not be verified; observe again";

/** A fixed worker pool scoped to one capture; each worker issues at most one
 * collection request at a time. Geometry has its own measurement-phase bound. */
async function collectTasks<T>(
  items: readonly T[],
  collect: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      try {
        while (cursor < items.length && !failed && !signal?.aborted) {
          const item = items[cursor++];
          await collect(item);
        }
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }),
  );
  // A worker's rejection must not let the capture outlive its own task scope.
  // In-flight reads and their finally blocks settle before cancellation/failure.
  throwCaptureAborted(signal);
  if (failed) throw failure;
}

export const ACCESSIBILITY_LEASE_TTL_MS = 10_000;

interface LeasedAccessibilityTarget {
  process: FrameProcessBoundary;
  attachmentId: string;
  needsEnable: boolean;
}

const leasesByTab = new Map<number, Set<AccessibilityLease>>();

function registerTabLease(tabId: number, lease: AccessibilityLease): void {
  let set = leasesByTab.get(tabId);
  if (!set) {
    set = new Set();
    leasesByTab.set(tabId, set);
  }
  set.add(lease);
}

function unregisterTabLease(tabId: number, lease: AccessibilityLease): void {
  const set = leasesByTab.get(tabId);
  if (!set) return;
  set.delete(lease);
  if (set.size === 0) leasesByTab.delete(tabId);
}

function isProcessLeased(
  tabId: number,
  process: FrameProcessBoundary,
  attachmentId: string,
): boolean {
  const set = leasesByTab.get(tabId);
  if (!set) return false;
  for (const lease of set) {
    if (lease.holdsAttachment(process, attachmentId)) return true;
  }
  return false;
}

/**
 * Sliding idle lease for `Accessibility.enable` across back-to-back cooperative
 * captures on the same tab/attachment. Avoids tearing down and rebuilding
 * Blink's full renderer AX tree on every sync/verify cycle while still
 * disabling the domain after idle expiry, session stop, tab release, or error.
 */
export class AccessibilityLease {
  private readonly entries = new Map<string, LeasedAccessibilityTarget>();
  private cdp?: CdpRunner;
  private timer?: ReturnType<typeof setTimeout>;
  private activeUsers = 0;
  private disposed = false;

  constructor(
    readonly tabId: number,
    private readonly ttlMs = ACCESSIBILITY_LEASE_TTL_MS,
  ) {}

  hasActive(process: FrameProcessBoundary, attachmentId: string | undefined): boolean {
    if (this.disposed || attachmentId === undefined) return false;
    const entry = this.entries.get(frameProcessIdentityKey(process));
    return entry !== undefined && entry.attachmentId === attachmentId && !entry.needsEnable;
  }

  holdsAttachment(process: FrameProcessBoundary, attachmentId: string): boolean {
    if (this.disposed) return false;
    const entry = this.entries.get(frameProcessIdentityKey(process));
    return entry !== undefined && entry.attachmentId === attachmentId;
  }

  beginUse(): void {
    this.activeUsers++;
    this.clearTimer();
  }

  endUse(): void {
    if (this.activeUsers > 0) this.activeUsers--;
    this.syncState();
  }

  markNeedsEnable(): void {
    for (const entry of this.entries.values()) {
      entry.needsEnable = true;
    }
  }

  forgetTimedOut(error: CdpReadTimeoutError): void {
    if (error.tabId !== this.tabId) return;
    for (const [key, entry] of this.entries) {
      if (
        !error.processKey ||
        error.processKey === "root" ||
        entry.process.processKey === error.processKey
      ) {
        this.entries.delete(key);
      }
    }
    this.syncState();
  }

  retain(
    cdp: CdpRunner,
    enabled: ReadonlyMap<FrameProcessBoundary, string | undefined>,
  ): Map<FrameProcessBoundary, string | undefined> {
    const unretained = new Map<FrameProcessBoundary, string | undefined>();
    if (this.disposed) {
      for (const [process, attachmentId] of enabled) unretained.set(process, attachmentId);
      return unretained;
    }
    const currentAttachmentId = cdp.getAttachmentId(this.tabId);
    for (const [key, entry] of this.entries) {
      if (entry.attachmentId !== currentAttachmentId) {
        this.entries.delete(key);
        unretained.set(entry.process, entry.attachmentId);
      }
    }
    for (const [process, attachmentId] of enabled) {
      if (attachmentId !== undefined && attachmentId === currentAttachmentId) {
        this.entries.set(frameProcessIdentityKey(process), {
          process,
          attachmentId,
          needsEnable: false,
        });
      } else {
        unretained.set(process, attachmentId);
      }
    }
    this.cdp = cdp;
    this.syncState();
    return unretained;
  }

  takeEntries(): Map<FrameProcessBoundary, string | undefined> {
    this.clearTimer();
    unregisterTabLease(this.tabId, this);
    const drained = new Map<FrameProcessBoundary, string | undefined>();
    for (const entry of this.entries.values()) {
      drained.set(entry.process, entry.attachmentId);
    }
    this.entries.clear();
    return drained;
  }

  async release(cdpOverride?: CdpRunner): Promise<void> {
    const runner = cdpOverride ?? this.cdp;
    const drained = this.takeEntries();
    if (drained.size > 0 && runner) {
      await releaseAccessibility(runner, this.tabId, drained);
    }
  }

  async dispose(cdpOverride?: CdpRunner): Promise<void> {
    this.disposed = true;
    await this.release(cdpOverride);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private syncState(): void {
    this.clearTimer();
    if (this.disposed || this.entries.size === 0 || !this.cdp) {
      unregisterTabLease(this.tabId, this);
      return;
    }
    registerTabLease(this.tabId, this);
    if (this.activeUsers > 0) return;
    const runner = this.cdp;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const drained = this.takeEntries();
      if (drained.size > 0) {
        void releaseAccessibility(runner, this.tabId, drained);
      }
    }, this.ttlMs);
    (this.timer as { unref?: () => void }).unref?.();
  }
}

/** `Accessibility.enable` keeps the renderer's accessibility tree live, updated
 * and reported on every page change, until the domain is disabled again. A
 * capture needs it only for its own reads, so each target that enabled it
 * disables it again under the same worker bound. Like other cleanup, this
 * never reconnects a replaced attachment, and nothing is queued behind a read
 * still running past its deadline. The driver's cleanup deadline also bounds
 * a disable command if the renderer stops responding after the AX reads. */
async function releaseAccessibility(
  cdp: CdpRunner,
  tabId: number,
  enabled: ReadonlyMap<FrameProcessBoundary, string | undefined>,
): Promise<void> {
  await collectTasks([...enabled], async ([process, attachmentId]) => {
    // A detach already disabled every domain of that attachment.
    if (cdp.getAttachmentId(tabId) !== attachmentId) return;
    if (attachmentId !== undefined && isProcessLeased(tabId, process, attachmentId)) return;
    await cdp
      .sendToFrame(
        process.rootHandle,
        "Accessibility.disable",
        {},
        {
          ...(attachmentId !== undefined ? { attachmentId } : {}),
          allowReattach: false,
          ignoreFrameNavigation: true,
        },
      )
      .catch(() => {});
  });
}

/** Never queue cleanup behind a timed-out read. A pending root command gates
 * every frame on the tab; a child command gates only its original target. */
function forgetPendingAccessibility(
  tabId: number,
  enabled: Map<FrameProcessBoundary, string | undefined>,
  error: unknown,
): void {
  if (!(error instanceof CdpReadTimeoutError)) return;
  for (const process of enabled.keys()) {
    if (
      !error.processKey ||
      error.processKey === "root" ||
      process.processKey === error.processKey
    ) {
      enabled.delete(process);
    }
  }
  const leases = leasesByTab.get(tabId);
  if (leases) {
    for (const lease of [...leases]) lease.forgetTimedOut(error);
  }
}

export function captureObservationFacts<T extends FrameOwnedAxNode>(
  cdp: CdpRunner,
  tabId: number,
  signal?: AbortSignal,
  pageUrl?: string,
  options: { includeVisualFacts?: boolean; accessibilityLease?: AccessibilityLease } = {},
): Promise<ObservationFacts<T>> {
  return withObservationFacts(
    cdp,
    tabId,
    (facts: ObservationFacts<T>) => facts,
    signal,
    pageUrl,
    options,
  );
}

/** Keep Accessibility enabled through the consumer's remaining reads, including
 * hover probes. Cleanup can close the read gate until Chrome replies, so it
 * must follow the entire observation, even when the consumer fails or aborts. */
export async function withObservationFacts<T extends FrameOwnedAxNode, R>(
  cdp: CdpRunner,
  tabId: number,
  consume: (facts: ObservationFacts<T>) => R | Promise<R>,
  signal?: AbortSignal,
  pageUrl?: string,
  options: { includeVisualFacts?: boolean; accessibilityLease?: AccessibilityLease } = {},
): Promise<R> {
  const axEnabled = new Map<FrameProcessBoundary, string | undefined>();
  const lease = options.accessibilityLease;
  lease?.beginUse();
  let toRelease = axEnabled;
  let result: R;
  try {
    const facts = await collectObservationFacts<T>(cdp, tabId, axEnabled, signal, pageUrl, options);
    throwCaptureAborted(signal);
    result = await consume(facts);
    throwCaptureAborted(signal);
    if (lease) {
      toRelease = lease.retain(cdp, axEnabled);
    }
  } catch (error) {
    forgetPendingAccessibility(tabId, axEnabled, error);
    if (lease) {
      const seenKeys = new Set([...axEnabled.keys()].map(frameProcessIdentityKey));
      for (const [process, attachmentId] of lease.takeEntries()) {
        if (!seenKeys.has(frameProcessIdentityKey(process))) {
          axEnabled.set(process, attachmentId);
        }
      }
    }
    throw error;
  } finally {
    lease?.endUse();
    if (toRelease.size > 0) {
      await releaseAccessibility(cdp, tabId, toRelease);
    }
  }
  if (signal?.aborted && lease) {
    await lease.release(cdp);
  }
  throwCaptureAborted(signal);
  return result;
}

async function collectObservationFacts<T extends FrameOwnedAxNode>(
  cdp: CdpRunner,
  tabId: number,
  axEnabled: Map<FrameProcessBoundary, string | undefined>,
  signal: AbortSignal | undefined,
  pageUrl: string | undefined,
  options: { includeVisualFacts?: boolean; accessibilityLease?: AccessibilityLease },
): Promise<ObservationFacts<T>> {
  const profile = options.includeVisualFacts ? VISUAL_SNAPSHOT : BASIC_SNAPSHOT;
  const startedAt = Date.now();
  throwCaptureAborted(signal);
  let graph: FrameDocumentGraph | undefined;
  try {
    graph = await cdp.getFrameDocuments(tabId, signal);
  } catch (error) {
    forgetPendingAccessibility(tabId, axEnabled, error);
    if (isCaptureAbort(error)) throw error;
  }
  throwCaptureAborted(signal);
  const geometry = new GeometryContext(cdp, tabId, graph, signal);
  const issues: CaptureIssue[] = (graph?.unavailableFrames ?? []).map((frame) => ({
    tabId,
    processKey: frame.processKey,
    frameId: frame.frameId,
    stage: "dom",
    reason: "capture-unavailable",
  }));
  const unavailableFrameIds = new Set(graph?.unavailableFrames?.map((frame) => frame.frameId));
  const graphFrames = new Map(graph?.frames.map((frame) => [frame.frameId, frame]) ?? []);
  const groups = new Map<string, TargetBatch<T>>();
  for (const frame of graph?.frames ?? []) {
    const process = frameProcessBoundary(frame);
    const key = frameProcessIdentityKey(process);
    const isTargetRoot =
      !frame.parentFrameId || graphFrames.get(frame.parentFrameId)?.processKey !== frame.processKey;
    let group = groups.get(key);
    if (!group) {
      group = {
        process,
        frames: [],
        documents: [],
        ax: [],
        fallbackExcluded: new Set(),
      };
      groups.set(key, group);
    } else if (process.isOutOfProcess && isTargetRoot) {
      group.process = process;
    }
    group.frames.push(
      !frame.isOutOfProcess && frame.frameId === graph?.rootFrameId && !frame.url && pageUrl
        ? { ...frame, url: pageUrl }
        : frame,
    );
  }
  const rootProcess = rootProcessBoundary(tabId);
  if (!groups.has(frameProcessIdentityKey(rootProcess))) {
    groups.set(frameProcessIdentityKey(rootProcess), {
      process: rootProcess,
      frames: [],
      documents: [],
      ax: [],
      fallbackExcluded: new Set(),
    });
  }
  const batches = [...groups.values()];
  const unavailable = (batch: TargetBatch<T>, stage: CaptureIssue["stage"], frameId?: string) =>
    issues.push({
      tabId: batch.process.tabId,
      processKey: batch.process.processKey,
      frameId,
      stage,
      reason: "capture-unavailable",
    });
  let firstFailure: unknown;
  const stopped = new Set<TargetBatch<T>>();
  const isolateChildTimeout = (error: unknown, batch: TargetBatch<T>): boolean => {
    if (
      !(error instanceof CdpReadTimeoutError) ||
      !batch.process.isOutOfProcess ||
      !error.processKey ||
      error.processKey === "root" ||
      error.tabId !== tabId
    )
      return false;
    const failed = batches.find((item) => item.process.processKey === error.processKey);
    if (!failed) return false;
    // Projection of a nested OOPIF can fail in an ancestor's session. Omit
    // that dependency subtree as well, without turning it into a root failure.
    const omitted = omitFrameDocumentSubtrees(
      { rootFrameId: graph?.rootFrameId ?? "root", frames: batches.flatMap((item) => item.frames) },
      new Map<string, UnavailableFrameDocument>(
        [...failed.frames, ...batch.frames].map((frame) => [
          frame.frameId,
          {
            frameId: frame.frameId,
            ...(frame.parentFrameId ? { parentFrameId: frame.parentFrameId } : {}),
            ...(frame.url ? { url: frame.url } : {}),
            processKey: frame.processKey,
            isOutOfProcess: frame.isOutOfProcess,
          },
        ]),
      ),
    );
    for (const frame of omitted.unavailableFrames ?? []) unavailableFrameIds.add(frame.frameId);
    for (const item of batches) {
      if (!item.process.isOutOfProcess) continue;
      if (item !== batch && !item.frames.some((frame) => unavailableFrameIds.has(frame.frameId)))
        continue;
      if (!stopped.has(item)) unavailable(item, "dom");
      stopped.add(item);
    }
    return true;
  };
  await collectTasks(
    batches,
    async (batch) => {
      if (stopped.has(batch)) return;
      const scoped = cdpRunnerForFrame(cdp, batch.process.rootHandle, {
        ignoreFrameNavigation: true,
        signal,
      });
      try {
        throwCaptureAborted(signal);
        await scoped.send(tabId, "DOMSnapshot.enable", {});
        throwCaptureAborted(signal);
        batch.snapshotAttachmentId = cdp.getAttachmentId(tabId);
        const snapshot = await scoped.send<SnapshotReply>(tabId, "DOMSnapshot.captureSnapshot", {
          computedStyles: profile.computedStyles,
          includePaintOrder: true,
          includeDOMRects: true,
        });
        throwCaptureAborted(signal);
        const observed = describeSnapshotFrames(snapshot, batch.process, graphFrames, pageUrl);
        batch.snapshotFrameIds = new Set(
          [...observed.ids].filter((id) => !unavailableFrameIds.has(id)),
        );
        batch.rootFrameId = observed.rootFrameId;
        // Keep graph-only frames for AX fallback, never in preference to observed membership.
        batch.frames = [
          ...observed.frames.filter((frame) => !unavailableFrameIds.has(frame.frameId)),
          ...batch.frames.filter((frame) => !observed.ids.has(frame.frameId)),
        ];
        batch.documents = await prepareSnapshot(
          snapshot,
          batch.process,
          batch.frames.filter((frame) => observed.ids.has(frame.frameId)),
          issues,
          signal,
          profile,
        );
        const formsAvailable = await enrichFormControlStates(
          scoped,
          tabId,
          batch.documents.map((doc) => doc.nodes),
          signal,
        );
        throwCaptureAborted(signal);
        if (!formsAvailable) unavailable(batch, "forms");
        const present = new Set(batch.documents.map((doc) => doc.frame.frameId));
        for (const frame of batch.frames)
          if (!present.has(frame.frameId)) unavailable(batch, "dom", frame.frameId);
      } catch (error) {
        forgetPendingAccessibility(tabId, axEnabled, error);
        throwCaptureAborted(signal);
        if (isolateChildTimeout(error, batch)) return;
        if (isCaptureAbort(error)) throw error;
        firstFailure ??= error;
        unavailable(batch, "dom");
        batch.fallbackExcluded = await collectOverlayExcludedBackendIds(scoped, tabId, signal);
      }
      if (stopped.has(batch)) return;
      if (!batch.frames.length && !graph?.frames.length) {
        batch.frames = [
          {
            handle: toFrameDocumentHandle(tabId, { frameId: "root", loaderId: "" }),
            frameId: "root",
            loaderId: "",
            processKey: batch.process.processKey,
            isOutOfProcess: batch.process.isOutOfProcess,
            ...(!batch.process.isOutOfProcess && pageUrl ? { url: pageUrl } : {}),
          },
        ];
      }
      try {
        throwCaptureAborted(signal);
        const currentAttachmentId = cdp.getAttachmentId(tabId);
        if (!options.accessibilityLease?.hasActive(batch.process, currentAttachmentId)) {
          await scoped.send(tabId, "Accessibility.enable", {});
        }
      } catch (error) {
        forgetPendingAccessibility(tabId, axEnabled, error);
        throwCaptureAborted(signal);
        if (isolateChildTimeout(error, batch)) return;
        if (isCaptureAbort(error)) throw error;
        firstFailure ??= error;
        unavailable(batch, "ax");
        return;
      }
      axEnabled.set(batch.process, cdp.getAttachmentId(tabId));
    },
    signal,
  );

  // Schedule AX by frame across all ready targets, rather than nesting pools.
  // Keep result slots in source order even when CDP replies arrive out of order.
  const axTasks: { batch: TargetBatch<T>; frame: FrameDocumentInfo; result?: FrameAxBatch<T> }[] =
    batches.flatMap((batch) =>
      axEnabled.has(batch.process) ? batch.frames.map((frame) => ({ batch, frame })) : [],
    );
  await collectTasks(
    axTasks,
    async (task) => {
      const { batch, frame } = task;
      if (stopped.has(batch)) return;
      try {
        throwCaptureAborted(signal);
        const result = await cdp.sendToFrame<{ nodes?: T[] }>(
          batch.process.rootHandle,
          "Accessibility.getFullAXTree",
          frame.frameId === "root" ? {} : { frameId: frame.frameId },
          { ignoreFrameNavigation: true, signal },
        );
        throwCaptureAborted(signal);
        task.result = { frame, nodes: result.nodes ?? [] };
      } catch (error) {
        forgetPendingAccessibility(tabId, axEnabled, error);
        // Chrome may still be running this read; queue no cleanup behind it.
        throwCaptureAborted(signal);
        if (isolateChildTimeout(error, batch)) return;
        if (isCaptureAbort(error)) throw error;
        firstFailure ??= error;
        unavailable(batch, "ax", frame.frameId);
      }
    },
    signal,
  );
  for (const task of axTasks) if (task.result) task.batch.ax.push(task.result);

  // A snapshot claim outranks an old graph hint. Conflicting actual claims
  // cannot be resolved by completion order or by overwriting a frameId map.
  const claims = new Map<string, string>();
  const invalid = new Set(unavailableFrameIds);
  for (const batch of batches) {
    const processIdentity = frameProcessIdentityKey(batch.process);
    for (const id of batch.snapshotFrameIds ?? []) {
      const previous = claims.get(id);
      if (previous !== undefined && previous !== processIdentity) invalid.add(id);
      claims.set(id, processIdentity);
    }
    const accepted = new Set(batch.frames.map((frame) => frame.frameId));
    for (const id of batch.snapshotFrameIds ?? []) if (!accepted.has(id)) invalid.add(id);
  }
  const currentFrames = batches.flatMap((batch) =>
    batch.frames.filter(
      (frame) =>
        !claims.has(frame.frameId) ||
        claims.get(frame.frameId) === frameProcessIdentityKey(batch.process),
    ),
  );
  const rootBatch = batches.find((batch) => !batch.process.isOutOfProcess);
  const rootFrameId =
    rootBatch?.rootFrameId || graph?.rootFrameId || rootBatch?.frames[0]?.frameId || "root";
  const ownershipInvalid = new Set(invalid);
  const identities = new Map<string, DocumentIdentity>();
  const selected = new Map(currentFrames.map((frame) => [frame.frameId, frame]));
  const checks = batches.flatMap((batch) => {
    const docs = new Map(batch.documents.map((doc) => [doc.frame.frameId, doc]));
    return batch.frames
      .filter((frame) => {
        const chosen = selected.get(frame.frameId);
        return (
          !invalid.has(frame.frameId) &&
          chosen !== undefined &&
          frameProcessIdentityKey({ tabId: chosen.handle.tabId, processKey: chosen.processKey }) ===
            frameProcessIdentityKey(batch.process)
        );
      })
      .map((frame) => ({ batch, frame, doc: docs.get(frame.frameId) }));
  });
  const checkIdentities = (recheck = false) =>
    collectTasks(
      checks,
      async ({ batch, frame, doc }) => {
        throwCaptureAborted(signal);
        if (
          stopped.has(batch) ||
          invalid.has(frame.frameId) ||
          (recheck && !identities.has(frame.frameId))
        )
          return;
        if (!batch.snapshotAttachmentId || doc?.documentElementBackendNodeId === undefined) {
          issues.push({
            tabId: frame.handle.tabId,
            processKey: frame.processKey,
            frameId: frame.frameId,
            stage: "identity",
            reason: "identity-unverified",
          });
          return;
        }
        const identity: DocumentIdentity = {
          attachmentId: batch.snapshotAttachmentId,
          tabId: frame.handle.tabId,
          frameId: frame.frameId,
          loaderId: frame.loaderId ?? "",
          documentElementBackendNodeId: doc.documentElementBackendNodeId,
        };
        let verified: Awaited<ReturnType<typeof verifyDocumentIdentity>>;
        try {
          verified = await verifyDocumentIdentity(cdp, identity, signal);
        } catch (error) {
          forgetPendingAccessibility(tabId, axEnabled, error);
          throwCaptureAborted(signal);
          if (!isolateChildTimeout(error, batch)) throw error;
          for (const id of unavailableFrameIds) invalid.add(id);
          return;
        }
        const status = cdp.getAttachmentId(tabId) === identity.attachmentId ? verified : "changed";
        if (status === "current") {
          cdp.recordFrameDocumentElement(
            tabId,
            frame.frameId,
            identity.loaderId,
            identity.documentElementBackendNodeId,
          );
          identities.set(frame.frameId, identity);
        } else {
          invalid.add(frame.frameId);
          issues.push({
            tabId: frame.handle.tabId,
            processKey: frame.processKey,
            frameId: frame.frameId,
            stage: "identity",
            reason: status === "changed" ? "document-changed" : "identity-unavailable",
          });
        }
      },
      signal,
    );
  await checkIdentities();
  let viewport = { width: 0, height: 0 };
  let layoutTimedOut = false;
  if (!invalid.has(rootFrameId)) {
    try {
      const measured = cssViewport(await geometry.layoutMetrics(rootProcessBoundary(tabId)));
      viewport = { width: measured.width, height: measured.height };
    } catch (error) {
      forgetPendingAccessibility(tabId, axEnabled, error);
      throwCaptureAborted(signal);
      if (error instanceof CdpReadTimeoutError) layoutTimedOut = true;
      else if (isCaptureAbort(error)) throw error;
    }
    if (layoutTimedOut) {
      // All required reads and identity checks have completed. Keep their
      // results, report missing geometry, and issue no reads behind the gate.
      for (const frame of currentFrames)
        if (!invalid.has(frame.frameId))
          issues.push({
            tabId: frame.handle.tabId,
            processKey: frame.processKey,
            frameId: frame.frameId,
            stage: "geometry",
            reason: "geometry-unavailable",
          });
    } else {
      await collectTasks(
        batches,
        async (batch) => {
          if (stopped.has(batch)) return;
          try {
            await projectSnapshot(
              batch.documents,
              batch.process,
              batch.frames.filter((frame) => !invalid.has(frame.frameId)),
              geometry,
              issues,
              signal,
              batch.rootFrameId,
              profile,
            );
          } catch (error) {
            forgetPendingAccessibility(tabId, axEnabled, error);
            throwCaptureAborted(signal);
            if (!isolateChildTimeout(error, batch)) throw error;
          }
        },
        signal,
      );
      for (const id of unavailableFrameIds) invalid.add(id);
      // Preserve the existing post-geometry check on successful reads. Only a
      // timed-out optional root layout uses the earlier, captured identity.
      await checkIdentities(true);
    }
  }
  // Reattachment during optional layout work invalidates even an earlier
  // successful identity proof. This check requires no renderer command.
  for (const [frameId, identity] of identities) {
    if (cdp.getAttachmentId(tabId) !== identity.attachmentId) {
      invalid.add(frameId);
      const selectedFrame = selected.get(frameId);
      issues.push({
        tabId,
        processKey: selectedFrame?.processKey ?? "root",
        frameId,
        stage: "identity",
        reason: "document-changed",
      });
    }
  }
  const children = new Map<string, string[]>();
  for (const frame of currentFrames) {
    if (!frame.parentFrameId) continue;
    const siblings = children.get(frame.parentFrameId);
    if (siblings) siblings.push(frame.frameId);
    else children.set(frame.parentFrameId, [frame.frameId]);
  }
  const blocked = [...invalid];
  for (let i = 0; i < blocked.length; i++) {
    for (const child of children.get(blocked[i]) ?? []) {
      if (!invalid.has(child)) {
        invalid.add(child);
        blocked.push(child);
      }
    }
  }
  for (const frame of currentFrames) {
    if (ownershipInvalid.has(frame.frameId))
      issues.push({
        tabId: frame.handle.tabId,
        processKey: frame.processKey,
        frameId: frame.frameId,
        stage: "ownership",
        reason: "frame-ownership-unresolved",
      });
  }
  if (invalid.has(rootFrameId))
    throw new Error(
      ownershipInvalid.has(rootFrameId)
        ? "observation root document ownership is ambiguous"
        : OBSERVE_IDENTITY_CHANGED,
    );
  const frames = currentFrames.filter((frame) => !invalid.has(frame.frameId));
  const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
  const belongs = (frame: FrameDocumentInfo) => {
    const current = frameById.get(frame.frameId);
    return (
      current &&
      frameProcessIdentityKey({ tabId: current.handle.tabId, processKey: current.processKey }) ===
        frameProcessIdentityKey({ tabId: frame.handle.tabId, processKey: frame.processKey })
    );
  };
  const decoded = new Map(
    batches
      .flatMap((batch) => batch.documents)
      .filter((doc) => belongs(doc.frame))
      .map((doc) => [doc.frame.frameId, doc]),
  );
  for (const doc of decoded.values()) finalizeDocumentHiddenExclusions(doc);
  const ax = batches.flatMap((batch) => batch.ax).filter((batch) => belongs(batch.frame));
  const documents = await buildFrameDocuments(
    { rootFrameId, frames },
    ax,
    {
      nodes: [],
      rootFrameId,
      frameNodes: new Map([...decoded].map(([id, doc]) => [id, doc.nodes])),
      frameExcludedBackendNodeIds: new Map(
        [...decoded].map(([id, doc]) => [id, doc.index.excludedBackendNodeIds]),
      ),
    },
    signal,
    (frame) =>
      issues.push({
        tabId: frame.handle.tabId,
        processKey: frame.processKey,
        frameId: frame.frameId,
        stage: "ownership",
        reason: "frame-ownership-unresolved",
      }),
  );
  const facts: ObservationFacts<T>["documents"][number][] = [];
  for (const document of documents) {
    const doc = decoded.get(document.frameId);
    const index = doc?.index ?? (await buildDocumentIndex([], signal));
    const fallback = groups.get(
      frameProcessIdentityKey({ tabId: document.handle.tabId, processKey: document.processKey }),
    )?.fallbackExcluded;
    const {
      domNodes,
      axNodes,
      contextScopeId: _scope,
      excludedBackendNodeIds: _excluded,
      ...frame
    } = document;
    facts.push({
      frame,
      identity: identities.get(document.frameId),
      ...(doc?.geometry ? { geometry: doc.geometry } : {}),
      index: fallback?.size ? { ...index, excludedBackendNodeIds: fallback } : index,
      domNodes,
      axNodes,
    });
  }
  throwCaptureAborted(signal);
  if (firstFailure && facts.every((doc) => !doc.domNodes.length && !doc.axNodes.length))
    throw firstFailure;
  return {
    visualFactsCollected: profile.includeVisualFacts,
    rootFrameId,
    viewport,
    documents: facts,
    issues,
    startedAt,
    finishedAt: Date.now(),
  };
}

/** Existing semantic consumers get a narrow view; no raw snapshot
 * data can leak through recording's allowlisted output DTO. */
export function semanticCapture<T extends FrameOwnedAxNode>(
  facts: ObservationFacts<T>,
): { captured: CapturedSceneInput; documents: FrameDocument<T>[] } {
  const documents = facts.documents.map((doc) => ({
    ...doc.frame,
    contextScopeId: doc.frame.frameId,
    domNodes: doc.domNodes.filter(
      (node) => !doc.index.excludedBackendNodeIds.has(node.backendNodeId),
    ),
    axNodes: doc.axNodes,
    excludedBackendNodeIds: doc.index.excludedBackendNodeIds,
  }));
  const root = documents.find((doc) => doc.frameId === facts.rootFrameId);
  return {
    documents,
    captured: {
      nodes: root?.domNodes ?? [],
      viewport: facts.viewport,
      rootFrameId: facts.rootFrameId,
      excludedBackendNodeIds: root?.excludedBackendNodeIds ?? new Set(),
    },
  };
}
