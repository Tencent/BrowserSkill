import { useTranslation } from "@browser-skill/i18n/react";
import { Badge, Button } from "@browser-skill/ui";
import { RiArrowLeftLine, RiDownloadLine, RiFolderOpenLine, RiHistoryLine } from "@remixicon/react";
import { useEffect, useRef, useState } from "react";
import { AuditError, AuditRunList, auditRunTitle } from "@/components/audit-panel";
import {
  type AuditDetail,
  type AuditEvent,
  type AuditList,
  type AuditRun,
  auditRequest,
} from "@/lib/audit";
import { type AuditStep, auditStepStatus, auditTimeline } from "@/lib/audit-timeline";

const methodKeys = {
  "tool.tab_list": "tabList",
  "tool.tab_create": "tabCreate",
  "tool.tab_close": "tabClose",
  "tool.tab_select": "tabSelect",
  "tool.tab_borrow": "tabBorrow",
  "tool.tab_return": "tabReturn",
  "tool.navigate": "navigate",
  "tool.navigate_back": "navigateBack",
  "tool.navigate_forward": "navigateForward",
  "tool.reload": "reload",
  "tool.click": "click",
  "tool.fill": "fill",
  "tool.press": "press",
  "tool.select": "select",
  "tool.hover": "hover",
  "tool.focus": "focus",
  "tool.blur": "blur",
  "tool.wheel": "scroll",
  "tool.scroll_to": "scroll",
  "tool.upload": "upload",
  "tool.download": "download",
  "tool.snapshot": "read",
  "tool.observe": "read",
  "tool.get_html": "read",
  "tool.screenshot": "screenshot",
  "tool.console": "console",
  "tool.network": "network",
  "tool.evaluate": "evaluate",
  "tool.wait_ms": "wait",
  "tool.wait_for_navigation": "wait",
  "tool.request_help": "help",
  "tool.record_start": "recordStart",
  "tool.record_stop": "recordStop",
  "tool.record_await": "recordAwait",
  "tool.window_resize": "resize",
  "tool.emulate": "emulate",
} as const;

function TimelineStep({
  step,
  run,
  pending,
}: {
  step: AuditStep;
  run: AuditRun;
  pending?: string[];
}) {
  const { t } = useTranslation("extension");
  const clock = new Date(step.at).toLocaleTimeString();
  if (step.kind !== "operation") {
    const marker = ["started", "ended", "paused", "resumed", "user_interrupt"].includes(step.kind)
      ? step.kind
      : "event";
    return (
      <li className="flex gap-4 py-3 text-xs text-muted-foreground">
        <time className="w-20 shrink-0 tabular-nums">{clock}</time>
        <span>{t(`audit.marker.${marker as "started"}`)}</span>
      </li>
    );
  }
  const method = typeof step.data.method === "string" ? step.data.method : "";
  const key = methodKeys[method as keyof typeof methodKeys];
  const status = auditStepStatus(step, run, pending);
  const statusKey = ["running", "completed", "error", "unknown", "cancelled"].includes(status)
    ? status
    : "unknown";
  const target = typeof step.data.target === "string" ? step.data.target : "";
  const url = step.data.url ?? step.data.page_url;
  return (
    <li className="border-t border-border/70 py-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <time className="w-20 shrink-0 pt-1 text-xs tabular-nums text-muted-foreground">
          {clock}
        </time>
        <div className="min-w-0 flex-1 basis-48">
          <p className="break-words text-sm font-medium">
            {key ? t(`audit.methods.${key}`) : method}
            {target && <span className="ml-2 font-normal text-muted-foreground">「{target}」</span>}
          </p>
          {typeof url === "string" && (
            <p className="mt-1 break-all text-xs text-muted-foreground">{url}</p>
          )}
          {step.data.input_redacted === true && (
            <p className="mt-1 text-xs text-muted-foreground">{t("audit.inputRedacted")}</p>
          )}
          {typeof step.data.file_count === "number" && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("audit.fileCount", { count: step.data.file_count })}
            </p>
          )}
          {typeof step.result?.dialogs_handled === "number" && step.result.dialogs_handled > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("audit.dialogCount", { count: step.result.dialogs_handled })}
            </p>
          )}
          {typeof step.result?.outcome === "string" && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("audit.helpOutcome")}: {step.result.outcome}
            </p>
          )}
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer">{t("audit.technicalDetails")}</summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-3">
              {JSON.stringify(
                { operation_id: step.id, ...step.data, result: step.result ?? { status } },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
        <Badge
          variant="outline"
          className={
            statusKey === "error" ? "text-destructive dark:text-red-400" : "text-muted-foreground"
          }
        >
          {t(`audit.status.${statusKey as "running"}`)}
        </Badge>
      </div>
    </li>
  );
}

