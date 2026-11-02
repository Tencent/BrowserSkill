import { useTranslation } from "@browser-skill/i18n/react";
import { useState } from "react";
import type { DebugEvidence, DebugOperation, DebugRequest, DebugValue } from "@/debug/types";
import { clock, PageState, RequestList } from "./evidence";

export function OperationEvidence({
  evidence,
  operation,
  requests,
  onRequest,
}: {
  evidence?: DebugEvidence;
  operation: DebugOperation;
  requests: DebugRequest[];
  onRequest: (request: DebugRequest, part?: "request" | "response") => void;
}) {
  const { t } = useTranslation("extension");
  const [expanded, setExpanded] = useState(false);
  if (!evidence) return null;
  const changed = evidence.fields.filter(
    (field) =>
      field.before.value !== field.input.value ||
      field.input.value !== field.later.value ||
      field.submitted.length ||
      field.response.length,
  );
  const fields = expanded
    ? evidence.fields
    : (changed.length ? changed : evidence.fields).slice(0, 6);
  const gap = (key: string) => t(`debug.gap_${key}` as "debug.partial", { defaultValue: key });
  const pending = requests.filter((request) => request.state === "pending").length;
  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-border/80 bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
          <h3 className="text-xs font-medium">{t("debug.fieldChain")}</h3>
          <span className="text-[10px] text-muted-foreground">{t("debug.exactFields")}</span>
        </div>
        {fields.length ? (
          fields.map((field) => (
            <div key={field.key} className="border-b border-border/60 p-5 last:border-b-0">
              <h4 className="mb-4 text-sm font-medium">{field.label}</h4>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                {(
                  [
                    ["chainBefore", [field.before]],
                    ["chainInput", [field.input]],
                    ["chainSubmitted", field.submitted],
                    ["chainResponse", field.response],
                    ["chainLater", [field.later]],
                  ] as [string, DebugValue[]][]
                ).map(([stage, values], index) => {
                  const comparable = values.filter((value) => value.state === "available");
                  const different =
                    index > 1 &&
                    field.input.state === "available" &&
                    comparable.some((value) => value.value !== field.input.value);
                  return (
                    <div
                      key={stage}
                      className={`min-w-0 rounded-xl border p-3 ${different ? "border-[var(--debug-accent)]/40 bg-[var(--debug-tint)]" : "border-border/60 bg-background/40"}`}
                    >
                      <p className="mb-3 text-[10px] text-muted-foreground">
                        {String(index + 1).padStart(2, "0")} ·{" "}
                        {t(`debug.${stage}` as "debug.before")}
                      </p>
                      {(values.length ? values : [{ state: "unmatched" }]).map((value, n) => (
                        <div key={`${value.source}-${n}`} className="mb-3 last:mb-0">
                          <p
                            className={`whitespace-pre-wrap break-all font-mono text-xs leading-relaxed ${value.state !== "available" ? "text-muted-foreground" : ""}`}
                          >
                            {value.state === "available"
                              ? value.value === ""
                                ? t("debug.emptyValue")
                                : value.value
                              : t(
                                  `debug.${value.state.startsWith("body_") ? "gap" : "value"}_${value.state}` as "debug.unavailable",
                                  {
                                    defaultValue: value.state,
                                  },
                                )}
                          </p>
                          {value.state === "truncated" && (
                            <p className="mt-1 break-all font-mono text-xs">{value.value}</p>
                          )}
                          {value.at && (
                            <time className="mt-2 block text-[9px] text-muted-foreground">
                              {clock(value.at)}
                            </time>
                          )}
                          {value.source?.includes(":n") ? (
                            <button
                              type="button"
                              className="mt-1 break-all text-left font-mono text-[9px] text-[var(--debug-accent)] underline decoration-dotted underline-offset-4"
                              onClick={() => {
                                const request = requests.find(
                                  (item) => item.id === value.source?.split(" ")[0],
                                );
                                if (request)
                                  onRequest(request, index === 2 ? "request" : "response");
                              }}
                            >
                              {value.source}
                            </button>
                          ) : value.source?.startsWith("page:") ? (
                            <p className="mt-1 text-[9px] text-muted-foreground">
                              {t(
                                value.source === "page:reload"
                                  ? "debug.afterReload"
                                  : "debug.laterPage",
                              )}
                            </p>
                          ) : null}
                        </div>
                      ))}
                      {different && (
                        <p className="mt-2 text-[9px] text-[var(--debug-accent)]">
                          {t("debug.differsFromInput")}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        ) : (
          <p className="p-5 text-xs leading-relaxed text-muted-foreground">{t("debug.noFields")}</p>
        )}
        {evidence.fields.length > fields.length && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="px-5 pb-4 text-xs text-[var(--debug-accent)]"
          >
            {t("debug.allFields", { count: evidence.fields.length })}
          </button>
        )}
      </section>
      <section className="overflow-hidden rounded-2xl border border-border/80 bg-card">
        <h3 className="border-b border-border/70 px-5 py-4 text-xs font-medium">
          {t("debug.submissionFacts")}
        </h3>
        <p className="px-5 pt-4 text-[10px] leading-relaxed text-muted-foreground">
          {t("debug.submissionHelp")}
        </p>
        {evidence.payloads.length ? (
          <div className="max-h-80 overflow-auto p-5">
            <div className="space-y-2">
              {evidence.payloads.map((item, index) => (
                <button
                  type="button"
                  key={`${item.request_id}-${item.part}-${item.path}-${index}`}
                  onClick={() => {
                    const request = requests.find((request) => request.id === item.request_id);
                    if (request)
                      onRequest(request, item.part === "request" ? "request" : "response");
                  }}
                  className="grid w-full grid-cols-[72px_minmax(0,1fr)] gap-3 rounded-lg bg-muted/40 px-3 py-2 text-left text-[11px] hover:bg-muted sm:grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)]"
                >
                  <span className="text-[10px] text-muted-foreground">
                    {t(item.part === "request" ? "debug.requestBody" : "debug.responseBody")}
                    <span className="mt-1 block font-mono">
                      {item.request_id.split(":").at(-1)}
                    </span>
                  </span>
                  <span className="break-all font-mono">{item.path}</span>
                  <span className="col-start-2 break-all font-mono text-[var(--debug-accent)] sm:col-start-auto">
                    {item.value}
                    {item.truncated && (
                      <span className="ml-2 text-[9px] text-muted-foreground">
                        {t("debug.value_truncated")}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="p-5 text-xs text-muted-foreground">{t("debug.noStructuredBody")}</p>
        )}
        <RequestList
          requests={requests}
          onSelect={onRequest}
          delayedIds={evidence.links
            .filter((link) => link.relation === "delayed")
            .map((link) => link.request_id)}
        />
      </section>
      <section className="overflow-hidden rounded-2xl border border-border/80 bg-card">
        <h3 className="border-b border-border/70 px-5 py-4 text-xs font-medium">
          {t("debug.visibleChanges")}
        </h3>
        <div className="space-y-2 p-5 text-xs leading-relaxed">
          {!evidence.changes.added.length && !evidence.changes.removed.length && (
            <p className="text-muted-foreground">
              {t(
                operation.before?.state !== "available" || operation.after?.state !== "available"
                  ? "debug.unavailable"
                  : "debug.noVisibleChanges",
              )}
            </p>
          )}
          {evidence.changes.removed.map((line, i) => (
            <p key={`removed-${i}`} className="break-words text-muted-foreground">
              <span className="mr-2 select-none">−</span>
              {line}
            </p>
          ))}
          {evidence.changes.added.map((line, i) => (
            <p key={`added-${i}`} className="break-words text-[var(--debug-accent)]">
              <span className="mr-2 select-none">+</span>
              {line}
            </p>
          ))}
          {evidence.changes.truncated && (
            <p className="text-[10px] text-muted-foreground">{t("debug.partial")}</p>
          )}
        </div>
        {evidence.observations.length > 0 && (
          <details className="border-t border-border/60 p-5">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t("debug.followingChanges", { count: evidence.observations.length })}
            </summary>
            <div className="mt-5 space-y-6">
              {evidence.observations.map((page, i) => (
                <div key={`${page.at}-${i}`}>
                  <p className="mb-3 text-[10px] text-muted-foreground">
                    {clock(page.at)} ·{" "}
                    {page.navigation ? t("debug.laterPage") : t("debug.observedAfter")}
                  </p>
                  <PageState page={page} />
                </div>
              ))}
            </div>
          </details>
        )}
      </section>
      <section className="rounded-2xl border border-border/80 bg-[var(--debug-tint)]/40 p-5">
        <h3 className="text-xs font-medium">{t("debug.evidenceCoverage")}</h3>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t("debug.coverageNoScore")}
        </p>
        {pending > 0 && (
          <p className="mt-3 text-xs text-[var(--debug-accent)]">
            {t("debug.waitingRequests", { count: pending })}
          </p>
        )}
        <ul className="mt-3 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
          {evidence.gaps.map((item) => (
            <li key={item}>· {gap(item)}</li>
          ))}
          <li>
            ·{" "}
            {t("debug.observationWindow", {
              seconds: operation.observation_end
                ? Math.max(0, Math.round((operation.observation_end - operation.started_at) / 1000))
                : 0,
            })}
          </li>
          <li>· {t("debug.unsupportedCapture")}</li>
        </ul>
      </section>
    </>
  );
}
