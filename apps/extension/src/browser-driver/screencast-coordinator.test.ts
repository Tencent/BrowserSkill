import { expect, it, vi } from "vitest";
import type { CdpRunner } from "@/tools/shared";
import { ScreencastCoordinator } from "./screencast-coordinator";

it("shares one stream and ACK, restores remaining consumers and never stops a replacement attachment", async () => {
  let event!: Parameters<NonNullable<CdpRunner["onEvent"]>>[0];
  let attachment = "original";
  const cdp: CdpRunner = {
    send: vi.fn(async () => ({}) as never),
    getAttachmentId: () => attachment,
    onEvent: (handler) => {
      event = handler;
      return { dispose: vi.fn() };
    },
  };
  const coordinator = new ScreencastCoordinator(cdp);
  const frames = vi.fn();
  const video = await coordinator.acquire(7, {
    format: "jpeg",
    maxWidth: 1280,
    maxHeight: 1280,
    frame: frames,
  });
  const screenshot = await coordinator.acquire(7, { format: "png", maxWidth: 32, maxHeight: 32 });
  expect(
    vi.mocked(cdp.send).mock.calls.filter(([, method]) => method === "Page.startScreencast"),
  ).toHaveLength(1);
  event({ tabId: 7 }, "Page.screencastFrame", { data: "test", metadata: {}, sessionId: 9 });
  expect(frames).toHaveBeenCalledOnce();
  expect(
    vi.mocked(cdp.send).mock.calls.filter(([, method]) => method === "Page.screencastFrameAck"),
  ).toHaveLength(1);
  await screenshot.release();
  expect(
    vi.mocked(cdp.send).mock.calls.some(([, method]) => method === "Page.stopScreencast"),
  ).toBe(false);
  attachment = "new";
  const replacement = await coordinator.acquire(7, { format: "png", maxWidth: 32, maxHeight: 32 });
  await video.release();
  expect(
    vi.mocked(cdp.send).mock.calls.some(([, method]) => method === "Page.stopScreencast"),
  ).toBe(false);
  await replacement.release();
  await replacement.release();
  expect(
    vi.mocked(cdp.send).mock.calls.filter(([, method]) => method === "Page.stopScreencast"),
  ).toHaveLength(1);
});

it("does not block another tab behind a slow screencast command", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cdp: CdpRunner = {
    send: vi.fn(async (tab, method) => {
      if (tab === 7 && method === "Page.startScreencast") await blocked;
      return {} as never;
    }),
    getAttachmentId: (tab) => String(tab),
    onEvent: () => ({ dispose() {} }),
  };
  const coordinator = new ScreencastCoordinator(cdp);
  const pending = coordinator.acquire(7, { format: "jpeg", maxWidth: 1280, maxHeight: 1280 });
  const independent = await coordinator.acquire(8, { format: "png", maxWidth: 32, maxHeight: 32 });
  await independent.release();
  release();
  await (await pending).release();
});
