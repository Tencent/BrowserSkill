import type { SnapshotInfo } from "./connection-controller";

/**
 * Wire protocol for `chrome.runtime.connect({ name: "popup" })`:
 *  - Background pushes `{ kind: "snapshot", data: SnapshotInfo }`.
 *  - Popup sends `{ kind: "set_label" }`, `{ kind: "set_connection_enabled" }`, etc.
 *
 * NOTE(review M4/M5 C2): the `set_port` variant is defined as a
 * placeholder so the future custom-port UI does not have to re-design
 * the bridge, but the popup does NOT render a control that emits it
 * yet and the background does NOT route it. The wiring requires
 * ConnectionController to dispose its current Transport and persist
 * the port in chrome.storage; tracked as a follow-up.
 */

export const POPUP_PORT_NAME = "popup";

export type PopupOutbound =
  | { kind: "set_label"; value: string }
  | { kind: "set_port"; value: number }
  | { kind: "set_connection_enabled"; value: boolean };

export type PopupInbound = { kind: "snapshot"; data: SnapshotInfo };
