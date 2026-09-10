import { useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import { RiCheckLine, RiImageLine, RiLoader4Line } from "@remixicon/react";
import { useEffect, useState } from "react";
import {
  type CaptureError,
  type CaptureReply,
  type CaptureRequest,
  type CaptureState,
  isCapturing,
  LONG_SCREENSHOT,
  LONG_SCREENSHOT_STATE,
} from "@/long-screenshot/types";

export function LongScreenshot() {
  const { t } = useTranslation("extension");
  const [state, setState] = useState<CaptureState | null>(null);
  const [error, setError] = useState<CaptureError | null>(null);
  const [pending, setPending] = useState(true);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let mounted = true;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && changes[LONG_SCREENSHOT_STATE]) {
        setState(changes[LONG_SCREENSHOT_STATE].newValue ?? null);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    void chrome.runtime
      .sendMessage({ type: LONG_SCREENSHOT, action: "status" })
      .then((reply: CaptureReply) => {
        if (!mounted) return;
        if (reply.ok) setState(reply.state);
        else setError(reply.error);
      })
      .catch(() => {
        if (mounted) setError("unavailable");
      })
      .finally(() => {
        if (mounted) setPending(false);
      });
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const active = isCapturing(state);
  useEffect(() => {
    if (!active) setCancelling(false);
  }, [active]);

  async function send(request: CaptureRequest) {
    setPending(true);
    setError(null);
    try {
      const reply: CaptureReply = await chrome.runtime.sendMessage(request);
      if (reply.ok) {
        setState(reply.state);
        if (request.action === "cancel") setCancelling(true);
      } else setError(reply.error);
    } catch {
      setError("unavailable");
    } finally {
      setPending(false);
    }
  }

  const currentError = error ?? (state?.phase === "error" ? state.error : null);
  return (
    <section className="space-y-3" data-slot="popup-long-screenshot">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("longScreenshot.description")}
      </p>
      <div className="rounded-xl border border-border/80 bg-card/60 p-3">
        {active && state ? (
          <div className="space-y-3" role="status" aria-live="polite">
            <div className="flex items-center gap-2 text-xs font-medium">
              <RiLoader4Line className="size-4 animate-spin" aria-hidden />
              <span>
                {t(
                  cancelling ? "longScreenshot.cancelling" : `longScreenshot.phase.${state.phase}`,
                )}
              </span>
              {!cancelling && <span className="ml-auto tabular-nums">{state.progress}%</span>}
            </div>
            <div
              role="progressbar"
              aria-label={t("longScreenshot.title")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={state.progress}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-foreground transition-all"
                style={{ width: `${state.progress}%` }}
              />
            </div>
            <p className="truncate text-[11px] text-muted-foreground" title={state.title}>
              {state.title}
            </p>
          </div>
        ) : state?.phase === "complete" ? (
          <div className="flex items-center gap-2 text-xs">
            <RiCheckLine className="size-5 shrink-0" aria-hidden />
            <div className="min-w-0">
              <p className="font-medium">{t("longScreenshot.phase.complete")}</p>
              <p className="mt-1 text-muted-foreground">
                {state.width} × {state.height} px
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 text-xs text-muted-foreground">
            <RiImageLine className="mt-0.5 size-5 shrink-0" aria-hidden />
            <p className="leading-relaxed">
              {t(state?.phase === "cancelled" ? "longScreenshot.cancelled" : "longScreenshot.hint")}
            </p>
          </div>
        )}
      </div>
      {currentError && (
        <p role="alert" className="text-xs leading-relaxed text-destructive">
          {t(`longScreenshot.errors.${currentError}`)}
        </p>
      )}
      {active && state ? (
        <>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("longScreenshot.runningHint")}
          </p>
          <Button
            className="w-full"
            variant="outline"
            size="sm"
            disabled={pending || cancelling}
            onClick={() => void send({ type: LONG_SCREENSHOT, action: "cancel", id: state.id })}
          >
            {t("longScreenshot.cancel")}
          </Button>
        </>
      ) : (
        <div className="flex gap-2">
          {state?.phase === "complete" && (
            <Button
              className="flex-1"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void send({ type: LONG_SCREENSHOT, action: "preview", id: state.id })}
            >
              {t("longScreenshot.preview")}
            </Button>
          )}
          <Button
            className="flex-1"
            size="sm"
            disabled={pending}
            onClick={() => void send({ type: LONG_SCREENSHOT, action: "start" })}
          >
            {t("longScreenshot.start")}
          </Button>
        </div>
      )}
    </section>
  );
}
