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

export interface CooperationFrameTree {
  frame: { id: string; url?: string; unreachableUrl?: string; loaderId?: string };
  childFrames?: CooperationFrameTree[];
}

type ReadFrameTree = (tabId: number) => Promise<{ frameTree: CooperationFrameTree }>;
type NavigationFrame = chrome.webNavigation.GetAllFrameResultDetails;

// Chrome error documents cannot run content scripts. Keep their document identity
// in the guard instead of requiring a receiver that Chrome cannot install there.
// A missing receiver in an ordinary web document must still stop the action.
async function browserErrorState(
  tabId: number,
  frame: NavigationFrame,
  frames: NavigationFrame[],
  readFrameTree: ReadFrameTree | undefined,
): Promise<FrameState | undefined> {
  if (!readFrameTree || frame.frameId === 0 || !frame.documentId) return;
  if (frames.filter((item) => item.url === frame.url).length !== 1) return;
  const tree = await readFrameTree(tabId);
  const pending = [...(tree.frameTree.childFrames ?? [])];
  const matches: CooperationFrameTree[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    pending.push(...(node.childFrames ?? []));
    if (
      node.frame.url === "chrome-error://chromewebdata/" &&
      (frame.url === node.frame.url ||
        (frame.errorOccurred && frame.url === node.frame.unreachableUrl))
    )
      matches.push(node);
  }
  if (matches.length !== 1) return;
  const current = (await chrome.webNavigation.getAllFrames({ tabId }))?.find(
    (item) => item.frameId === frame.frameId,
  );
  if (
    current?.documentId !== frame.documentId ||
    current?.url !== frame.url ||
    current?.errorOccurred !== frame.errorOccurred
  )
    return;
  return {
    document: `browser-error:${frame.documentId}:${matches[0].frame.id}:${matches[0].frame.loaderId ?? ""}`,
    revision: 0,
    structure: 0,
    human: 0,
    busy: false,
    editing: false,
    lastInput: 0,
    fields: [],
    fieldsComplete: true,
    events: [],
  };
}

export async function collectCooperationFrames(
  tabId: number,
  kind: string,
  lease: string,
  input?: InputExpectation,
  readFrameTree?: ReadFrameTree,
): Promise<Map<number, FrameState>> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!frames?.length) throw new Error("No observable document in this tab");
  const results = await Promise.all(
    frames.map(async (frame) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let active = true;
      try {
        const request = async () => {
          try {
            return await chrome.tabs.sendMessage(
              tabId,
              { kind, input, lease },
              { documentId: frame.documentId },
            );
          } catch (error) {
            if (!active || !String(error).includes("Receiving end does not exist")) throw error;
            const state = await browserErrorState(tabId, frame, frames, readFrameTree);
            if (!state) throw error;
            return state;
          }
        };
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
  readFrameTree?: ReadFrameTree,
): CooperationController {
  const controller = new CooperationController({
    sessions,
    changed,
    sessionActivity,
    readFrames: (tabId, input, lease) =>
      collectCooperationFrames(
        tabId,
        input ? COOPERATION_ARM : COOPERATION_READ,
        lease,
        input,
        readFrameTree,
      ),
    resumeFrames: async (tabId, lease) => {
      await collectCooperationFrames(tabId, COOPERATION_RESUME, lease, undefined, readFrameTree);
    },
    releaseFrames: async (tabId, lease) => {
      await collectCooperationFrames(tabId, COOPERATION_DISABLE, lease, undefined, readFrameTree);
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
