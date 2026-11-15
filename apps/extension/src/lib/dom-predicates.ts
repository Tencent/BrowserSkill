import { OVERLAY_HOST_MARKER_ATTR, OVERLAY_HOST_NAME } from "./overlay-bridge";
import {
  RECORD_PASSWORD_ATTRIBUTE,
  SENSITIVE_AUTOCOMPLETE_SELECTOR,
  sensitiveAutocomplete,
} from "./sensitive-autocomplete";

export { RECORD_PASSWORD_ATTRIBUTE, SENSITIVE_AUTOCOMPLETE_SELECTOR, sensitiveAutocomplete };

/** Selector matching BrowserSkill's injected overlay hosts and Shadow DOM roots. */
export const BSK_OVERLAY_SELECTOR = `[data-bsk-overlay],[${OVERLAY_HOST_MARKER_ATTR}],${OVERLAY_HOST_NAME}`;

/** Non-rendered or BrowserSkill-internal ancestor subtrees excluded from passive DOM reads. */
export const READ_REDACTED_ANCESTOR_SELECTOR = `script,style,template,noscript,${BSK_OVERLAY_SELECTOR}`;

/** Sensitive input controls whose values must never be emitted by `extract`. */
export const SENSITIVE_EXTRACT_INPUT_SELECTOR = `input[type="password"],input[type="hidden"],[${RECORD_PASSWORD_ATTRIBUTE}],${SENSITIVE_AUTOCOMPLETE_SELECTOR}`;

/** Sensitive input controls whose values/attributes are redacted in `read` and `expect` checks. */
export const SENSITIVE_READ_INPUT_SELECTOR = `input[type="password"],input[type="file"],input[type="hidden"],[${RECORD_PASSWORD_ATTRIBUTE}],${SENSITIVE_AUTOCOMPLETE_SELECTOR}`;

/** Canonical WAI-ARIA interactive widget roles shared across VOM fact capture and semantic resolution. */
export const INTERACTIVE_ARIA_ROLES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);
