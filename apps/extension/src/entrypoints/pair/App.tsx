import { useTranslation } from "@browser-skill/i18n/react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@browser-skill/ui";
import type React from "react";
import { useEffect, useState } from "react";
import { LOCAL_PAIRING_MESSAGE, type PairTicketPreview } from "@/lib/local-pairing-bridge";

type PairErrorCode =
  | "missing_ticket"
  | "ticket_expired"
  | "already_paired"
  | "replace_mismatch"
  | "server_unverified"
  | "daemon_too_old"
  | "busy"
  | "pairing_failed";

type PageState =
  | { phase: "loading" }
  | { phase: "ready"; ticket: string; preview: PairTicketPreview; approving: boolean }
  | { phase: "paired"; preview: PairTicketPreview; connectionEnabled: boolean }
  | {
      phase: "error";
      code: PairErrorCode;
      browserId?: string;
      preview?: PairTicketPreview;
    };

const KNOWN_ERRORS = new Set<PairErrorCode>([
  "missing_ticket",
  "ticket_expired",
  "already_paired",
  "replace_mismatch",
  "server_unverified",
  "daemon_too_old",
  "busy",
  "pairing_failed",
]);

function normalizeErrorCode(raw: unknown): PairErrorCode {
  if (typeof raw === "string" && KNOWN_ERRORS.has(raw as PairErrorCode)) {
    return raw as PairErrorCode;
  }
  return "pairing_failed";
}

export function PairApp() {
  const { t } = useTranslation("extension");
  const [state, setState] = useState<PageState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    const ticket = new URLSearchParams(window.location.search).get("ticket")?.trim() ?? "";
    if (!ticket) {
      setState({ phase: "error", code: "missing_ticket" });
      return;
    }

    void chrome.runtime
      .sendMessage({
        kind: LOCAL_PAIRING_MESSAGE,
        action: "inspect_ticket",
        ticket,
      })
      .then(
        (
          reply: { preview?: PairTicketPreview; error?: string; browserId?: string } | undefined,
        ) => {
          if (cancelled) return;
          if (!reply || reply.error || !reply.preview) {
            setState({
              phase: "error",
              code: normalizeErrorCode(reply?.error),
              ...(typeof reply?.browserId === "string" ? { browserId: reply.browserId } : {}),
            });
            return;
          }
          setState({
            phase: "ready",
            ticket,
            preview: reply.preview,
            approving: false,
          });
        },
        () => {
          if (!cancelled) {
            setState({ phase: "error", code: "pairing_failed" });
          }
        },
      );

    return () => {
      cancelled = true;
    };
  }, []);

  function handleApproveClick(e: React.MouseEvent<HTMLButtonElement>): void {
    if (e.nativeEvent.isTrusted !== true) return;
    if (state.phase !== "ready" || state.approving) return;
    const { ticket, preview } = state;
    setState({ phase: "ready", ticket, preview, approving: true });

    void chrome.runtime
      .sendMessage({
        kind: LOCAL_PAIRING_MESSAGE,
        action: "approve_ticket",
        ticket,
      })
      .then(
        (
          reply:
            | { ok?: boolean; connectionEnabled?: boolean; error?: string; browserId?: string }
            | undefined,
        ) => {
          if (reply?.ok) {
            setState({
              phase: "paired",
              preview,
              connectionEnabled: reply.connectionEnabled !== false,
            });
            return;
          }
          setState({
            phase: "error",
            code: normalizeErrorCode(reply?.error),
            preview,
            ...(typeof reply?.browserId === "string" ? { browserId: reply.browserId } : {}),
          });
        },
        () => {
          setState({
            phase: "error",
            code: "pairing_failed",
            preview,
          });
        },
      );
  }

  const preview =
    state.phase === "ready" || state.phase === "paired" || state.phase === "error"
      ? state.preview
      : undefined;

  function statusSummary(item: PairTicketPreview): string {
    switch (item.existingPairing) {
      case "same_daemon":
        return t("pairPage.statusSameDaemon");
      case "other_daemon":
        return t("pairPage.statusOtherDaemon");
      default:
        return t("pairPage.statusUnpaired");
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-lg shadow-lg" data-slot="pair-card">
        <CardHeader className="space-y-2">
          <div>
            <Badge variant="secondary">{t("pairPage.badge")}</Badge>
          </div>
          <CardTitle className="text-xl">{t("pairPage.title")}</CardTitle>
          <CardDescription className="text-sm leading-relaxed">
            {t("pairPage.description")}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {state.phase === "loading" && (
            <p className="text-sm text-muted-foreground" data-slot="pair-loading">
              {t("pairPage.loading")}
            </p>
          )}

          {preview && (
            <dl
              className="space-y-2.5 rounded-xl border border-border/80 bg-muted/40 p-4 text-sm"
              data-slot="pair-preview"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">{t("pairPage.endpointLabel")}</dt>
                <dd className="font-mono font-medium">{preview.endpoint}</dd>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">{t("pairPage.daemonLabel")}</dt>
                <dd className="font-mono">{preview.daemonFingerprint}</dd>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">{t("pairPage.deviceLabel")}</dt>
                <dd className="font-mono">{preview.deviceFingerprint}</dd>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">{t("pairPage.browserLabel")}</dt>
                <dd className="font-mono">{preview.instanceId}</dd>
              </div>
              <div className="border-t border-border/60 pt-2">
                <dt className="text-xs text-muted-foreground">{t("pairPage.statusLabel")}</dt>
                <dd className="mt-0.5 text-xs leading-relaxed">{statusSummary(preview)}</dd>
              </div>
            </dl>
          )}

          {state.phase === "ready" && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("pairPage.securityHint")}
            </p>
          )}

          {state.phase === "paired" && (
            <div
              role="status"
              data-slot="pair-success"
              className="space-y-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4"
            >
              <p className="text-base font-semibold text-emerald-700 dark:text-emerald-300">
                {t("pairPage.connectedBadge")}
              </p>
              <p className="text-sm leading-relaxed text-foreground/90">
                {t("pairPage.connectedSubtitle")}
              </p>
              {!state.connectionEnabled && (
                <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                  {t("pairPage.connectedDisabledHint")}
                </p>
              )}
            </div>
          )}

          {state.phase === "error" && (
            <div
              role="alert"
              data-slot="pair-error"
              className="space-y-1.5 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm"
            >
              <p className="font-semibold text-destructive">{t("pairPage.errorTitle")}</p>
              <p className="leading-relaxed text-foreground/90">
                {t(`pairPage.errors.${state.code}`, {
                  browser: state.browserId ?? preview?.instanceId ?? "",
                  instance: preview?.instanceId ?? "",
                })}
              </p>
            </div>
          )}
        </CardContent>

        {state.phase === "ready" && (
          <CardFooter>
            <Button
              type="button"
              className="w-full"
              disabled={state.approving}
              onClick={handleApproveClick}
            >
              {state.approving ? t("pairPage.approvingButton") : t("pairPage.approveButton")}
            </Button>
          </CardFooter>
        )}
      </Card>
    </main>
  );
}
