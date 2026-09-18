import { useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import {
  RiArrowLeftLine,
  RiArrowRightLine,
  RiArrowRightUpLine,
  RiCheckLine,
  RiCodeSSlashLine,
} from "@remixicon/react";
import { useEffect, useState } from "react";
import { recordingRequest } from "@/debug/client";
import { requestKind } from "@/debug/evidence-model";
import type {
  DebugBody,
  DebugConsole,
  DebugOperation,
  DebugPage,
  DebugParams,
  DebugRequest,
} from "@/debug/types";

export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

import { RequestBadges } from "./network-controls";

export function requestPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}
export function OperationName({ operation }: { operation: DebugOperation }) {
  const { t } = useTranslation("extension");
  const key = operation.method.replace("tool.", "");
  return (
    <>
      {t(`debug.method_${key}` as "debug.method_click", { defaultValue: key })}
      {operation.target && <> · {operation.target}</>}
    </>
  );
}
export function Quiet({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 py-10 text-center text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}
export function RequestList({
  requests,
  onSelect,
  delayedIds = [],
}: {
  requests: DebugRequest[];
  onSelect: (request: DebugRequest) => void;
  delayedIds?: string[];
}) {
  const { t } = useTranslation("extension");
  const [showNoise, setShowNoise] = useState(false);
  const primary = requests.filter((request) => requestKind(request) === "business");
  const noise = requests.length - primary.length;
  if (!requests.length) return <Quiet>{t("debug.noRequests")}</Quiet>;
  return (
    <div className="divide-y divide-border/60">
      {!primary.length && !showNoise && (
        <p className="px-5 py-4 text-xs text-muted-foreground">{t("debug.noPrimaryRequests")}</p>
      )}
      {(showNoise ? requests : primary).map((request) => (
        <button
          key={request.id}
          type="button"
          onClick={() => onSelect(request)}
          className="group flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-muted/60"
        >
          <span
            className={`w-11 shrink-0 rounded-md py-1 text-center font-mono text-[11px] ${request.state === "failed" || (request.status ?? 0) >= 400 ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}
          >
            {request.status ?? (request.state === "pending" ? "…" : "ERR")}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="font-mono text-[10px] text-muted-foreground">{request.method}</span>
              <span className="truncate font-mono text-xs" title={request.url}>
                {requestPath(request.url)}
              </span>
            </span>
            <span className="mt-1 flex flex-wrap gap-1">
              <RequestBadges request={request} />
            </span>
            <span className="mt-1 block truncate text-[10px] text-muted-foreground">
              {request.error || request.resource_type || request.mime_type} ·{" "}
              {request.id.split(":").at(-1)}
              {requestKind(request) === "extension" && <> · {t("debug.source_extension")}</>}
              {delayedIds.includes(request.id) && <> · {t("debug.delayedAssociation")}</>}
              {!["available", "empty"].includes(request.response_body.state) && (
                <> · {t(`debug.gap_body_${request.response_body.state}` as "debug.partial")}</>
              )}
            </span>
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {request.duration_ms === undefined ? "—" : `${Math.round(request.duration_ms)} ms`}
          </span>
          <RiArrowRightUpLine
            className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground"
            aria-hidden
          />
        </button>
      ))}
      {noise > 0 && (
        <button
          type="button"
          onClick={() => setShowNoise((value) => !value)}
          className="w-full px-5 py-3 text-left text-[11px] text-muted-foreground"
        >
          {t(showNoise ? "debug.hideNoise" : "debug.showNoise", { count: noise })}
        </button>
      )}
    </div>
  );
}
export function ConsoleList({ entries }: { entries: DebugConsole[] }) {
  const { t } = useTranslation("extension");
  const [showOther, setShowOther] = useState(false);
  const other = entries.filter((entry) =>
    ["extension", "browser"].includes(entry.source ?? "unknown"),
  );
  if (!entries.length) return <Quiet>{t("debug.noConsole")}</Quiet>;
  return (
    <div className="divide-y divide-border/60">
      {(showOther ? entries : entries.filter((entry) => !other.includes(entry))).map((entry) => (
        <div key={entry.id} className="px-5 py-3">
          <div className="mb-2 flex gap-2 text-[10px] text-muted-foreground">
            <time>{clock(entry.at)}</time>
            <span className={entry.level === "error" ? "text-destructive" : ""}>{entry.level}</span>
            {entry.count > 1 && <span>×{entry.count}</span>}
            {entry.relation === "delayed" && <span>{t("debug.delayedAssociation")}</span>}
            <span className="ml-auto">
              {t(`debug.source_${entry.source ?? "unknown"}` as "debug.source_unknown")}
            </span>
          </div>
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
            {entry.text}
          </pre>
          {entry.source_url && (
            <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
              {entry.source_url}
            </p>
          )}
          {entry.stack && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Stack</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all text-[11px]">{entry.stack}</pre>
            </details>
          )}
        </div>
      ))}
      {other.length > 0 && (
        <button
          type="button"
          onClick={() => setShowOther((value) => !value)}
          className="w-full px-5 py-3 text-left text-[11px] text-muted-foreground"
        >
          {t(showOther ? "debug.hideNoise" : "debug.otherSources", { count: other.length })}
        </button>
      )}
    </div>
  );
}
export function PageState({ page }: { page?: DebugPage }) {
  const { t } = useTranslation("extension");
  return (
    <div className="min-w-0">
      <p className="mb-2 truncate text-xs font-medium">{page?.title}</p>
      {page?.url && (
        <p className="mb-3 break-all font-mono text-[10px] text-muted-foreground">{page.url}</p>
      )}
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
        {page?.state === "available" ? page.text || t("debug.noData") : t("debug.unavailable")}
      </pre>
      {page?.truncated && (
        <p className="mt-2 text-xs text-muted-foreground">{t("debug.partial")}</p>
      )}
      {!!page?.fields?.length && (
        <details className="mt-4 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t("debug.capturedFields")}</summary>
          <dl className="mt-3 space-y-2">
            {page.fields.map((field, index) => (
              <div key={`${field.key}-${index}`} className="grid grid-cols-2 gap-3">
                <dt className="break-all">{field.name || field.label}</dt>
                <dd className="break-all font-mono">
                  {field.state === "available"
                    ? field.value === ""
                      ? t("debug.emptyValue")
                      : field.value
                    : t(`debug.value_${field.state}` as "debug.value_redacted")}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}
export function PageChanges({ operation }: { operation: DebugOperation }) {
  const { t } = useTranslation("extension");
  return (
    <div className="grid gap-5 p-5 sm:grid-cols-2">
      {(["before", "after"] as const).map((side) => (
        <section key={side} className="min-w-0">
          <h4 className="mb-4 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            {t(`debug.${side}`)}
          </h4>
          <PageState page={operation[side]} />
        </section>
      ))}
    </div>
  );
}
function BodyView({ body, onOffset }: { body: DebugBody; onOffset: (offset: number) => void }) {
  const { t } = useTranslation("extension");
  const label =
    body.state === "pending"
      ? "pendingBody"
      : body.state === "empty"
        ? "emptyBody"
        : body.state === "truncated"
          ? "truncatedBody"
          : body.state === "available"
            ? "completeBody"
            : "missingBody";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-3 text-[10px] text-muted-foreground">
        <span>{t(`debug.${label}`)}</span>
        {body.reason && <span>· {body.reason}</span>}
        {body.redacted && (
          <span className="ml-auto flex items-center gap-1">
            <RiCheckLine className="size-3" aria-hidden />
            {t("debug.redacted")}
          </span>
        )}
      </div>
      {body.text ? (
        <pre
          className="min-h-48 overflow-x-auto whitespace-pre-wrap break-all px-5 py-5 font-mono text-xs leading-7"
          data-testid="debug-body"
        >
          {body.text}
        </pre>
      ) : (
        <Quiet>{t(`debug.${label}`)}</Quiet>
      )}
      {((body.offset ?? 0) > 0 || body.next_offset !== undefined) && (
        <div className="flex items-center justify-between border-t border-border/60 px-5 py-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={!body.offset}
            onClick={() => onOffset(Math.max(0, (body.offset ?? 0) - 4096))}
          >
            <RiArrowLeftLine className="size-3" />
            {t("debug.previous")}
          </Button>
          <span className="font-mono text-[10px] text-muted-foreground">
            {body.offset ?? 0}–{(body.offset ?? 0) + (body.text?.length ?? 0)} / {body.chars}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={body.next_offset === undefined}
            onClick={() => onOffset(body.next_offset!)}
          >
            {t("debug.next")}
            <RiArrowRightLine className="size-3" />
          </Button>
        </div>
      )}
    </>
  );
}
function Fields({ values }: { values?: Record<string, string | number | undefined> }) {
  const { t } = useTranslation("extension");
  return values && Object.keys(values).length ? (
    <dl className="space-y-3">
      {Object.entries(values).map(([key, value]) => (
        <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 text-[11px]">
          <dt className="break-words text-muted-foreground">{key}</dt>
          <dd className="break-all font-mono">{String(value ?? "—")}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="text-xs text-muted-foreground">{t("debug.noData")}</p>
  );
}
export function RequestDetail({
  session,
  request,
  pulse,
  onClose,
  initialPart = "response",
  onControl,
}: {
  session: string;
  request: DebugRequest;
  pulse: number;
  onClose: () => void;
  initialPart?: NonNullable<DebugParams["part"]>;
  onControl?: (action: "replay" | "block" | "modify" | "mock") => void;
}) {
  const { t } = useTranslation("extension");
  const [part, setPart] = useState<NonNullable<DebugParams["part"]>>(initialPart);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<DebugRequest>();
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void recordingRequest({
      action: "request",
      session_id: session,
      run_id: request.run_id,
      id: request.id,
      part,
      offset,
      max_chars: 4096,
    }).then(
      (result) => {
        if (!cancelled) {
          setData(result.request);
          setError("");
        }
      },
      (err: Error) => {
        if (!cancelled) {
          setData(undefined);
          setError(err.message);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session, request.run_id, request.id, part, offset, pulse]);
  return (
    <section
      className="overflow-hidden rounded-2xl border border-border bg-card"
      aria-label={t("debug.evidence")}
    >
      <div className="border-b border-border/70 p-5">
        <button
          type="button"
          onClick={onClose}
          className="mb-5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <RiArrowLeftLine className="size-3.5" />
          {t("debug.back")}
        </button>
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-md bg-muted px-2 py-1 font-mono text-[11px]">
            {data?.status ?? request.status ?? request.state}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">{request.method}</span>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">{request.id}</span>
        </div>
        <h3 className="break-all font-mono text-sm leading-relaxed">{data?.url ?? request.url}</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          <RequestBadges request={data ?? request} />
        </div>
        {(data ?? request).intervention && (
          <p className="mt-3 break-words text-[11px] text-muted-foreground">
            {(data ?? request).intervention?.rule_id} ·{" "}
            {(data ?? request).intervention?.error ||
              (data ?? request).intervention?.changes?.join(", ")}
          </p>
        )}
        {(data ?? request).replay_from && (
          <p className="mt-2 break-all text-[11px] text-muted-foreground">
            {t("debug.originalRequest")} · {(data ?? request).replay_from}
          </p>
        )}
        {onControl && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-border/60 pt-4">
            {(["replay", "modify", "mock", "block"] as const).map((action) => (
              <Button key={action} size="sm" variant="outline" onClick={() => onControl(action)}>
                {t(`debug.${action}`)}
              </Button>
            ))}
          </div>
        )}
      </div>
      <nav
        className="flex overflow-x-auto border-b border-border/70 px-3"
        aria-label={t("debug.evidence")}
      >
        {(
          [
            ["response", "responseBody"],
            ["request", "requestBody"],
            ["headers", "headers"],
            ["timing", "timing"],
          ] as const
        ).map(([value, key]) => (
          <button
            key={value}
            type="button"
            aria-pressed={part === value}
            onClick={() => {
              setPart(value);
              setOffset(0);
              setData(undefined);
            }}
            className={`shrink-0 border-b-2 px-3 py-3 text-xs ${part === value ? "border-[var(--debug-accent)] text-[var(--debug-accent)]" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t(`debug.${key}`)}
          </button>
        ))}
      </nav>
      {error ? (
        <p role="alert" className="p-5 text-xs text-destructive">
          {error}
        </p>
      ) : !data ? (
        <Quiet>{t("debug.loading")}</Quiet>
      ) : part === "request" || part === "response" ? (
        <BodyView
          body={part === "request" ? data.request_body : data.response_body}
          onOffset={(value) => {
            setData(undefined);
            setOffset(value);
          }}
        />
      ) : part === "headers" ? (
        <div className="space-y-7 p-5">
          <section>
            <h4 className="mb-4 text-xs font-medium">{t("debug.requestHeaders")}</h4>
            <Fields values={data.request_headers} />
          </section>
          <section>
            <h4 className="mb-4 text-xs font-medium">{t("debug.responseHeaders")}</h4>
            <Fields values={data.response_headers} />
          </section>
        </div>
      ) : (
        <div className="space-y-7 p-5">
          <Fields
            values={{
              [t("debug.duration")]:
                data.duration_ms === undefined ? "—" : `${data.duration_ms} ms`,
              [t("debug.transferSize")]: data.transfer_bytes,
              [t("debug.decodedSize")]: data.decoded_bytes,
              [t("debug.initiator")]: data.initiator,
              [t("debug.cache")]: String(data.from_cache ?? false),
              [t("debug.serviceWorker")]: String(data.from_service_worker ?? false),
            }}
          />
          <Fields values={data.timing} />
        </div>
      )}
    </section>
  );
}
