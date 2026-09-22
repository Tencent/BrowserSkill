import { type JsonSource, parseJsonSource } from "./json-source";

/** Redact before retaining evidence, including URLs and JSON/form values. */
const SECRET =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|secret|client[_-]?secret|(?:(?:access|refresh|id|auth|csrf|xsrf)[_-]?)?token|api[_-]?key|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|session[_-]?(?:id|key)|credentials?)$/i;
const MASK = "[redacted]";
export const BODY_CHARS = 64 * 1024;
export const URL_CHARS = 2048;

function secretField(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[.[\]]+/)
    .some((part) => SECRET.test(part) || /(?:^|[_-])(?:password|passwd|pwd)(?:[_-]|$)/i.test(part));
}

export function redactText(value: string, cap = 4096): string {
  return value
    .slice(0, cap)
    .replace(/\b(Bearer|Basic)\s+[\w.+/~=-]+/gi, `$1 ${MASK}`)
    .replace(
      /((?:password|passwd|pwd|secret|(?:(?:access|refresh|id|auth|csrf|xsrf)[_-]?)?token|api[_-]?key)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\s,;&}]+)/gi,
      `$1${MASK}`,
    );
}

export function redactRequestUrl(value: string): {
  text: string;
  state: "complete" | "redacted" | "truncated";
} {
  let result: string;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (secretField(key)) url.searchParams.set(key, MASK);
    }
    result = url.href;
  } catch {
    result = value;
  }
  const text = redactText(result, URL_CHARS);
  return {
    text: text.slice(0, URL_CHARS),
    state:
      Math.max(result.length, text.length) > URL_CHARS
        ? "truncated"
        : text !== value
          ? "redacted"
          : "complete",
  };
}

export function redactUrl(value: string): string {
  return redactRequestUrl(value).text;
}

export function redactHeaderEvidence(value: unknown): {
  headers: Record<string, string>;
  truncated: boolean;
} {
  const headers: Record<string, string> = {};
  let truncated = false;
  if (!value || typeof value !== "object") return { headers, truncated };
  const entries = Object.entries(value);
  truncated = entries.length > 80;
  let remaining = 4 * 1024;
  for (const [key, raw] of entries.slice(0, 80)) {
    const name = key.slice(0, 128).toLowerCase();
    const secret = SECRET.test(name);
    const original = String(raw);
    const redacted = secret ? MASK : redactText(original, 2048);
    const limit = Math.max(0, Math.min(2048, remaining - name.length));
    truncated ||= key.length > 128 || (!secret && original.length > 2048);
    if (name.length > remaining || (secret && redacted.length > limit)) {
      truncated = true;
      break;
    }
    const text = redacted.slice(0, limit);
    truncated ||= text.length < redacted.length || Object.hasOwn(headers, name);
    // Define avoids the legacy __proto__ setter for untrusted header names.
    Object.defineProperty(headers, name, { value: text, enumerable: true, configurable: true });
    remaining -= name.length + text.length;
  }
  return { headers, truncated };
}

export function redactHeaders(value: unknown): Record<string, string> {
  return redactHeaderEvidence(value).headers;
}

function redactJson(text: string, bounds: { truncated: boolean }): string {
  const root = parseJsonSource(text);
  const parts: string[] = [];
  let cursor = 0;
  const replace = (node: JsonSource, value: string) => {
    parts.push(text.slice(cursor, node.start), JSON.stringify(value));
    cursor = node.end;
  };
  const visit = (node: JsonSource, depth: number, secret = false) => {
    if (secret) replace(node, MASK);
    else if (depth > 24) {
      bounds.truncated = true;
      replace(node, "[depth limit]");
    } else if (node.children) {
      for (const child of node.children)
        visit(child.value, depth + 1, node.kind === "object" && secretField(child.key));
    } else if (node.kind === "string") {
      const value: string = JSON.parse(text.slice(node.start, node.end));
      const redacted = redactText(value, BODY_CHARS);
      if (redacted !== value) replace(node, redacted);
    }
  };
  visit(root, 0);
  parts.push(text.slice(cursor));
  return parts.join("");
}

export function redactBody(
  text: string,
  mime: string,
): {
  text: string;
  redacted: boolean;
  truncated: boolean;
  replay_safe: boolean;
  reason?: "unparsed_json";
} {
  const truncated = text.length > BODY_CHARS;
  // Structured payloads must be redacted before truncation. Refuse oversized JSON
  // rather than retaining a prefix that may contain a cut-off secret value.
  if (truncated && /json|x-www-form-urlencoded/i.test(mime)) {
    return { text: "", redacted: true, truncated: true, replay_safe: false };
  }
  let result: string;
  const bounds = { truncated: false };
  if (/json/i.test(mime) || /^[\s]*[\[{]/.test(text)) {
    try {
      if (truncated) return { text: "", redacted: true, truncated: true, replay_safe: false };
      result = redactJson(text, bounds);
    } catch {
      // An unparsed structured payload cannot be safely inspected for nested secrets.
      return {
        text: "",
        redacted: true,
        truncated: true,
        replay_safe: false,
        reason: "unparsed_json",
      };
    }
  } else if (/html/i.test(mime)) {
    // A password can also occur in a server-rendered input's value attribute.
    // Remove that input from retained HTML rather than exposing its initial value.
    result = redactText(
      text.replace(/<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
        const attributes = tag.matchAll(
          /\b(type|name|id|autocomplete)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
        );
        for (const match of attributes) {
          const value = match[2] ?? match[3] ?? match[4];
          if (
            secretField(value) ||
            /^(?:current-password|new-password|one-time-code|cc-.+)$/i.test(value)
          )
            return '<input data-bsk-redacted="true">';
        }
        return tag;
      }),
      BODY_CHARS,
    );
  } else if (/x-www-form-urlencoded/i.test(mime)) {
    // Preserve untouched bytes, ordering and duplicates (including signed form bodies).
    result = text
      .split("&")
      .map((field) => {
        const key = new URLSearchParams(field).keys().next().value;
        if (key === undefined || !secretField(key)) return field;
        return `${field.split("=", 1)[0]}=${encodeURIComponent(MASK)}`;
      })
      .join("&");
  } else {
    result = redactText(text, BODY_CHARS);
  }
  return {
    text: result.slice(0, BODY_CHARS),
    redacted: result !== text,
    truncated: truncated || bounds.truncated || result.length > BODY_CHARS,
    replay_safe: !truncated && !bounds.truncated && result === text,
  };
}
