// @vitest-environment happy-dom
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScreenshotImage } from "../../src/client/ScreenshotImage";

const attachment = {
  attachmentId: "sha256:screenshot",
  mediaType: "image/png",
  bytes: 4,
  width: 800,
  height: 457,
  name: "screenshot.png",
} as ImageAttachmentRef;

beforeEach(() => vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("retries an attachment read failure and releases the loaded URL on unmount", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("blob:retry");
  const view = render(<ScreenshotImage attachment={attachment} load={load} />);
  expect(screen.getByRole("status").textContent).toBe("Loading…");
  fireEvent.click(await screen.findByRole("button", { name: "Load failed — retry" }));
  expect((await screen.findByRole("img")).getAttribute("src")).toBe("blob:retry");
  expect(load).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:retry");
});

it("also offers retry when the image cannot decode", async () => {
  const load = vi.fn().mockResolvedValueOnce("blob:broken").mockResolvedValueOnce("blob:good");
  render(<ScreenshotImage attachment={attachment} load={load} />);
  fireEvent.error(await screen.findByRole("img"));
  fireEvent.click(screen.getByRole("button", { name: "Load failed — retry" }));
  expect((await screen.findByRole("img")).getAttribute("src")).toBe("blob:good");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:broken");
});

it("releases an attachment URL that arrives after the card unmounts", async () => {
  let finish!: (url: string) => void;
  const load = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<ScreenshotImage attachment={attachment} load={load} />);
  view.unmount();
  await act(async () => finish("blob:late"));
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:late");
  expect(screen.queryByRole("img")).toBeNull();
});

it("ignores stale loads when the attachment changes", async () => {
  let finish!: (url: string) => void;
  const load = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce("blob:next");
  const view = render(<ScreenshotImage attachment={attachment} load={load} />);
  view.rerender(<ScreenshotImage attachment={{ ...attachment, name: "next.png" }} load={load} />);
  await screen.findByRole("img", { name: "next.png" });
  await act(async () => finish("blob:previous"));
  expect(screen.getByRole("img").getAttribute("src")).toBe("blob:next");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:previous");
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:next");
});

it("releases the previous URL when the owning loader changes", async () => {
  const load = vi.fn(async () => "blob:original");
  const view = render(<ScreenshotImage attachment={attachment} load={load} />);
  await screen.findByRole("img");
  const nextLoad = vi.fn(async () => "blob:replacement");
  view.rerender(<ScreenshotImage attachment={attachment} load={nextLoad} />);
  await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).toBe("blob:replacement"));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:original");
});
