import { useTranslation } from "@browser-skill/i18n/react";
import { Button, Input, Label } from "@browser-skill/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_DAEMON_PORT, resolveDaemonWsUrl } from "@/transport/daemon-endpoint";
import type { LocalAuthStatus } from "@/transport/local-auth";
import { parseLocalPairing } from "@/transport/local-credentials";
import { parseRemoteEndpoint, remoteAuthorizationStatus } from "@/transport/remote-endpoint";
import {
  REMOTE_CONNECTION_MODE,
  REMOTE_CONNECTION_REVISION,
  readRemoteConnection,
  readSavedRemoteConnection,
} from "@/transport/remote-storage";
import {
  type LocalPairingInfo,
  LocalPairingNotice,
  LocalVerificationControls,
  localPairingRequest,
  readLocalPairingInfo,
} from "./local-pairing";
import { SettingInfo } from "./setting-info";
import { useDaemonPort } from "./use-daemon-port";

type Mode = "local" | "remote";
type Connection = {
  url: string;
  expiresAt?: string;
  status: ReturnType<typeof remoteAuthorizationStatus>;
};
function parseLink(input: string) {
  try {
    const local = parseLocalPairing(input);
    return { mode: "local" as const, local, url: local.endpoint };
  } catch {
    return { mode: "remote" as const, url: parseRemoteEndpoint(input).url };
  }
}
export function ConnectionSettings({
  connectionEnabled,
  disconnected = false,
  localAuth,
  instanceId = "",
}: {
  connectionEnabled: boolean;
  disconnected?: boolean;
  localAuth?: LocalAuthStatus | null;
  instanceId?: string;
}) {
  const { t } = useTranslation("extension");
  const port = useDaemonPort();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [savedRemote, setSavedRemote] = useState<Connection | null>(null);
  const [local, setLocal] = useState<LocalPairingInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [selection, setSelection] = useState<Mode | null>(null);
  const [draft, setDraft] = useState("");
  const [newLink, setNewLink] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejection, setRejection] = useState<LocalAuthStatus | null>(null);
  const [success, setSuccess] = useState<"pairing" | "local" | "port" | null>(null);
  const saving = useRef(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const read = useCallback(async () => {
    const current = ++revision.current;
    clearTimeout(timer.current);
    const [remote, saved, info] = await Promise.allSettled([
      readRemoteConnection(),
      readSavedRemoteConnection(),
      readLocalPairingInfo(),
    ]);
    if (!mounted.current || current !== revision.current) return;
    const publicConnection = (
      endpoint: NonNullable<Awaited<ReturnType<typeof readRemoteConnection>>>,
    ): Connection => ({
      url: endpoint.url,
      expiresAt: endpoint.expiresAt,
      status: remoteAuthorizationStatus(endpoint),
    });
    setStorageError(remote.status === "rejected");
    if (remote.status === "fulfilled")
      setConnection(remote.value ? publicConnection(remote.value) : null);
    if (saved.status === "fulfilled")
      setSavedRemote(saved.value ? publicConnection(saved.value) : null);
    if (info.status === "fulfilled") setLocal(info.value);
    setReady(true);
    timer.current = setTimeout(() => void read(), 30_000);
  }, []);
  useEffect(() => {
    mounted.current = true;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (
        area === "local" &&
        (changes[REMOTE_CONNECTION_REVISION] || changes[REMOTE_CONNECTION_MODE])
      ) {
        setSuccess(null);
        void read();
      }
    };
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.onChanged.addListener(changed);
      void read();
    }
    return () => {
      mounted.current = false;
      revision.current += 1;
      clearTimeout(timer.current);
      if (typeof chrome !== "undefined") chrome.storage?.onChanged.removeListener(changed);
    };
  }, [read]);
  useEffect(() => {
    if (localAuth?.state === "pairing_required") {
      setOpen(true);
      setSelection("local");
      setNewLink(true);
    }
    if (mounted.current && localAuth?.state === "verified") void read();
  }, [localAuth?.state, read]);
  const activeMode: Mode = connection || storageError ? "remote" : "local";
  const mode = selection ?? activeMode;
  const switchingToLocal = mode === "local" && activeMode !== "local";
  const paired = local?.devices.find(
    (device) =>
      device.daemonId === localAuth?.daemonId ||
      Number(new URL(device.endpoint).port || "80") === port.savedPort,
  );
  const skip = local?.policy.skip ?? localAuth?.reason === "skip";
  let parsed: ReturnType<typeof parseLink> | null = null;
  try {
    if (draft.trim()) parsed = parseLink(draft);
  } catch {
    /* Validate when submitted. */
  }
  const resumeRemote =
    mode === "remote" &&
    activeMode === "local" &&
    !!savedRemote &&
    !["expired", "rejected"].includes(savedRemote.status) &&
    !draft.trim();
  const dirty = mode !== activeMode || port.dirty || !!draft.trim();
  const showInput = mode === "remote" || newLink || !paired;
  const statusKey = connection
    ? (
        {
          active: null,
          renewing: "remoteRenewing",
          unavailable: "remoteRenewalFailed",
          rejected: "remoteRejected",
          expired: "remoteExpired",
          unconfirmed: "remoteUnconfirmed",
        } as const
      )[connection.status]
    : null;
  const needsAttention =
    storageError ||
    error ||
    rejection ||
    statusKey ||
    skip ||
    ["pairing_required", "server_unverified", "daemon_too_old"].includes(localAuth?.state ?? "");
  const address = !ready
    ? t("popup.connectionLoading")
    : storageError
      ? t("popup.remoteUnknown")
      : t("popup.connectionCurrent", {
          mode: t(activeMode === "local" ? "popup.connectionLocal" : "popup.connectionRemote"),
          address:
            connection?.url ?? (port.savedPort === null ? "—" : resolveDaemonWsUrl(port.savedPort)),
        });
  const saveDisabled =
    !ready ||
    busy ||
    (!draft.trim() &&
      (mode === "remote" ? !resumeRemote : !switchingToLocal && (!port.loaded || !port.dirty)));

  async function save(confirmed = false) {
    if (!ready || saving.current) return;
    setError(null);
    setRejection(null);
    setSuccess(null);
    if ((draft.trim() && !parsed) || (mode === "remote" && !parsed && !resumeRemote)) {
      setError("format");
      return;
    }
    if (
      parsed?.mode === "local" &&
      local?.devices.some((d) => d.daemonId === parsed.local.daemonId) &&
      !confirmed
    ) {
      setConfirm(true);
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      if (parsed?.mode === "local") {
        await localPairingRequest({ action: "pair", link: draft });
      } else if (mode === "remote") {
        const reply = await chrome.runtime.sendMessage({
          kind: "bsk-remote-authorization",
          ...(resumeRemote ? { resume: true } : { pairing: draft }),
        });
        if (!reply || reply.error) throw new Error("pairing");
      } else {
        if (port.loaded) {
          if (!(await port.commit())) return;
        } else if (!switchingToLocal) return;
        if (switchingToLocal) {
          const reply = await chrome.runtime.sendMessage({
            kind: "bsk-remote-authorization",
            pairing: null,
          });
          if (!reply || reply.error) throw new Error("local");
        }
      }
      await read();
      if (!mounted.current) return;
      setDraft("");
      setSelection(null);
      setConfirm(false);
      setNewLink(false);
      setSuccess(parsed || resumeRemote ? "pairing" : switchingToLocal ? "local" : "port");
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof Error && ["already_paired", "replace_mismatch"].includes(cause.message))
        setRejection({
          state: cause.message as "already_paired" | "replace_mismatch",
          browserId: (cause as Error & { browserId?: string }).browserId,
        });
      else setError(parsed?.mode === "local" ? "pairing" : mode === "remote" ? "pairing" : "local");
      setConfirm(false);
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function changeSkip(value: boolean) {
    await localPairingRequest({ action: "skip", value });
    await read();
    setRestored(!value);
  }
  async function retry() {
    try {
      await localPairingRequest({ action: "retry" });
    } catch {
      setError("local");
    }
  }
  function edit(value: string) {
    setDraft(value);
    setError(null);
    setRejection(null);
    setSuccess(null);
    setConfirm(false);
    try {
      setSelection(parseLink(value).mode);
    } catch {
      /* Keep current tab while typing. */
    }
  }
  const notice =
    rejection ??
    (activeMode === "local"
      ? skip
        ? { state: "unverified_local" as const, reason: "skip" as const }
        : localAuth
      : null);
  return (
    <>
      <LocalPairingNotice
        status={notice}
        instanceId={instanceId}
        onRetry={() => void retry()}
        onRestore={() => void changeSkip(false).catch(() => setError("local"))}
      />
      {restored && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {t("popup.localAuth.restoreHint")}
        </p>
      )}
      {disconnected && !notice && !storageError && !statusKey && (
        <p className="mt-2 text-xs text-muted-foreground" data-slot="popup-daemon-unreachable">
          {t(activeMode === "remote" ? "popup.remoteUnreachable" : "popup.daemonUnreachable")}
        </p>
      )}
      {statusKey && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {t(`popup.${statusKey}`)}
        </p>
      )}
      {storageError && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {t("popup.remoteStorageError")}
        </p>
      )}
      <details
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
        className="mt-3 border-t border-border/70 pt-2.5"
        data-slot="popup-connection-settings"
      >
        <summary className="cursor-pointer text-xs text-muted-foreground">
          <span>{t("popup.connectionSettings")}</span>
          {ready && !storageError && (
            <span className="ml-2">
              · {t(activeMode === "local" ? "popup.connectionLocal" : "popup.connectionRemote")}
              {paired && activeMode === "local" ? ` · ${t("popup.localAuth.paired")}` : ""}
            </span>
          )}
          {needsAttention && (
            <span className="ml-2 text-destructive">{t("popup.remoteNeedsAttention")}</span>
          )}
        </summary>
        <div className="mt-3 space-y-3">
          <p
            className="break-all text-xs text-muted-foreground"
            data-slot="popup-current-connection"
          >
            {address}
          </p>
          {(connection ?? (mode === "remote" ? savedRemote : null))?.expiresAt && (
            <p className="text-xs text-muted-foreground">
              {t("popup.remoteExpires", {
                date: new Date((connection ?? savedRemote)!.expiresAt!).toLocaleString(),
              })}
            </p>
          )}
          <div
            role="group"
            aria-label={t("popup.connectionMode")}
            className="flex rounded-lg bg-muted/60 p-1"
          >
            {(["local", "remote"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={mode === value}
                disabled={!ready || busy}
                onClick={() => {
                  setSelection(value);
                  setDraft("");
                  setConfirm(false);
                  setError(null);
                  setSuccess(null);
                }}
                className={`h-8 min-w-0 flex-1 rounded-md text-xs ${mode === value ? "bg-background shadow-sm" : "text-muted-foreground"}`}
              >
                {t(value === "local" ? "popup.connectionLocal" : "popup.connectionRemote")}
              </Button>
            ))}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!saveDisabled && !confirm) void save();
            }}
            className="space-y-2"
            aria-busy={busy}
          >
            {mode === "local" && (
              <>
                {paired && (
                  <div data-slot="local-paired-info" className="rounded-lg bg-muted/50 p-2 text-xs">
                    <p>
                      {t("popup.localAuth.pairedInfo", {
                        daemon: paired.daemonId.slice(0, 8),
                        device: paired.deviceId.slice(0, 8),
                      })}
                    </p>
                    {!newLink && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="mt-1 h-7 px-0 text-xs"
                        onClick={() => setNewLink(true)}
                      >
                        {t("popup.localAuth.newLink")}
                      </Button>
                    )}
                  </div>
                )}
                <div className="relative flex items-center gap-1">
                  <Label htmlFor="bh-daemon-port" className="shrink-0">
                    {t("popup.daemonPortLabel")}
                  </Label>
                  <SettingInfo
                    label={t("popup.daemonPortInfoLabel")}
                    data-slot="popup-daemon-port-info"
                  >
                    {t("popup.daemonPortHint")}
                  </SettingInfo>
                  <Input
                    id="bh-daemon-port"
                    inputMode="numeric"
                    value={port.draft}
                    placeholder={String(DEFAULT_DAEMON_PORT)}
                    disabled={!port.loaded || busy}
                    onChange={(event) => {
                      port.setDraft(event.target.value);
                      setError(null);
                      setSuccess(null);
                    }}
                    aria-invalid={port.invalid || undefined}
                    className="ml-auto h-8 w-24 shrink-0 text-center"
                    data-slot="popup-daemon-port-input"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("popup.connectionPortHint", { port: DEFAULT_DAEMON_PORT })}
                </p>
                {port.error && (
                  <p role="alert" className="text-xs text-destructive">
                    {t(
                      port.error === "read"
                        ? "popup.daemonPortReadFailed"
                        : "popup.daemonPortWriteFailed",
                    )}
                  </p>
                )}
                {port.invalid && (
                  <p
                    role="alert"
                    className="text-xs text-destructive"
                    data-slot="popup-daemon-port-error"
                  >
                    {t("popup.daemonPortInvalid")}
                  </p>
                )}
              </>
            )}
            {showInput && (
              <>
                <div className="relative flex items-center gap-1">
                  <Label htmlFor="remote-pairing">{t("popup.remotePairing")}</Label>
                  {mode === "remote" && (
                    <SettingInfo label={t("popup.remotePermissionsInfo")}>
                      {t("popup.remotePermissionsHint")}
                    </SettingInfo>
                  )}
                </div>
                <Input
                  id="remote-pairing"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={mode === "local" ? "ws://127.0.0.1:52800/#…" : "wss://…/extension#…"}
                  value={draft}
                  disabled={!ready || busy}
                  aria-invalid={error === "format" || undefined}
                  onChange={(event) => edit(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t(mode === "local" ? "popup.localAuth.pairHint" : "popup.remoteHint")}
                </p>
                {parsed && (
                  <p
                    className="break-all text-xs text-muted-foreground"
                    data-slot="popup-pending-connection"
                  >
                    {t("popup.connectionDestination", { address: parsed.url })}
                  </p>
                )}
              </>
            )}
            {mode === "remote" && activeMode === "local" && savedRemote?.status === "expired" && (
              <p className="text-xs text-muted-foreground">{t("popup.remoteExpired")}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {t(
                switchingToLocal
                  ? "popup.connectionLocalWarning"
                  : mode === "local" && showInput && !port.dirty
                    ? "popup.localAuth.pairPreserves"
                    : "popup.connectionSaveWarning",
              )}
            </p>
            {confirm && (
              <div
                role="alertdialog"
                aria-label={t("popup.localAuth.replaceTitle")}
                className="space-y-2 rounded-lg border border-amber-400/40 p-2 text-xs"
              >
                <p>{t("popup.localAuth.replaceConfirm")}</p>
                <Button type="button" size="sm" disabled={busy} onClick={() => void save(true)}>
                  {t("popup.localAuth.confirmReplace")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirm(false)}
                >
                  {t("popup.connectionCancel")}
                </Button>
              </div>
            )}
            {!confirm && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button type="submit" size="sm" disabled={saveDisabled}>
                  {t(
                    busy
                      ? draft.trim()
                        ? "popup.remoteSaving"
                        : "popup.daemonPortSaving"
                      : resumeRemote
                        ? "popup.localAuth.resumeRemote"
                        : draft.trim() ||
                            mode === "remote" ||
                            (showInput && !switchingToLocal && !port.dirty)
                          ? "popup.remoteSave"
                          : switchingToLocal
                            ? "popup.remoteLocal"
                            : "popup.daemonPortSave",
                  )}
                </Button>
                {dirty && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setSelection(null);
                      setDraft("");
                      setConfirm(false);
                      if (port.savedPort !== null) port.setDraft(String(port.savedPort));
                      setError(null);
                      setSuccess(null);
                    }}
                  >
                    {t("popup.connectionCancel")}
                  </Button>
                )}
              </div>
            )}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {t(
                  error === "format"
                    ? "popup.remoteFormatError"
                    : error === "local"
                      ? "popup.connectionLocalError"
                      : "popup.remoteError",
                )}
              </p>
            )}
            {success && (
              <p role="status" className="text-xs text-muted-foreground">
                {t(
                  success === "pairing"
                    ? connectionEnabled
                      ? "popup.remoteSaved"
                      : "popup.remoteSavedDisabled"
                    : success === "local"
                      ? "popup.connectionLocalSaved"
                      : "popup.connectionPortSaved",
                )}
              </p>
            )}
          </form>
          {mode === "local" && (
            <LocalVerificationControls
              skip={skip}
              disabled={!local || busy}
              onChange={changeSkip}
            />
          )}
        </div>
      </details>
    </>
  );
}
