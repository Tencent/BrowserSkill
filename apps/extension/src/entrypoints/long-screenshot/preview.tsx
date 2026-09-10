import { useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import { RiDownloadLine, RiImageLine, RiLoader4Line } from "@remixicon/react";
import { useEffect, useState } from "react";
import {
  readScreenshot,
  type SavedScreenshot,
  screenshotFilename,
} from "@/long-screenshot/storage";

export function Preview() {
  const { t } = useTranslation("extension");
  const [shot, setShot] = useState<SavedScreenshot | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const [zoom, setZoom] = useState("fit");

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const theme = () => document.documentElement.classList.toggle("dark", media.matches);
    theme();
    media.addEventListener("change", theme);
    let alive = true;
    let objectUrl = "";
    const id = new URLSearchParams(location.search).get("id");
    void (id ? readScreenshot(id) : Promise.resolve(undefined))
      .then((value) => {
        if (!alive) return;
        if (!value) {
          setError(true);
          return;
        }
        objectUrl = URL.createObjectURL(value.blob);
        setImageUrl(objectUrl);
        setShot(value);
        document.title = `${value.title} · BrowserSkill`;
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      media.removeEventListener("change", theme);
    };
  }, []);

  async function download() {
    if (!shot || !imageUrl) return;
    setSaving(true);
    setDownloadError(false);
    try {
      await chrome.downloads.download({
        url: imageUrl,
        filename: screenshotFilename(shot.title, shot.createdAt),
        saveAs: true,
      });
    } catch {
      setDownloadError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="preview-toolbar sticky top-0 z-10 flex flex-wrap items-center gap-4 border-b border-border bg-background/95 px-6 py-4 backdrop-blur-md">
        <img
          src={chrome.runtime.getURL("icon/logo.png")}
          className="size-8 shrink-0 rounded-lg"
          alt="BrowserSkill"
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold" title={shot?.title}>
            {shot?.title || t("longScreenshot.title")}
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {shot
              ? `${shot.width.toLocaleString()} × ${shot.height.toLocaleString()} px · PNG · ${(shot.blob.size / 1024 / 1024).toFixed(1)} MB`
              : t("longScreenshot.preview")}
          </p>
        </div>
        {shot && (
          <div className="flex items-center gap-3">
            <label className="sr-only" htmlFor="preview-zoom">
              {t("longScreenshot.zoom")}
            </label>
            <select
              id="preview-zoom"
              value={zoom}
              onChange={(event) => setZoom(event.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="fit">{t("longScreenshot.fit")}</option>
              <option value="0.25">25%</option>
              <option value="0.5">50%</option>
              <option value="1">100%</option>
            </select>
            <Button size="sm" disabled={saving} onClick={() => void download()}>
              <RiDownloadLine className="size-4" aria-hidden />
              {t("longScreenshot.download")}
            </Button>
          </div>
        )}
      </header>
      {downloadError && (
        <p role="alert" className="px-6 py-3 text-sm text-destructive">
          {t("longScreenshot.downloadError")}
        </p>
      )}
      {loading ? (
        <div role="status" className="flex justify-center gap-2 p-20 text-sm text-muted-foreground">
          <RiLoader4Line className="size-5 animate-spin" aria-hidden />
          {t("longScreenshot.loading")}
        </div>
      ) : error ? (
        <div
          role="alert"
          className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-24 text-center"
        >
          <RiImageLine className="size-10 text-muted-foreground" aria-hidden />
          <h2 className="font-medium">{t("longScreenshot.missingTitle")}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("longScreenshot.missingDescription")}
          </p>
        </div>
      ) : (
        shot && (
          <>
            <p className="px-6 py-3 text-center text-xs text-muted-foreground">
              {t("longScreenshot.previewHint")}
            </p>
            <div className="preview-canvas overflow-auto p-6 pt-2">
              <img
                src={imageUrl}
                alt={t("longScreenshot.imageAlt", { title: shot.title })}
                onError={() => setError(true)}
                className="preview-image mx-auto block rounded-sm bg-white shadow-lg"
                style={
                  zoom === "fit"
                    ? { width: "100%", maxWidth: Math.min(1100, shot.width) }
                    : { width: shot.width * Number(zoom), maxWidth: "none" }
                }
              />
            </div>
          </>
        )
      )}
    </main>
  );
}
