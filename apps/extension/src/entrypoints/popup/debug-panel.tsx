import { useTranslation } from "@browser-skill/i18n/react";
import { Button, Input } from "@browser-skill/ui";
import { RiArrowRightUpLine, RiBugLine, RiCheckLine, RiShieldCheckLine } from "@remixicon/react";
import { useState } from "react";
import { debugRequest, openDebugPage } from "@/debug/client";
import type { DebugTask } from "@/debug/types";
import { useDebugTasks } from "@/debug/use-tasks";

export function DebugPanel({ connected }: { connected: boolean }) {
  const { t } = useTranslation("extension");
  const { tasks, loaded, error, refresh } = useDebugTasks(connected);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [copied, setCopied] = useState(false);
  const task: DebugTask | undefined =
    tasks.find((entry) => entry.session_id === selected) ?? tasks[0];
  const run = task?.run;
  const capture = async () => {
    if (!task) return;
    setBusy(true);
    setFailure("");
    try {
      await debugRequest({
        session_id: task.session_id,
        action: run?.state === "capturing" ? "stop" : "start",
        ...(run?.state === "capturing"
          ? { run_id: run.id }
          : { tab_id: task.tab_id, name: name.trim() || task.title }),
      });
      refresh();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "unavailable");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3" data-slot="popup-debug-panel">
      <Button size="sm" variant="outline" className="w-full" onClick={() => openDebugPage()}>
        <RiArrowRightUpLine className="size-4" aria-hidden />
        {t("debug.history")}
      </Button>
      {!connected && (
        <p className="py-4 text-xs text-muted-foreground">{t("debug.disconnected")}</p>
      )}
      {connected && !loaded && (
        <p className="text-xs text-muted-foreground">{t("debug.loading")}</p>
      )}
      {(failure || error) && (
        <p
          role="alert"
          className="break-words rounded-lg bg-destructive/10 p-3 text-xs text-destructive"
        >
          {failure || error}
        </p>
      )}
      {connected && loaded && !task && (
        <div className="space-y-3 py-3 text-center">
          <RiBugLine className="mx-auto size-7 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-medium">{t("debug.emptyTitle")}</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("debug.emptyHelp")}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(t("debug.prompt")).then(
                () => setCopied(true),
                () => setFailure(t("debug.copyFailed")),
              );
            }}
          >
            {t(copied ? "debug.copied" : "debug.copyPrompt")}
          </Button>
        </div>
      )}
      {connected && task && (
        <>
          {tasks.length > 1 && (
            <label className="block text-xs text-muted-foreground">
              {t("debug.currentTasks")}
              <select
                value={task.session_id}
                onChange={(event) => setSelected(event.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background p-2 text-foreground"
              >
                {tasks.map((entry) => (
                  <option key={entry.session_id} value={entry.session_id}>
                    {entry.run?.name || entry.title || entry.session_id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="space-y-2 rounded-xl border border-border/80 bg-card/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">
                {t(
                  run?.state === "capturing"
                    ? "debug.capturing"
                    : run
                      ? "debug.stopped"
                      : "debug.notCapturing",
                )}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">{task.session_id}</span>
            </div>
            <p className="truncate text-sm font-medium">
              {run?.name || task.title || t("debug.task")}
            </p>
            <p className="break-all text-[11px] text-muted-foreground">
              {run?.url || task.url || "about:blank"}
            </p>
            {run && (
              <div className="grid grid-cols-3 divide-x divide-border border-y border-border py-3">
                {[
                  [run.operations, "debug.operations"],
                  [run.requests, "debug.requests"],
                  [run.errors, "debug.exceptions"],
                ].map(([count, key]) => (
                  <div key={String(key)} className="px-2">
                    <p className="text-lg tabular-nums">{count}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {t(key as "debug.operations")}
                    </p>
                  </div>
                ))}
              </div>
            )}
            {run && (
              <Button
                size="sm"
                className="w-full"
                onClick={() => openDebugPage(task.session_id, run.id)}
              >
                <RiArrowRightUpLine className="size-4" aria-hidden />
                {t("debug.viewEvidence")}
              </Button>
            )}
          </div>
          {run?.state !== "capturing" && (
            <>
              <label className="block text-xs text-muted-foreground" htmlFor="debug-task-name">
                {t("debug.taskName")}
              </label>
              <Input
                id="debug-task-name"
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("debug.namePlaceholder")}
              />
              <div className="space-y-2 py-1 text-xs text-muted-foreground">
                {["debug.captureNetwork", "debug.captureConsole", "debug.capturePage"].map(
                  (key) => (
                    <p className="flex items-center gap-2" key={key}>
                      <RiCheckLine className="size-4" aria-hidden />
                      {t(key as "debug.captureNetwork")}
                    </p>
                  ),
                )}
              </div>
            </>
          )}
          <Button
            size="sm"
            variant={run?.state === "capturing" ? "outline" : "default"}
            className="w-full"
            disabled={busy || (run?.state !== "capturing" && task.tab_id === undefined)}
            onClick={() => void capture()}
          >
            {t(busy ? "debug.working" : run?.state === "capturing" ? "debug.stop" : "debug.start")}
          </Button>
          <p className="flex gap-2 text-[11px] leading-relaxed text-muted-foreground">
            <RiShieldCheckLine className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("debug.retention")}
          </p>
        </>
      )}
    </section>
  );
}
