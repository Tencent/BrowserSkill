import { useTranslation } from "@browser-skill/i18n/react";
import { Button, Input, Label } from "@browser-skill/ui";
import { useState } from "react";
import { openVideo, useVideos, videoTime } from "@/video/client";
import type { VideoQuality } from "@/video/types";

export function VideoPanel() {
  const { t } = useTranslation("extension");
  const { tasks, recordings, busy, interrupting, error, run } = useVideos();
  const [session, setSession] = useState("");
  const [tab, setTab] = useState("");
  const [duration, setDuration] = useState(60);
  const [quality, setQuality] = useState<VideoQuality>("standard");
  const [copied, setCopied] = useState(false);
  const task =
    tasks.find((value) => value.session_id === session) ??
    (tasks.length === 1 ? tasks[0] : undefined);
  const target =
    task?.tabs.find((value) => String(value.id) === tab) ??
    (task?.tabs.length === 1 ? task.tabs[0] : undefined);
  const active = recordings.find((value) =>
    ["starting", "recording", "finalizing"].includes(value.state),
  );
  const elapsed = active?.started_at
    ? Math.min(active.max_duration_ms, Date.now() - active.started_at)
    : 0;
  const valid = task && target && Number.isInteger(duration) && duration >= 1 && duration <= 600;
  const selectClass = "w-full rounded-md border bg-background p-2 text-xs";

  return (
    <section className="space-y-3" data-slot="video-panel">
      <p className="text-xs text-muted-foreground">{t("video.description")}</p>
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
      {active ? (
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-sm font-medium">{t(`video.state.${active.state}`)}</p>
          <p className="truncate text-xs" title={active.title}>
            {active.title}
          </p>
          <p className="text-xs tabular-nums">
            {videoTime(elapsed)} / {videoTime(active.max_duration_ms)} ·{" "}
            {t("video.remaining", { time: videoTime(active.max_duration_ms - elapsed) })}
          </p>
          <p className="text-xs text-muted-foreground">{t("video.backgroundHint")}</p>
          <Button
            className="w-full"
            disabled={busy || active.state === "finalizing"}
            onClick={() => void run("stop", { recording_id: active.recording_id })}
          >
            {t("video.stop")}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={interrupting}
            onClick={() => void run("interrupt", { session_id: active.session_id })}
          >
            {t("video.interrupt")}
          </Button>
        </div>
      ) : (
        <>
          {!tasks.length && <p className="rounded-lg border p-3 text-xs">{t("video.noTask")}</p>}
          <div className="space-y-1">
            <Label htmlFor="video-task">{t("video.task")}</Label>
            <select
              id="video-task"
              className={selectClass}
              value={task?.session_id ?? ""}
              onChange={(event) => {
                setSession(event.target.value);
                setTab("");
              }}
            >
              <option value="">{t("video.chooseTask")}</option>
              {tasks.map((value) => (
                <option key={value.session_id} value={value.session_id}>
                  {value.session_id}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="video-tab">{t("video.tab")}</Label>
            <select
              id="video-tab"
              className={selectClass}
              value={target?.id ?? ""}
              onChange={(event) => setTab(event.target.value)}
            >
              <option value="">{t("video.chooseTab")}</option>
              {task?.tabs.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.title || value.url || value.id}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="video-duration">{t("video.duration")}</Label>
              <Input
                id="video-duration"
                type="number"
                min={1}
                max={600}
                value={duration}
                onChange={(event) => setDuration(Number(event.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="video-quality">{t("video.quality")}</Label>
              <select
                id="video-quality"
                className={selectClass}
                value={quality}
                onChange={(event) => setQuality(event.target.value as VideoQuality)}
              >
                <option value="standard">{t("video.standard")}</option>
                <option value="clear">{t("video.clear")}</option>
              </select>
            </div>
          </div>
          <Button
            className="w-full"
            disabled={!valid || busy}
            onClick={() =>
              void run("start", {
                options: {
                  session_id: task!.session_id,
                  tab_id: target!.id,
                  max_duration_ms: duration * 1000,
                  quality,
                  request_id: crypto.randomUUID(),
                },
              })
            }
          >
            {t("video.start")}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={!valid || busy}
            onClick={() => {
              void navigator.clipboard
                .writeText(
                  t("video.prompt", {
                    command: `bsk video start --session ${task!.session_id} --tab-id ${target!.id} --duration ${duration}s --quality ${quality}`,
                  }),
                )
                .then(() => setCopied(true));
            }}
          >
            {t(copied ? "video.copied" : "video.copyPrompt")}
          </Button>
        </>
      )}
      <Button variant="ghost" className="w-full" onClick={() => void openVideo()}>
        {t("video.recent", { count: recordings.length })}
      </Button>
      {recordings
        .filter((value) => value.state === "ready")
        .slice(0, 2)
        .map((value) => (
          <button
            type="button"
            key={value.recording_id}
            className="w-full rounded-lg border p-2 text-left text-xs"
            onClick={() => void openVideo(value.recording_id)}
          >
            <span className="block truncate">{value.title}</span>
            <span className="text-muted-foreground">
              {t(
                value.completeness === "partial"
                  ? "video.partial"
                  : value.exported
                    ? "video.saved"
                    : "video.unsaved",
              )}{" "}
              · {videoTime(value.duration_ms)}
            </span>
          </button>
        ))}
    </section>
  );
}
