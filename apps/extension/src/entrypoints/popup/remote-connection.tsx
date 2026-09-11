import { useTranslation } from "@browser-skill/i18n/react";
import { Button, Input, Label } from "@browser-skill/ui";
import { useEffect, useState } from "react";
import {
  parseRemoteEndpoint,
  REMOTE_ENDPOINT_KEY,
  readRemoteEndpoint,
} from "@/transport/remote-endpoint";

export function RemoteConnection({
  onRemoteChange,
}: {
  onRemoteChange?: (remote: boolean) => void;
}) {
  const { t } = useTranslation("extension");
  const [draft, setDraft] = useState("");
  const [server, setServer] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    let revision = 0;
    const read = async () => {
      const current = ++revision;
      const values = await chrome.storage.local.get(REMOTE_ENDPOINT_KEY);
      if (!alive || current !== revision) return;
      const remote = readRemoteEndpoint(values[REMOTE_ENDPOINT_KEY]);
      setServer(remote?.url ?? null);
      onRemoteChange?.(remote !== null);
      setReady(true);
    };
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[REMOTE_ENDPOINT_KEY])
        void read().catch(() => alive && setError(true));
    };
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    chrome.storage.onChanged.addListener(changed);
    void read().catch(() => {
      if (alive) {
        setError(true);
        setReady(true);
      }
    });
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, [onRemoteChange]);
  async function save(disconnect = false) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const reply = (await chrome.runtime.sendMessage({
        kind: "bsk-remote-authorization",
        pairing: disconnect ? null : draft,
      })) as { url: string | null; error?: string };
      if (reply.error) throw new Error(reply.error);
      setServer(reply.url);
      onRemoteChange?.(reply.url !== null);
      setDraft("");
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  let destination = server;
  try {
    if (draft.trim()) destination = parseRemoteEndpoint(draft).url;
  } catch {
    /* Invalid drafts cannot be saved. */
  }
  return (
    <details className="rounded-xl border border-border/80 bg-card/60 px-3 py-2.5">
      <summary className="cursor-pointer text-sm font-medium">{t("popup.remoteTitle")}</summary>
      <div className="mt-3 space-y-2">
        <p className="break-all text-xs text-muted-foreground">
          {destination ?? t("popup.remoteLocal")}
        </p>
        <Label htmlFor="remote-pairing">{t("popup.remotePairing")}</Label>
        <Input
          id="remote-pairing"
          type="password"
          autoComplete="off"
          value={draft}
          disabled={!ready || busy}
          onChange={(e) => setDraft(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t("popup.remoteHint")}</p>
        <div className="flex gap-2">
          <Button size="sm" disabled={!ready || busy || !draft.trim()} onClick={() => void save()}>
            {t("popup.remoteSave")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!ready || busy || (!server && !error)}
            onClick={() => void save(true)}
          >
            {t("popup.remoteLocal")}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {t("popup.remoteError")}
          </p>
        )}
      </div>
    </details>
  );
}
