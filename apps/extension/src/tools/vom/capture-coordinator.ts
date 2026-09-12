import {
  type CdpFrame,
  type CdpFrameGraph,
  type CdpTarget,
  cdpTargetKey,
} from "@/browser-driver/frame-graph";
import { cssViewport, GeometryContext } from "../geometry/frame-context";
import { type CdpRunner, cdpRunnerForTarget } from "../shared";
import { collectOverlayExcludedBackendIds } from "./capture";
import {
  isAbortError as isCaptureAbort,
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
import { type NormalizedFrameDocument, normalizeSnapshot } from "./normalize";
import {
  BASIC_SNAPSHOT,
  describeSnapshotFrames,
  type SnapshotReply,
  VISUAL_SNAPSHOT,
} from "./snapshot";

interface TargetBatch<T extends FrameOwnedAxNode> {
  target: CdpTarget;
  frames: CdpFrame[];
  snapshotAttachmentId?: string;
  documents: NormalizedFrameDocument[];
  ax: FrameAxBatch<T>[];
  fallbackExcluded: Set<number>;
  snapshotFrameIds?: Set<string>;
  rootFrameId?: string;
}

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

export async function captureObservationFacts<T extends FrameOwnedAxNode>(
  cdp: CdpRunner,
  tabId: number,
  signal?: AbortSignal,
  pageUrl?: string,
  options: { includeVisualFacts?: boolean } = {},
): Promise<ObservationFacts<T>> {
  const profile = options.includeVisualFacts ? VISUAL_SNAPSHOT : BASIC_SNAPSHOT;
  const startedAt = Date.now();
  throwCaptureAborted(signal);
  let graph: CdpFrameGraph | undefined;
  try {
    graph = await cdp.getFrameGraph?.(tabId);
  } catch (error) {
    if (isCaptureAbort(error)) throw error;
  }
  throwCaptureAborted(signal);
  const geometry = new GeometryContext(cdp, tabId, graph, signal);
  const issues: CaptureIssue[] = [];
  const graphFrames = new Map(graph?.frames.map((frame) => [frame.frameId, frame]) ?? []);
  const groups = new Map<string, TargetBatch<T>>();
  for (const frame of graph?.frames ?? []) {
    const key = cdpTargetKey(frame.target);
    let group = groups.get(key);
    if (!group) {
      group = {
        target: frame.target,
        frames: [],
        documents: [],
        ax: [],
        fallbackExcluded: new Set(),
      };
      groups.set(key, group);
    }
    group.frames.push(
      !frame.target.sessionId && frame.frameId === graph?.rootFrameId && !frame.url && pageUrl
        ? { ...frame, url: pageUrl }
        : frame,
    );
  }
  if (!groups.has(cdpTargetKey({ tabId })))
    groups.set(cdpTargetKey({ tabId }), {
      target: { tabId },
      frames: [],
      documents: [],
      ax: [],
      fallbackExcluded: new Set(),
    });
  const batches = [...groups.values()];
  const unavailable = (batch: TargetBatch<T>, stage: CaptureIssue["stage"], frameId?: string) =>
    issues.push({ target: batch.target, frameId, stage, reason: "capture-unavailable" });
  let firstFailure: unknown;
  const axReady = new Set<TargetBatch<T>>();
  await collectTasks(
    batches,
    async (batch) => {
      const scoped = cdpRunnerForTarget(cdp, batch.target);
      try {
        throwCaptureAborted(signal);
        await scoped.send(tabId, "DOMSnapshot.enable", {});
        throwCaptureAborted(signal);
        batch.snapshotAttachmentId = cdp.getAttachmentId?.(tabId);
        const snapshot = await scoped.send<SnapshotReply>(tabId, "DOMSnapshot.captureSnapshot", {
          computedStyles: profile.computedStyles,
          includePaintOrder: true,
          includeDOMRects: true,
        });
        throwCaptureAborted(signal);
        const observed = describeSnapshotFrames(snapshot, batch.target, graphFrames, pageUrl);
        batch.snapshotFrameIds = observed.ids;
        batch.rootFrameId = observed.rootFrameId;
        // Keep graph-only frames for AX fallback, never in preference to observed membership.
        batch.frames = [
          ...observed.frames,
          ...batch.frames.filter((frame) => !observed.ids.has(frame.frameId)),
        ];
        batch.documents = await normalizeSnapshot(
          snapshot,
          batch.target,
          batch.frames.filter((frame) => observed.ids.has(frame.frameId)),
          geometry,
          issues,
          signal,
          observed.rootFrameId,
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
        throwCaptureAborted(signal);
        if (isCaptureAbort(error)) throw error;
        firstFailure ??= error;
        unavailable(batch, "dom");
        batch.fallbackExcluded = await collectOverlayExcludedBackendIds(scoped, tabId, signal);
      }
      if (!batch.frames.length && !graph)
        batch.frames = [
          {
            frameId: "root",
            target: batch.target,
            ...(!batch.target.sessionId && pageUrl ? { url: pageUrl } : {}),
          },
        ];
      try {
        throwCaptureAborted(signal);
        await scoped.send(tabId, "Accessibility.enable", {});
      } catch (error) {
        throwCaptureAborted(signal);
        if (isCaptureAbort(error)) throw error;
        firstFailure ??= error;
        unavailable(batch, "ax");
        return;
      }
      axReady.add(batch);
    },
    signal,
  );

  // Schedule AX by frame across all ready targets, rather than nesting pools.
  // Keep result slots in source order even when CDP replies arrive out of order.
  const axTasks: { batch: TargetBatch<T>; frame: CdpFrame; result?: FrameAxBatch<T> }[] =
    batches.flatMap((batch) =>
      axReady.has(batch) ? batch.frames.map((frame) => ({ batch, frame })) : [],
    );
  await collectTasks(
    axTasks,
    async (task) => {
      const { batch, frame } = task;
      try {
        throwCaptureAborted(signal);
        const result = await cdpRunnerForTarget(cdp, batch.target).send<{ nodes?: T[] }>(
          tabId,
          "Accessibility.getFullAXTree",
          frame.frameId === "root" ? {} : { frameId: frame.frameId },
        );
        throwCaptureAborted(signal);
        task.result = { frame, nodes: result.nodes ?? [] };
      } catch (error) {
        throwCaptureAborted(signal);
        if (isCaptureAbort(error)) throw error;
        firstFailure ??= error;
        unavailable(batch, "ax", frame.frameId);
      }
    },
    signal,
  );
  for (const task of axTasks) if (task.result) task.batch.ax.push(task.result);

  let viewport = { width: 0, height: 0 };
  try {
    const measured = cssViewport(await geometry.layoutMetrics({ tabId }));
    viewport = { width: measured.width, height: measured.height };
  } catch (error) {
    if (isCaptureAbort(error)) throw error;
  }

  // A snapshot claim outranks an old graph hint. Conflicting actual claims
  // cannot be resolved by completion order or by overwriting a frameId map.
  const claims = new Map<string, string>();
  const invalid = new Set<string>();
  for (const batch of batches) {
    const targetKey = cdpTargetKey(batch.target);
    for (const id of batch.snapshotFrameIds ?? []) {
      const previous = claims.get(id);
      if (previous !== undefined && previous !== targetKey) invalid.add(id);
      claims.set(id, targetKey);
    }
    const accepted = new Set(batch.frames.map((frame) => frame.frameId));
    for (const id of batch.snapshotFrameIds ?? []) if (!accepted.has(id)) invalid.add(id);
  }
  const currentFrames = batches.flatMap((batch) =>
    batch.frames.filter(
      (frame) =>
        !claims.has(frame.frameId) || claims.get(frame.frameId) === cdpTargetKey(batch.target),
    ),
  );
  const rootBatch = batches.find((batch) => !batch.target.sessionId);
  const rootFrameId =
    rootBatch?.rootFrameId ?? graph?.rootFrameId ?? rootBatch?.frames[0]?.frameId ?? "root";
  const ownershipInvalid = new Set(invalid);
  const identities = new Map<string, DocumentIdentity>();
  const selected = new Map(currentFrames.map((frame) => [frame.frameId, frame]));
  const checks = batches.flatMap((batch) => {
    const docs = new Map(batch.documents.map((doc) => [doc.frame.frameId, doc]));
    return batch.frames
      .filter(
        (frame) =>
          !invalid.has(frame.frameId) &&
          cdpTargetKey(selected.get(frame.frameId)!.target) === cdpTargetKey(batch.target),
      )
      .map((frame) => ({ batch, frame, doc: docs.get(frame.frameId) }));
  });
  await collectTasks(
    checks,
    async ({ batch, frame, doc }) => {
      throwCaptureAborted(signal);
      if (!batch.snapshotAttachmentId || doc?.documentElementBackendNodeId === undefined) {
        issues.push({
          target: frame.target,
          frameId: frame.frameId,
          stage: "identity",
          reason: "identity-unverified",
        });
        return;
      }
      const identity: DocumentIdentity = {
        attachmentId: batch.snapshotAttachmentId,
        target: frame.target,
        frameId: frame.frameId,
        documentElementBackendNodeId: doc.documentElementBackendNodeId,
      };
      const verified = await verifyDocumentIdentity(cdp, identity, signal);
      const status = cdp.getAttachmentId?.(tabId) === identity.attachmentId ? verified : "changed";
      if (status === "current") identities.set(frame.frameId, identity);
      else {
        invalid.add(frame.frameId);
        issues.push({
          target: frame.target,
          frameId: frame.frameId,
          stage: "identity",
          reason: status === "changed" ? "document-changed" : "identity-unavailable",
        });
      }
    },
    signal,
  );
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
        target: frame.target,
        frameId: frame.frameId,
        stage: "ownership",
        reason: "frame-ownership-unresolved",
      });
  }
  if (invalid.has(rootFrameId))
    throw new Error(
      ownershipInvalid.has(rootFrameId)
        ? "observation root document ownership is ambiguous"
        : "observation document identity changed or could not be verified; observe again",
    );
  const frames = currentFrames.filter((frame) => !invalid.has(frame.frameId));
  const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
  const belongs = (frame: CdpFrame) => {
    const current = frameById.get(frame.frameId);
    return current && cdpTargetKey(current.target) === cdpTargetKey(frame.target);
  };
  const decoded = new Map(
    batches
      .flatMap((batch) => batch.documents)
      .filter((doc) => belongs(doc.frame))
      .map((doc) => [doc.frame.frameId, doc]),
  );
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
        target: frame.target,
        frameId: frame.frameId,
        stage: "ownership",
        reason: "frame-ownership-unresolved",
      }),
  );
  const facts: ObservationFacts<T>["documents"][number][] = [];
  for (const document of documents) {
    const doc = decoded.get(document.frameId);
    const index = doc?.index ?? (await buildDocumentIndex([], signal));
    const fallback = groups.get(cdpTargetKey(document.target))?.fallbackExcluded;
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
