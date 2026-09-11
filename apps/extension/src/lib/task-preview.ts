import type { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { withExtensionOverlayHidden } from "@/lib/capture-suppress-bridge";
import { isAgentControlledTab, type SessionManager } from "@/session-manager/manager";

const captures = new Map<string, Promise<unknown>>();
/** UI-only capture, outside the automation queue (including human-help waits).
 * Captures only the task's concrete tab; never activates it or reads a user tab. */
export function captureTaskPreview(
  manager: SessionManager,
  cdp: ChromiumCdp,
  sessionId: string,
): Promise<unknown> {
  const pending = captures.get(sessionId);
  if (pending) return pending;
  const work = capture(manager, cdp, sessionId).finally(() => captures.delete(sessionId));
  captures.set(sessionId, work);
  return work;
}
async function capture(manager: SessionManager, cdp: ChromiumCdp, sessionId: string) {
  const task = manager.get(sessionId);
  if (!task) throw new Error("Task unavailable");
  const tabId =
    task.activeTabId !== undefined && isAgentControlledTab(task, task.activeTabId)
      ? task.activeTabId
      : [...task.agentCreatedTabs, ...task.borrowedTabs.keys()][0];
  if (tabId === undefined || !isAgentControlledTab(task, tabId))
    throw new Error("Task tab unavailable");
  const tab = await chrome.tabs.get(tabId);
  cdp.trackSessionTab(sessionId, tabId);
  await cdp.ensureAttached(tabId);
  const shot = await withExtensionOverlayHidden(
    tabId,
    async () => {
      const metrics = await cdp.send<{
        cssVisualViewport: {
          pageX: number;
          pageY: number;
          clientWidth: number;
          clientHeight: number;
        };
      }>(tabId, "Page.getLayoutMetrics", {});
      const v = metrics.cssVisualViewport;
      return cdp.send<{ data: string }>(tabId, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 50,
        fromSurface: true,
        captureBeyondViewport: false,
        clip: {
          x: v.pageX,
          y: v.pageY,
          width: v.clientWidth,
          height: v.clientHeight,
          scale: Math.min(1, 640 / v.clientWidth),
        },
      });
    },
    (id, message) => chrome.tabs.sendMessage(id, message),
  );
  if (manager.get(sessionId) !== task || !isAgentControlledTab(task, tabId))
    throw new Error("Task ended during capture");
  // CDP clip.scale is expressed in CSS pixels; HiDPI displays can still
  // return larger bitmaps. Bound the actual encoded image, not just the clip.
  let data = shot.data;
  const bitmap = await createImageBitmap(
    new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: "image/jpeg" }),
  );
  try {
    if (bitmap.width > 640) {
      const canvas = new OffscreenCanvas(
        640,
        Math.max(1, Math.round((bitmap.height * 640) / bitmap.width)),
      );
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Preview canvas unavailable");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
      data = btoa(
        Array.from(new Uint8Array(await jpeg.arrayBuffer()), (b) => String.fromCharCode(b)).join(
          "",
        ),
      );
    }
  } finally {
    bitmap.close();
  }
  if (manager.get(sessionId) !== task || !isAgentControlledTab(task, tabId))
    throw new Error("Task ended during capture");
  return {
    image_base64: data,
    format: "jpeg",
    tab_id: tabId,
    title: tab.title ?? "",
    captured_at: new Date().toISOString(),
  };
}
