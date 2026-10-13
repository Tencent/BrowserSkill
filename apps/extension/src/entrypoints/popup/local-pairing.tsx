import { useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import { useState } from "react";
import type { LocalAuthStatus } from "@/transport/local-auth";
import { Switch } from "./switch";

export interface LocalPairingInfo {
  policy: { skip: boolean; everPaired: boolean; legacyCompat: boolean };
  devices: { daemonId: string; deviceId: string; endpoint: string }[];
}
export async function localPairingRequest(request: Record<string, unknown>) {
  const reply = await chrome.runtime.sendMessage({ kind: "bsk-local-pairing", ...request });
  if (!reply || reply.error)
    throw Object.assign(new Error(reply?.error ?? "pairing_failed"), {
      browserId: reply?.browserId,
    });
  return reply;
}
export async function readLocalPairingInfo(): Promise<LocalPairingInfo> {
  return localPairingRequest({ action: "info" });
}
export function LocalPairingNotice({
  status,
  instanceId = "",
  onRetry,
  onRestore,
}: {
  status?: LocalAuthStatus | null;
  instanceId?: string;
  onRetry: () => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation("extension");
  if (!status || status.state === "verified" || status.state === "verifying") return null;
  const key = status.state === "unverified_local" ? (status.reason ?? "skip") : status.state;
  return (
    <div
      data-slot="local-pairing-notice"
      className={`mt-2 rounded-lg p-2 text-xs leading-relaxed ${key === "skip" ? "border border-amber-400/40 bg-amber-400/10" : "bg-muted/60"}`}
    >
      <p>
        {t(`popup.localAuth.message.${key}`, {
          browser: status.browserId ?? instanceId,
          instance: instanceId,
        })}
      </p>
      {key === "skip" && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-1 h-7 px-1 text-xs"
          onClick={onRestore}
        >
          {t("popup.localAuth.restore")}
        </Button>
      )}
      {["server_unverified", "daemon_too_old", "busy"].includes(key) && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-1 h-7 px-1 text-xs"
          onClick={onRetry}
        >
          {t("popup.localAuth.retry")}
        </Button>
      )}
    </div>
  );
}
export function LocalVerificationControls({
  skip,
  disabled,
  onChange,
}: {
  skip: boolean;
  disabled: boolean;
  onChange: (skip: boolean) => Promise<void>;
}) {
  const { t } = useTranslation("extension");
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  async function save(next: boolean) {
    setSaving(true);
    setError(false);
    try {
      await onChange(next);
      setConfirm(false);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <details className="border-t border-border/70 pt-2" data-slot="local-advanced">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t("popup.localAuth.advanced")}
        </summary>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-xs">{t("popup.localAuth.skipLabel")}</span>
          <Switch
            aria-label={t("popup.localAuth.skipLabel")}
            checked={skip}
            disabled={disabled || saving}
            onCheckedChange={(next) => (next ? setConfirm(true) : void save(false))}
          />
        </div>
        {confirm && (
          <div
            role="alertdialog"
            aria-label={t("popup.localAuth.skipConfirmTitle")}
            className="mt-2 space-y-2 rounded-lg border border-amber-400/40 p-2 text-xs"
          >
            <p>{t("popup.localAuth.skipConfirm")}</p>
            <p className="break-words font-mono">bsk daemon trust-local on</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={saving} onClick={() => void save(true)}>
                {t("popup.localAuth.confirmSkip")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => setConfirm(false)}
              >
                {t("popup.connectionCancel")}
              </Button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {t("popup.localAuth.settingsFailed")}
          </p>
        )}
      </details>
    </>
  );
}
