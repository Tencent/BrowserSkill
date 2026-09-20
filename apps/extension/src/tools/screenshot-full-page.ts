import { i18n } from "@browser-skill/i18n";
import { CAPTURE_SUPPRESS, type CaptureSuppressPhase } from "@/lib/capture-suppress-bridge";
import { capturePage } from "@/long-screenshot/capture";
import type { ScreenshotExports } from "@/long-screenshot/exports";
import { createPageClient } from "@/long-screenshot/page-client";
import { exportPng } from "@/long-screenshot/png";
import { TileWriter } from "@/long-screenshot/tiles";
import {
  type CaptureCancelReason,
  LONG_SCREENSHOT,
  ScreenshotError,
} from "@/long-screenshot/types";
import { waitForReply } from "@/long-screenshot/wait";
import { isAgentControlledTab, type SessionManager } from "@/session-manager/manager";
import type {
  RpcError,
  ScreenshotFullPageParams,
  ScreenshotFullPageResult,
} from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { rpcError } from "./errors";
import {
  type CdpRunner,
  type ChromeTabsApi,
  enforceAgentWindow,
  enforceCdpAccessibleTarget,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

export interface FullPageScreenshotDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  exports: ScreenshotExports;
}

/** Agent-only adapter around the same scrolling, tiling and PNG encoder used
 * by Quick Actions. It never changes popup state or opens a preview/download. */
