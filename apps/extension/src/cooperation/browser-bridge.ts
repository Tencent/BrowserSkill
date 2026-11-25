import { executeScriptBounded, injectCooperationAllFrames } from "@/lib/runtime-content-scripts";
import type { SessionManager } from "@/session-manager/manager";
import { CooperationController } from "./controller";
import { FrameCollectionError, FrameUnresponsiveError } from "./frame-error";
import { provenHiddenFrames } from "./hidden-frames";
import {
  COOPERATION_ARM,
  COOPERATION_ARM_FRAME,
  COOPERATION_CONTROL,
  COOPERATION_DISABLE,
  COOPERATION_MESSAGE,
  COOPERATION_READ,
  COOPERATION_RESUME,
  COOPERATION_SUBFRAME_READY,
  type CooperationFrames,
  type FrameGap,
  type FrameIdentity,
  type FrameRepairs,
  type FrameState,
  type HiddenFrames,
  type InputExpectation,
} from "./types";

export const COOPERATION_SUBFRAME_DEBOUNCE_MS = 50;
export const FRAME_REPLY_TIMEOUT_MS = 3_000;

function validFrame(value: unknown): value is FrameState {
  if (!value || typeof value !== "object") return false;
  const f = value as FrameState;
  return (
    typeof f.document === "string" &&
    (f.url === undefined || typeof f.url === "string") &&
    Number.isSafeInteger(f.revision) &&
    Number.isSafeInteger(f.structure) &&
    Number.isSafeInteger(f.human) &&
    typeof f.busy === "boolean" &&
    (f.pending === undefined || typeof f.pending === "boolean") &&
    (f.scrolling === undefined || typeof f.scrolling === "boolean") &&
    typeof f.editing === "boolean" &&
    typeof f.lastInput === "number" &&
    Array.isArray(f.fields) &&
    f.fields.length <= 64 &&
    Array.isArray(f.events) &&
    f.events.length <= 64
  );
}

function missingReceiver(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Receiving end does not exist");
}

function frameIdentity(frame: chrome.webNavigation.GetAllFrameResultDetails): FrameIdentity {
  let url = "[unavailable]";
  try {
    const parsed = new URL(frame.url);
    url = ["http:", "https:"].includes(parsed.protocol)
      ? `${parsed.origin}${parsed.pathname}`
      : parsed.protocol;
  } catch {
    // Diagnostic formatting must not fail collection or expose the original value.
  }
  return { frame_id: frame.frameId, url };
}

interface RunningFrameRead {
  readonly frame: chrome.webNavigation.GetAllFrameResultDetails;
  readonly promise: Promise<readonly [number, FrameState]>;
  settled(): boolean;
  fulfilled(): boolean;
  cancelAsUnresponsive(): void;
}

