import type { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { isAgentControlledTab, type SessionManager } from "@/session-manager/manager";

/** Longest a poll waits for Chrome before the caller is told to try again. */
const CAPTURE_DEADLINE_MS = 3_000;
/** Widest encoded preview frame, in image pixels. */
const PREVIEW_WIDTH = 640;

interface PreviewState {
  pending?: Promise<unknown>;
  stopping: number;
}
const previews = new WeakMap<object, PreviewState>();
function previewState(task: object): PreviewState {
  let state = previews.get(task);
  if (!state) {
    state = { stopping: 0 };
    previews.set(task, state);
  }
  return state;
}

/**
 * One UI frame of the task's own tab, captured outside the tool queue so a
 * preview still answers while the session is navigating or waiting for human
 * help. Concurrent polls share the frame that is already in flight.
 */
export function captureTaskPreview(
  manager: SessionManager,
  cdp: ChromiumCdp,
  sessionId: string,
): Promise<unknown> {
  const task = manager.get(sessionId);
  if (!task?.remote) return Promise.reject(new Error("Task unavailable"));
  const state = previewState(task);
  if (state.stopping) return Promise.reject(new Error("Task is stopping"));
  if (state.pending) return state.pending;
  const work = capture(manager, cdp, sessionId).finally(() => {
    if (state.pending === work) state.pending = undefined;
  });
  state.pending = work;
  return work;
}

/**
 * Drains an in-flight preview before `session.stop` detaches the debugger and
 * closes the task's tabs, and refuses new ones for the duration. Session state
 * is untouched: a stop that fails can be retried and previews resume.
 */
export async function withTaskPreviewStop<T>(
  manager: SessionManager,
  sessionId: string | undefined,
  stop: () => Promise<T>,
): Promise<T> {
  const task = sessionId ? manager.get(sessionId) : undefined;
  if (!task?.remote) return stop();
  const state = previewState(task);
  state.stopping++;
  try {
    await state.pending?.catch(() => {});
    return await stop();
  } finally {
    state.stopping--;
  }
}

async function capture(manager: SessionManager, cdp: ChromiumCdp, sessionId: string) {
  const task = manager.get(sessionId);
  if (!task?.remote) throw new Error("Task unavailable");
  const tabId = await taskTarget(manager, sessionId);
  if (!isAgentControlledTab(task, tabId)) throw new Error("Task tab unavailable");
  const tab = await chrome.tabs.get(tabId);
  // The preview does not pass through the dispatcher, so it acquires the same
  // explicit background-execution claim the tools use before reading a page
  // that is not in the foreground. `session.stop` drains this capture before
  // releasing the claim and closing the tab.
  await cdp.acquireBackgroundExecution(sessionId, tabId);
  const attachment = cdp.getAttachmentId(tabId);
  const revision = task.refStore.documentRevision(tabId);
  if (manager.get(sessionId) !== task || !isAgentControlledTab(task, tabId))
    throw new Error("Task ended during capture");
  // UI frames keep the extension's own control and help overlays: hiding and
  // restoring them on every poll would make them flicker in the user's browser.
  // Tool screenshots suppress the overlays separately, for unobstructed content.
  // Only the viewport is captured; the bitmap is scaled below without a layout read.
  const shot = await captureViewport(cdp, tabId);
  const stillOurs = () =>
    manager.get(sessionId) === task &&
    isAgentControlledTab(task, tabId) &&
    cdp.getAttachmentId(tabId) === attachment &&
    task.refStore.documentRevision(tabId) === revision;
  if (!stillOurs()) throw new Error("Task ended during capture");
  const data = await downscale(shot.data);
  if (!stillOurs()) throw new Error("Task ended during capture");
  return {
    image_base64: data,
    format: "jpeg",
    tab_id: tabId,
    title: tab.title ?? "",
    captured_at: new Date().toISOString(),
  };
}

const capturesInFlight = new WeakMap<object, Map<number, Promise<unknown>>>();

/**
 * At most one capture per tab, and a bounded wait for the caller.
 *
 * A local deadline cannot cancel a CDP command, so the fence is released only
 * when Chrome actually answers (or the debugger detaches). A poll that arrives
 * while a capture is stuck is refused instead of queueing another one behind it.
 */
async function captureViewport(cdp: ChromiumCdp, tabId: number): Promise<{ data: string }> {
  let inFlight = capturesInFlight.get(cdp);
  if (!inFlight) {
    inFlight = new Map();
    capturesInFlight.set(cdp, inFlight);
  }
  if (inFlight.has(tabId)) {
    throw new Error(`Previous preview capture is still running in Chrome (tab ${tabId})`);
  }
  const shot = cdp.send<{ data: string }>(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 50,
    fromSurface: true,
    captureBeyondViewport: false,
  });
  inFlight.set(tabId, shot);
  const release = () => {
    if (inFlight.get(tabId) === shot) inFlight.delete(tabId);
  };
  void shot.then(release, release);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      shot,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`Preview capture timed out after ${CAPTURE_DEADLINE_MS}ms`)),
          CAPTURE_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Viewport captures are returned in physical display pixels, so a HiDPI screen
 * produces a bitmap several times wider than the preview needs. Bound the
 * encoded image itself rather than leaving that to the gateway.
 */
async function downscale(jpegBase64: string): Promise<string> {
  const bitmap = await createImageBitmap(
    new Blob([Uint8Array.from(atob(jpegBase64), (c) => c.charCodeAt(0))], { type: "image/jpeg" }),
  );
  try {
    if (bitmap.width <= PREVIEW_WIDTH) return jpegBase64;
    const canvas = new OffscreenCanvas(
      PREVIEW_WIDTH,
      Math.max(1, Math.round((bitmap.height * PREVIEW_WIDTH) / bitmap.width)),
    );
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Preview canvas unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
    return btoa(
      Array.from(new Uint8Array(await jpeg.arrayBuffer()), (b) => String.fromCharCode(b)).join(""),
    );
  } finally {
    bitmap.close();
  }
}

/**
 * The task's active tab, or another tab it owns when the user has selected an
 * unauthorized page inside the Agent Window. Window membership alone never
 * grants access, so an unowned tab is never captured or focused.
 */
export async function taskTarget(manager: SessionManager, sessionId: string): Promise<number> {
  const task = manager.get(sessionId);
  if (!task?.remote) throw new Error("Task unavailable");
  const tabs = await chrome.tabs.query({ windowId: task.agentWindowId });
  if (manager.get(sessionId) !== task) throw new Error("Task unavailable");
  const owned = tabs.filter(
    (tab) => typeof tab.id === "number" && isAgentControlledTab(task, tab.id),
  );
  const tabId = (owned.find((tab) => tab.active) ?? owned[0])?.id;
  if (tabId === undefined) throw new Error("Task tab unavailable");
  return tabId;
}
