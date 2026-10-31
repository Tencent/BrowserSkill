/** Shared model-facing parameter schemas for browser tools. */

export const CONTROL_POLICY_PARAM = {
  type: "string",
  enum: ["auto", "target", "strict"],
  description:
    "Sync/share: auto (default) preserves the session policy or chooses target for a new session. target checks the chosen element and explicit expect conditions; strict preserves whole-page observation guards. An established policy cannot be changed.",
} as const;

export const OBSERVATION_ID_PARAM = {
  type: "string",
  description:
    "Explicit observation_id from sync. Required for untargeted actions under target policy. Strict-policy drag instead accepts its ref-map observation token. Never substitute a newer observation into an old decision.",
} as const;

export const EXPECT_PARAM = {
  type: "array",
  description:
    "At most 16 exact conditions checked before the action. Declare the business facts used for the decision, such as a row's record ID or a price; unrelated page updates do not block target actions.",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      target: {
        type: "string",
        required: true,
        description:
          "Observed ref or main-document CSS selector, at most 1024 characters. Use refs for iframe elements.",
      },
      field: {
        type: "string",
        required: true,
        enum: ["text", "value", "checked", "attribute", "exists"],
      },
      equals: {
        required: true,
        oneOf: [{ type: "string" }, { type: "boolean" }, { type: "null" }],
        description:
          "text/value: string; checked/exists: boolean; attribute: string or null for absence.",
      },
      attribute: {
        type: "string",
        description: "Required only for field=attribute, at most 256 characters.",
      },
    },
  },
} as const;

export interface ActionExpectation {
  target: string;
  field: "text" | "value" | "checked" | "attribute" | "exists";
  equals: string | boolean | null;
  attribute?: string;
}

/** Field-dependent constraints supplement the public JSON schema. */
export function validateExpectations(expect: readonly ActionExpectation[] | undefined): void {
  if (expect === undefined) return;
  if (!Array.isArray(expect) || expect.length > 16)
    throw new Error("expect requires at most 16 conditions");
  for (const condition of expect) {
    if (
      !condition ||
      typeof condition.target !== "string" ||
      !condition.target.trim() ||
      [...condition.target].length > 1024
    )
      throw new Error("expect target must be a nonempty ref or selector, at most 1024 characters");
    const { field, equals, attribute } = condition;
    const validValue =
      field === "text" || field === "value"
        ? typeof equals === "string"
        : field === "checked" || field === "exists"
          ? typeof equals === "boolean"
          : field === "attribute" && (typeof equals === "string" || equals === null);
    if (!validValue) throw new Error("expect equals must match its field type");
    if (field === "attribute") {
      if (typeof attribute !== "string" || !attribute.trim() || [...attribute].length > 256)
        throw new Error("expect attribute requires a nonempty name, at most 256 characters");
    } else if (attribute !== undefined) {
      throw new Error("expect attribute is only valid for field=attribute");
    }
  }
}

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
    "bsk session id to act on; must be one created by bsk_session with action=start. " +
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

export const ELEMENT_WAIT_PARAMS = {
  target: {
    type: "string",
    description:
      "wait-for-element: fresh @eN ref or observed main-document CSS selector; no text=, XPath or Playwright locators.",
  },
  state: {
    type: "string",
    enum: ["visible", "hidden", "attached", "detached"],
    description:
      "wait-for-element (default: visible). hidden includes absence; visible does not mean enabled.",
  },
  pollMs: {
    type: "integer",
    description: "wait-for-element poll interval, 16..2000 ms (default: 100).",
  },
} as const;

export const TIMEOUT_MS_PARAM = {
  type: "integer",
  description: "Command timeout in milliseconds; must be greater than zero.",
} as const;
