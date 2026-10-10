import { i18n } from "@browser-skill/i18n";
import { I18nextProvider, useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVideos, videoTime } from "@/video/client";
import { VideoArtifactStore } from "@/video/store";
import "../long-screenshot/style.css";

function VideoLibrary() {
  const { t } = useTranslation("extension");
  const { recordings, busy, error, run } = useVideos();
  const [selected, setSelected] = useState(new URLSearchParams(location.search).get("id") ?? "");
  const [url, setUrl] = useState("");
  const [playbackError, setPlaybackError] = useState("");
  const recording = recordings.find((value) => value.recording_id === selected) ?? recordings[0];
  useEffect(() => {
    let disposed = false;
    let objectUrl = "";
    setUrl("");
    setPlaybackError("");
    if (recording?.state === "ready") {
      void new VideoArtifactStore()
        .file(recording.recording_id)
        .then((file) => {
          if (!disposed) {
            objectUrl = URL.createObjectURL(file);
            setUrl(objectUrl);
          }
        })
        .catch((reason) => {
          if (!disposed) setPlaybackError(String(reason));
        });
    }
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [recording?.recording_id, recording?.state]);
  return (
    <main className="mx-auto min-h-screen max-w-6xl space-y-5 bg-background p-6 text-foreground">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{t("video.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("video.retention")}</p>
      </header>
      {(error || playbackError) && (
        <p role="alert" className="text-destructive">
          {error || playbackError}
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-[240px_1fr]">
        <aside className="space-y-2" aria-label={t("video.library")}>
          {!recordings.length && (
            <p className="text-sm text-muted-foreground">{t("video.empty")}</p>
          )}
          {recordings.map((value) => (
            <button
              key={value.recording_id}
              type="button"
              aria-pressed={value.recording_id === recording?.recording_id}
              className={`w-full space-y-1 rounded-lg border p-3 text-left text-sm ${value.recording_id === recording?.recording_id ? "border-primary" : ""}`}
              onClick={() => setSelected(value.recording_id)}
            >
              <span className="block truncate">{value.title}</span>
              <span className="block text-xs text-muted-foreground">
                {new Date(value.created_at).toLocaleString()} · {videoTime(value.duration_ms)}
              </span>
              <span className="text-xs">{t(`video.state.${value.state}`)}</span>
            </button>
          ))}
        </aside>
        {recording && (
          <section className="min-w-0 space-y-4">
            <h2 className="break-words text-lg font-medium">{recording.title}</h2>
            {url ? (
              <video
                className="max-h-[65vh] w-full rounded-lg bg-black"
                src={url}
                controls
                preload="metadata"
                onError={() => setPlaybackError(t("video.playbackError"))}
              >
                <track kind="captions" />
              </video>
            ) : (
              <div className="rounded-lg border p-12 text-center">
                {t(`video.state.${recording.state}`)}
              </div>
            )}
            <p className="text-sm">
              {t(
                recording.state === "ready"
                  ? recording.exported
                    ? "video.saved"
                    : "video.unsaved"
                  : `video.state.${recording.state}`,
              )}
            </p>
            {recording.state === "ready" && recording.completeness === "partial" && (
              <p className="text-sm text-destructive">{t("video.partial")}</p>
            )}
            {recording.stop_reason && (
              <p className="text-sm text-muted-foreground">
                {t(`video.reason.${recording.stop_reason}`)}
              </p>
            )}
            {recording.error && <p className="text-sm text-destructive">{recording.error}</p>}
            <p className="text-xs text-muted-foreground">
              {videoTime(recording.duration_ms)} · {recording.width} × {recording.height} ·{" "}
              {(recording.byte_size / 1048576).toFixed(1)} MB · MP4 / H.264
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || recording.state !== "ready"}
                onClick={() => void run("save", { recording_id: recording.recording_id })}
              >
                {t("video.save")}
              </Button>
              {!["ready", "failed"].includes(recording.state) && (
                <Button
                  variant="outline"
                  disabled={busy || recording.state === "finalizing"}
                  onClick={() => void run("stop", { recording_id: recording.recording_id })}
                >
                  {t("video.stop")}
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy || !["ready", "failed"].includes(recording.state)}
                onClick={() => {
                  if (window.confirm(t("video.deleteConfirm")))
                    void run("discard", { recording_id: recording.recording_id });
                }}
              >
                {t("video.delete")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("video.saveHint")}</p>
          </section>
        )}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nextProvider i18n={i18n}>
    <VideoLibrary />
  </I18nextProvider>,
);