export function AuditApp() {
  const { t } = useTranslation("extension");
  const [id, setId] = useState(() => new URL(window.location.href).searchParams.get("id"));
  const [list, setList] = useState<AuditList | null>(null);
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const eventsRef = useRef<AuditEvent[]>([]);
  const [limit, setLimit] = useState(25);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [working, setWorking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    document.title = `${t("audit.title")} · BrowserSkill`;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => document.documentElement.classList.toggle("dark", media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [t]);
  useEffect(() => {
    const pop = () => setId(new URL(window.location.href).searchParams.get("id"));
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    setDetail(null);
    setEvents([]);
    eventsRef.current = [];
    setError("");
    setActionError("");
    setConfirmDelete(false);
  }, [id]);
  useEffect(() => {
    let active = true;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        if (id) {
          const result = await auditRequest<AuditDetail>("get", {
            id,
            offset: eventsRef.current.length,
            limit: 500,
          });
          if (!active) return;
          eventsRef.current = [...eventsRef.current, ...result.events];
          setEvents(eventsRef.current);
          setDetail(result);
          setError(result.error || "");
        } else {
          const pages: AuditRun[] = [];
          let last: AuditList | null = null;
          for (let offset = 0; offset < limit; offset += 100) {
            last = await auditRequest<AuditList>("list", {
              offset,
              limit: Math.min(100, limit - offset),
            });
            pages.push(...last.runs);
            if (pages.length >= last.total) break;
          }
          if (active && last) {
            setList({ ...last, runs: pages });
            setError(last.error || "");
          }
        }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : "unavailable");
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id, limit, tick]);

  const navigate = (nextId: string | null) => {
    const url = new URL(window.location.href);
    if (nextId) url.searchParams.set("id", nextId);
    else url.searchParams.delete("id");
    window.history.pushState(null, "", url);
    setId(nextId);
  };

  const exportRun = async () => {
    if (!id) return;
    setWorking(true);
    setActionError("");
    try {
      const first = await auditRequest<AuditDetail>("get", { id, limit: 500 });
      const all = [...first.events];
      // Freeze the export boundary so a running task cannot create an endless export.
      while (all.length < first.total) {
        const page = await auditRequest<AuditDetail>("get", {
          id,
          offset: all.length,
          limit: Math.min(500, first.total - all.length),
        });
        if (!page.events.length) throw new Error("request_failed");
        all.push(...page.events);
      }
      const url = URL.createObjectURL(
        new Blob([JSON.stringify({ version: 1, run: first.run, events: all }, null, 2)], {
          type: "application/json",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `browserskill-audit-${id}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "unavailable");
    } finally {
      setWorking(false);
    }
  };
  const deleteRun = async () => {
    if (!id) return;
    setWorking(true);
    setActionError("");
    try {
      await auditRequest("delete", { id });
      setList(null);
      navigate(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "unavailable");
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-5 py-8 text-foreground sm:px-8">
      <header className="mb-8 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
          <RiHistoryLine className="size-5" aria-hidden />
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">BrowserSkill</p>
          <h1 className="text-xl font-semibold">{t("audit.title")}</h1>
        </div>
        {id && (
          <Button variant="outline" className="ml-auto" onClick={() => navigate(null)}>
            <RiArrowLeftLine className="size-4" aria-hidden />
            {t("audit.viewAll")}
          </Button>
        )}
      </header>
      {error && (
        <div className="mb-4">
          <AuditError error={error} retry={() => setTick((tick) => tick + 1)} />
        </div>
      )}
      {actionError && (
        <div className="mb-4">
          <AuditError error={actionError} />
        </div>
      )}
      {id ? (
        detail && detail.run.id === id ? (
          <>
            <section className="mb-6 rounded-2xl border border-border bg-card p-5">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge variant="outline">{t(`audit.status.${detail.run.status}`)}</Badge>
                {detail.run.partial && <Badge variant="outline">{t("audit.partialLabel")}</Badge>}
              </div>
              <h2 className="break-words text-lg font-semibold">
                {auditRunTitle(detail.run, t("audit.untitled"))}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {new Date(detail.run.started_at).toLocaleString()} ·{" "}
                {t("audit.operationCount", { count: detail.run.operations })} ·{" "}
                {t("audit.errorCount", { count: detail.run.errors })}
              </p>
              {detail.run.partial && (
                <p className="mt-3 text-sm text-muted-foreground">
                  {t("audit.partialDescription", {
                    time: new Date(detail.run.recorded_at).toLocaleString(),
                  })}
                </p>
              )}
              <div className="mt-5 flex flex-wrap gap-2">
                <Button variant="outline" disabled={working} onClick={() => void exportRun()}>
                  <RiDownloadLine className="size-4" aria-hidden />
                  {t("audit.export")}
                </Button>
                {detail.run.status !== "running" && (
                  <Button variant="ghost" disabled={working} onClick={() => setConfirmDelete(true)}>
                    {t("audit.delete")}
                  </Button>
                )}
              </div>
              {confirmDelete && (
                <div className="mt-4 rounded-lg border border-destructive/30 p-3" role="alert">
                  <p className="text-sm">{t("audit.deleteConfirm")}</p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="outline"
                      className="text-destructive dark:text-red-400"
                      disabled={working}
                      onClick={() => void deleteRun()}
                    >
                      {t("audit.delete")}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={working}
                      onClick={() => setConfirmDelete(false)}
                    >
                      {t("audit.cancel")}
                    </Button>
                  </div>
                </div>
              )}
            </section>
            <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
              {t("audit.resultNote")}
            </p>
            <ol aria-label={t("audit.timeline")}>
              {auditTimeline(events).map((step) => (
                <TimelineStep
                  key={step.id}
                  step={step}
                  run={detail.run}
                  pending={detail.pending_operations}
                />
              ))}
            </ol>
            {events.length < detail.total && (
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => setTick((tick) => tick + 1)}
              >
                {t("audit.loadMore")}
              </Button>
            )}
          </>
        ) : (
          !error && <p className="text-sm text-muted-foreground">{t("audit.loading")}</p>
        )
      ) : (
        <>
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-base font-medium">{t("audit.allTasks")}</h2>
            <Button
              variant="ghost"
              onClick={() => {
                void auditRequest("open_directory").catch((error: Error) =>
                  setActionError(error.message),
                );
              }}
            >
              <RiFolderOpenLine className="size-4" aria-hidden />
              {t("audit.openDirectory")}
            </Button>
          </div>
          {list ? (
            list.runs.length ? (
              <AuditRunList runs={list.runs} onSelect={navigate} />
            ) : (
              !error && (
                <div className="rounded-2xl border border-dashed border-border px-6 py-14 text-center text-sm text-muted-foreground">
                  {t("audit.empty")}
                </div>
              )
            )
          ) : (
            !error && <p className="text-sm text-muted-foreground">{t("audit.loading")}</p>
          )}
          {list && list.total > list.runs.length && (
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => setLimit((limit) => limit + 25)}
            >
              {t("audit.loadMore")}
            </Button>
          )}
          {list && <p className="mt-6 break-all text-xs text-muted-foreground">{list.directory}</p>}
        </>
      )}
      <footer className="mt-8 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
        {t("audit.privacyFull")}
      </footer>
    </main>
  );
}
