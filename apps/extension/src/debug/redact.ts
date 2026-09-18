/** Redact before retaining evidence, including URLs and JSON/form values. */
const SECRET =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|secret|client[_-]?secret|(?:(?:access|refresh|id|auth|csrf|xsrf)[_-]?)?token|api[_-]?key|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|session[_-]?(?:id|key)|credential)$/i;
const MASK = "[redacted]";
export const BODY_CHARS = 64 * 1024;

export function redactText(value: string, cap = 4096): string {
  return value
    .slice(0, cap)
    .replace(/\b(Bearer|Basic)\s+[\w.+/~=-]+/gi, `$1 ${MASK}`)
    .replace(
      /((?:password|passwd|pwd|secret|(?:(?:access|refresh|id|auth|csrf|xsrf)[_-]?)?token|api[_-]?key)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\s,;&}]+)/gi,
      `$1${MASK}`,
    );
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET.test(key)) url.searchParams.set(key, MASK);
    }
    return redactText(url.href, 2048);
  } catch {
    return redactText(value, 2048);
  }
}

export function redactHeaders(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== "object") return result;
  let remaining = 4 * 1024;
  for (const [key, raw] of Object.entries(value).slice(0, 80)) {
    if (remaining <= 0) break;
    const name = key.slice(0, 128).toLowerCase();
    const text = SECRET.test(name) ? MASK : redactText(String(raw), Math.min(2048, remaining));
    // Define avoids the legacy __proto__ setter for untrusted header names.
    Object.defineProperty(result, name, { value: text, enumerable: true, configurable: true });
    remaining -= name.length + text.length;
  }
  return result;
}

function redactJson(value: unknown, bounds: { truncated: boolean }, depth = 0): unknown {
  if (depth > 24) {
    bounds.truncated = true;
    return "[depth limit]";
  }
  if (typeof value === "string") return redactText(value, BODY_CHARS);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, bounds, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET.test(key) ? MASK : redactJson(item, bounds, depth + 1),
    ]),
  );
}

export function redactBody(
  text: string,
  mime: string,
): { text: string; redacted: boolean; truncated: boolean } {
  const truncated = text.length > BODY_CHARS;
  // Structured payloads must be redacted before truncation. Refuse oversized JSON
  // rather than retaining a prefix that may contain a cut-off secret value.
  if (truncated && /json|x-www-form-urlencoded/i.test(mime)) {
    return { text: "", redacted: true, truncated: true };
  }
  let result: string;
  const bounds = { truncated: false };
  if (/json/i.test(mime) || /^[\s]*[\[{]/.test(text)) {
    try {
      if (truncated) return { text: "", redacted: true, truncated: true };
      result = JSON.stringify(redactJson(JSON.parse(text), bounds), null, 2);
    } catch {
      // A malformed payload cannot be parsed safely; scrub common assignments.
      result = redactText(text, BODY_CHARS);
    }
  } else if (/x-www-form-urlencoded/i.test(mime)) {
    const fields = new URLSearchParams(text);
    for (const key of [...fields.keys()]) if (SECRET.test(key)) fields.set(key, MASK);
    result = fields.toString();
  } else {
    result = redactText(text, BODY_CHARS);
  }
  return {
    text: result.slice(0, BODY_CHARS),
    redacted: result !== text,
    truncated: truncated || bounds.truncated || result.length > BODY_CHARS,
  };
}
