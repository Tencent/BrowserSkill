import { i18n } from "@browser-skill/i18n";
import { withExtensionOverlayHidden } from "@/lib/capture-suppress-bridge";
import { capturePage } from "@/long-screenshot/capture";
import type { ScreenshotExports } from "@/long-screenshot/exports";
import { createPageClient } from "@/long-screenshot/page-client";
import { exportPng } from "@/long-screenshot/png";
import { openScreenshotSource } from "@/long-screenshot/source";
import { removeTiledScreenshot, TileWriter } from "@/long-screenshot/tiles";
import { LONG_SCREENSHOT, ScreenshotError } from "@/long-screenshot/types";
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
  if (!target.active)
    return rpcError(
      "invalid_params",
      "tab_not_active",
      "Select the target tab before capturing a full-page screenshot",
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
  const checkTab = async () => {
    controller.signal.throwIfAborted();
    const current = await deps.tabsApi.get(target.tabId);
    if (
      manager.get(ctx.sessionId) !== ctx ||
      !isAgentControlledTab(ctx, target.tabId) ||
      !current.active ||
      current.windowId !== target.windowId ||
      current.url !== target.url
    )
      throw new ScreenshotError("changed");
    controller.signal.throwIfAborted();
  };
  const client = createPageClient(target.tabId, id, controller.signal, checkTab);
  const changed = () => controller.abort(new ScreenshotError("changed"));
  const navigated = (info: { tabId: number; frameId: number }) => {
    if (info.tabId === target.tabId && info.frameId === 0) changed();
  };
  const removed = (tabId: number) => {
    if (tabId === target.tabId) changed();
  };
  const activated = (info: chrome.tabs.TabActiveInfo) => {
    if (info.windowId === target.windowId && info.tabId !== target.tabId) changed();
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
    const request = message as { type?: string; action?: string; id?: string };
    if (request.type === LONG_SCREENSHOT && request.action === "cancel" && request.id === id)
      controller.abort();
  };
  chrome.webNavigation.onBeforeNavigate.addListener(navigated);
  chrome.webNavigation.onCommitted.addListener(navigated);
  chrome.tabs.onRemoved.addListener(removed);
  chrome.tabs.onAttached.addListener(removed);
  chrome.tabs.onActivated.addListener(activated);
  chrome.runtime.onMessage.addListener(cancelled);
  const writer = new TileWriter(id, new URL(target.url).hostname);
  let retained = false;
  let phase = "preparing";
  let source: Awaited<ReturnType<typeof openScreenshotSource>> | undefined;
  const cursor = markDialogCursor(deps.cdp, target.tabId);
  try {
    await deps.exports.prepare();
    await client.prepare();
    await withExtensionOverlayHidden(
      target.tabId,
      async () => {
        phase = "opening capture source";
        source = await openScreenshotSource(
          target.tabId,
          target.windowId,
          controller.signal,
          checkTab,
          true,
          async () => {
            deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
            await deps.cdp.ensureAttachedToUrl?.(target.tabId, target.url);
            return {
              async capture() {
                const shot = await waitForReply(
                  deps.cdp.send<{ data: string }>(target.tabId, "Page.captureScreenshot", {
                    format: "png",
                    fromSurface: true,
                    captureBeyondViewport: false,
                  }),
                  controller.signal,
                );
                if (!shot.data) throw new ScreenshotError("captureFailed");
                return `data:image/png;base64,${shot.data}`;
              },
              async close() {}, // The session retains ownership of its debugger.
            };
          },
        );
        phase = "capturing";
        await capturePage({
          page: (command) => {
            if (command.action !== "finish") phase = `page ${command.action}`;
            return client.page(command);
          },
          signal: controller.signal,
          screenshot: async () => {
            phase = "reading viewport pixels";
            const data = await source!.capture();
            await checkTab();
            phase = "decoding viewport pixels";
            return createImageBitmap(await (await fetch(data)).blob());
          },
          write: (...args) => writer.write(...args, controller.signal),
          progress: () => {},
          label: i18n.t("longScreenshot.pageProgress", { ns: "extension" }),
          cancelLabel: i18n.t("longScreenshot.cancel", { ns: "extension" }),
        });
      },
      (tabId, message) =>
        chrome.tabs.sendMessage(tabId, message, { documentId: client.documentId }),
    );
    controller.signal.throwIfAborted();
    await writer.finish();
    phase = "encoding";
    const file = await exportPng(writer.shot, controller.signal);
    controller.signal.throwIfAborted();
    deps.exports.put(ctx.sessionId, id, file);
    retained = true;
    return attachDialogs(deps.cdp, target.tabId, cursor, {
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
    if (reason instanceof ScreenshotError) {
      if (reason.code === "timeout")
        return {
          code: "timeout",
          message: controller.signal.aborted
            ? "Full-page screenshot timed out; increase --timeout for longer pages"
            : `Full-page screenshot: browser operation timed out (${phase})`,
          data: { phase },
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
    chrome.tabs.onActivated.removeListener(activated);
    chrome.runtime.onMessage.removeListener(cancelled);
    await source?.close();
    if (!retained) await removeTiledScreenshot(id).catch(() => {});
  }
}
