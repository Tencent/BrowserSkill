import type { SessionManager } from "@/session-manager/manager";
import { CooperationController } from "./controller";
import { FrameCollectionError } from "./frame-error";
import {
  COOPERATION_ARM,
  COOPERATION_CONTROL,
  COOPERATION_DISABLE,
  COOPERATION_MESSAGE,
  COOPERATION_READ,
  COOPERATION_READY,
  COOPERATION_RESUME,
  type CooperationFrames,
  type FrameGap,
  type FrameIdentity,
  type FrameRepairs,
  type FrameState,
  type InputExpectation,
} from "./types";

function validFrame(value: unknown): value is FrameState {
  if (!value || typeof value !== "object") return false;
  const f = value as FrameState;
  return (
    typeof f.document === "string" &&
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

async function readFrame(
  tabId: number,
  frame: chrome.webNavigation.GetAllFrameResultDetails,
  message: { kind: string; lease: string; input?: InputExpectation },
  repairs: FrameRepairs,
): Promise<FrameState> {
  const { kind } = message;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  try {
    const request = () => chrome.tabs.sendMessage(tabId, message, { documentId: frame.documentId });
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
            repair = chrome.scripting
              .executeScript({
                target: { tabId, documentIds: [frame.documentId] },
                files: ["content-scripts/cooperation.js"],
                injectImmediately: true,
              })
              .then(() => {});
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
        timer = setTimeout(() => reject(new Error("A page frame is not responding")), 1200);
      }),
    ]);
    if (!validFrame(value))
      throw new Error(
        `Interaction collection is unavailable in frame ${frame.frameId} (${value === undefined ? "no reply" : "invalid state"})`,
      );
    return value;
  } finally {
    active = false;
    clearTimeout(timer);
  }
}

export async function collectCooperationFrames(
  tabId: number,
  kind: string,
  lease: string,
  input?: InputExpectation,
  repairs: FrameRepairs = new Map(),
  replacementPass = false,
): Promise<CooperationFrames> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const documents = new Set(frames?.map((frame) => frame.documentId));
  for (const documentId of repairs.keys())
    if (!documents.has(documentId)) repairs.delete(documentId);
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
  const results = await Promise.allSettled(
    live.map(async (frame) => {
      return [
        frame.frameId,
        await readFrame(tabId, frame, { kind, input, lease }, repairs),
      ] as const;
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length && !replacementPass && kind !== COOPERATION_DISABLE) {
    const failed = live.filter((_frame, i) => results[i].status === "rejected");
    // A document-addressed message can race a child navigation after inventory.
    // Recollect once only when every failed document is provably retired. Never
    // hide an active unobservable document, a root replacement or further churn.
    const current = await chrome.webNavigation.getAllFrames({ tabId });
    if (
      current?.find((frame) => frame.frameId === 0)?.documentId ===
        frames.find((frame) => frame.frameId === 0)?.documentId &&
      failed.every(
        (old) =>
          old.frameId !== 0 &&
          !current?.some(
            (frame) =>
              frame.documentId === old.documentId &&
              !frame.errorOccurred &&
              (!frame.documentLifecycle || frame.documentLifecycle === "active"),
          ),
      )
    )
      return collectCooperationFrames(tabId, kind, lease, input, repairs, true);
  }
  const unobservable = failures.flatMap((result) =>
    result.reason instanceof FrameCollectionError ? result.reason.frames : [],
  );
  if (unobservable.length) throw new FrameCollectionError("frame_unobservable", unobservable);
  if (failures.length) throw failures[0].reason;
  return {
    frames: new Map(
      results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    ),
    gaps,
  };
}

export function attachCooperation(
  sessions: SessionManager,
  changed: (tabId: number) => void,
  sessionActivity?: (sessionId: string, idleProtected: boolean) => void,
): CooperationController {
  const controller = new CooperationController({
    sessions,
    changed,
    sessionActivity,
    readFrames: (tabId, input, lease, repairs) =>
      collectCooperationFrames(
        tabId,
        input ? COOPERATION_ARM : COOPERATION_READ,
        lease,
        input,
        repairs,
      ),
    resumeFrames: async (tabId, lease, repairs) => {
      await collectCooperationFrames(tabId, COOPERATION_RESUME, lease, undefined, repairs);
    },
    releaseFrames: async (tabId, lease) => {
      await collectCooperationFrames(tabId, COOPERATION_DISABLE, lease);
    },
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || typeof sender.tab?.id !== "number") return false;
    if (message?.kind === COOPERATION_READY) {
      void controller.observeTab(sender.tab.id).catch(() => {});
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
  chrome.tabs.onRemoved.addListener((tabId) => controller.releaseTab(tabId));
  chrome.tabs.onDetached.addListener((tabId) => controller.detachTab(tabId));
  return controller;
}
