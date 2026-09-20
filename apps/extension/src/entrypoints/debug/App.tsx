import { useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import {
  RiArrowLeftLine,
  RiArrowRightUpLine,
  RiBugLine,
  RiDeleteBinLine,
  RiDownloadLine,
  RiHistoryLine,
  RiShieldCheckLine,
  RiStopCircleLine,
} from "@remixicon/react";
import { useEffect, useRef, useState } from "react";
import { debugHistory, debugRequest, deleteRecording, recordingRequest } from "@/debug/client";
import type {
  DebugConsole,
  DebugOperation,
  DebugPage,
  DebugRequest,
  DebugResult,
  DebugRun,
} from "@/debug/types";
import { useDebugTasks } from "@/debug/use-tasks";
import {
  ConsoleList,
  clock,
  OperationName,
  PageChanges,
  PageState,
  Quiet,
  RequestDetail,
  RequestList,
} from "./evidence";
import { ReplayEditor, RuleEditor, RulesPanel } from "./network-controls";
import { OperationEvidence } from "./operation-evidence";

export function DebugApp() {
  const { t } = useTranslation("extension");
  const { tasks, error: taskError, refresh } = useDebugTasks();
  const [selection, setSelection] = useState(() => {
    const query = new URLSearchParams(location.search);
    return { session: query.get("session") ?? "", run: query.get("run") ?? "" };
  });
  const [runs, setRuns] = useState<DebugRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [filter, setFilter] = useState("");
  const [revision, setRevision] = useState(0);
  const [operations, setOperations] = useState<DebugOperation[]>([]);
  const [requests, setRequests] = useState<DebugRequest[]>([]);
  const [messages, setMessages] = useState<DebugConsole[]>([]);
  const [pages, setPages] = useState<DebugPage[]>([]);
  const [operationId, setOperationId] = useState("");
  const [mode, setMode] = useState<"requests" | "console" | "pages" | "rules">("requests");
  const [detail, setDetail] = useState<DebugResult>();
  const [selectedRequest, setSelectedRequest] = useState<DebugRequest>();
  const [requestPart, setRequestPart] = useState<"request" | "response">("response");
  const [controlEditor, setControlEditor] = useState<"replay" | "block" | "modify" | "mock">();
  const initialOperation = useRef("");
  const run = selection.run
    ? runs.find((item) => item.id === selection.run)
    : selection.session
      ? runs.find((item) => item.session_id === selection.session)
      : undefined;
  const runId = run?.id;
  const sessionId = run?.session_id ?? selection.session;
  const task = tasks.find(
    (item) => item.session_id === sessionId && (!run || run.started_at >= item.created_at),
  );
  const isHistory = !selection.session && !selection.run;
  const pulse = run?.next_since ?? 0;
  const errorCounts = messages
    .filter((entry) => entry.level === "error")
    .reduce<Record<string, number>>((counts, entry) => {
      const source = entry.source ?? "unknown";
      counts[source] = (counts[source] ?? 0) + entry.count;
      return counts;
    }, {});

  function select(session = "", id = "") {
    setSelection({ session, run: id });
    setError("");
    setConfirmDelete(false);
    const query = new URLSearchParams();
    if (session) query.set("session", session);
    if (id) query.set("run", id);
    history.replaceState(null, "", `${location.pathname}${query.size ? `?${query}` : ""}`);
  }
  function openRequest(request: DebugRequest, part: "request" | "response" = "response") {
    setControlEditor(undefined);
    setRequestPart(part);
    setSelectedRequest(request);
  }

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const poll = async () => {
      if (cancelled || document.hidden || pending) return;
      pending = true;
      try {
        const result = await debugHistory();
        if (!cancelled) {
          setRuns(result.runs);
          setHistoryError(result.error ?? "");
        }
      } catch (reason) {
        if (!cancelled) setHistoryError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        pending = false;
        if (!cancelled) setLoaded(true);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [revision]);

  useEffect(() => {
    initialOperation.current = "";
    setOperations([]);
    setRequests([]);
    setMessages([]);
    setPages([]);
    setOperationId("");
    setDetail(undefined);
    setSelectedRequest(undefined);
    setControlEditor(undefined);
    setMode("requests");
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const base = { session_id: sessionId, run_id: runId };
    void (async () => {
      const [actions, consoleResult, pageResult] = await Promise.all([
        recordingRequest({ ...base, action: "operations", limit: 100 }),
        recordingRequest({ ...base, action: "console" }),
        recordingRequest({ ...base, action: "pages" }),
      ]);
      const entries: DebugRequest[] = [];
      let since = 0;
      for (let page = 0; page < 20; page++) {
        if (cancelled) return;
        const batch = await recordingRequest({ ...base, action: "requests", since, limit: 100 });
        entries.push(...(batch.requests ?? []));
        since = batch.next_since ?? since;
        if ((batch.requests?.length ?? 0) < 100) break;
      }
      if (cancelled) return;
      setOperations((actions.operations ?? []).sort((a, b) => a.started_at - b.started_at));
      if (initialOperation.current !== runId && actions.operations?.length) {
        initialOperation.current = runId;
        setOperationId(actions.operations.at(-1)!.id);
      }
      setRequests(
        [...new Map(entries.map((item) => [item.id, item])).values()].sort(
          (a, b) => a.started_at - b.started_at,
        ),
      );
      setMessages(consoleResult.console ?? []);
      setPages(pageResult.pages ?? []);
    })().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [runId, sessionId, pulse]);

  useEffect(() => {
    if (!runId || !operationId) {
      setDetail(undefined);
      return;
    }
    let cancelled = false;
    void recordingRequest({
      action: "operation",
      session_id: sessionId,
      run_id: runId,
      id: operationId,
    }).then(
      (result) => {
        if (!cancelled) setDetail(result);
      },
      (reason: Error) => {
        if (!cancelled) {
          setDetail(undefined);
          setError(reason.message);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runId, sessionId, operationId, pulse]);

  async function capture() {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      const result = await debugRequest({
        session_id: task.session_id,
        action: run?.state === "capturing" ? "stop" : "start",
        ...(run?.state === "capturing"
          ? { run_id: run.id }
          : { tab_id: task.tab_id, name: task.title }),
      });
      if (result.run) {
        setRuns((current) => [
          result.run!,
          ...current.filter((item) => item.id !== result.run!.id),
        ]);
        select(task.session_id, result.run.id);
      }
      setRevision((value) => value + 1);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function exportRecord() {
    if (!run) return;
    setBusy(true);
    setError("");
    try {
      const result = await recordingRequest({
        action: "export",
        session_id: run.session_id,
        run_id: run.id,
      });
      if (!result.recording) throw new Error(t("debug.recordMissing"));
      const blob = new Blob([JSON.stringify(result.recording, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `browser-debug-${run.id}.json`;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removeRecord() {
    if (!run || run.state === "capturing") return;
    setBusy(true);
    setError("");
    try {
      await deleteRecording(run.id);
      setRuns((current) => current.filter((item) => item.id !== run.id));
      select();
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const visible = runs.filter((item) =>
    `${item.name} ${item.url} ${item.id}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
  );
  return (
    <div className="debug-workspace min-h-screen bg-background text-foreground">
      <header className="border-b border-border/70 bg-card/70">
        <div className="mx-auto flex max-w-[1480px] flex-wrap items-center gap-4 px-6 py-5 lg:px-10">
          <img src="/icon/logo.png" width="28" height="28" alt="" />
          <span className="text-sm font-semibold tracking-tight">BrowserSkill</span>
          <span className="text-border">/</span>
          <span className="text-xs text-muted-foreground">{t("debug.title")}</span>
          {!isHistory && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => select()}>
              <RiHistoryLine className="size-4" aria-hidden />
              {t("debug.history")}
            </Button>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-[1480px] px-6 py-8 lg:px-10">
        <div className="mb-7 flex flex-wrap items-start gap-5">
          <div className="min-w-0 flex-1">
            <p className="mb-3 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--debug-accent)]">
              <RiBugLine className="size-3.5" aria-hidden />
              {t(isHistory ? "debug.localHistory" : "debug.evidence")}
            </p>
            <h1 className="break-words text-2xl font-medium tracking-tight">
              {isHistory ? t("debug.history") : run?.name || task?.title || t("debug.title")}
            </h1>
            <p className="mt-3 break-all text-xs leading-relaxed text-muted-foreground">
              {isHistory ? t("debug.historyHelp") : run?.url || task?.url || t("debug.emptyHelp")}
            </p>
          </div>
          {!isHistory && (
            <div className="flex flex-wrap items-center gap-2">
              {run && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void exportRecord()}
                >
                  <RiDownloadLine className="size-4" aria-hidden />
                  {t("debug.export")}
                </Button>
              )}
              {task && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || (run?.state !== "capturing" && task.tab_id === undefined)}
                  onClick={() => void capture()}
                >
                  <RiStopCircleLine className="size-4" aria-hidden />
                  {t(run?.state === "capturing" ? "debug.stop" : "debug.start")}
                </Button>
              )}
              {run && run.state !== "capturing" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t("debug.delete")}
                  onClick={() => setConfirmDelete(true)}
                >
                  <RiDeleteBinLine className="size-4" aria-hidden />
                </Button>
              )}
            </div>
          )}
        </div>
        {(error || historyError || taskError || run?.storage_error) && (
          <p
            role="alert"
            className="mb-5 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive"
          >
            {run?.storage_error
              ? `${t("debug.storageFailed")} ${run.storage_error}`
              : historyError
                ? `${t("debug.storageFailed")} ${historyError}`
                : error || taskError}
          </p>
        )}
        {confirmDelete && (
          <div
            role="alertdialog"
            aria-label={t("debug.delete")}
            className="mb-5 flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card p-4"
          >
            <p className="flex-1 text-xs">{t("debug.deleteConfirm")}</p>
            <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
              {t("debug.cancel")}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void removeRecord()}>
              {t("debug.delete")}
            </Button>
          </div>
        )}
        {!loaded ? (
          <Quiet>{t("debug.loading")}</Quiet>
        ) : isHistory ? (
          <>
            {tasks.length > 0 && (
              <section className="mb-7 rounded-2xl border border-border bg-card p-5">
                <h2 className="mb-3 text-xs text-muted-foreground">{t("debug.currentTasks")}</h2>
                <div className="flex flex-wrap gap-3">
                  {tasks.map((item) => (
                    <button
                      type="button"
                      key={item.session_id}
                      onClick={() => select(item.session_id, item.run?.id)}
                      className="flex min-w-0 items-center gap-3 rounded-xl border border-border px-4 py-3 text-left text-xs hover:bg-muted"
                    >
                      <span className="max-w-72 truncate">
                        {item.run?.name || item.title || item.session_id}
                      </span>
                      <RiArrowRightUpLine className="size-3.5 shrink-0" aria-hidden />
                    </button>
                  ))}
                </div>
              </section>
            )}
            {runs.length > 0 && (
              <div className="mb-4 flex items-center gap-4">
                <input
                  type="search"
                  aria-label={t("debug.searchHistory")}
                  placeholder={t("debug.searchHistory")}
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  className="w-full max-w-sm rounded-lg border border-input bg-card px-3 py-2.5 text-xs outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-xs text-muted-foreground">
                  {visible.length} / {runs.length}
                </span>
              </div>
            )}
            {visible.length ? (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {visible.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => select(item.session_id, item.id)}
                    className="group min-w-0 rounded-2xl border border-border/80 bg-card p-5 text-left transition-colors hover:border-[var(--debug-accent)]/50"
                  >
                    <div className="mb-4 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <time>{new Date(item.started_at).toLocaleString()}</time>
                      <span
                        className={item.state === "capturing" ? "text-[var(--debug-accent)]" : ""}
                      >
                        {t(item.state === "capturing" ? "debug.capturing" : "debug.savedRecord")}
                      </span>
                    </div>
                    <h2 className="truncate text-sm font-medium">{item.name || t("debug.run")}</h2>
                    <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
                      {item.url || "about:blank"}
                    </p>
                    <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 border-t border-border/60 pt-4 text-[11px] text-muted-foreground">
                      <span>
                        {item.requests} {t("debug.requests")}
                      </span>
                      <span>
                        {item.operations} {t("debug.operations")}
                      </span>
                      <span>
                        {item.errors} {t("debug.exceptions")}
                      </span>
                      <RiArrowRightUpLine className="ml-auto size-3.5" aria-hidden />
                    </div>
                    {item.storage_error && (
                      <p className="mt-3 text-xs text-destructive">{t("debug.storageFailed")}</p>
                    )}
                    {(item.dropped_requests + item.dropped_operations + item.dropped_console > 0 ||
                      item.coverage.includes("interrupted_checkpoint") ||
                      item.coverage.includes("manual_capture_unavailable")) && (
                      <p className="mt-3 text-[10px] text-[var(--debug-accent)]">
                        {t("debug.partial")}
                      </p>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border py-14 text-center">
                <RiHistoryLine className="mx-auto mb-4 size-8 text-muted-foreground" aria-hidden />
                <h2 className="text-sm font-medium">
                  {t(runs.length ? "debug.noMatches" : "debug.noHistory")}
                </h2>
                <Quiet>{t("debug.emptyHelp")}</Quiet>
              </div>
            )}
          </>
        ) : !run ? (
          <div className="rounded-2xl border border-dashed border-border py-14 text-center">
            <h2 className="text-sm font-medium">
              {t(
                selection.run
                  ? "debug.recordMissing"
                  : task
                    ? "debug.notCapturing"
                    : "debug.noSession",
              )}
            </h2>
            <Quiet>{t("debug.emptyHelp")}</Quiet>
            <Button variant="outline" size="sm" onClick={() => select()}>
              <RiArrowLeftLine className="size-4" aria-hidden />
              {t("debug.history")}
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-5 flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-muted-foreground">
              <span className={run.state === "capturing" ? "text-[var(--debug-accent)]" : ""}>
                {t(run.state === "capturing" ? "debug.capturing" : "debug.stopped")}
              </span>
              <time>{new Date(run.started_at).toLocaleString()}</time>
              <span className="font-mono">{run.id}</span>
              {run.environment?.extension_version && (
                <span>BrowserSkill {run.environment.extension_version}</span>
              )}
              {run.saved_at && <span>{t("debug.savedAt", { time: clock(run.saved_at) })}</span>}
              {run.stop_reason && (
                <span>
                  {t("debug.stopReason")}:{" "}
                  {t(`debug.reason_${run.stop_reason}` as "debug.reason_requested", {
                    defaultValue: run.stop_reason,
                  })}
                </span>
              )}
            </div>
            <div className="mb-6 grid grid-cols-3 overflow-hidden rounded-2xl border border-border/80 bg-card">
              {(
                [
                  [run.requests, "requests"],
                  [run.operations, "operations"],
                  [errorCounts.website ?? 0, "websiteErrors"],
                ] as const
              ).map(([value, key]) => (
                <div key={key} className="border-r border-border/70 px-5 py-5 last:border-r-0">
                  <span className="block text-[11px] text-muted-foreground">
                    {t(`debug.${key}`)}
                  </span>
                  <span className="mt-2 block text-3xl font-light tracking-tight tabular-nums">
                    {value}
                  </span>
                </div>
              ))}
            </div>
            <p className="mb-5 flex flex-wrap gap-4 text-[10px] text-muted-foreground">
              {(["website", "extension", "browser", "unknown"] as const).map((source) => (
                <span key={source}>
                  {t(`debug.source_${source}`)} · {errorCounts[source] ?? 0}
                </span>
              ))}
            </p>
            {(run.dropped_requests + run.dropped_operations + run.dropped_console > 0 ||
              run.coverage.includes("page_context_limit") ||
              run.coverage.includes("interrupted_checkpoint")) && (
              <p className="mb-4 text-xs text-[var(--debug-accent)]">{t("debug.partial")}</p>
            )}
            {run.storage && (
              <p className="mb-4 text-[11px] text-muted-foreground">
                {t("debug.storageSaved", { count: run.storage.requests })}
              </p>
            )}
            {run.coverage
              .filter((gap) => gap.startsWith("evidence_"))
              .map((gap) => (
                <p
                  key={gap}
                  role="status"
                  className="mb-3 rounded-xl border border-border bg-card p-3 text-xs text-[var(--debug-accent)]"
                >
                  {t(`debug.gap_${gap}` as "debug.partial", { defaultValue: gap })}
                </p>
              ))}
            <div className="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
              <aside className="overflow-hidden rounded-2xl border border-border/80 bg-card">
                <h2 className="border-b border-border/70 px-5 py-4 text-xs font-medium">
                  {t("debug.timeline")}
                </h2>
                {(["requests", "console", "pages", "rules"] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    onClick={() => {
                      setMode(value);
                      setOperationId("");
                      setSelectedRequest(undefined);
                    }}
                    aria-pressed={!operationId && mode === value}
                    className={`flex w-full items-center justify-between border-b border-border/60 px-5 py-3 text-left text-xs ${!operationId && mode === value ? "bg-[var(--debug-tint)] text-[var(--debug-accent)]" : "text-muted-foreground"}`}
                  >
                    {t(`debug.${value}`)}
                    <span className="font-mono text-[10px]">
                      {value === "requests"
                        ? run.requests
                        : value === "console"
                          ? messages.length
                          : value === "rules"
                            ? (run.active_rules ?? 0)
                            : pages.length}
                    </span>
                  </button>
                ))}
                <div className="max-h-[180px] overflow-y-auto sm:max-h-[300px] lg:max-h-[620px]">
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
                          <span className="mt-2 flex gap-2 text-[10px] text-muted-foreground">
                            <time>{clock(item.started_at)}</time>
                            <span>{t(`debug.state_${item.state}`)}</span>
                            <span>
                              {t(
                                item.source === "human" ? "debug.humanAction" : "debug.agentAction",
                              )}
                            </span>
                          </span>
                        </span>
                      </button>
                    ))
                  ) : (
                    <Quiet>{t("debug.noOperations")}</Quiet>
                  )}
                </div>
              </aside>
              <div className="min-w-0 space-y-5">
                {selectedRequest ? (
                  <div className="space-y-4">
                    <RequestDetail
                      key={selectedRequest.id}
                      session={sessionId}
                      request={selectedRequest}
                      pulse={pulse}
                      initialPart={requestPart}
                      onClose={() => {
                        setSelectedRequest(undefined);
                        setControlEditor(undefined);
                      }}
                      onControl={task && run.state === "capturing" ? setControlEditor : undefined}
                    />
                    {task &&
                      run.state === "capturing" &&
                      controlEditor &&
                      (controlEditor === "replay" ? (
                        <ReplayEditor
                          key={selectedRequest.id}
                          session={sessionId}
                          request={selectedRequest}
                          onChange={() => setRevision((value) => value + 1)}
                          onCancel={() => setControlEditor(undefined)}
                          onRequest={(id) => {
                            void recordingRequest({
                              action: "request",
                              session_id: sessionId,
                              run_id: run.id,
                              id,
                            })
                              .then((value) => {
                                if (value.request) openRequest(value.request);
                              })
                              .catch((reason) => setError(String(reason)));
                          }}
                        />
                      ) : (
                        <RuleEditor
                          key={`${selectedRequest.id}-${controlEditor}`}
                          session={sessionId}
                          run={run.id}
                          request={selectedRequest}
                          initial={controlEditor}
                          onCancel={() => setControlEditor(undefined)}
                          onDone={() => {
                            setControlEditor(undefined);
                            setSelectedRequest(undefined);
                            setOperationId("");
                            setMode("rules");
                            setRevision((value) => value + 1);
                          }}
                        />
                      ))}
                  </div>
                ) : operationId ? (
                  detail?.operation ? (
                    <>
                      <div className="px-1">
                        <h2 className="text-sm font-medium">
                          <OperationName operation={detail.operation} />
                        </h2>
                        <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                          {detail.operation.id}
                        </p>
                        {detail.operation.error && (
                          <p className="mt-3 break-words text-xs text-destructive">
                            {detail.operation.error}
                          </p>
                        )}
                      </div>
                      <OperationEvidence
                        key={detail.operation.id}
                        evidence={detail.evidence}
                        operation={detail.operation}
                        requests={detail.requests ?? []}
                        onRequest={openRequest}
                      />
                      {!detail.evidence && (
                        <Panel title={t("debug.duringRequests")}>
                          <RequestList requests={detail.requests ?? []} onSelect={openRequest} />
                        </Panel>
                      )}
                      <Panel title={t("debug.console")}>
                        <ConsoleList entries={detail.console ?? []} />
                      </Panel>
                      <details className="rounded-2xl border border-border/80 bg-card">
                        <summary className="cursor-pointer px-5 py-4 text-xs font-medium">
                          {t("debug.rawPageEvidence")}
                        </summary>
                        <PageChanges operation={detail.operation} />
                      </details>
                      <p className="text-[10px] text-muted-foreground">{t("debug.correlation")}</p>
                    </>
                  ) : (
                    <Quiet>{t("debug.loading")}</Quiet>
                  )
                ) : mode === "rules" ? (
                  <RulesPanel
                    key={run.id}
                    session={sessionId}
                    run={run.id}
                    pulse={pulse}
                    active={!!task && run.state === "capturing"}
                    onChange={() => setRevision((value) => value + 1)}
                  />
                ) : mode === "requests" ? (
                  <Panel title={t("debug.requests")}>
                    <RequestList requests={requests} onSelect={openRequest} />
                  </Panel>
                ) : mode === "console" ? (
                  <Panel title={t("debug.console")}>
                    <ConsoleList entries={messages} />
                  </Panel>
                ) : (
                  <Panel title={t("debug.pages")}>
                    {pages.length ? (
                      pages.map((page, index) => (
                        <details
                          key={`${page.at}-${index}`}
                          open={index === pages.length - 1}
                          className="border-b border-border/60 p-5 last:border-b-0"
                        >
                          <summary className="mb-4 cursor-pointer break-all text-xs text-muted-foreground">
                            {clock(page.at)} · {page.title || page.url || t("debug.unavailable")}
                          </summary>
                          <PageState page={page} />
                        </details>
                      ))
                    ) : (
                      <Quiet>{t("debug.noData")}</Quiet>
                    )}
                  </Panel>
                )}
              </div>
            </div>
          </>
        )}
        <footer className="mt-8 flex flex-wrap items-start gap-x-5 gap-y-3 border-t border-border/60 pt-5 text-[10px] leading-relaxed text-muted-foreground">
          <span className="flex max-w-3xl items-start gap-1.5">
            <RiShieldCheckLine className="mt-0.5 size-3.5 shrink-0" aria-hidden />
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border/80 bg-card">
      <h3 className="border-b border-border/60 px-5 py-4 text-xs font-medium">{title}</h3>
      {children}
    </section>
  );
}
