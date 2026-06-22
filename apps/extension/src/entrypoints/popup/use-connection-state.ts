import { useEffect, useRef, useState } from "react";
import type { SnapshotInfo } from "@/lib/connection-controller";
import { POPUP_PORT_NAME, type PopupInbound, type PopupOutbound } from "@/lib/popup-bridge";
import type { ConnectionState } from "@/transport/types";

export type PopupDisplayState = Exclude<ConnectionState, "connecting">;

/** Popup status including user-disabled connection preference. */
export type PopupStatusState = PopupDisplayState | "disabled";

/** Popup UI: omit transient `connecting` to avoid label/dot flicker on reconnect. */
export function resolvePopupDisplayState(
  state: ConnectionState,
  lastStable: ConnectionState,
): PopupDisplayState {
  if (state !== "connecting") return state;
  return lastStable === "connecting" ? "disconnected" : lastStable;
}

/** When the user has disabled connection, always show the disabled status. */
export function resolvePopupStatusState(
  snapshot: Pick<SnapshotInfo, "connectionEnabled" | "state">,
  displayState: PopupDisplayState,
): PopupStatusState {
  if (!snapshot.connectionEnabled) return "disabled";
  if (snapshot.state === "version_skew") return "version_skew";
  return displayState;
}

const FALLBACK_SNAPSHOT: SnapshotInfo = {
  state: "disconnected",
  instanceId: "",
  label: "",
  extensionVersion: "",
  handshake: null,
  lastError: null,
  connectionEnabled: true,
};

/**
 * Live snapshot of the background's `ConnectionController` for popup UI.
 *
 * Posts `set_label` mutations back to the background; the incoming
 * snapshot stream reflects the canonical state. The `set_port` channel
 * is defined by the popup-bridge but is not currently routed to the
 * background — wiring it requires `ConnectionController` to swap its
 * Transport URL and persist the chosen port. Tracked for a follow-up
 * milestone; the popup intentionally does not expose a control until
 * the underlying support lands (review M4/M5 C2).
 */
export function useConnectionState(): {
  snapshot: SnapshotInfo;
  statusState: PopupStatusState;
  setLabel: (value: string) => void;
  setConnectionEnabled: (value: boolean) => void;
} {
  const [snapshot, setSnapshot] = useState<SnapshotInfo>(FALLBACK_SNAPSHOT);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const lastStableRef = useRef<ConnectionState>("disconnected");

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.runtime?.connect) {
      return undefined;
    }
    const port = chrome.runtime.connect({ name: POPUP_PORT_NAME });
    portRef.current = port;
    const onMessage = (raw: unknown) => {
      const msg = raw as PopupInbound;
      if (msg?.kind === "snapshot") setSnapshot(msg.data);
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      portRef.current = null;
    });
    return () => {
      port.onMessage.removeListener(onMessage);
      port.disconnect();
      portRef.current = null;
    };
  }, []);

  const post = (msg: PopupOutbound) => {
    try {
      portRef.current?.postMessage(msg);
    } catch (err) {
      console.warn("[browser-skill] popup post failed", err);
    }
  };

  const displayState = resolvePopupDisplayState(snapshot.state, lastStableRef.current);
  if (snapshot.state !== "connecting") {
    lastStableRef.current = snapshot.state;
  }

  const statusState = resolvePopupStatusState(snapshot, displayState);

  return {
    snapshot,
    statusState,
    setLabel: (value: string) => post({ kind: "set_label", value }),
    setConnectionEnabled: (value: boolean) => post({ kind: "set_connection_enabled", value }),
  };
}
