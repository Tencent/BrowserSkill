import { useTranslation } from "@browser-skill/i18n/react";
import { Button, Input, Label } from "@browser-skill/ui";
import { RiPencilLine } from "@remixicon/react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { SHORT_INSTANCE_ID_PATTERN } from "@/lib/instance-id";
import { ProfileInstructions } from "./profile-instructions";

const MAX_LABEL_LENGTH = 48;

export function BrowserProfile({
  label,
  instanceId,
  connected,
  sessionCount,
  onSave,
}: {
  label: string;
  instanceId: string;
  connected: boolean;
  sessionCount: number;
  onSave: (value: string) => void;
}) {
  const { t } = useTranslation("extension");
  const [draft, setDraft] = useState(label);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(label);
    setEditing(false);
  }, [label]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const normalized = draft.trim();
  const changed = normalized !== label;
  const busy = sessionCount > 0;
  const ready = connected && Boolean(instanceId);
  const looksLikeInstanceId = normalized !== "" && SHORT_INSTANCE_ID_PATTERN.test(normalized);
  const save = () => {
    if (busy || !changed || looksLikeInstanceId) return;
    onSave(normalized);
  };
  const cancel = () => {
    setDraft(label);
    setEditing(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      cancel();
    }
  };

  return (
    <div className="mt-3 space-y-1.5" data-slot="popup-profile">
      {editing ? (
        <>
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
              ref={inputRef}
              aria-invalid={looksLikeInstanceId || undefined}
              aria-describedby="bsk-browser-label-hint"
              data-slot="popup-label-input"
            />
          </div>
          <div className="flex items-center justify-end gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={cancel}>
              {t("popup.browserLabel.cancel")}
            </Button>
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
            <p
              id="bsk-browser-label-hint"
              className="text-[11px] leading-snug text-muted-foreground"
            >
              {t("popup.browserLabel.busyHint")}
            </p>
          ) : looksLikeInstanceId ? (
            <p id="bsk-browser-label-hint" role="alert" className="text-[11px] text-destructive">
              {t("popup.browserLabel.instanceIdError")}
            </p>
          ) : (
            <p
              id="bsk-browser-label-hint"
              className="text-[11px] leading-snug text-muted-foreground"
            >
              {t("popup.browserLabel.hint")}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground">{t("popup.profile.title")}</p>
              <div className="flex min-w-0 items-center gap-1">
                <span className="truncate text-sm font-medium" title={label || undefined}>
                  {label || t("popup.profile.unnamed")}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0 text-muted-foreground"
                  aria-label={t("popup.browserLabel.edit")}
                  title={t(busy ? "popup.browserLabel.busyHint" : "popup.browserLabel.edit")}
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  <RiPencilLine className="size-3.5" aria-hidden />
                </Button>
              </div>
            </div>
            <ProfileInstructions label={label} instanceId={instanceId} connected={connected} />
          </div>
          {!ready && (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t("popup.profile.unavailableHint")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
