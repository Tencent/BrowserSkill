// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePip } from "../../src/client/observation-view";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pendingWindow() {
  let resolve!: (win: Window) => void;
  const promise = new Promise<Window>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pipWindow() {
  const listeners: (() => void)[] = [];
  const close = vi.fn();
  const win = {
    document: document.implementation.createHTMLDocument("pip"),
    addEventListener: (name: string, listener: () => void) => {
      if (name === "pagehide") listeners.push(listener);
    },
    close,
  } as unknown as Window;
  return { win, close, pagehide: () => listeners.forEach((listener) => listener()) };
}

it("closes a PiP window that opens after its carrier unmounts", async () => {
  const pending = pendingWindow();
  const opened = pipWindow();
  vi.stubGlobal("documentPictureInPicture", { requestWindow: () => pending.promise });
  const { result, unmount } = renderHook(() => usePip());
  act(() => result.current.popOut());
  unmount();

  await act(async () => pending.resolve(opened.win));

  expect(opened.close).toHaveBeenCalledOnce();
});

it("closes an older pending result without replacing the latest PiP window", async () => {
  const first = pendingWindow();
  const second = pendingWindow();
  const older = pipWindow();
  const latest = pipWindow();
  const requestWindow = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  vi.stubGlobal("documentPictureInPicture", { requestWindow });
  const { result, unmount } = renderHook(() => usePip());
  act(() => {
    result.current.popOut();
    result.current.popOut();
  });

  await act(async () => second.resolve(latest.win));
  await act(async () => first.resolve(older.win));

  expect(result.current.pipWindow).toBe(latest.win);
  expect(older.close).toHaveBeenCalledOnce();
  expect(latest.close).not.toHaveBeenCalled();
  unmount();
  expect(latest.close).toHaveBeenCalledOnce();
});

it("ignores pagehide from a replaced PiP window", async () => {
  const older = pipWindow();
  const latest = pipWindow();
  const requestWindow = vi.fn().mockResolvedValueOnce(older.win).mockResolvedValueOnce(latest.win);
  vi.stubGlobal("documentPictureInPicture", { requestWindow });
  const { result } = renderHook(() => usePip());
  await act(async () => result.current.popOut());
  await act(async () => result.current.popOut());
  expect(older.close).toHaveBeenCalledOnce();

  act(() => older.pagehide());
  expect(result.current.pipWindow).toBe(latest.win);
  expect(latest.close).not.toHaveBeenCalled();

  act(() => latest.pagehide());
  expect(result.current.pipWindow).toBeNull();
});

it("does not close the active window when an older request returns the same window", async () => {
  const first = pendingWindow();
  const second = pendingWindow();
  const shared = pipWindow();
  const requestWindow = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  vi.stubGlobal("documentPictureInPicture", { requestWindow });
  const { result } = renderHook(() => usePip());
  act(() => {
    result.current.popOut();
    result.current.popOut();
  });
  await act(async () => second.resolve(shared.win));
  await act(async () => first.resolve(shared.win));

  expect(result.current.pipWindow).toBe(shared.win);
  expect(shared.close).not.toHaveBeenCalled();
});

it.each([
  "styles",
  "listener",
])("closes a window when %s initialization fails and preserves the previous window", async (failure) => {
  const previous = pipWindow();
  const failed = pipWindow();
  const requestWindow = vi
    .fn()
    .mockResolvedValueOnce(previous.win)
    .mockResolvedValueOnce(failed.win);
  vi.stubGlobal("documentPictureInPicture", { requestWindow });
  const { result } = renderHook(() => usePip());
  await act(async () => result.current.popOut());
  const fail = () => {
    throw new Error("PiP initialization failed");
  };
  if (failure === "styles") vi.spyOn(document, "querySelectorAll").mockImplementationOnce(fail);
  else vi.spyOn(failed.win, "addEventListener").mockImplementationOnce(fail);

  await act(async () => result.current.popOut());

  expect(result.current.pipWindow).toBe(previous.win);
  expect(previous.close).not.toHaveBeenCalled();
  expect(failed.close).toHaveBeenCalledOnce();
});
