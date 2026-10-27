import type { SessionManager } from "@/session-manager/manager";
import { CooperationController } from "./controller";
import {
  COOPERATION_ARM,
  COOPERATION_CONTROL,
  COOPERATION_DISABLE,
  COOPERATION_MESSAGE,
  COOPERATION_READ,
  COOPERATION_READY,
  COOPERATION_RESUME,
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
    typeof f.editing === "boolean" &&
    typeof f.lastInput === "number" &&
    Array.isArray(f.fields) &&
    f.fields.length <= 64 &&
    Array.isArray(f.events) &&
    f.events.length <= 64
  );
}

export async function collectCooperationFrames(
  tabId: number,
  kind: string,
  lease: string,
  input?: InputExpectation,
): Promise<Map<number, FrameState>> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!frames?.length) throw new Error("No observable document in this tab");
  const results = await Promise.all(
    frames.map(async (frame) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let active = true;
      try {
        const request = () =>
          chrome.tabs.sendMessage(tabId, { kind, input, lease }, { documentId: frame.documentId });
        const value = await Promise.race([
          (async () => {
            const first = await request();
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
        return [frame.frameId, value] as const;
      } finally {
        active = false;
        clearTimeout(timer);
      }
    }),
  );
  return new Map(results);
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
    readFrames: (tabId, input, lease) =>
      collectCooperationFrames(tabId, input ? COOPERATION_ARM : COOPERATION_READ, lease, input),
    resumeFrames: async (tabId, lease) => {
      await collectCooperationFrames(tabId, COOPERATION_RESUME, lease);
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
  chrome.webNavigation.onBeforeNavigate.addListener(({ tabId }) => controller.invalidate(tabId));
  chrome.tabs.onRemoved.addListener((tabId) => controller.releaseTab(tabId));
  chrome.tabs.onDetached.addListener((tabId) => controller.detachTab(tabId));
  return controller;
}
