import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useVideos } from "./client";

afterEach(() => vi.unstubAllGlobals());

it("keeps task interruption independent of a pending video stop", async () => {
  let finish!: () => void;
  const stopping = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const sendMessage = vi.fn(async ({ action }: { action: string }) => {
    if (action === "stop") await stopping;
    return { ok: true, data: { tasks: [], recordings: [] } };
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  const { result, unmount } = renderHook(() => useVideos());
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.run("stop", { recording_id: "video" });
  });
  await waitFor(() => expect(result.current.busy).toBe(true));
  await act(async () => result.current.run("interrupt", { session_id: "task" }));
  expect(result.current.interrupting).toBe(false);
  expect(result.current.busy).toBe(true);
  expect(sendMessage.mock.calls.some(([message]) => message.action === "interrupt")).toBe(true);
  await act(async () => {
    finish();
    await pending;
  });
  expect(result.current.busy).toBe(false);
  unmount();
});
