import { useTranslation } from "@browser-skill/i18n/react";
import { Badge, Button, cn, Input, Label } from "@browser-skill/ui";
import {
  RiApps2Line,
  RiArrowLeftLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiFileCopyLine,
} from "@remixicon/react";
import { type ChangeEvent, useEffect, useState } from "react";
import { PROTOCOL_VERSION } from "@/transport/handshake";
import { ConnectionStatusIndicator } from "./connection-status-indicator";
import { POPUP_FEATURES, type PopupView } from "./features";
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
  const { snapshot, statusState, setConnectionEnabled } = useConnectionState();
  const [view, setView] = useState<PopupView>("main");
  const [copiedInstanceId, setCopiedInstanceId] = useState(false);
  const [purposeDraft, setPurposeDraft] = useState("");
  const [startUrlDraft, setStartUrlDraft] = useState("");
  // Bumped on every successful copy so the "copied" toast re-shows (and its
  // auto-hide timer restarts) even when the copied content is unchanged.
  const [copiedTick, setCopiedTick] = useState(0);
  const showCopiedToast = copiedTick > 0;

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
    setCopiedInstanceId(false);
    setCopiedTick(0);
  }, [snapshot.instanceId]);

  // Hide the copied toast when the command changes (topic / start URL edits).
  useEffect(() => {
    setCopiedTick(0);
  }, [purposeDraft, startUrlDraft]);

  // Auto-hide the copied toast shortly after it appears.
  useEffect(() => {
    if (copiedTick === 0) return;
    const timer = window.setTimeout(() => setCopiedTick(0), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedTick]);

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

  const recordReady = statusState === "connected" && Boolean(snapshot.instanceId);
  const recordPurpose = purposeDraft.trim();
  const recordStartUrl = startUrlDraft.trim();
  const recordCommand = snapshot.instanceId
    ? [
        `bsk record start --browser ${snapshot.instanceId}`,
        recordStartUrl ? `--url ${recordStartUrl}` : "",
        recordPurpose ? `--purpose "${recordPurpose}"` : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const recordPrompt = snapshot.instanceId
    ? t("popup.record.promptTemplate", {
        command: recordCommand,
      })
    : "";

  const copyRecordPrompt = async () => {
    if (!recordReady || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(recordPrompt);
    setCopiedTick((tick) => tick + 1);
  };

  const headerTitle =
    view === "features"
      ? t("popup.launcher.title")
      : view === "record"
        ? t("popup.record.sectionTitle")
        : t("popup.brandName");

  return (
    <main
      className="min-w-[320px] max-w-[340px] space-y-3 bg-background p-3 text-foreground"
      data-slot="popup-root"
      data-view={view}
      data-version-skew={isSkewed ? "true" : undefined}
    >
      <header
        className="flex items-center gap-2"
        data-slot={view === "main" ? "popup-brand-header" : "popup-subview-header"}
      >
        {view !== "main" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 rounded-md"
            aria-label={t("popup.back")}
            onClick={() => setView(view === "record" ? "features" : "main")}
            data-slot="popup-back"
          >
            <RiArrowLeftLine className="size-4" aria-hidden />
          </Button>
        ) : (
          <img
            src={getLogoSrc()}
            alt=""
            className="size-7 rounded-lg"
            data-slot="popup-brand-logo"
          />
        )}
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
          {headerTitle}
        </h1>
        {view === "main" && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 rounded-md"
            aria-label={t("popup.launcher.title")}
            onClick={() => setView("features")}
            data-slot="popup-launcher"
          >
            <RiApps2Line className="size-4" aria-hidden />
          </Button>
        )}
      </header>

      {view === "main" && (
        <>
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
        </>
      )}

      {view === "features" && (
        <section className="space-y-2" data-slot="popup-feature-list">
          {POPUP_FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <button
                key={feature.id}
                type="button"
                className="flex w-full items-center gap-3 rounded-xl border border-border/80 bg-card/60 px-3 py-2.5 text-left transition-colors hover:bg-card/80"
                onClick={() => setView(feature.id)}
                data-slot={`popup-feature-${feature.id}`}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-foreground">
                    {t(feature.titleKey)}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                    {t(feature.descKey)}
                  </span>
                </span>
                <RiArrowRightSLine className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            );
          })}
        </section>
      )}

      {view === "record" && (
        <section className="space-y-2.5" data-slot="popup-record-body">
          <p
            className="text-[11px] leading-snug text-muted-foreground"
            data-slot="popup-record-hint-desc"
          >
            {t("popup.record.sectionHint")}
          </p>
          <div className="flex flex-col gap-1.5" data-slot="popup-record-purpose-field">
            <Label htmlFor="bh-record-purpose" className="block text-xs text-muted-foreground">
              {t("popup.record.topicLabel")}
            </Label>
            <Input
              id="bh-record-purpose"
              type="text"
              value={purposeDraft}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setPurposeDraft(event.target.value)
              }
              placeholder={t("popup.record.topicPlaceholder")}
              className="mt-0 h-8 text-sm"
              data-slot="popup-record-purpose-input"
            />
          </div>
          <div className="flex flex-col gap-1.5" data-slot="popup-record-start-url-field">
            <Label htmlFor="bh-record-start-url" className="block text-xs text-muted-foreground">
              {t("popup.record.startUrlLabel")}
            </Label>
            <Input
              id="bh-record-start-url"
              type="url"
              value={startUrlDraft}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setStartUrlDraft(event.target.value)
              }
              placeholder={t("popup.record.startUrlPlaceholder")}
              className="mt-0 h-8 text-sm"
              data-slot="popup-record-start-url-input"
            />
          </div>
          <textarea
            readOnly
            value={recordPrompt}
            rows={5}
            className="w-full resize-none rounded-md border border-input bg-muted/40 px-2.5 py-2 font-mono text-[10px] leading-snug text-foreground/90 focus-visible:outline-none"
            data-slot="popup-record-prompt"
          />
          <div className="flex items-center justify-between gap-2">
            {!recordReady && (
              <p className="text-[10px] text-muted-foreground" data-slot="popup-record-hint">
                {t("popup.record.hintDisconnected")}
              </p>
            )}
            <div className="relative ml-auto shrink-0">
              {showCopiedToast && (
                <div
                  role="status"
                  className="absolute bottom-full right-0 mb-1.5 flex items-center gap-1 whitespace-nowrap rounded-md bg-foreground/65 px-2 py-1 text-[10px] font-medium text-background shadow-md backdrop-blur-sm"
                  data-slot="popup-record-copied-toast"
                >
                  <RiCheckLine className="size-3" aria-hidden />
                  {t("popup.record.copied")}
                </div>
              )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-7 px-2.5 text-xs"
                disabled={!recordReady}
                onClick={() => {
                  void copyRecordPrompt();
                }}
                data-slot="popup-record-copy"
              >
                <RiFileCopyLine className="size-3.5" aria-hidden />
                {t("popup.record.copyButton")}
              </Button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