export async function handleFullPageScreenshot(
  manager: SessionManager,
  params: ScreenshotFullPageParams,
  deps: FullPageScreenshotDeps,
  signal?: AbortSignal,
): Promise<ScreenshotFullPageResult | RpcError> {
  if (signal?.aborted) return { code: "cancelled", message: "Screenshot cancelled" };
  const timeout = params.timeout_ms ?? 120_000;
  if (params.scope !== undefined && params.scope !== "current" && params.scope !== "follow")
    return { code: "invalid_params", message: "scope must be current or follow" };
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 0xffffffff)
    return { code: "invalid_params", message: "timeout_ms must be a positive u32" };
  const ctx = lookupSession(manager, params, "screenshot --full-page");
  if (isRpcError(ctx)) return ctx;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied =
    enforceAgentWindow(ctx, target, "screenshot --full-page") ??
    enforceCdpAccessibleTarget(target, "screenshot --full-page");
  if (denied) return denied;
  if (!isAgentControlledTab(ctx, target.tabId))
    return rpcError(
      "permission_denied",
      "agent_window_scope",
      "Full-page screenshot scrolls the page; borrow this tab into the session first",
    );
  if (!target.url || !/^https?:\/\//i.test(target.url))
    return {
      code: "unsupported",
      message: "Full-page screenshot requires a scriptable HTTP(S) page",
    };

  const id = `agent-${crypto.randomUUID()}`;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const expires = performance.now() + timeout;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = () => {
    const remaining = expires - performance.now();
    if (remaining <= 0) controller.abort(new ScreenshotError("timeout"));
    else deadline = setTimeout(armDeadline, Math.min(remaining, 0x7fffffff));
  };
  armDeadline();
  // Never resume a partially stitched job on a replacement debugger connection.
  let attachmentId: string | undefined;
  const checkOwnership = () => {
    controller.signal.throwIfAborted();
    if (
      manager.get(ctx.sessionId) !== ctx ||
      !isAgentControlledTab(ctx, target.tabId) ||
      (attachmentId !== undefined && deps.cdp.getAttachmentId?.(target.tabId) !== attachmentId)
    )
      throw new ScreenshotError("changed");
  };
  const checkTab = async () => {
    checkOwnership();
    const current = await waitForReply(deps.tabsApi.get(target.tabId), controller.signal);
    if (current.windowId !== target.windowId || current.url !== target.url)
      throw new ScreenshotError("changed");
    if (client.documentId) {
      const frame = await waitForReply(
        chrome.webNavigation.getFrame({ tabId: target.tabId, frameId: 0 }),
        controller.signal,
      );
      if (frame?.documentId !== client.documentId) throw new ScreenshotError("changed");
    }
    checkOwnership();
  };
  const client = createPageClient(target.tabId, id, controller.signal, checkTab);
  const changed = () => controller.abort(new ScreenshotError("changed"));
  const navigated = (info: { tabId: number; frameId: number }) => {
    if (info.tabId === target.tabId && info.frameId === 0)
      controller.abort(new ScreenshotError("interrupted", "navigation"));
  };
  const removed = (tabId: number) => {
    if (tabId === target.tabId) changed();
  };
  const cancelled = (message: unknown, sender: chrome.runtime.MessageSender) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab?.id !== target.tabId ||
      sender.frameId !== 0 ||
      sender.documentId !== client.documentId ||
      !message ||
      typeof message !== "object"
    )
      return;
    const request = message as {
      type?: string;
      action?: string;
      id?: string;
      reason?: CaptureCancelReason;
    };
    if (request.type === LONG_SCREENSHOT && request.action === "cancel" && request.id === id)
      controller.abort(
        new ScreenshotError(
          "interrupted",
          request.reason &&
            ["user_cancelled", "page_hidden", "navigation", "watchdog_timeout"].includes(
              request.reason,
            )
            ? request.reason
            : "user_cancelled",
        ),
      );
  };
  chrome.webNavigation.onBeforeNavigate.addListener(navigated);
  chrome.webNavigation.onCommitted.addListener(navigated);
  chrome.tabs.onRemoved.addListener(removed);
  chrome.tabs.onAttached.addListener(removed);
  chrome.runtime.onMessage.addListener(cancelled);
  const writer = new TileWriter(id, new URL(target.url).hostname);
  let retained = false;
  let phase = "preparing";
  let frames = 0;
  let progress = 0;
  const cursor = markDialogCursor(deps.cdp, target.tabId);
  try {
    await deps.exports.prepare();
    // Attach before measuring: the debugger infobar can change viewport geometry.
    // The dispatcher owns background execution; this job never toggles it.
    await checkTab();
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    await waitForReply(deps.cdp.send(target.tabId, "Page.getFrameTree"), controller.signal);
    attachmentId = deps.cdp.getAttachmentId?.(target.tabId);
    if (!attachmentId) throw new ScreenshotError("changed");
    const platform = await waitForReply(chrome.runtime.getPlatformInfo(), controller.signal);
    await client.prepare();
    await withScreenshotOverlayHidden(
      target.tabId,
      client.documentId!,
      controller.signal,
      async () => {
        phase = "capturing";
        await capturePage({
          page: (command) => {
            if (command.action !== "finish") phase = `page ${command.action}`;
            return client.page(command);
          },
          signal: controller.signal,
          screenshot: async () => {
            phase = "reading viewport pixels";
            await checkTab();
            checkOwnership();
            const shot = await waitForReply(
              deps.cdp.send<{ data?: string }>(target.tabId, "Page.captureScreenshot", {
                format: "png",
                fromSurface: true,
                captureBeyondViewport: false,
              }),
              controller.signal,
            );
            if (!shot.data) throw new ScreenshotError("captureFailed");
            const data = `data:image/png;base64,${shot.data}`;
            await checkTab();
            phase = "decoding viewport pixels";
            return createImageBitmap(await (await fetch(data)).blob());
          },
          write: (...args) => writer.write(...args, controller.signal),
          scope: params.scope,
          loadingTimeoutMs: 30_000,
          // Preserve the Windows stale-frame guard with the target-only CDP source.
          checkFreshness: platform.os === "win",
          progress: (_phase, value, count) => {
            progress = value;
            frames = count;
          },
          label: i18n.t("longScreenshot.pageProgress", { ns: "extension" }),
          cancelLabel: i18n.t("longScreenshot.cancel", { ns: "extension" }),
        });
      },
    );
    controller.signal.throwIfAborted();
    await writer.finish();
    phase = "encoding";
    const file = await exportPng(writer.shot, controller.signal);
    controller.signal.throwIfAborted();
    await checkTab();
    // No await between the final ownership check and publishing the export.
    checkOwnership();
    deps.exports.put(ctx.sessionId, id, file);
    retained = true;
    return attachDialogs(deps.cdp, target.tabId, cursor, {
      scope: params.scope ?? "follow",
      capture_id: id,
      width: writer.shot.width,
      height: writer.shot.height,
      format: "png" as const,
      tab_id: target.tabId,
      byte_size: file.size,
    });
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    if (controller.signal.aborted && !(reason instanceof ScreenshotError))
      return { code: "cancelled", message: "Full-page screenshot cancelled; no image was saved" };
    const details = { phase, frames, progress, captured_height: writer.shot.height };
    if (reason instanceof ScreenshotError) {
      if (reason.reason) {
        const messages = {
          user_cancelled: "Full-page screenshot cancelled by user input",
          page_hidden:
            "Full-page screenshot stopped because the page became hidden; keep the capture tab visible",
          navigation: "Full-page screenshot stopped because the page navigated",
          watchdog_timeout: "Full-page screenshot lost contact with the page",
          stale_frame: "Screenshot pixels did not update after scrolling; no image was saved",
          loading_stalled:
            "Page height stopped growing for 30s while its loading indicator remained; use --scope current to capture the current document range",
        };
        return {
          code:
            reason.reason === "user_cancelled"
              ? "cancelled"
              : reason.reason === "watchdog_timeout" || reason.reason === "loading_stalled"
                ? "timeout"
                : "cdp_failed",
          message: messages[reason.reason],
          data: { ...details, reason: reason.reason },
        };
      }
      if (reason.code === "timeout")
        return {
          code: "timeout",
          message: controller.signal.aborted
            ? "Full-page screenshot timed out; increase --timeout for longer pages"
            : `Full-page screenshot: browser operation timed out (${phase})`,
          data: details,
        };
      if (reason.code === "autoUnavailable" || reason.code === "unavailable")
        return {
          code: "unsupported",
          message: "This page does not allow automatic scrolling for full-page screenshots",
        };
      if (reason.code === "busy")
        return { code: "invalid_params", message: "A screenshot is already running on this page" };
      return rpcError(
        "cdp_failed",
        "screenshot_capture_failed",
        `Full-page screenshot failed (${reason.code}); no partial image was saved`,
      );
    }
    return rpcError(
      "cdp_failed",
      "screenshot_capture_failed",
      reason instanceof Error ? reason.message : String(reason),
    );
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    chrome.webNavigation.onBeforeNavigate.removeListener(navigated);
    chrome.webNavigation.onCommitted.removeListener(navigated);
    chrome.tabs.onRemoved.removeListener(removed);
    chrome.tabs.onAttached.removeListener(removed);
    chrome.runtime.onMessage.removeListener(cancelled);
    if (!retained) await deps.exports.discard(id);
  }
}

/** A screenshot may outlive a responsive renderer. Bound both bridge phases,
 * and send exactly one restore even if the page hid its overlay but never acked. */
async function withScreenshotOverlayHidden<T>(
  tabId: number,
  documentId: string,
  signal: AbortSignal,
  capture: () => Promise<T>,
): Promise<T> {
  const send = (phase: CaptureSuppressPhase) =>
    chrome.tabs.sendMessage(tabId, { type: CAPTURE_SUPPRESS, phase }, { documentId });
  try {
    try {
      await waitForReply(send("begin"), signal);
    } catch (error) {
      // A missing overlay script is allowed, but a stuck renderer must stop capture.
      if (signal.aborted || error instanceof ScreenshotError) throw error;
    }
    signal.throwIfAborted();
    return await capture();
  } finally {
    // Cleanup must still be sent after cancellation, to the original document.
    await waitForReply(send("end"), undefined, 1000).catch(() => {});
  }
}
