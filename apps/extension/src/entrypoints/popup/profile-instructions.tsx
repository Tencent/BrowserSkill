import { useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import { RiFileCopyLine } from "@remixicon/react";
import { useState } from "react";

export function ProfileInstructions({
  instanceId,
  connected,
}: {
  instanceId: string;
  connected: boolean;
}) {
  const { t } = useTranslation("extension");
  const [feedback, setFeedback] = useState<{
    instanceId: string;
    kind: "copied" | "failed";
  } | null>(null);
  const ready = connected && Boolean(instanceId);
  const currentFeedback = ready && feedback?.instanceId === instanceId ? feedback.kind : null;

  const copy = async () => {
    if (!ready) return;
    setFeedback(null);
    try {
      await navigator.clipboard.writeText(
        t("popup.profile.promptTemplate", {
          command: `bsk session start --browser ${instanceId} --json`,
          toolCall: `browser_session({ action: "start", browser: ${JSON.stringify(instanceId)} })`,
        }),
      );
      setFeedback({ instanceId, kind: "copied" });
    } catch {
      setFeedback({ instanceId, kind: "failed" });
    }
  };

  return (
    <div className="mt-3 space-y-2 border-t border-border/70 pt-2" data-slot="popup-profile">
      <p className="text-[11px] leading-snug text-muted-foreground">{t("popup.profile.hint")}</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 px-2.5 text-xs"
        disabled={!ready}
        onClick={() => void copy()}
        data-slot="popup-profile-copy"
      >
        <RiFileCopyLine className="size-3.5" aria-hidden />
        {t("popup.profile.copyButton")}
      </Button>
      {currentFeedback && (
        <p
          role={currentFeedback === "failed" ? "alert" : "status"}
          className="text-[11px] leading-snug text-muted-foreground"
        >
          {t(currentFeedback === "failed" ? "popup.profile.copyFailed" : "popup.copied")}
        </p>
      )}
    </div>
  );
}
