import type { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionContext } from "@/session-manager/manager";
import {
  isAgentControlledTab,
  type SessionManager,
  sessionWindowId,
} from "@/session-manager/manager";
import {
  checkedUiTab,
  runTaskUi,
  type UiOperation,
  UiTaskError,
  withUiTeardown,
} from "@/session-manager/ui-activity";

const PREVIEW_WIDTH = 640;
const previews = new WeakMap<object, Promise<unknown>>();
export function captureTaskPreview(
  manager: SessionManager,
  cdp: ChromiumCdp,
  sessionId: string,
): Promise<unknown> {
  const task = manager.get(sessionId);
  if (!task?.remote)
    return Promise.reject(new UiTaskError("not_found", "Task unavailable", "task_unavailable"));
  const pending = previews.get(task);
  if (pending) return pending;
  const work = runTaskUi(manager, sessionId, async (op, task) => {
    // Cleanup is independent of the UI deadline: a timed-out request must still
    // release control of a tab that moved out of the task window. Pin the claim
    // before lookup so a late lookup cannot release a newer tool acquisition.
    const releaseIfUnauthorized = async () => {
      const tabId = op.tabId;
      if (tabId === undefined || manager.get(sessionId) !== task) return;
      const claim = cdp.getSessionClaimId(sessionId, tabId);
      if (!claim) return;
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (manager.get(sessionId) !== task) return;
      if (!isAgentControlledTab(task, tabId) || (tab && tab.windowId !== sessionWindowId(task)))
        await cdp.releaseSessionTab(sessionId, tabId, { ifClaim: claim });
    };
    const onAbort = () => {
      void releaseIfUnauthorized().catch(() => {});
    };
    op.signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await capture(manager, cdp, sessionId, op, task);
    } catch (error) {
      await releaseIfUnauthorized().catch(() => {});
      throw error;
    } finally {
      op.signal.removeEventListener("abort", onAbort);
    }
  }).finally(() => {
    if (previews.get(task) === work) previews.delete(task);
  });
  previews.set(task, work);
  return work;
}

export async function withTaskPreviewStop<T>(
  manager: SessionManager,
  sessionId: string | undefined,
  stop: () => Promise<T>,
) {
  const task = sessionId ? manager.get(sessionId) : undefined;
  return task?.remote ? withUiTeardown(task, undefined, stop) : stop();
}

export function focusTask(manager: SessionManager, sessionId: string) {
  return runTaskUi(manager, sessionId, async (op, task) => {
    const tabId = await taskTarget(manager, sessionId);
    await checkedUiTab(task, op, tabId);
    await op.mutate(tabId, () => chrome.tabs.update(tabId, { active: true }));
    await checkedUiTab(task, op, tabId);
    await op.mutate(tabId, () => chrome.windows.update(sessionWindowId(task), { focused: true }));
    await checkedUiTab(task, op, tabId);
    return { focused: true };
  });
}

async function capture(
  manager: SessionManager,
  cdp: ChromiumCdp,
  sessionId: string,
  op: UiOperation,
  task: SessionContext,
) {
  const tabId = await taskTarget(manager, sessionId);
  await checkedUiTab(task, op, tabId);
  // This is a session-lifetime claim, shared with tools. A stale image must
  // never release the session's claim; return/stop own that responsibility.
  await cdp.acquireBackgroundExecution(sessionId, tabId);
  await checkedUiTab(task, op, tabId);
  const attachment = cdp.getAttachmentId(tabId);
  const revision = task.refStore.documentRevision(tabId);
  const checkFrame = async () => {
    const tab = await checkedUiTab(task, op, tabId);
    if (
      cdp.getAttachmentId(tabId) !== attachment ||
      task.refStore.documentRevision(tabId) !== revision
    )
      throw new UiTaskError("cancelled", "Task ended during capture", "stale_frame");
    return tab;
  };
  const shot = await captureViewport(cdp, tabId, op.signal);
  await checkFrame();
  const data = await downscale(shot.data, op);
  const tab = await checkFrame();
  return {
    image_base64: data,
    format: "jpeg",
    tab_id: tabId,
    title: tab.title ?? "",
    captured_at: new Date().toISOString(),
  };
}

const capturesInFlight = new WeakMap<
  object,
  Map<number, { attachment: string | undefined; shot: Promise<{ data: string }> }>
>();
async function captureViewport(
  cdp: ChromiumCdp,
  tabId: number,
  signal: AbortSignal,
): Promise<{ data: string }> {
  let inFlight = capturesInFlight.get(cdp);
  if (!inFlight) {
    inFlight = new Map();
    capturesInFlight.set(cdp, inFlight);
  }
  const attachment = cdp.getAttachmentId(tabId);
  const previous = inFlight.get(tabId);
  if (previous && previous.attachment === attachment)
    throw new UiTaskError(
      "timeout",
      `Previous preview capture is still running in Chrome (tab ${tabId})`,
      "preview_busy",
    );
  const shot = cdp.send<{ data: string }>(
    tabId,
    "Page.captureScreenshot",
    {
      format: "jpeg",
      quality: 50,
      fromSurface: true,
      captureBeyondViewport: false,
    },
    signal,
  );
  const entry = { attachment, shot };
  inFlight.set(tabId, entry);
  const release = () => {
    if (inFlight.get(tabId) === entry) inFlight.delete(tabId);
  };
  void shot.then(release, release);
  return shot;
}

/**
 * Viewport captures are returned in physical display pixels, so a HiDPI screen
 * produces a bitmap several times wider than the preview needs. Bound the
 * encoded image itself rather than leaving that to the gateway.
 */
async function downscale(jpegBase64: string, op: UiOperation): Promise<string> {
  const bitmap = await createImageBitmap(
    new Blob([Uint8Array.from(atob(jpegBase64), (c) => c.charCodeAt(0))], { type: "image/jpeg" }),
  );
  try {
    op.check();
    if (bitmap.width <= PREVIEW_WIDTH) return jpegBase64;
    const canvas = new OffscreenCanvas(
      PREVIEW_WIDTH,
      Math.max(1, Math.round((bitmap.height * PREVIEW_WIDTH) / bitmap.width)),
    );
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Preview canvas unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
    op.check();
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
  if (!task?.remote) throw new UiTaskError("not_found", "Task unavailable", "task_unavailable");
  const tabs = await chrome.tabs.query({ windowId: sessionWindowId(task) });
  if (manager.get(sessionId) !== task)
    throw new UiTaskError("not_found", "Task unavailable", "task_unavailable");
  const owned = tabs.filter(
    (tab) => typeof tab.id === "number" && isAgentControlledTab(task, tab.id),
  );
  const tabId = (owned.find((tab) => tab.active) ?? owned[0])?.id;
  if (tabId === undefined)
    throw new UiTaskError("not_found", "Task tab unavailable", "target_unavailable");
  return tabId;
}
