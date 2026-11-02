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

it.each([
  { width: 1280, height: 40, boxWidth: 240, ratio: 4, fit: "cover", position: "left center" },
  { width: 300, height: 3000, boxWidth: 60, ratio: 0.25, fit: "cover", position: "center top" },
  { width: 1, height: 10000, boxWidth: 60, ratio: 0.25, fit: "cover", position: "center top" },
  { width: 16, height: 16, boxWidth: 60, ratio: 1, fit: "scale-down", position: "center" },
  { width: 128, height: 96, boxWidth: 128, ratio: 4 / 3, fit: "scale-down", position: "center" },
])("keeps a $width×$height capture usable without cropping its preview", async (size) => {
  const imageAttachment = { ...attachment, width: size.width, height: size.height };
  let finish!: (url: string) => void;
  const load = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  render(<ScreenshotImage attachment={imageAttachment} load={load} />);
  const frame = screen.getByRole("status").parentElement!;
  expect(frame.style.width).toBe(`${size.boxWidth}px`);
  const [horizontal, vertical = 1] = frame.style.aspectRatio.split("/").map(Number);
  expect(horizontal / vertical).toBe(size.ratio);
  await act(async () => finish("blob:thumbnail"));
  const thumbnail = screen.getByRole("img");
  expect(thumbnail.parentElement?.parentElement).toBe(frame);
  expect(thumbnail.style.objectFit).toBe(size.fit);
  expect(thumbnail.style.objectPosition).toBe(size.position);

  fireEvent.click(screen.getByRole("button", { name: "Open screenshot screenshot.png" }));
  const preview = screen.getByRole("dialog").querySelector("img")!;
  expect(preview.getAttribute("src")).toBe("blob:thumbnail");
  expect(preview.style.objectFit).toBe("");
  expect(preview.style.objectPosition).toBe("");
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
