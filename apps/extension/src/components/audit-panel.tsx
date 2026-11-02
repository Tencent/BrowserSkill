import { useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import { RiArrowRightSLine } from "@remixicon/react";
import { useEffect, useState } from "react";
import { Switch } from "@/entrypoints/popup/switch";
import {
  AUDIT_ENABLED_KEY,
  type AuditList,
  type AuditRun,
  auditRequest,
  openAuditPage,
} from "@/lib/audit";

export function auditRunTitle(run: AuditRun, fallback: string): string {
  return run.name || `${run.site || fallback} · ${new Date(run.started_at).toLocaleString()}`;
}

export function AuditError({ error, retry }: { error: string; retry?: () => void }) {
  const { t } = useTranslation("extension");
  const key =
    error === "disconnected"
      ? "disconnected"
      : error === "unsupported"
        ? "unsupported"
        : "requestFailed";
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs leading-relaxed"
    >
      <p>{t(`audit.${key}`)}</p>
      {retry && (
        <Button variant="outline" size="sm" className="mt-2" onClick={retry}>
          {t("audit.retry")}
        </Button>
      )}
    </div>
  );
}

export function AuditRunList({
  runs,
  onSelect,
}: {
  runs: AuditRun[];
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("extension");
  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <button
          type="button"
          key={run.id}
          onClick={() => onSelect(run.id)}
          className="flex w-full items-center gap-2 rounded-xl border border-border/80 bg-card/60 px-3 py-3 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {auditRunTitle(run, t("audit.untitled"))}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(`audit.status.${run.status}`)} ·{" "}
              {t("audit.operationCount", { count: run.operations })}
              {run.errors > 0 && (
                <span className="ml-1 text-destructive dark:text-red-400">
                  {" "}
                  · {t("audit.errorCount", { count: run.errors })}
                </span>
              )}
            </p>
            {run.partial && (
              <p className="mt-1 text-xs text-muted-foreground">{t("audit.partialLabel")}</p>
            )}
          </div>
          <RiArrowRightSLine className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      ))}
    </div>
  );
}

export function AuditPanel() {
  const { t } = useTranslation("extension");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [list, setList] = useState<AuditList | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [tick, setTick] = useState(0);
  const [stateTick, setStateTick] = useState(0);
  useEffect(() => {
    let live = true;
    void auditRequest<{ enabled: boolean }>("state").then(
      (state) => {
        if (live) {
          setEnabled(state.enabled);
          setError("");
        }
      },
      (error: Error) => {
        if (live) setError(error.message);
      },
    );
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && AUDIT_ENABLED_KEY in changes)
        setEnabled(changes[AUDIT_ENABLED_KEY].newValue === true);
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, [stateTick]);
  useEffect(() => {
    if (!enabled) {
      setList(null);
      return;
    }
    let live = true;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await auditRequest<AuditList>("list", { limit: 5 });
        if (live) {
          setList(result);
          setError(result.error || "");
        }
      } catch (error) {
        if (live) setError(error instanceof Error ? error.message : "unavailable");
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [enabled, tick]);

  const toggle = async (value: boolean) => {
    setSaving(true);
    setError("");
    try {
      await auditRequest("configure", { enabled: value });
      setEnabled(value);
    } catch (error) {
      setError(error instanceof Error ? error.message : "unavailable");
    } finally {
      setSaving(false);
      setTick((tick) => tick + 1);
    }
  };

  return (
    <section className="space-y-3" data-slot="popup-audit-body">
      <div className="flex items-center justify-between rounded-xl border border-border/80 bg-card/60 px-3 py-3">
        <span className="text-sm font-medium">{t("audit.enabledLabel")}</span>
        <Switch
          checked={enabled === true}
          disabled={saving || enabled === null}
          onCheckedChange={(value) => void toggle(value)}
          aria-label={t("audit.enabledLabel")}
        />
      </div>
      {enabled === null && <p className="text-xs text-muted-foreground">{t("audit.loading")}</p>}
      {enabled && (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("audit.privacyShort")}</p>
          {error && <AuditError error={error} retry={() => setTick((tick) => tick + 1)} />}
          {!list && !error && <p className="text-xs text-muted-foreground">{t("audit.loading")}</p>}
          {list && list.runs.length === 0 && !error && (
            <p className="py-4 text-center text-xs leading-relaxed text-muted-foreground">
              {t("audit.empty")}
            </p>
          )}
          {list && <AuditRunList runs={list.runs} onSelect={openAuditPage} />}
          <Button variant="outline" className="w-full" onClick={() => openAuditPage()}>
            {t("audit.viewAll")}
          </Button>
        </>
      )}
      {!enabled && error && (
        <AuditError error={error} retry={() => setStateTick((tick) => tick + 1)} />
      )}
    </section>
  );
}
