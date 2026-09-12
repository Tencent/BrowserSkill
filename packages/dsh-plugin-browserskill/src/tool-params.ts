/** Shared model-facing parameter schemas for browser tools. */

export const SESSION_PARAM = {
  type: "string",
  description:
    "bsk session id to act on; must be one created by browser_session with action=start. " +
    "Omit to use the current session (the one most recently started or used).",
} as const;

export const TAB_ID_PARAM = {
  type: "integer",
  description: "Target tab id. Omit to use the Agent Window's active tab.",
} as const;

export const WAIT_UNTIL_PARAM = {
  type: "string",
  enum: ["load", "domcontentloaded", "networkidle", "commit"],
  description: "Page lifecycle phase to wait for (default: load).",
} as const;

export const TIMEOUT_MS_PARAM = {
  type: "integer",
  description: "Command timeout in milliseconds; must be greater than zero.",
} as const;
