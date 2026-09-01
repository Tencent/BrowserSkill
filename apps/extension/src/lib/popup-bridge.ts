import type { SnapshotInfo } from "./connection-controller";

/**
 * Wire protocol for `chrome.runtime.connect({ name: "popup" })`:
 *  - Background pushes `{ kind: "snapshot", data: SnapshotInfo }`.
 *  - Popup sends `{ kind: "set_label" }`, `{ kind: "set_connection_enabled" }`, etc.
 *
 * `set_port` is a legacy placeholder; the popup uses `set_daemon_ws_url`
 * for the runtime endpoint control.
 */

export const POPUP_PORT_NAME = "popup";

export type PopupOutbound =
  | { kind: "set_label"; value: string }
  | { kind: "set_port"; value: number }
  | { kind: "set_daemon_ws_url"; value: string }
  | { kind: "set_connection_enabled"; value: boolean };

export type PopupInbound = { kind: "snapshot"; data: SnapshotInfo };
