import { useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import {
  RiArrowRightLine,
  RiBugLine,
  RiCodeSSlashLine,
  RiGitMergeLine,
  RiPulseLine,
  RiShieldCheckLine,
  RiStopCircleLine,
} from "@remixicon/react";
import { useEffect, useState } from "react";
import { debugRequest } from "@/debug/client";
import type {
  DebugComparison,
  DebugOperation,
  DebugRequest,
  DebugResult,
  DebugRun,
} from "@/debug/types";
import { useDebugTasks } from "@/debug/use-tasks";
import {
  Comparison,
  ConsoleList,
  clock,
  OperationName,
  PageChanges,
  Quiet,
  RequestDetail,
  RequestList,
} from "./evidence";

const selectClass =
  "min-w-0 max-w-full rounded-lg border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring";

export function DebugApp() {
  const { t } = useTranslation("extension");
  const { tasks, loaded, error: taskError, refresh } = useDebugTasks();
  const [session, setSession] = useState(
    () => new URLSearchParams(location.search).get("session") ?? "",
  );
  const task =
    tasks.find((item) => item.session_id === session) ?? (!session ? tasks[0] : undefined);
  const sessionId = task?.session_id ?? "";
  const [runId, setRunId] = useState(() => new URLSearchParams(location.search).get("run") ?? "");
  const [runs, setRuns] = useState<DebugRun[]>([]);
  const [operations, setOperations] = useState<DebugOperation[]>([]);
  const [requests, setRequests] = useState<DebugRequest[]>([]);
  const [operationId, setOperationId] = useState("");
  const [detail, setDetail] = useState<DebugResult>();
  const [selectedRequest, setSelectedRequest] = useState<DebugRequest>();
  const [mode, setMode] = useState<"evidence" | "compare">("evidence");
  const [compareOptions, setCompareOptions] = useState<DebugOperation[]>([]);
  const [beforeId, setBeforeId] = useState("");
  const [afterId, setAfterId] = useState("");
  const [comparison, setComparison] = useState<DebugComparison>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pulse, setPulse] = useState(0);
  const [revision, setRevision] = useState(0);
  const run = runs.find((item) => item.id === runId) ?? (!runId ? runs.at(-1) : undefined);
  const activeRunId = run?.id;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    let pending = false;
    const poll = async () => {
      if (cancelled || document.hidden || pending) return;
      pending = true;
      try {
        const result = await debugRequest({ action: "status", session_id: sessionId });
        if (!cancelled) {
          setRuns(result.runs ?? []);
          setRunId((value) =>
            value && !result.runs?.some((item) => item.id === value) ? "" : value,
          );
          setError("");
          setPulse((value) => value + 1);
        }
      } catch (err) {
        if (!cancelled) setError(String(err instanceof Error ? err.message : err));
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [sessionId, revision]);

  useEffect(() => {
    setOperations([]);
    setRequests([]);
    setOperationId("");
    setSelectedRequest(undefined);
    setDetail(undefined);
    if (!sessionId || !activeRunId) return;
    let cancelled = false;
    let pending = false;
    let since = 0;
    const retained = new Map<string, DebugRequest>();
    const poll = async () => {
      if (cancelled || document.hidden || pending) return;
      pending = true;
      try {
        const result = await debugRequest({
          action: "operations",
          session_id: sessionId,
          run_id: activeRunId,
          limit: 100,
        });
        if (cancelled) return;
        for (let page = 0; page < 3; page++) {
          if (cancelled || document.hidden) return;
          const batch = await debugRequest({
            action: "requests",
            session_id: sessionId,
            run_id: activeRunId,
            since,
            limit: 100,
          });
          if (cancelled) return;
          for (const entry of batch.requests ?? []) retained.set(entry.id, entry);
          since = batch.next_since ?? since;
          if ((batch.requests?.length ?? 0) < 100) break;
        }
        const entries = [...retained.values()]
          .sort((a, b) => a.started_at - b.started_at)
          .slice(-200);
        retained.clear();
        for (const entry of entries) retained.set(entry.id, entry);
        if (!cancelled) {
          setOperations((result.operations ?? []).sort((a, b) => a.started_at - b.started_at));
          setRequests(entries);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [sessionId, activeRunId, revision]);

  useEffect(() => {
    if (!sessionId || !operationId || !activeRunId) {
      setDetail(undefined);
      return;
    }
    let cancelled = false;
    void debugRequest({
      action: "operation",
      session_id: sessionId,
      run_id: activeRunId,
      id: operationId,
    }).then(
      (result) => {
        if (!cancelled) {
          setDetail(result);
        }
      },
      (err: Error) => {
        if (!cancelled) {
          setDetail(undefined);
          setError(err.message);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, activeRunId, operationId, pulse]);

  useEffect(() => {
    if (mode !== "compare" || !sessionId) return;
    let cancelled = false;
    void Promise.all(
      runs.map((item) =>
        debugRequest({ action: "operations", session_id: sessionId, run_id: item.id, limit: 100 }),
      ),
    ).then(
      (results) => {
        if (!cancelled)
          setCompareOptions(
            results
              .flatMap((item) => item.operations ?? [])
              .sort((a, b) => a.started_at - b.started_at),
          );
      },
      (err: Error) => {
        if (!cancelled) setError(err.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mode, sessionId, runs]);

  async function capture() {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      const result = await debugRequest({
        action: run?.state === "capturing" ? "stop" : "start",
        session_id: sessionId,
        ...(run?.state === "capturing"
          ? { run_id: run.id }
          : { tab_id: task.tab_id, name: task.title }),
      });
      if (result.run) setRunId(result.run.id);
      setRevision((value) => value + 1);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function compare() {
    setBusy(true);
    setError("");
    try {
      setComparison(
        (
          await debugRequest({
            action: "compare",
            session_id: sessionId,
            before: beforeId,
            after: afterId,
          })
        ).comparison,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  function switchSession(value: string) {
    setSession(value);
    setRunId("");
    setRuns([]);
    setComparison(undefined);
    setBeforeId("");
    setAfterId("");
    setCompareOptions([]);
  }
  return (
    <div className="debug-workspace min-h-screen bg-background text-foreground">
      <header className="border-b border-border/70 bg-card/70">
        <div className="mx-auto flex max-w-[1480px] flex-wrap items-center gap-4 px-6 py-5 lg:px-10">
          <img src="/icon/logo.png" width="28" height="28" alt="" />
          <span className="text-sm font-semibold tracking-tight">BrowserSkill</span>
          <span className="text-border">/</span>
          <span className="text-xs text-muted-foreground">{t("debug.title")}</span>
          <div className="ml-auto flex items-center gap-3">
            {tasks.length > 0 && (
              <select
                aria-label={t("debug.currentTasks")}
                className={selectClass}
                value={sessionId}
                onChange={(event) => switchSession(event.target.value)}
              >
                {!task && <option value="">{t("debug.currentTasks")}</option>}
                {tasks.map((item) => (
                  <option key={item.session_id} value={item.session_id}>
                    {item.run?.name || item.title || item.session_id}
                  </option>
                ))}
              </select>
            )}
            <span className="hidden font-mono text-[10px] text-muted-foreground sm:block">
              {sessionId}
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1480px] px-6 py-8 lg:px-10">
        <div className="mb-8 flex flex-wrap items-start gap-5">
          <div className="min-w-0 flex-1">
            <p className="mb-3 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--debug-accent)]">
              <RiBugLine className="size-3.5" aria-hidden />
              {t("debug.evidence")}
            </p>
            <h1 className="break-words text-2xl font-medium tracking-tight">
              {run?.name || task?.title || t("debug.title")}
            </h1>
            <p className="mt-3 break-all font-mono text-xs text-muted-foreground">
              {run?.url || task?.url || t("debug.emptyHelp")}
            </p>
          </div>
          {task && (
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-2 rounded-full border border-border px-3 py-2 text-[11px] text-muted-foreground">
                <span
                  className={`size-1.5 rounded-full ${run?.state === "capturing" ? "bg-[var(--debug-accent)]" : "bg-muted-foreground/50"}`}
                />
                {t(
                  run?.state === "capturing"
                    ? "debug.capturing"
                    : run
                      ? "debug.stopped"
                      : "debug.notCapturing",
                )}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || (run?.state !== "capturing" && task.tab_id === undefined)}
                onClick={() => void capture()}
              >
                <RiStopCircleLine className="size-4" aria-hidden />
                {t(
                  busy
                    ? "debug.working"
                    : run?.state === "capturing"
                      ? "debug.stop"
                      : "debug.start",
                )}
              </Button>
            </div>
          )}
        </div>
        {(error || taskError) && (
          <p
            role="alert"
            className="mb-5 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive"
          >
            {error || taskError}
          </p>
        )}
        {!loaded ? (
          <Quiet>{t("debug.loading")}</Quiet>
        ) : !task ? (
          <div className="rounded-2xl border border-dashed border-border py-16 text-center">
            <RiBugLine className="mx-auto mb-4 size-8 text-muted-foreground" />
            <h2 className="text-sm font-medium">
              {t(session ? "debug.noSession" : "debug.emptyTitle")}
            </h2>
            <Quiet>{t("debug.emptyHelp")}</Quiet>
          </div>
        ) : !run ? (
          <div className="rounded-2xl border border-border bg-card p-10 text-center">
            <RiPulseLine className="mx-auto mb-5 size-8 text-[var(--debug-accent)]" />
            <h2 className="text-lg font-medium">{t("debug.notCapturing")}</h2>
            <p className="mx-auto my-4 max-w-md text-sm leading-relaxed text-muted-foreground">
              {t("debug.captureNetwork")} · {t("debug.captureConsole")} · {t("debug.capturePage")}
            </p>
            <p className="text-xs text-muted-foreground">{t("debug.retention")}</p>
          </div>
        ) : (
          <>
            <div className="mb-7 grid grid-cols-3 overflow-hidden rounded-2xl border border-border/80 bg-card">
              {[
                [run.operations, "operations"],
                [run.requests, "requests"],
                [run.errors, "exceptions"],
              ].map(([value, key]) => (
                <div key={key} className="border-r border-border/70 px-5 py-5 last:border-r-0">
                  <span className="block text-[11px] text-muted-foreground">
                    {t(`debug.${key}` as "debug.operations")}
                  </span>
                  <span
                    className={`mt-2 block text-3xl font-light tracking-tight tabular-nums ${key === "exceptions" && Number(value) > 0 ? "text-[var(--debug-accent)]" : ""}`}
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <nav className="flex rounded-xl bg-muted/60 p-1" aria-label={t("debug.evidence")}>
                {(["evidence", "compare"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={mode === value}
                    onClick={() => {
                      setMode(value);
                      setSelectedRequest(undefined);
                    }}
                    className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs transition-colors ${mode === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
                  >
                    {value === "evidence" ? (
                      <RiPulseLine className="size-3.5" aria-hidden />
                    ) : (
                      <RiGitMergeLine className="size-3.5" aria-hidden />
                    )}
                    {t(`debug.${value}`)}
                  </button>
                ))}
              </nav>
              <select
                aria-label={t("debug.selectRun")}
                value={run.id}
                onChange={(event) => setRunId(event.target.value)}
                className={`${selectClass} ml-auto`}
              >
                {runs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name || t("debug.run")} · {clock(item.started_at)}
                  </option>
                ))}
              </select>
            </div>
            {run.dropped_requests + run.dropped_operations + run.dropped_console > 0 && (
              <p className="mb-4 text-xs text-[var(--debug-accent)]">{t("debug.partial")}</p>
            )}
            {mode === "compare" ? (
              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
                  {(
                    [
                      [beforeId, setBeforeId, "firstRun"],
                      [afterId, setAfterId, "secondRun"],
                    ] as const
                  ).map(([value, setValue, key], index) => (
                    <div key={key} className="flex min-w-0 flex-1 items-center gap-3">
                      {index === 1 && (
                        <RiArrowRightLine
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      )}
                      <select
                        aria-label={t(`debug.${key}`)}
                        value={value}
                        onChange={(event) => {
                          setValue(event.target.value);
                          setComparison(undefined);
                        }}
                        className={`${selectClass} w-full`}
                      >
                        <option value="">{t(`debug.${key}`)}</option>
                        {compareOptions.map((item) => (
                          <option key={item.id} value={item.id}>
                            {clock(item.started_at)} · {item.method.replace("tool.", "")}{" "}
                            {item.target} · {item.id.split(":").at(-1)}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    disabled={busy || !beforeId || !afterId || beforeId === afterId}
                    onClick={() => void compare()}
                  >
                    {t("debug.compareAction")}
                  </Button>
                </div>
                {selectedRequest ? (
                  <RequestDetail
                    key={selectedRequest.id}
                    session={sessionId}
                    request={selectedRequest}
                    pulse={pulse}
                    onClose={() => setSelectedRequest(undefined)}
                  />
                ) : comparison ? (
                  <Comparison comparison={comparison} onSelect={setSelectedRequest} />
                ) : (
                  <Quiet>{t("debug.noCompare")}</Quiet>
                )}
              </div>
            ) : (
              <div className="grid items-start gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
                <aside className="overflow-hidden rounded-2xl border border-border/80 bg-card">
                  <h2 className="border-b border-border/70 px-5 py-4 text-xs font-medium">
                    {t("debug.timeline")}
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      setOperationId("");
                      setSelectedRequest(undefined);
                    }}
                    aria-pressed={!operationId}
                    className={`w-full border-b border-border/60 px-5 py-3 text-left text-xs ${!operationId ? "bg-[var(--debug-tint)] text-[var(--debug-accent)]" : "text-muted-foreground"}`}
                  >
                    {t("debug.requests")}{" "}
                    <span className="float-right font-mono text-[10px]">{run.requests}</span>
                  </button>
                  <div className="max-h-[620px] overflow-y-auto">
                    {operations.length ? (
                      operations.map((item, index) => (
                        <button
                          key={item.id}
                          type="button"
                          aria-pressed={operationId === item.id}
                          onClick={() => {
                            setOperationId(item.id);
                            setDetail(undefined);
                            setSelectedRequest(undefined);
                          }}
                          className={`flex w-full gap-3 border-b border-border/50 px-4 py-4 text-left last:border-b-0 ${operationId === item.id ? "bg-[var(--debug-tint)]" : "hover:bg-muted/50"}`}
                        >
                          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-[9px] text-muted-foreground">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-xs font-medium leading-relaxed">
                              <OperationName operation={item} />
                            </span>
                            <span className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                              <time>{clock(item.started_at)}</time>
                              <span className={item.state === "error" ? "text-destructive" : ""}>
                                {t(`debug.state_${item.state}`)}
                              </span>
                            </span>
                            <span className="mt-1 block text-[10px] text-muted-foreground">
                              {t("debug.requestCount", { count: item.request_ids.length })}
                            </span>
                          </span>
                        </button>
                      ))
                    ) : (
                      <Quiet>{t("debug.noOperations")}</Quiet>
                    )}
                  </div>
                </aside>
                <div className="min-w-0 space-y-4">
                  {selectedRequest ? (
                    <RequestDetail
                      key={selectedRequest.id}
                      session={sessionId}
                      request={selectedRequest}
                      pulse={pulse}
                      onClose={() => setSelectedRequest(undefined)}
                    />
                  ) : operationId ? (
                    detail?.operation ? (
                      <>
                        <div className="px-1 py-2">
                          <p className="mb-2 font-mono text-[10px] text-muted-foreground">
                            {detail.operation.id}
                          </p>
                          <h2 className="break-words text-lg font-medium">
                            <OperationName operation={detail.operation} />
                          </h2>
                          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                            {t("debug.correlation")}
                          </p>
                          {detail.operation.error && (
                            <p className="mt-3 break-words text-xs text-destructive">
                              {detail.operation.error}
                            </p>
                          )}
                        </div>
                        <section className="overflow-hidden rounded-2xl border border-border/80 bg-card">
                          <h3 className="border-b border-border/60 px-5 py-4 text-xs font-medium">
                            {t("debug.duringRequests")} · {detail.requests?.length ?? 0}
                          </h3>
                          <RequestList
                            requests={detail.requests ?? []}
                            onSelect={setSelectedRequest}
                          />
                        </section>
                        <section className="overflow-hidden rounded-2xl border border-border/80 bg-card">
                          <h3 className="border-b border-border/60 px-5 py-4 text-xs font-medium">
                            {t("debug.console")}
                          </h3>
                          <ConsoleList entries={detail.console ?? []} />
                        </section>
                        <section className="overflow-hidden rounded-2xl border border-border/80 bg-card">
                          <h3 className="flex items-center gap-2 border-b border-border/60 px-5 py-4 text-xs font-medium">
                            <RiCodeSSlashLine className="size-4" aria-hidden />
                            {t("debug.pageChanges")}
                          </h3>
                          <PageChanges operation={detail.operation} />
                        </section>
                      </>
                    ) : (
                      <Quiet>{t("debug.loading")}</Quiet>
                    )
                  ) : (
                    <section className="overflow-hidden rounded-2xl border border-border/80 bg-card">
                      <h2 className="border-b border-border/70 px-5 py-4 text-xs font-medium">
                        {t("debug.requests")}
                      </h2>
                      <RequestList requests={requests} onSelect={setSelectedRequest} />
                    </section>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        <footer className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border/60 pt-5 text-[10px] leading-relaxed text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <RiShieldCheckLine className="size-3.5" aria-hidden />
            {t("debug.retention")}
          </span>
          <details className="ml-auto max-w-lg">
            <summary className="cursor-pointer">{t("debug.coverage")}</summary>
            <p className="pt-3">{t("debug.coverageHelp")}</p>
            {run?.coverage.some((value) => value.startsWith("child_capture")) && (
              <p className="pt-2 text-[var(--debug-accent)]">{t("debug.coveragePartial")}</p>
            )}
          </details>
        </footer>
      </main>
    </div>
  );
}
