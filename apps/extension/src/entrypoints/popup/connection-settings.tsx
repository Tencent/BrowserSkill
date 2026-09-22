import { useTranslation } from "@browser-skill/i18n/react";
import { Button, Input, Label } from "@browser-skill/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_DAEMON_PORT, resolveDaemonWsUrl } from "@/transport/daemon-endpoint";
import { parseRemoteEndpoint, remoteAuthorizationStatus } from "@/transport/remote-endpoint";
import {
  REMOTE_CONNECTION_MODE,
  REMOTE_CONNECTION_REVISION,
  readRemoteConnection,
} from "@/transport/remote-storage";
import { SettingInfo } from "./setting-info";
import { useDaemonPort } from "./use-daemon-port";

type Mode = "local" | "remote";
type Connection = {
  url: string;
  expiresAt?: string;
  status: ReturnType<typeof remoteAuthorizationStatus>;
};

export function ConnectionSettings({
  connectionEnabled,
  disconnected = false,
}: {
  connectionEnabled: boolean;
  disconnected?: boolean;
}) {
  const { t } = useTranslation("extension");
  const port = useDaemonPort();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  // Selecting a form does not change the persisted connection.
  const [selection, setSelection] = useState<Mode | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"format" | "pairing" | "local" | null>(null);
  const [success, setSuccess] = useState<"pairing" | "local" | "port" | null>(null);
  const saving = useRef(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const read = useCallback(async () => {
    const current = ++revision.current;
    clearTimeout(timer.current);
    try {
      const remote = await readRemoteConnection();
      if (!mounted.current || current !== revision.current) return;
      setConnection(
        remote
          ? {
              url: remote.url,
              expiresAt: remote.expiresAt,
              status: remoteAuthorizationStatus(remote),
            }
          : null,
      );
      setStorageError(false);
      setReady(true);
      if (remote) timer.current = setTimeout(() => void read(), 30_000);
    } catch {
      if (!mounted.current || current !== revision.current) return;
      setStorageError(true);
      setReady(true);
      timer.current = setTimeout(() => void read(), 30_000);
    }
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
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return () => {
        mounted.current = false;
      };
    }
    chrome.storage.onChanged.addListener(changed);
    void read();
    return () => {
      mounted.current = false;
      revision.current += 1;
      clearTimeout(timer.current);
      chrome.storage.onChanged.removeListener(changed);
    };
  }, [read]);

  const activeMode: Mode = connection || storageError ? "remote" : "local";
  const mode = selection ?? activeMode;
  const switchingToLocal = mode === "local" && activeMode !== "local";
  const dirty = mode !== activeMode || (mode === "local" ? port.dirty : !!draft.trim());
  let destination: string | null = null;
  try {
    if (draft.trim()) destination = parseRemoteEndpoint(draft).url;
  } catch {
    // Validate on submit; an incomplete draft must not replace the current address.
  }

  async function save() {
    if (!ready || saving.current) return;
    setError(null);
    setSuccess(null);
    if (mode === "remote" && !destination) {
      setError("format");
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      if (mode === "local") {
        // Reuse the existing port writer. Failed validation or persistence must
        // not discard a remote grant. Explicit local recovery also works when
        // the port preference cannot be read; no unread port is overwritten.
        if (port.loaded) {
          if (!(await port.commit())) return;
        } else if (!switchingToLocal) {
          return;
        }
        if (switchingToLocal) {
          const reply = await chrome.runtime.sendMessage({
            kind: "bsk-remote-authorization",
            pairing: null,
          });
          if (!reply || reply.error) throw new Error("Local selection failed");
          await read();
        }
      } else {
        const reply = await chrome.runtime.sendMessage({
          kind: "bsk-remote-authorization",
          pairing: draft,
        });
        if (!reply || reply.error) throw new Error("Pairing failed");
        await read();
      }
      if (!mounted.current) return;
      setDraft("");
      setSelection(null);
      setSuccess(mode === "remote" ? "pairing" : switchingToLocal ? "local" : "port");
    } catch {
      if (mounted.current) setError(mode === "remote" ? "pairing" : "local");
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function select(mode: Mode) {
    setSelection(mode);
    setError(null);
    setSuccess(null);
  }

  const statusKey =
    connection && !storageError
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
    storageError || error || (connection && !["active", "renewing"].includes(connection.status));
  const localAddress = port.savedPort === null ? "—" : resolveDaemonWsUrl(port.savedPort);
  const address = !ready
    ? t("popup.connectionLoading")
    : storageError
      ? t("popup.remoteUnknown")
      : t("popup.connectionCurrent", {
          mode: t(activeMode === "local" ? "popup.connectionLocal" : "popup.connectionRemote"),
          address: connection?.url ?? localAddress,
        });
  const saveDisabled =
    !ready ||
    busy ||
    (mode === "remote" ? !draft.trim() : !switchingToLocal && (!port.loaded || !port.dirty));

  return (
    <>
      <p
        className="mt-2 break-all text-xs text-muted-foreground"
        data-slot="popup-current-connection"
      >
        {address}
      </p>
      {disconnected && !storageError && !statusKey && (
        <p
          className="mt-2 text-xs leading-snug text-muted-foreground"
          data-slot="popup-daemon-unreachable"
        >
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
        className="mt-3 border-t border-border/70 pt-2.5"
        data-slot="popup-connection-settings"
      >
        <summary className="cursor-pointer text-sm font-medium">
          {t("popup.connectionSettings")}
          {needsAttention && (
            <span className="ml-2 text-xs text-destructive">{t("popup.remoteNeedsAttention")}</span>
          )}
        </summary>
        <div className="mt-3 space-y-3">
          {connection?.expiresAt && !storageError && (
            <p className="text-xs text-muted-foreground">
              {t("popup.remoteExpires", { date: new Date(connection.expiresAt).toLocaleString() })}
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
                onClick={() => select(value)}
                className={`h-8 min-w-0 flex-1 rounded-md text-xs ${mode === value ? "bg-background shadow-sm" : "text-muted-foreground"}`}
              >
                {t(value === "local" ? "popup.connectionLocal" : "popup.connectionRemote")}
              </Button>
            ))}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!saveDisabled) void save();
            }}
            className="space-y-2"
            aria-busy={busy}
          >
            {mode === "local" ? (
              <>
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
                    type="text"
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
            ) : (
              <>
                <div className="relative flex items-center gap-1">
                  <Label htmlFor="remote-pairing">{t("popup.remotePairing")}</Label>
                  <SettingInfo label={t("popup.remotePermissionsInfo")}>
                    {t("popup.remotePermissionsHint")}
                  </SettingInfo>
                </div>
                <Input
                  id="remote-pairing"
                  type="password"
                  autoComplete="off"
                  placeholder="wss://…/extension#…"
                  value={draft}
                  disabled={!ready || busy}
                  aria-invalid={error === "format" || undefined}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setError(null);
                    setSuccess(null);
                  }}
                />
                <p className="text-xs text-muted-foreground">{t("popup.remoteHint")}</p>
                {destination && (
                  <p
                    className="break-all text-xs text-muted-foreground"
                    data-slot="popup-pending-connection"
                  >
                    {t("popup.connectionDestination", { address: destination })}
                  </p>
                )}
              </>
            )}
            <p className="text-xs text-muted-foreground">
              {t(switchingToLocal ? "popup.connectionLocalWarning" : "popup.connectionSaveWarning")}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="submit" size="sm" disabled={saveDisabled}>
                {t(
                  busy
                    ? mode === "remote"
                      ? "popup.remoteSaving"
                      : "popup.daemonPortSaving"
                    : mode === "remote"
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
                    if (port.savedPort !== null) port.setDraft(String(port.savedPort));
                    setError(null);
                    setSuccess(null);
                  }}
                >
                  {t("popup.connectionCancel")}
                </Button>
              )}
            </div>
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
        </div>
      </details>
    </>
  );
}
