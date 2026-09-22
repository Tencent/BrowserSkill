import { useCallback, useEffect, useState } from "react";
import { debugTasks } from "./client";
import type { DebugTask } from "./types";

/** Poll only while extension UI is visible; never wake a closed popup. */
export function useDebugTasks(enabled = true) {
  const [tasks, setTasks] = useState<DebugTask[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) {
      setTasks([]);
      setLoaded(false);
      return;
    }
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    let live = true;
    let busy = false;
    const update = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const result = await debugTasks();
        if (live) {
          setTasks(result.tasks ?? []);
          setError("");
        }
      } catch (err) {
        if (live) {
          setTasks([]);
          setError(err instanceof Error ? err.message : "unavailable");
        }
      } finally {
        busy = false;
        if (live) setLoaded(true);
      }
    };
    void update();
    const timer = setInterval(() => void update(), 2000);
    document.addEventListener("visibilitychange", update);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [enabled, revision]);
  return { tasks, error, loaded, refresh };
}
