import { useTranslation } from "@browser-skill/i18n/react";
import { RiArrowRightUpLine, RiBugLine } from "@remixicon/react";
import { openDebugPage } from "@/debug/client";
import { useDebugTasks } from "@/debug/use-tasks";

/** Additive homepage section: existing controls retain their order and behavior. */
export function CurrentTasks({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation("extension");
  const { tasks } = useDebugTasks(enabled);
  if (!enabled || tasks.length === 0) return null;
  return (
    <section
      className="space-y-2 rounded-xl border border-border/80 bg-card/60 px-3 py-2.5"
      data-slot="popup-current-tasks"
    >
      <h2 className="text-sm font-medium">{t("debug.currentTasks")}</h2>
      {tasks.map((task) => (
        <button
          key={task.session_id}
          type="button"
          onClick={() => openDebugPage(task.session_id, task.run?.id)}
          className="flex w-full items-center gap-2 rounded-lg py-2 text-left transition-colors hover:bg-muted"
        >
          <RiBugLine className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">
              {task.run?.name || task.title || `${t("debug.task")} ${task.session_id}`}
            </span>
            <span className="mt-1 block truncate text-[11px] text-muted-foreground">
              {task.run
                ? t(task.run.state === "capturing" ? "debug.capturing" : "debug.stopped")
                : t("debug.notCapturing")}{" "}
              · {task.run ? t("debug.requestCount", { count: task.run.requests }) : task.session_id}
            </span>
            {!!task.run?.active_rules && (
              <span className="mt-1 block text-[10px] text-[var(--debug-accent)]">
                {t("debug.activeRules", { count: task.run.active_rules })}
              </span>
            )}
          </span>
          <RiArrowRightUpLine className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      ))}
    </section>
  );
}
