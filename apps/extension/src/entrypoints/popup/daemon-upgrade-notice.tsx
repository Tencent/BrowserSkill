import { useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import { RiAlertLine, RiCheckLine, RiFileCopyLine } from "@remixicon/react";
import { useEffect, useRef, useState } from "react";
import type { SnapshotInfo } from "@/lib/connection-controller";

export function DaemonUpgradeNotice({
  upgrade,
  error,
}: {
  upgrade: NonNullable<SnapshotInfo["daemonUpgradeRequired"]>;
  error: string | null;
}) {
  const { t } = useTranslation("extension");
  const [feedback, setFeedback] = useState<"copied" | "failed" | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    return () => {
      attempt.current += 1;
    };
  }, []);

  useEffect(() => {
    if (feedback !== "copied") return;
    const timer = window.setTimeout(() => setFeedback(null), 1500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const copy = async () => {
    const currentAttempt = ++attempt.current;
    setFeedback(null);
    try {
      await navigator.clipboard.writeText("bsk update");
      if (currentAttempt === attempt.current) setFeedback("copied");
    } catch {
      if (currentAttempt === attempt.current) setFeedback("failed");
    }
  };

  return (
    <section
      role="alert"
      aria-labelledby="daemon-upgrade-title"
      className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-3"
      data-slot="popup-daemon-upgrade"
    >
      <div className="flex items-start gap-2 text-destructive">
        <RiAlertLine className="mt-0.5 size-4 shrink-0" aria-hidden />
        <h2
          id="daemon-upgrade-title"
          className="text-sm font-semibold leading-snug"
          data-slot="popup-daemon-upgrade-title"
        >
          {t("popup.daemonUpgrade.title")}
        </h2>
      </div>
      <p className="text-xs leading-snug">{t("popup.daemonUpgrade.description")}</p>
      {upgrade.daemonVersion && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t("popup.daemonUpgrade.version", { version: upgrade.daemonVersion })}
        </p>
      )}
      <p className="text-xs leading-snug">{t("popup.daemonUpgrade.runCommand")}</p>
      <div className="flex items-center justify-between gap-2 rounded-md border border-border/80 bg-background/80 py-1 pl-2.5 pr-1">
        <code className="shrink-0 font-mono text-xs">bsk update</code>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-auto min-h-7 whitespace-normal px-2 py-1 text-xs"
          onClick={() => void copy()}
          data-slot="popup-daemon-upgrade-copy"
        >
          {feedback === "copied" ? (
            <RiCheckLine className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <RiFileCopyLine className="size-3.5 shrink-0" aria-hidden />
          )}
          <span aria-live="polite">
            {t(feedback === "copied" ? "popup.copied" : "popup.daemonUpgrade.copyButton")}
          </span>
        </Button>
      </div>
      {feedback === "failed" && (
        <p role="status" className="text-[11px] leading-snug text-destructive">
          {t("popup.daemonUpgrade.copyFailed")}
        </p>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        {t("popup.daemonUpgrade.restart")}
      </p>
      <details
        className="text-[11px] leading-snug text-muted-foreground"
        data-slot="popup-daemon-upgrade-details"
      >
        <summary className="cursor-pointer">{t("popup.daemonUpgrade.details")}</summary>
        <p className="mt-1 break-words">
          {t("popup.daemonUpgrade.protocols", {
            actual: upgrade.daemonProtocolVersion,
            required: upgrade.requiredProtocolVersion,
          })}
        </p>
        {error && <p className="mt-1 break-words">{error}</p>}
      </details>
    </section>
  );
}
