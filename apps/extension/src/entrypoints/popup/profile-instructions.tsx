import { useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import { RiCheckLine, RiFileCopyLine } from "@remixicon/react";
import { useEffect, useRef, useState } from "react";

export function ProfileInstructions({
  label,
  instanceId,
  connected,
}: {
  label: string;
  instanceId: string;
  connected: boolean;
}) {
  const { t } = useTranslation("extension");
  const [feedback, setFeedback] = useState<"copied" | "failed" | null>(null);
  const attempt = useRef(0);
  const ready = connected && Boolean(instanceId);
  const prompt = t("popup.profile.promptTemplate", {
    name: JSON.stringify(label || t("popup.profile.unnamed")),
    instanceId,
    command: `bsk session start --browser ${instanceId} --json`,
    toolCall: `browser_session({ action: "start", browser: ${JSON.stringify(instanceId)} })`,
  });

  useEffect(() => {
    setFeedback(null);
    return () => {
      attempt.current += 1;
    };
  }, [prompt, ready]);

  useEffect(() => {
    if (feedback !== "copied") return;
    const timer = window.setTimeout(() => setFeedback(null), 1500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const copy = async () => {
    if (!ready) return;
    const currentAttempt = ++attempt.current;
    setFeedback(null);
    try {
      await navigator.clipboard.writeText(prompt);
      if (currentAttempt === attempt.current) setFeedback("copied");
    } catch {
      if (currentAttempt === attempt.current) setFeedback("failed");
    }
  };

  return (
    <div className="max-w-[55%] shrink-0">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-auto min-h-7 max-w-full whitespace-normal px-2.5 py-1 text-xs"
        disabled={!ready}
        title={t(ready ? "popup.profile.hint" : "popup.profile.unavailableHint")}
        onClick={() => void copy()}
        data-slot="popup-profile-copy"
      >
        {feedback === "copied" ? (
          <RiCheckLine className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <RiFileCopyLine className="size-3.5 shrink-0" aria-hidden />
        )}
        <span aria-live="polite">
          {t(feedback === "copied" ? "popup.copied" : "popup.profile.copyButton")}
        </span>
      </Button>
      {feedback === "failed" && (
        <p role="alert" className="mt-1 text-[11px] leading-snug text-destructive">
          {t("popup.profile.copyFailed")}
        </p>
      )}
    </div>
  );
}
