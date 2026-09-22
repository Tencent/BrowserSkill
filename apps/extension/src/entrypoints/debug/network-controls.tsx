import { useTranslation } from "@browser-skill/i18n/react";
import { Button } from "@browser-skill/ui";
import { RiAddLine, RiArrowRightUpLine, RiEqualizerLine } from "@remixicon/react";
import { useEffect, useRef, useState } from "react";
import { debugRequest, recordingRequest } from "@/debug/client";
import type {
  DebugParams,
  DebugReplay,
  DebugRequest,
  DebugRule,
  DebugRuleSpec,
} from "@/debug/types";

const inputClass =
  "mt-2 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2.5 text-xs outline-none focus:ring-2 focus:ring-ring";
const codeClass = `${inputClass} resize-y font-mono leading-relaxed`;
const labelClass = "block min-w-0 text-[11px] text-muted-foreground";
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
type Effect = DebugRuleSpec["effect"]["type"];
export function requestRuleType(request?: DebugRequest): DebugRuleSpec["match"]["resource_type"] {
  const type = request?.resource_type;
  return type === "Fetch" || type === "XHR" || type === "Document" ? type : undefined;
}
function objectJson(text: string): Record<string, never> {
  const value = JSON.parse(text || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("JSON must be an object");
  return value;
}
export function RequestBadges({ request }: { request: DebugRequest }) {
  const { t } = useTranslation("extension");
  return (
    <>
      {request.intervention && (
        <span className="rounded bg-[var(--debug-tint)] px-1.5 py-0.5 text-[10px] text-[var(--debug-accent)]">
          {t(`debug.${request.intervention.type}`)} ·{" "}
          {t(
            request.intervention.state === "pending"
              ? "debug.working"
              : request.intervention.state === "applied"
                ? "debug.controlApplied"
                : request.intervention.state === "failed"
                  ? "debug.controlFailed"
                  : "debug.controlCancelled",
          )}
        </span>
      )}
      {request.replay_from && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {t("debug.replay")}
        </span>
      )}
    </>
  );
}
export function RuleEditor({
  session,
  run,
  request,
  initial = "mock",
  onDone,
  onCancel,
}: {
  session: string;
  run: string;
  request?: DebugRequest;
  initial?: Effect;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("extension");
  const [effect, setEffect] = useState<Effect>(initial);
  const [name, setName] = useState("");
  const [url, setUrl] = useState(request?.url ?? "");
  const [method, setMethod] = useState(request?.method ?? "");
  const [times, setTimes] = useState(1);
  const [status, setStatus] = useState(503);
  const [delay, setDelay] = useState(0);
  const [headers, setHeaders] = useState("{}");
  const [body, setBody] = useState('{\n  "error": "Temporarily unavailable"\n}');
  const [json, setJson] = useState("");
  const [replacement, setReplacement] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newMethod, setNewMethod] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resourceType = requestRuleType(request);
  const unsupported = !!request && !resourceType;
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (unsupported) throw new Error(t("debug.ruleResourceUnsupported"));
      let value: DebugRuleSpec["effect"] = { type: "block" };
      if (effect === "mock")
        value = {
          type: "mock",
          status,
          body,
          delay_ms: delay,
          headers: { "content-type": "application/json", ...objectJson(headers) },
        };
      if (effect === "modify")
        value = {
          type: "modify",
          ...(headers.trim() && headers.trim() !== "{}" ? { headers: objectJson(headers) } : {}),
          ...(replacement ? { body } : json.trim() ? { json: objectJson(json) } : {}),
          ...(newUrl ? { url: newUrl } : {}),
          ...(newMethod ? { method: newMethod } : {}),
        };
      await debugRequest({
        session_id: session,
        run_id: run,
        action: "rule_add",
        rule: {
          name,
          match: {
            url,
            ...(method ? { method } : {}),
            ...(resourceType ? { resource_type: resourceType } : {}),
          },
          effect: value,
          times,
        },
      });
      onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="space-y-5 rounded-2xl border border-[var(--debug-accent)]/30 bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <RiEqualizerLine className="size-4 text-[var(--debug-accent)]" />
          {t("debug.addRule")}
        </h3>
        <span className="text-[10px] text-muted-foreground">
          {t(times === 1 ? "debug.once" : "debug.untilStop")}
          {resourceType && ` · ${resourceType}`}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {(["block", "modify", "mock"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={effect === value}
            className={`rounded-lg border px-3 py-2 text-xs ${effect === value ? "border-[var(--debug-accent)]/50 bg-[var(--debug-tint)] text-[var(--debug-accent)]" : "border-border text-muted-foreground"}`}
            onClick={() => setEffect(value)}
          >
            {t(`debug.${value}`)}
          </button>
        ))}
      </div>
      <label className={labelClass}>
        {t("debug.ruleName")}
        <input
          className={inputClass}
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_130px]">
        <label className={labelClass}>
          {t("debug.matchUrl")}
          <input
            className={`${inputClass} font-mono`}
            required
            placeholder="http://localhost:3000/api/*"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label className={labelClass}>
          {t("debug.httpMethod")}
          <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="">{t("debug.anyMethod")}</option>
            {methods.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      {effect === "mock" && (
        <div className="grid grid-cols-2 gap-4">
          <label className={labelClass}>
            {t("debug.mockStatus")}
            <input
              className={inputClass}
              type="number"
              min={200}
              max={599}
              value={status}
              onChange={(e) => setStatus(Number(e.target.value))}
            />
          </label>
          <label className={labelClass}>
            {t("debug.delayMs")}
            <input
              className={inputClass}
              type="number"
              min={0}
              max={10000}
              value={delay}
              onChange={(e) => setDelay(Number(e.target.value))}
            />
          </label>
        </div>
      )}
      {effect === "modify" && (
        <>
          <label className={labelClass}>
            {t("debug.jsonEdits")}
            <textarea
              className={codeClass}
              disabled={replacement}
              rows={3}
              placeholder={'{"rename":{"displayName":"name"}}'}
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
            <span className="mt-2 block leading-relaxed">{t("debug.jsonEditsHint")}</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={replacement}
              onChange={(e) => {
                setReplacement(e.target.checked);
                setBody("");
              }}
            />
            {t("debug.replaceBody")}
          </label>
        </>
      )}
      {(effect === "mock" || (effect === "modify" && replacement)) && (
        <label className={labelClass}>
          {t("debug.bodyText")}
          <textarea
            className={codeClass}
            rows={5}
            aria-label={t("debug.bodyText")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
      )}
      {effect !== "block" && (
        <details className="rounded-xl border border-border/70 p-4">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {t(effect === "mock" ? "debug.mockHeaders" : "debug.headers")}
          </summary>
          <label className={`${labelClass} mt-4`}>
            {t(effect === "mock" ? "debug.mockHeaders" : "debug.headersJson")}
            <textarea
              className={codeClass}
              rows={3}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
            />
          </label>
          {effect === "modify" && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className={labelClass}>
                {t("debug.newUrl")}
                <input
                  className={inputClass}
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                />
              </label>
              <label className={labelClass}>
                {t("debug.newMethod")}
                <select
                  className={inputClass}
                  value={newMethod}
                  onChange={(e) => setNewMethod(e.target.value)}
                >
                  <option value="">—</option>
                  {methods.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </details>
      )}
      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 pt-4">
        <select
          aria-label={t("debug.once")}
          className="min-w-0 flex-1 rounded-lg border border-input bg-background p-2 text-xs"
          value={times}
          onChange={(e) => setTimes(Number(e.target.value))}
        >
          <option value={1}>{t("debug.once")}</option>
          <option value={0}>{t("debug.untilStop")}</option>
        </select>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("debug.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={busy || unsupported}>
          {t(busy ? "debug.working" : "debug.applyRule")}
        </Button>
      </div>
      {(error || unsupported) && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error || t("debug.ruleResourceUnsupported")}
        </p>
      )}
    </form>
  );
}
export function RulesPanel({
  session,
  run,
  pulse,
  active,
  onChange,
}: {
  session: string;
  run: string;
  pulse: number;
  active: boolean;
  onChange: () => void;
}) {
  const { t } = useTranslation("extension");
  const [rules, setRules] = useState<DebugRule[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void recordingRequest({ session_id: session, run_id: run, action: "rules" }).then(
      (value) => {
        if (!cancelled) setRules(value.rules ?? []);
      },
      (reason) => {
        if (!cancelled) setError(String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session, run, pulse, revision]);
  function changed() {
    setRevision((value) => value + 1);
    onChange();
  }
  async function update(id: string, action: DebugParams["action"]) {
    setBusy(true);
    setError("");
    try {
      await debugRequest({ session_id: session, run_id: run, id, action });
      changed();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const labels = {
    enabled: "ruleEnabled",
    disabled: "ruleDisabled",
    exhausted: "ruleExhausted",
    removed: "ruleRemoved",
    stopped: "ruleStopped",
  } as const;
  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">{t("debug.rules")}</h2>
          {active && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <RiAddLine className="size-3.5" />
              {t("debug.addRule")}
            </Button>
          )}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t("debug.rulesHelp")}</p>
        {!active && (
          <p className="mt-3 text-xs text-muted-foreground">{t("debug.captureRequired")}</p>
        )}
      </div>
      {adding && active && (
        <RuleEditor
          session={session}
          run={run}
          onDone={() => {
            setAdding(false);
            changed();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {!rules.length && !adding && (
        <p className="rounded-2xl border border-dashed border-border p-10 text-center text-xs text-muted-foreground">
          {t("debug.noRules")}
        </p>
      )}
      {rules.map((rule) => (
        <article key={rule.id} className="rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-md bg-[var(--debug-tint)] px-2 py-1 text-[10px] text-[var(--debug-accent)]">
              {t(`debug.${rule.effect.type}`)}
            </span>
            <h3 className="min-w-0 flex-1 break-words text-sm font-medium">
              {rule.name || rule.id}
            </h3>
            <span
              className={`text-[10px] ${rule.state === "enabled" ? "text-[var(--debug-accent)]" : "text-muted-foreground"}`}
            >
              {t(`debug.${labels[rule.state]}`)}
            </span>
          </div>
          <p className="mt-4 break-all font-mono text-xs">
            {rule.match.method ?? "*"} {rule.match.url}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <span>{t("debug.ruleHits", { count: rule.hits })}</span>
            <span>
              ·{" "}
              {rule.times === 0
                ? t("debug.untilStop")
                : rule.times === 1
                  ? t("debug.once")
                  : `${rule.hits} / ${rule.times}`}
            </span>
            {active && ["enabled", "disabled"].includes(rule.state) && (
              <Button
                className="ml-auto"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void update(rule.id, rule.state === "enabled" ? "rule_disable" : "rule_enable")
                }
              >
                {t(rule.state === "enabled" ? "debug.disableRule" : "debug.enableRule")}
              </Button>
            )}
            {active && rule.state !== "removed" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void update(rule.id, "rule_remove")}
              >
                {t("debug.removeRule")}
              </Button>
            )}
          </div>
          {rule.last_error && <p className="mt-3 text-xs text-destructive">{rule.last_error}</p>}
          <details className="mt-4 border-t border-border/60 pt-3">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              {t("debug.controlDetails")}
            </summary>
            <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-3 text-[11px]">
              {JSON.stringify(
                { match: rule.match, effect: rule.effect, times: rule.times },
                null,
                2,
              )}
            </pre>
          </details>
        </article>
      ))}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
export function ReplayEditor({
  session,
  request,
  onChange,
  onCancel,
  onRequest,
}: {
  session: string;
  request: DebugRequest;
  onChange: () => void;
  onCancel: () => void;
  onRequest: (id: string) => void;
}) {
  const { t } = useTranslation("extension");
  const [url, setUrl] = useState(request.integrity?.url === "complete" ? request.url : ""),
    [method, setMethod] = useState(request.method),
    [headers, setHeaders] = useState("{}"),
    [body, setBody] = useState("");
  const [complete, setComplete] = useState(false),
    [touched, setTouched] = useState(false),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [result, setResult] = useState<DebugReplay>();
  const attempt = useRef(crypto.randomUUID());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const base = {
        session_id: session,
        run_id: request.run_id,
        action: "request" as const,
        id: request.id,
      };
      const hdr = await recordingRequest({ ...base, part: "headers" });
      let text = "",
        offset = 0,
        full = false;
      for (let page = 0; page < 4; page++) {
        const item = (
          await recordingRequest({ ...base, part: "request", offset, max_chars: 16384 })
        ).request!;
        const value = item.request_body;
        text += value.text ?? "";
        full = ["available", "empty"].includes(value.state) && value.replay_safe === true;
        if (value.next_offset === undefined) break;
        offset = value.next_offset;
        full = false;
      }
      if (cancelled) return;
      const editable = Object.fromEntries(
        Object.entries(hdr.request?.request_headers ?? {}).filter(
          ([name]) =>
            !/^(?:host|content-length|cookie|cookie2|origin|referer|user-agent|accept-encoding|connection|transfer-encoding|upgrade|proxy-.*|sec-.*|access-control-request-.*)$/i.test(
              name,
            ),
        ),
      );
      setHeaders(JSON.stringify(editable, null, 2));
      setBody(text);
      setComplete(full);
      setLoaded(true);
    })().catch((reason) => {
      if (!cancelled) setError(String(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [session, request.id, request.run_id]);
  async function send() {
    setBusy(true);
    setError("");
    try {
      const value = await debugRequest({
        session_id: session,
        run_id: request.run_id,
        action: "replay",
        id: request.id,
        replay: {
          key: attempt.current,
          ...(url !== request.url || request.integrity?.url !== "complete" ? { url } : {}),
          method,
          headers: objectJson(headers),
          ...(touched ? { body } : {}),
        },
      });
      setResult(value.replay);
      onChange();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="space-y-4 rounded-2xl border border-[var(--debug-accent)]/30 bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <h3 className="text-sm font-medium">{t("debug.replay")}</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("debug.replayHelp")}</p>
      <fieldset disabled={!loaded || busy || !!result} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
          <label className={labelClass}>
            {t("debug.httpMethod")}
            <select
              className={inputClass}
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {methods.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            URL
            <input
              required
              className={inputClass}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {request.integrity?.url !== "complete" && (
              <span className="text-xs text-[var(--debug-accent)]">{t("debug.urlIncomplete")}</span>
            )}
          </label>
        </div>
        <label className={labelClass}>
          {t("debug.headersJson")}
          <textarea
            className={codeClass}
            rows={4}
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
          />
        </label>
        <label className={labelClass}>
          {t("debug.bodyText")}
          <textarea
            className={codeClass}
            rows={5}
            aria-label={t("debug.bodyText")}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setTouched(true);
            }}
          />
        </label>
        {loaded && !complete && (
          <p className="text-xs text-[var(--debug-accent)]">{t("debug.bodyIncomplete")}</p>
        )}
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={onCancel}>
          {t("debug.cancel")}
        </Button>
        {!result && (
          <Button
            size="sm"
            type="submit"
            disabled={!loaded || busy || !url.trim() || (!complete && !touched)}
          >
            {t(busy ? "debug.working" : "debug.sendReplay")}
          </Button>
        )}
        {result?.request_id && (
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => onRequest(result.request_id!)}
          >
            <RiArrowRightUpLine className="size-3.5" />
            {t("debug.openReplay")}
          </Button>
        )}
      </div>
      {result && (
        <p
          className={`text-xs ${result.state === "complete" ? "text-[var(--debug-accent)]" : "text-destructive"}`}
        >
          {result.error || t("debug.replayDone")}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
