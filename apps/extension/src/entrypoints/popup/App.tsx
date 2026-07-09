import { useTranslation } from "@browser-skill/i18n/react";
import { Badge, Button, cn, Input, Label } from "@browser-skill/ui";
import { RiCheckLine, RiFileCopyLine } from "@remixicon/react";
import { type ChangeEvent, useEffect, useState } from "react";
import { PROTOCOL_VERSION } from "@/transport/handshake";
import { ConnectionStatusIndicator } from "./connection-status-indicator";
import { type PopupStatusState, useConnectionState } from "./use-connection-state";

const STATE_LABEL_KEYS = {
  disconnected: "popup.stateLabel.disconnected",
  connected: "popup.stateLabel.connected",
  version_skew: "popup.stateLabel.version_skew",
  disabled: "popup.stateLabel.disabled",
} as const satisfies Record<PopupStatusState, string>;

const STATE_BADGE_KEYS = {
  disconnected: "popup.stateBadge.disconnected",
  connected: "popup.stateBadge.connected",
  version_skew: "popup.stateBadge.version_skew",
  disabled: "popup.stateBadge.disabled",
} as const satisfies Record<PopupStatusState, string>;

function getLogoSrc() {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL("icon/logo.png");
  }
  return "/icon/logo.png";
}

export function App() {
  const { t } = useTranslation("extension");
  const { snapshot, statusState, setLabel, setConnectionEnabled } = useConnectionState();
  const [labelDraft, setLabelDraft] = useState(snapshot.label);
  const [copiedInstanceId, setCopiedInstanceId] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = (isDark: boolean) => {
      document.documentElement.classList.toggle("dark", isDark);
    };
    applyTheme(query.matches);
    const onChange = (event: MediaQueryListEvent) => applyTheme(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    setLabelDraft(snapshot.label);
  }, [snapshot.label]);

  useEffect(() => {
    setCopiedInstanceId(false);
  }, [snapshot.instanceId]);

  const onLabelBlur = () => {
    if (labelDraft !== snapshot.label) setLabel(labelDraft);
  };

  const isSkewed = statusState === "version_skew";
  const daemonVersion = snapshot.handshake?.version ?? "—";
  const daemonProtocol = snapshot.handshake?.protocol_version ?? "—";
  const extensionVersion = snapshot.extensionVersion || "—";
  const instanceId = snapshot.instanceId || "—";

  const copyInstanceId = async () => {
    if (!snapshot.instanceId || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(snapshot.instanceId);
    setCopiedInstanceId(true);
  };

  return (
    <main
      className="min-w-[320px] max-w-[340px] space-y-3 bg-background p-3 text-foreground"
      data-slot="popup-root"
      data-version-skew={isSkewed ? "true" : undefined}
    >
      <header className="flex items-center gap-2" data-slot="popup-brand-header">
        <img src={getLogoSrc()} alt="" className="size-7 rounded-lg" data-slot="popup-brand-logo" />
        <h1 className="text-sm font-semibold tracking-tight">{t("popup.brandName")}</h1>
      </header>

      <section
        className="rounded-xl border border-border/80 bg-card/60 px-3 py-2.5"
        data-slot="popup-connection-card"
      >
        <div className="flex items-center justify-between gap-2" data-slot="popup-status">
          <div className="flex min-w-0 items-center gap-2">
            <ConnectionStatusIndicator state={statusState} />
            <span className="truncate text-sm font-medium" data-slot="popup-state-label">
              {t(STATE_LABEL_KEYS[statusState])}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge
              variant="outline"
              className="px-1.5 py-0 text-[10px] font-medium uppercase"
              data-slot="popup-state-badge"
            >
              {t(STATE_BADGE_KEYS[statusState])}
            </Badge>
            <button
              type="button"
              role="switch"
              aria-checked={snapshot.connectionEnabled}
              aria-label={t("popup.connectionToggleTitle")}
              data-slot="popup-connection-toggle"
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                snapshot.connectionEnabled ? "bg-primary" : "bg-muted",
              )}
              onClick={() => setConnectionEnabled(!snapshot.connectionEnabled)}
            >
              <span
                className={cn(
                  "pointer-events-none block size-4 rounded-full bg-background shadow-sm transition-transform",
                  snapshot.connectionEnabled ? "translate-x-4" : "translate-x-0.5",
                )}
                aria-hidden
              />
            </button>
          </div>
        </div>
        {isSkewed && (
          <p
            className="mt-2 text-xs leading-snug text-amber-600 dark:text-amber-400"
            data-slot="popup-version-skew-warning"
          >
            {t("popup.versionSkewWarning", {
              extensionProtocol: PROTOCOL_VERSION,
              daemonProtocol,
            })}
          </p>
        )}
      </section>

      {snapshot.lastError && (
        <div
          className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs leading-snug text-destructive"
          data-slot="popup-error"
        >
          {snapshot.lastError}
        </div>
      )}

      <div className="flex flex-col gap-3" data-slot="popup-label-field">
        <Label htmlFor="bh-label" className="block text-xs text-muted-foreground">
          {t("popup.labelTitle")}
        </Label>
        <Input
          id="bh-label"
          type="text"
          value={labelDraft}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setLabelDraft(event.target.value)}
          onBlur={onLabelBlur}
          placeholder={t("popup.labelPlaceholder")}
          className="mt-0 h-8 text-sm"
          data-slot="popup-label-input"
        />
      </div>

      <section
        className="flex min-w-0 items-center justify-between gap-2 border-t border-border/70 pt-2 text-[10px] leading-tight text-muted-foreground"
        data-slot="popup-meta"
      >
        <div className="flex shrink-0 items-center gap-1">
          <span title={t("popup.extensionVersionHint")}>{extensionVersion}</span>
          <span aria-hidden>/</span>
          <span title={t("popup.daemonVersionHint")}>{daemonVersion}</span>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-1">
          <span className="shrink-0">{t("popup.instanceTitle")}</span>
          <code
            className="max-w-[88px] truncate font-mono text-[10px] text-foreground/80"
            data-slot="popup-instance-id"
          >
            {instanceId}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5 rounded-md"
            disabled={!snapshot.instanceId}
            aria-label={t("popup.copyInstanceId")}
            title={copiedInstanceId ? t("popup.copied") : t("popup.copyInstanceId")}
            onClick={() => {
              void copyInstanceId();
            }}
            data-slot="popup-copy-instance-id"
          >
            {copiedInstanceId ? (
              <RiCheckLine className="size-3" aria-hidden />
            ) : (
              <RiFileCopyLine className="size-3" aria-hidden />
            )}
          </Button>
        </div>
      </section>
    </main>
  );
}
