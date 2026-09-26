import { afterEach, expect, it, vi } from "vitest";
import { downloadTriggerDeps } from "../download-trigger";
import type { CdpRunner } from "../shared";

afterEach(() => vi.useRealTimers());

it("does not send cleanup input to a replacement attachment", async () => {
  const abort = new AbortController();
  let attachment = "first";
  const cdp: CdpRunner = {
    send: vi.fn(async () => ({})) as CdpRunner["send"],
    getAttachmentId: () => attachment,
  };
  const scope = downloadTriggerDeps(
    { cdp, tabsApi: { get: vi.fn(), query: vi.fn() } },
    abort.signal,
  );
  await scope.deps.cdp.send(7, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
  });
  abort.abort();
  attachment = "replacement";
  await scope.cleanup(Date.now() + 1_000);
  expect(cdp.send).toHaveBeenCalledTimes(1);
  await expect(
    scope.deps.cdp.send(7, "Input.dispatchMouseEvent", { type: "mouseReleased" }),
  ).rejects.toThrow("aborted");
});

it("bounds a lost button-release reply and detaches without replaying input", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const cdp: CdpRunner = {
    send: vi.fn(async () => ({})) as CdpRunner["send"],
    detach: vi.fn(async () => {}),
  };
  const scope = downloadTriggerDeps(
    { cdp, tabsApi: { get: vi.fn(), query: vi.fn() } },
    abort.signal,
  );
  await scope.deps.cdp.send(7, "Input.dispatchMouseEvent", { type: "mousePressed" });
  vi.mocked(cdp.send).mockImplementation(async () => new Promise(() => {}));
  abort.abort();
  const cleanup = scope.cleanup(Date.now() + 1_000);
  const failed = expect(cleanup).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(1_000);
  await failed;
  expect(cdp.detach).toHaveBeenCalledOnce();
  expect(cdp.send).toHaveBeenCalledTimes(2);
});

it("fences an already pending release rather than sending another one", async () => {
  const abort = new AbortController();
  const cdp: CdpRunner = {
    send: vi.fn(async () => ({})) as CdpRunner["send"],
    detach: vi.fn(async () => {}),
  };
  const scope = downloadTriggerDeps(
    { cdp, tabsApi: { get: vi.fn(), query: vi.fn() } },
    abort.signal,
  );
  await scope.deps.cdp.send(7, "Input.dispatchMouseEvent", { type: "mousePressed" });
  vi.mocked(cdp.send).mockImplementation(async () => new Promise(() => {}));
  void scope.deps.cdp.send(7, "Input.dispatchMouseEvent", { type: "mouseReleased" });
  abort.abort();
  await scope.cleanup(Date.now() + 1_000);
  expect(cdp.detach).toHaveBeenCalledWith(7);
  expect(cdp.send).toHaveBeenCalledTimes(2);
});
