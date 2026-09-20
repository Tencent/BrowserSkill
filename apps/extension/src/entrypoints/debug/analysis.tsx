import { useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import { useEffect, useState } from "react";
import { recordingRequest } from "@/debug/client";
import type { DebugResult } from "@/debug/types";
import { clock, Quiet } from "./evidence";

const number = (value?: number) =>
  value === undefined
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
const panel = "rounded-2xl border border-border/80 bg-card";
export function AnalysisPanel({
  session,
  run,
  pulse,
  onRequest,
}: {
  session: string;
  run: string;
  pulse: number;
  onRequest: (id: string) => void;
}) {
  const { t } = useTranslation("extension");
  const [mode, setMode] = useState<"aggregate" | "duplicates">("aggregate");
  const [data, setData] = useState<DebugResult>();
  const [offsets, setOffsets] = useState([0]);
  const offset = offsets.at(-1)!;
  const [error, setError] = useState("");
  const refresh = offset === 0 ? pulse : 0;
  useEffect(() => {
    let cancelled = false;
    void recordingRequest({
      session_id: session,
      run_id: run,
      action: mode,
      offset,
      limit: 20,
    }).then(
      (value) => {
        if (!cancelled) {
          setData(value);
          setError("");
        }
      },
      (reason) => {
        if (!cancelled) setError(String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session, run, mode, offset, refresh]);
  const refs = (ids: string[], truncated: boolean) => (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <span className="text-[10px] text-muted-foreground">{t("debug.analysisReferences")}</span>
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onRequest(id)}
          className="rounded-md border border-border px-2 py-1 font-mono text-[10px] hover:bg-muted"
        >
          {id.split(":").at(-1)}
        </button>
      ))}
      {truncated && (
        <span className="text-[10px] text-muted-foreground">
          {t("debug.analysisReferencesLimited")}
        </span>
      )}
    </div>
  );
  return (
    <div className="space-y-4">
      <div className={panel + " p-5"}>
        <div className="flex flex-wrap gap-2">
          {(["aggregate", "duplicates"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={mode === value ? "default" : "outline"}
              onClick={() => {
                setMode(value);
                setOffsets([0]);
                setData(undefined);
              }}
            >
              {t(`debug.${value}`)}
            </Button>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {t(mode === "aggregate" ? "debug.aggregateHint" : "debug.duplicatesHint")}
        </p>
        {data?.analysis && (
          <>
            <p className="mt-3 text-xs">
              {t("debug.analysisScope", {
                count: data.analysis.included,
                excluded: data.analysis.excluded_controlled,
                groups: data.analysis.groups,
              })}
            </p>
            {mode === "duplicates" && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("debug.duplicatesCount", {
                  count: data.analysis.suspected_extra_requests,
                  uncomparable: data.analysis.uncomparable,
                })}
              </p>
            )}
            {data.analysis.coverage.some(
              (gap) =>
                gap.startsWith("evidence_") ||
                gap === "request_retention_limit" ||
                gap === "initial_load_not_recorded",
            ) && (
              <p className="mt-3 text-xs text-[var(--debug-accent)]">
                {t("debug.analysisPartial")}
              </p>
            )}
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!data ? (
        <Quiet>{t("debug.loading")}</Quiet>
      ) : mode === "aggregate" ? (
        data.aggregates?.length ? (
          data.aggregates.map((group) => (
            <section key={group.id} className={panel + " p-5"}>
              <h3 className="break-all font-mono text-xs">
                <span className="mr-2 text-muted-foreground">{group.method}</span>
                {group.endpoint}
              </h3>
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                {(
                  [
                    ["analysisCalls", group.count],
                    ["analysisErrors", group.http_errors],
                    ["analysisSlow", group.slow],
                    ["analysisP95", group.duration_ms?.p95],
                  ] as const
                ).map(([key, value]) => (
                  <div key={key}>
                    <p className="text-[10px] text-muted-foreground">
                      {t(`debug.${key}` as "debug.analysisCalls")}
                    </p>
                    <p className="mt-1 font-mono text-lg">{number(value as number | undefined)}</p>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
                {t("debug.analysisTiming", {
                  mean: number(group.duration_ms?.mean),
                  max: number(group.duration_ms?.max),
                  samples: group.timing_samples,
                  failed: group.failed,
                  pending: group.pending + group.interrupted,
                })}
              </p>
              <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                {Object.entries(group.statuses)
                  .map(([status, count]) => `${status} × ${count}`)
                  .join(" · ")}
              </p>
              {refs(group.request_ids, group.refs_truncated)}
            </section>
          ))
        ) : (
          <Quiet>{t("debug.noData")}</Quiet>
        )
      ) : data.duplicates?.length ? (
        data.duplicates.map((group) => (
          <section key={group.id} className={panel + " p-5"}>
            <h3 className="break-all font-mono text-xs">
              {group.method} {group.url}
            </h3>
            <p className="mt-3 text-sm">
              {t("debug.duplicateGroup", {
                count: group.count,
                extra: group.extra_requests,
                ms: Math.round(group.ended_at - group.started_at),
                overlap: group.overlap_count,
              })}
            </p>
            {group.possible_retry && (
              <p className="mt-3 text-xs text-[var(--debug-accent)]">{t("debug.duplicateRetry")}</p>
            )}
            {refs(group.request_ids, group.refs_truncated)}
          </section>
        ))
      ) : (
        <Quiet>{t("debug.noDuplicates")}</Quiet>
      )}
      <div className="flex justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onClick={() => setOffsets((pages) => pages.slice(0, -1))}
        >
          {t("debug.analysisPrevious")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={data?.next_offset === undefined}
          onClick={() => setOffsets((pages) => [...pages, data!.next_offset!])}
        >
          {t("debug.analysisNext")}
        </Button>
      </div>
    </div>
  );
}
export function PerformancePanel({
  session,
  run,
  pulse,
}: {
  session: string;
  run: string;
  pulse: number;
}) {
  const { t } = useTranslation("extension");
  const [data, setData] = useState<DebugResult>();
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void recordingRequest({
      session_id: session,
      run_id: run,
      action: "performance",
      limit: 100,
      budget: 262144,
    }).then(
      (value) => {
        if (!cancelled) {
          setData(value);
          setError("");
        }
      },
      (reason) => {
        if (!cancelled) setError(String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session, run, pulse]);
  return (
    <div className="space-y-4">
      <div className={panel + " p-5"}>
        <h2 className="text-sm font-medium">{t("debug.performance")}</h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t("debug.performanceHint")}
        </p>
        {data?.run?.coverage.some((gap) => gap.startsWith("performance_")) && (
          <p className="mt-3 text-xs text-[var(--debug-accent)]">
            {t("debug.performancePartial")}:{" "}
            {data.run.coverage.filter((gap) => gap.startsWith("performance_")).join(", ")}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!data ? (
        <Quiet>{t("debug.loading")}</Quiet>
      ) : !data.performance?.length ? (
        <Quiet>{t("debug.noPerformance")}</Quiet>
      ) : (
        [...data.performance].reverse().map((load) => (
          <section key={load.id} className={panel + " p-5"}>
            <div className="flex flex-wrap justify-between gap-2 text-[10px] text-muted-foreground">
              <span>
                {clock(load.started_at)} · {load.navigation}
              </span>
              <span className="font-mono">{load.id}</span>
            </div>
            <h3 className="mt-3 break-all text-xs">{load.url}</h3>
            {(!load.early || load.state === "interrupted") && (
              <p className="mt-3 text-xs text-[var(--debug-accent)]">
                {t("debug.performancePartial")}
              </p>
            )}
            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
              {Object.entries(load.metrics).map(([key, metric]) => (
                <div key={key} className="rounded-xl border border-border/70 p-3">
                  <p className="text-[10px] text-muted-foreground">
                    {t(`debug.metric_${key}` as "debug.metric_cls")}
                  </p>
                  <p className="my-2 font-mono text-xl">
                    {number(metric.value)}
                    {metric.value !== undefined && key.endsWith("_ms") && (
                      <span className="ml-1 text-[10px] text-muted-foreground">ms</span>
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {t(`debug.metricState_${metric.state}` as "debug.metricState_available")}
                  </p>
                  {metric.reasons.map((reason) => (
                    <p
                      key={reason}
                      className="mt-1 text-[10px] leading-relaxed text-[var(--debug-accent)]"
                    >
                      {t(`debug.perfReason_${reason}` as "debug.performancePartial", {
                        defaultValue: reason,
                      })}
                    </p>
                  ))}
                </div>
              ))}
            </div>
            <details className="mt-4 rounded-lg bg-muted/50 p-3">
              <summary className="cursor-pointer text-xs">
                {t("debug.performanceVisibility")}
              </summary>
              <div className="mt-3 flex flex-wrap gap-3">
                {load.visibility.map((item, index) => (
                  <span key={`${item.at}-${index}`} className="text-[10px] text-muted-foreground">
                    {clock(item.at)} ·{" "}
                    {t(
                      item.state === "visible"
                        ? "debug.performanceVisible"
                        : "debug.performanceHidden",
                    )}
                  </span>
                ))}
              </div>
              {load.visibility_truncated && (
                <p className="mt-2 text-xs">{t("debug.performanceLimited")}</p>
              )}
            </details>
            {!!load.long_tasks.length && (
              <details className="mt-3 rounded-lg bg-muted/50 p-3">
                <summary className="cursor-pointer text-xs">
                  {t("debug.performanceLongTasks")}
                </summary>
                <div className="mt-3 space-y-2">
                  {load.long_tasks.map((task, index) => (
                    <div
                      key={`${task.at}-${index}`}
                      className="flex justify-between font-mono text-[11px]"
                    >
                      <span>{clock(task.at)}</span>
                      <span>{number(task.duration_ms)} ms</span>
                    </div>
                  ))}
                </div>
                {load.long_tasks_truncated && (
                  <p className="mt-3 text-[10px] text-muted-foreground">
                    {t("debug.performanceLimited")}
                  </p>
                )}
              </details>
            )}
          </section>
        ))
      )}
    </div>
  );
}