function startFrameRead(
  tabId: number,
  frame: chrome.webNavigation.GetAllFrameResultDetails,
  message: { kind: string; lease: string; input?: InputExpectation },
  repairs: FrameRepairs,
  timeoutMs = FRAME_REPLY_TIMEOUT_MS,
  signal?: AbortSignal,
): RunningFrameRead {
  const { kind } = message;
  const effectiveTimeoutMs = Math.max(1, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let isSettled = false;
  let isFulfilled = false;
  let rejectUnresponsive: ((reason: unknown) => void) | undefined;
  let onAbort: (() => void) | undefined;
  const promise = (async (): Promise<readonly [number, FrameState]> => {
    try {
      signal?.throwIfAborted();
      const request = () =>
        chrome.tabs.sendMessage(tabId, message, { documentId: frame.documentId });
      const value = await Promise.race([
        (async () => {
          let first: unknown;
          try {
            first = await request();
          } catch (error) {
            if (!active || !missingReceiver(error)) throw error;
            // Repair only a missing listener, never timeouts or navigation
            // failures. Cleanup must not install a new collector after release.
            if (kind === COOPERATION_DISABLE)
              throw new FrameCollectionError("frame_unobservable", [frameIdentity(frame)]);
            let repair = repairs.get(frame.documentId);
            if (!repair) {
              let started!: Promise<void>;
              started = (async () => {
                try {
                  await chrome.scripting.executeScript({
                    target: { tabId, documentIds: [frame.documentId] },
                    files: ["content-scripts/cooperation.js"],
                    injectImmediately: true,
                  });
                } catch (error) {
                  if (repairs.get(frame.documentId) === started) {
                    repairs.delete(frame.documentId);
                  }
                  throw error;
                }
              })();
              void started.catch(() => {});
              repair = started;
              repairs.set(frame.documentId, repair);
            }
            try {
              await repair;
            } catch {
              throw new FrameCollectionError("frame_unobservable", [frameIdentity(frame)]);
            }
            if (!active) return undefined;
            try {
              first = await request();
            } catch (error) {
              if (!missingReceiver(error)) throw error;
              throw new FrameCollectionError("frame_unobservable", [frameIdentity(frame)]);
            }
          }
          if (first !== undefined || ![COOPERATION_READ, COOPERATION_ARM].includes(kind))
            return first;
          // A renderer can transiently return an empty reply. Retry only this
          // state read, on the same document and lease, within the same deadline.
          await new Promise((resolve) => setTimeout(resolve, 25));
          return active ? request() : undefined;
        })(),
        new Promise<never>((_, reject) => {
          rejectUnresponsive = reject;
          timer = setTimeout(
            () => reject(new FrameUnresponsiveError([frameIdentity(frame)])),
            effectiveTimeoutMs,
          );
          if (signal) {
            onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
      ]);
      if (!validFrame(value))
        throw new Error(
          `Interaction collection is unavailable in frame ${frame.frameId} (${value === undefined ? "no reply" : "invalid state"})`,
        );
      isFulfilled = true;
      return [frame.frameId, value] as const;
    } finally {
      isSettled = true;
      active = false;
      clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    }
  })();
  return {
    frame,
    promise,
    settled: () => isSettled,
    fulfilled: () => isFulfilled,
    cancelAsUnresponsive: () => {
      rejectUnresponsive?.(new FrameUnresponsiveError([frameIdentity(frame)]));
    },
  };
}

export async function collectCooperationFrames(
  tabId: number,
  kind: string,
  lease: string,
  input?: InputExpectation,
  repairs: FrameRepairs = new Map(),
  hidden: HiddenFrames = new Set(),
  replacementPass = false,
  replyTimeoutMs = FRAME_REPLY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CooperationFrames> {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const documents = new Set(frames?.map((frame) => frame.documentId));
  for (const documentId of repairs.keys())
    if (!documents.has(documentId)) repairs.delete(documentId);
  for (const documentId of hidden) if (!documents.has(documentId)) hidden.delete(documentId);
  if (!frames?.length) throw new Error("No observable document in this tab");
  const gaps: FrameGap[] = [];
  const live = frames.filter((frame) => {
    if (frame.errorOccurred) {
      if (frame.frameId === 0)
        throw new FrameCollectionError("page_load_failed", [frameIdentity(frame)]);
      gaps.push({ ...frameIdentity(frame), reason: "load_error" });
      return false;
    }
    if (frame.documentLifecycle && frame.documentLifecycle !== "active") {
      gaps.push({ ...frameIdentity(frame), reason: "inactive_document" });
      return false;
    }
    return true;
  });
  // A child that already failed while hidden is not awaited again while its
  // element stays hidden. Release still messages every document.
  const remembered =
    kind === COOPERATION_DISABLE
      ? []
      : live.filter((frame) => frame.frameId !== 0 && hidden.has(frame.documentId));
  const skipped = remembered.length
    ? await provenHiddenFrames(tabId, frames, remembered)
    : new Set<number>();
  for (const frame of remembered) if (!skipped.has(frame.frameId)) hidden.delete(frame.documentId);
  const targets = live.filter((frame) => !skipped.has(frame.frameId));
  const reads = targets.map((frame) =>
    startFrameRead(tabId, frame, { kind, input, lease }, repairs, replyTimeoutMs, signal),
  );
  const earlyConcealed = new Set<number>();
  let earlyProbeTimer: ReturnType<typeof setTimeout> | undefined;
  if (replyTimeoutMs > FRAME_REPLY_TIMEOUT_MS && kind !== COOPERATION_DISABLE && reads.length > 1) {
    let windowElapsed = false;
    let probing = false;
    let recheckNeeded = false;
    const readById = new Map(reads.map((read) => [read.frame.frameId, read]));
    const maybeRetireHiddenPending = () => {
      if (!windowElapsed || signal?.aborted) return;
      if (probing) {
        recheckNeeded = true;
        return;
      }
      const pending = reads.filter((read) => !read.settled());
      if (!pending.length || pending.some((read) => read.frame.frameId === 0)) return;
      const pendingIds = new Set(pending.map((read) => read.frame.frameId));
      const candidates = pending.filter((read) => {
        const parentId = read.frame.parentFrameId;
        if (skipped.has(parentId) || earlyConcealed.has(parentId)) return true;
        if (pendingIds.has(parentId)) return true;
        const parentRead = readById.get(parentId);
        return parentRead ? parentRead.fulfilled() : false;
      });
      if (!candidates.length) return;
      probing = true;
      void provenHiddenFrames(
        tabId,
        frames,
        candidates.map((read) => read.frame),
        new Set([...skipped, ...earlyConcealed]),
      )
        .then((proven) => {
          for (const read of candidates) {
            if (!read.settled() && proven.has(read.frame.frameId)) {
              earlyConcealed.add(read.frame.frameId);
              read.cancelAsUnresponsive();
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          probing = false;
          if (recheckNeeded) {
            recheckNeeded = false;
            maybeRetireHiddenPending();
          }
        });
    };
    earlyProbeTimer = setTimeout(() => {
      windowElapsed = true;
      maybeRetireHiddenPending();
    }, FRAME_REPLY_TIMEOUT_MS);
    for (const read of reads) {
      void read.promise.then(maybeRetireHiddenPending, maybeRetireHiddenPending);
    }
  }
  let results: PromiseSettledResult<readonly [number, FrameState]>[];
  try {
    results = await Promise.allSettled(reads.map((read) => read.promise));
  } finally {
    clearTimeout(earlyProbeTimer);
  }
  signal?.throwIfAborted();
  const failed = targets.filter((_frame, i) => results[i].status === "rejected");
  if (
    failed.length &&
    !replacementPass &&
    kind !== COOPERATION_DISABLE &&
    !failed.some((old) => old.frameId === 0)
  ) {
    // A document-addressed message can race a child navigation after inventory,
    // including on pages that also carry a hidden unobservable subframe.
    // Recollect once only when every failed child document is either provably
    // retired or provably hidden in the current inventory.
    const current = await chrome.webNavigation.getAllFrames({ tabId });
    if (
      current &&
      current.find((frame) => frame.frameId === 0)?.documentId ===
        frames.find((frame) => frame.frameId === 0)?.documentId
    ) {
      const stillActive = failed.filter((old) =>
        current.some(
          (frame) =>
            frame.documentId === old.documentId &&
            !frame.errorOccurred &&
            (!frame.documentLifecycle || frame.documentLifecycle === "active"),
        ),
      );
      if (stillActive.length < failed.length) {
        const concealedActive = stillActive.length
          ? await provenHiddenFrames(tabId, current, stillActive, skipped)
          : new Set<number>();
        if (stillActive.every((old) => concealedActive.has(old.frameId))) {
          for (const old of stillActive) hidden.add(old.documentId);
          const remainingMs = Math.max(
            FRAME_REPLY_TIMEOUT_MS,
            replyTimeoutMs - (Date.now() - startedAt),
          );
          return collectCooperationFrames(
            tabId,
            kind,
            lease,
            input,
            repairs,
            hidden,
            true,
            remainingMs,
            signal,
          );
        }
      }
    }
  }
  // People cannot point at or type into a hidden child document, so only such a
  // document may stay uncollected. A failed main page or displayed frame still fails.
  const concealed = new Set<number>(earlyConcealed);
  const unconfirmedFailed = failed.filter((frame) => !earlyConcealed.has(frame.frameId));
  if (
    unconfirmedFailed.length &&
    kind !== COOPERATION_DISABLE &&
    !failed.some((frame) => frame.frameId === 0)
  ) {
    for (const id of await provenHiddenFrames(
      tabId,
      frames,
      unconfirmedFailed,
      new Set([...skipped, ...earlyConcealed]),
    )) {
      concealed.add(id);
    }
  }
  for (const frame of live)
    if (skipped.has(frame.frameId) || concealed.has(frame.frameId)) {
      hidden.add(frame.documentId);
      gaps.push({ ...frameIdentity(frame), reason: "hidden_frame" });
    }
  const failures = results.filter(
    (result, i): result is PromiseRejectedResult =>
      result.status === "rejected" && !concealed.has(targets[i].frameId),
  );
  const unobservable = failures.flatMap((result) =>
    result.reason instanceof FrameCollectionError ? result.reason.frames : [],
  );
  if (unobservable.length) throw new FrameCollectionError("frame_unobservable", unobservable);
  const unresponsive = failures.flatMap((result) =>
    result.reason instanceof FrameUnresponsiveError ? result.reason.frames : [],
  );
  if (unresponsive.length) throw new FrameUnresponsiveError(unresponsive);
  if (failures.length) throw failures[0].reason;
  return {
    frames: new Map(
      results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    ),
    gaps,
  };
}

const ARM_FRAME_TIMEOUT = Symbol("arm_frame_timeout");

function sendArmFrameBounded(
  tabId: number,
  target: { documentId: string } | { frameId: number },
  lease?: string,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    chrome.tabs.sendMessage(
      tabId,
      { kind: COOPERATION_ARM_FRAME, ...(lease !== undefined ? { lease } : {}) },
      target,
    ),
    new Promise<typeof ARM_FRAME_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(ARM_FRAME_TIMEOUT), FRAME_REPLY_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function attachCooperation(
  sessions: SessionManager,
  changed: (tabId: number) => void,
  sessionActivity?: (sessionId: string, idleProtected: boolean) => void,
  onOutermostFrameArmed?: (
    details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
  ) => void,
): CooperationController {
  const tabLeases = new Map<number, string>();
  const tabArmGenerations = new Map<number, number>();
  const lastReleasedLeases = new Map<number, string>();
  const invalidateTabArming = (tabId: number, releasedLease?: string) => {
    tabLeases.delete(tabId);
    tabArmGenerations.set(tabId, (tabArmGenerations.get(tabId) ?? 0) + 1);
    if (releasedLease !== undefined) lastReleasedLeases.set(tabId, releasedLease);
  };
  const controller = new CooperationController({
    sessions,
    changed,
    sessionActivity,
    readFrames: (tabId, input, lease, repairs, hidden, replyTimeoutMs, signal) => {
      tabLeases.set(tabId, lease);
      return collectCooperationFrames(
        tabId,
        input ? COOPERATION_ARM : COOPERATION_READ,
        lease,
        input,
        repairs,
        hidden,
        false,
        replyTimeoutMs,
        signal,
      );
    },
    resumeFrames: async (tabId, lease, repairs, hidden, replyTimeoutMs, signal) => {
      tabLeases.set(tabId, lease);
      await collectCooperationFrames(
        tabId,
        COOPERATION_RESUME,
        lease,
        undefined,
        repairs,
        hidden,
        false,
        replyTimeoutMs,
        signal,
      );
    },
    releaseFrames: async (tabId, lease) => {
      invalidateTabArming(tabId, lease);
      await collectCooperationFrames(tabId, COOPERATION_DISABLE, lease);
    },
  });
  const subframeNeedsInject = new Set<number>();
  const pendingArms = new Map<number, Set<Promise<void>>>();
  const observeTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const clearObserveTimer = (tabId: number) => {
    const existing = observeTimers.get(tabId);
    if (existing !== undefined) {
      clearTimeout(existing);
      observeTimers.delete(tabId);
    }
  };
  const scheduleObserveTab = (tabId: number, needsInject = false) => {
    if (needsInject) subframeNeedsInject.add(tabId);
    clearObserveTimer(tabId);
    observeTimers.set(
      tabId,
      setTimeout(() => {
        observeTimers.delete(tabId);
        const shouldInject = subframeNeedsInject.delete(tabId);
        if (!sessions.findControllingSession?.(tabId)) return;
        void (async () => {
          const arms = pendingArms.get(tabId);
          if (arms?.size) {
            await Promise.allSettled([...arms]);
            if (!sessions.findControllingSession?.(tabId)) return;
          }
          if (shouldInject) {
            const armGen = tabArmGenerations.get(tabId) ?? 0;
            const armLease = tabLeases.get(tabId);
            const isStillActive = () =>
              (tabArmGenerations.get(tabId) ?? 0) === armGen &&
              Boolean(sessions.findControllingSession?.(tabId));
            await injectCooperationAllFrames(tabId, {
              lease: armLease,
              isActive: isStillActive,
            });
            if (!sessions.findControllingSession?.(tabId)) {
              const cleanupLease = lastReleasedLeases.get(tabId) ?? armLease ?? crypto.randomUUID();
              await collectCooperationFrames(tabId, COOPERATION_DISABLE, cleanupLease);
              return;
            }
            if (!isStillActive()) return;
          }
          await controller.observeTab(tabId);
        })().catch(() => {});
      }, COOPERATION_SUBFRAME_DEBOUNCE_MS),
    );
  };
  const armCommittedFrame = (
    details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
  ) => {
    if (!sessions.findControllingSession?.(details.tabId)) return;
    const armGen = tabArmGenerations.get(details.tabId) ?? 0;
    const armLease = tabLeases.get(details.tabId);
    const isStaleArm = () =>
      (tabArmGenerations.get(details.tabId) ?? 0) !== armGen ||
      !sessions.findControllingSession?.(details.tabId);
    const disarmStaleFrame = () => {
      const cleanupLease = lastReleasedLeases.get(details.tabId) ?? armLease ?? crypto.randomUUID();
      return chrome.tabs
        .sendMessage(details.tabId, { kind: COOPERATION_DISABLE, lease: cleanupLease }, target)
        .catch(() => {});
    };
    const target = details.documentId
      ? { documentId: details.documentId }
      : { frameId: details.frameId };
    let arms = pendingArms.get(details.tabId);
    if (!arms) {
      arms = new Set();
      pendingArms.set(details.tabId, arms);
    }
    const armTask = (async () => {
      try {
        let needsInject = false;
        let armed = false;
        try {
          const ack = await sendArmFrameBounded(details.tabId, target, armLease);
          needsInject = ack === undefined;
          armed = typeof ack === "object" && ack !== null && (ack as { ok?: unknown }).ok === true;
        } catch (error) {
          needsInject = missingReceiver(error);
        }
        if (armed && isStaleArm()) {
          await disarmStaleFrame();
          return;
        }
        if (
          needsInject &&
          !isStaleArm() &&
          details.documentId &&
          typeof chrome.scripting?.executeScript === "function"
        ) {
          try {
            const injected = await executeScriptBounded({
              target: { tabId: details.tabId, documentIds: [details.documentId] },
              files: ["content-scripts/cooperation.js"],
              injectImmediately: true,
            });
            if (injected && !isStaleArm()) {
              const ack = await sendArmFrameBounded(details.tabId, target, armLease);
              if (
                typeof ack === "object" &&
                ack !== null &&
                (ack as { ok?: unknown }).ok === true &&
                isStaleArm()
              ) {
                await disarmStaleFrame();
              }
            }
          } catch {
            // Restricted or replaced documents are handled during frame collection.
          }
        }
      } finally {
        if ((details.frameId === 0 || details.frameType === "outermost_frame") && !isStaleArm()) {
          onOutermostFrameArmed?.(details);
        }
      }
    })();
    arms.add(armTask);
    void armTask.finally(() => {
      const tracked = pendingArms.get(details.tabId);
      tracked?.delete(armTask);
      if (tracked?.size === 0) pendingArms.delete(details.tabId);
    });
    scheduleObserveTab(details.tabId);
  };

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || typeof sender.tab?.id !== "number") return false;
    if (message?.kind === COOPERATION_SUBFRAME_READY) {
      if (sessions.findControllingSession?.(sender.tab.id)) {
        scheduleObserveTab(sender.tab.id, true);
      }
    } else if (message?.kind === COOPERATION_MESSAGE && validFrame(message.state)) {
      controller.receive(sender.tab.id, sender.frameId ?? 0, message.state, message.lease);
    } else if (
      message?.kind === COOPERATION_CONTROL &&
      sender.frameId === 0 &&
      Number.isSafeInteger(message.revision) &&
      ["hold", "resume"].includes(message.action)
    ) {
      void controller
        .control(sender.tab.id, message.revision, message.action)
        .then(reply, () => reply({ ok: false }));
      return true;
    }
    return false;
  });
  chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
    // Only the root document replaces the observed page. Child frames are
    // collected separately; invalidating here would discard the whole context
    // for an unrelated iframe navigation that may never commit.
    if (frameId === 0) controller.invalidate(tabId);
  });
  chrome.webNavigation.onCommitted?.addListener((details) => {
    armCommittedFrame(details);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    clearObserveTimer(tabId);
    subframeNeedsInject.delete(tabId);
    pendingArms.delete(tabId);
    invalidateTabArming(tabId);
    tabArmGenerations.delete(tabId);
    lastReleasedLeases.delete(tabId);
    controller.releaseTab(tabId);
  });
  chrome.tabs.onDetached.addListener((tabId) => {
    clearObserveTimer(tabId);
    subframeNeedsInject.delete(tabId);
    pendingArms.delete(tabId);
    invalidateTabArming(tabId);
    tabArmGenerations.delete(tabId);
    lastReleasedLeases.delete(tabId);
    controller.detachTab(tabId);
  });
  return controller;
}
