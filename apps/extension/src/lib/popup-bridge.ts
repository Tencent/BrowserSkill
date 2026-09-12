import type { SnapshotInfo } from "./connection-controller";

/**
 * Wire protocol for `chrome.runtime.connect({ name: "popup" })`:
 *  - Background pushes `{ kind: "snapshot", data: SnapshotInfo }`.
 *  - Popup sends `{ kind: "set_label" }`, `{ kind: "set_connection_enabled" }`, etc.
 *
 * Daemon port preference is persisted via `chrome.storage.local` instead
 * of this bridge (see `use-daemon-port.ts`).
 */

export const POPUP_PORT_NAME = "popup";

export type PopupOutbound =
  | { kind: "set_label"; value: string }
  | { kind: "set_connection_enabled"; value: boolean };

export type PopupInbound = { kind: "snapshot"; data: SnapshotInfo };
