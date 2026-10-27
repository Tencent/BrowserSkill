import { useEffect, useState } from "react";
import { VIDEO_MESSAGE, type VideoRecording, type VideoTask } from "./types";

export async function videoRequest<T = unknown>(action: string, params: object = {}): Promise<T> {
  const response = await chrome.runtime.sendMessage({ kind: VIDEO_MESSAGE, action, ...params });
  if (!response?.ok) throw new Error(response?.error ?? "Video service is unavailable");
  return response.data as T;
}

export function useVideos() {
  const [snapshot, setSnapshot] = useState<{ tasks: VideoTask[]; recordings: VideoRecording[] }>({
    tasks: [],
    recordings: [],
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await videoRequest<typeof snapshot>("snapshot");
        if (!disposed) setSnapshot(next);
      } catch (reason) {
        if (!disposed) setError(String(reason));
      } finally {
        if (!disposed) timer = setTimeout(refresh, 1000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  const run = async (action: string, params: object = {}) => {
    // Task interruption stays available while a save/stop request is pending.
    const setPending = action === "interrupt" ? setInterrupting : setBusy;
    setPending(true);
    setError("");
    try {
      await videoRequest(action, params);
      setSnapshot(await videoRequest("snapshot"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  return { ...snapshot, error, busy, interrupting, run };
}

export function videoTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function openVideo(id?: string): Promise<chrome.tabs.Tab> {
  return chrome.tabs.create({
    url: chrome.runtime.getURL(`video.html${id ? `?id=${encodeURIComponent(id)}` : ""}`),
  });
}
