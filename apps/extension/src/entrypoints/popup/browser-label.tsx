import { useTranslation } from "@browser-skill/i18n/react";
import { Button, Input, Label } from "@browser-skill/ui";
import { type KeyboardEvent, useEffect, useState } from "react";
import { SHORT_INSTANCE_ID_PATTERN } from "@/lib/instance-id";

const MAX_LABEL_LENGTH = 48;

export function BrowserLabel({
  label,
  sessionCount,
  onSave,
}: {
  label: string;
  sessionCount: number;
  onSave: (value: string) => void;
}) {
  const { t } = useTranslation("extension");
  const [draft, setDraft] = useState(label);

  useEffect(() => {
    setDraft(label);
  }, [label]);

  const normalized = draft.trim();
  const changed = normalized !== label;
  const busy = sessionCount > 0;
  const looksLikeInstanceId = normalized !== "" && SHORT_INSTANCE_ID_PATTERN.test(normalized);
  const save = () => {
    if (busy || !changed || looksLikeInstanceId) return;
    onSave(normalized);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      setDraft(label);
    }
  };

  return (
    <div className="mt-3 space-y-1.5 border-t border-border/70 pt-2" data-slot="popup-label-field">
      <Label htmlFor="bsk-browser-label" className="text-xs font-medium">
        {t("popup.browserLabel.title")}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id="bsk-browser-label"
          type="text"
          value={draft}
          maxLength={MAX_LABEL_LENGTH}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("popup.browserLabel.placeholder")}
          className="h-8 rounded-lg text-sm"
          aria-invalid={looksLikeInstanceId || undefined}
          aria-describedby="bsk-browser-label-hint"
          data-slot="popup-label-input"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 px-3 text-xs"
          disabled={busy || !changed || looksLikeInstanceId}
          onClick={save}
          data-slot="popup-label-save"
        >
          {t("popup.browserLabel.save")}
        </Button>
      </div>
      {busy ? (
        <p id="bsk-browser-label-hint" className="text-[11px] leading-snug text-muted-foreground">
          {t("popup.browserLabel.busyHint")}
        </p>
      ) : looksLikeInstanceId ? (
        <p id="bsk-browser-label-hint" role="alert" className="text-[11px] text-destructive">
          {t("popup.browserLabel.instanceIdError")}
        </p>
      ) : (
        <p id="bsk-browser-label-hint" className="text-[11px] leading-snug text-muted-foreground">
          {t("popup.browserLabel.hint")}
        </p>
      )}
    </div>
  );
}
