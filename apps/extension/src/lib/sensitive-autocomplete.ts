const SECRET_FIELDS = new Set(["current-password", "new-password", "one-time-code"]);

/** Marks an input whose type was switched away from "password" during recording. */
export const RECORD_PASSWORD_ATTRIBUTE = "data-bsk-record-password";

/** True when an autocomplete attribute names a credential, code or card field.
 * The attribute is an ASCII-whitespace token list, e.g. "section-login current-password"
 * or "billing cc-number", so match each token rather than the whole value. */
export function sensitiveAutocomplete(value: string | null | undefined): boolean {
  return (value ?? "")
    .toLowerCase()
    .split(/[\t\n\f\r ]+/)
    .some((token) => token.startsWith("cc-") || SECRET_FIELDS.has(token));
}

/** The same match as CSS, for probes that run in the page and cannot import this module. */
export const SENSITIVE_AUTOCOMPLETE_SELECTOR = [
  ...[...SECRET_FIELDS].map((token) => `[autocomplete~="${token}" i]`),
  '[autocomplete^="cc-" i]',
  '[autocomplete*=" cc-" i]',
].join(",");
