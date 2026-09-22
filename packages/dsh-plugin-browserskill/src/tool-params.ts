/** Shared model-facing parameter schemas for browser tools. */

export const BROWSER_PARAM = {
  type: "string",
  description:
    "Target browser instance ID or verified unique label for start. Always set this when a " +
    "specific profile is required, even if only one browser is connected. Confirm the mapping " +
    "with the user if unknown; never omit or substitute the selector to recover from an unavailable target.",
} as const;

export const SESSION_PARAM = {
  type: "string",
  description:
    "bsk session id to act on; must be one created by browser_session with action=start. " +
    "Omit to use the current session (the one most recently started or used).",
} as const;

export const SESSION_STOP_PARAMS = {
  session: {
    type: "string",
    description:
      "For stop: owned session ID; mutually exclusive with requestId. Omit both targets to retry " +
      "an unacknowledged stop before using the current session.",
  },
  requestId: {
    type: "string",
    description:
      "For stop: owned lifecycle request ID to stop or acknowledge; mutually exclusive with session. " +
      "Targets the original start even if its short session ID is reused or was never received.",
  },
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
