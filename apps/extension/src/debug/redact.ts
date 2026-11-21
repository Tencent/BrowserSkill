import { type JsonSource, parseJsonSource } from "./json-source";

/** Redact before retaining evidence, including URLs and JSON/form values. */
const SECRET =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|secret|client[_-]?secret|(?:(?:access|refresh|id|auth|csrf|xsrf)[_-]?)?token|api[_-]?key|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|session[_-]?(?:id|key)|credentials?)$/i;
// Exact vendor credential names. A generic `*token` suffix would also hide
// pagination cursors such as pageToken (#555), so each name is listed.
const VENDOR_SECRET =
  /^(?:private-token|x-goog-api-key|x-amz-security-token|ocp-apim-subscription-key|x-vault-token|x-access-token|x-csrftoken|x-shopify-access-token|x-hasura-admin-secret)$/i;
const MASK = "[redacted]";
export const BODY_CHARS = 64 * 1024;
export const URL_CHARS = 2048;

function secretName(name: string): boolean {
  return SECRET.test(name) || VENDOR_SECRET.test(name.replaceAll("_", "-"));
}

function secretField(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[.[\]]+/)
    .some((part) => secretName(part) || /(?:^|[_-])(?:password|passwd|pwd)(?:[_-]|$)/i.test(part));
}

const HTML_FIELD_SEPARATORS: Record<string, string> = {
  period: ".",
  lowbar: "_",
  UnderBar: "_",
  lbrack: "[",
  lsqb: "[",
  rbrack: "]",
  rsqb: "]",
};

function htmlField(value: string): string {
  // Normalize only references that can form our ASCII secret fields. A single
  // pass avoids treating escaped references as markup; retained bytes stay intact.
  return value.replace(
    /&(?:#(?:[xX]([\da-fA-F]+)|(\d+));?|(period|lowbar|UnderBar|lbrack|lsqb|rbrack|rsqb);)/g,
    (
      reference,
      hex: string | undefined,
      decimal: string | undefined,
      named: string | undefined,
    ) => {
      if (named) return HTML_FIELD_SEPARATORS[named];
      const code = Number.parseInt(hex ?? decimal!, hex === undefined ? 10 : 16);
      return code > 0 && code < 128 ? String.fromCharCode(code) : reference;
    },
  );
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
    const secret = secretName(name);
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

const JSON_PREFIX =
  /^\s*(?:\{\s*(?:"|\})|\[\s*(?:[\[{"\]]|(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\s,\]]|$)))/;

type NdjsonResult = { kind: "ok"; text: string } | { kind: "malformed" } | { kind: "not_ndjson" };

function redactNdjson(text: string, bounds: { truncated: boolean }): NdjsonResult {
  const parts = text.split(/(\r?\n)/);
  let parsedCount = 0;
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? "";
    const sep = parts[i + 1] ?? "";
    if (!line.trim()) {
      out.push(line, sep);
      continue;
    }
    const hasRecordSep = line.startsWith("\u001e");
    const record = hasRecordSep ? line.slice(1) : line;
    if (!/^\s*[\[{]/.test(record)) {
      return parsedCount > 0 ? { kind: "malformed" } : { kind: "not_ndjson" };
    }
    try {
      out.push(hasRecordSep ? "\u001e" : "", redactJson(record, bounds), sep);
      parsedCount += 1;
    } catch {
      return parsedCount > 0 ? { kind: "malformed" } : { kind: "not_ndjson" };
    }
  }
  return parsedCount > 0 ? { kind: "ok", text: out.join("") } : { kind: "not_ndjson" };
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
  const isJsonMime = /(?:^|\/|\+)json(?:$|[;\s])/i.test(mime);
  const isNdjsonMime = /(?:^|\/|\+)(?:x-)?(?:ndjson|jsonl|json-seq|jsonlines)(?:$|[;\s])/i.test(
    mime,
  );
  const isHtmlMime = /html/i.test(mime);
  const isFormMime = /x-www-form-urlencoded/i.test(mime);
  const isCodeOrMarkupMime = /(?:javascript|ecmascript|css|xml)/i.test(mime);
  // Structured payloads must be redacted before truncation. Refuse oversized JSON,
  // NDJSON, forms, and text/plain bodies with a valid JSON prefix rather than
  // retaining a prefix that may contain an unredacted secret field.
  if (
    truncated &&
    (isJsonMime ||
      isNdjsonMime ||
      isFormMime ||
      (!isHtmlMime && !isCodeOrMarkupMime && JSON_PREFIX.test(text)))
  ) {
    return { text: "", redacted: true, truncated: true, replay_safe: false };
  }
  let result: string | undefined;
  const bounds = { truncated: false };
  if (isJsonMime) {
    try {
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
  } else if (isNdjsonMime) {
    if (!text.trim()) {
      result = text;
    } else {
      const ndjson = redactNdjson(text, bounds);
      if (ndjson.kind !== "ok") {
        return {
          text: "",
          redacted: true,
          truncated: true,
          replay_safe: false,
          reason: "unparsed_json",
        };
      }
      result = ndjson.text;
    }
  } else if (!truncated && /^[\s]*[\[{]/.test(text)) {
    // Valid JSON served under form, HTML, JS, or plain-text MIME types must still
    // go through JSON key redaction before falling back to MIME-specific redaction.
    try {
      result = redactJson(text, bounds);
    } catch {
      bounds.truncated = false;
    }
  }
  if (result === undefined) {
    if (isHtmlMime) {
      // A password can also occur in a server-rendered input's value attribute.
      // Remove that input from retained HTML rather than exposing its initial value.
      result = redactText(
        text.replace(/<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
          const attributes = tag.matchAll(
            /\b(type|name|id|autocomplete)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
          );
          for (const match of attributes) {
            const value = htmlField(match[2] ?? match[3] ?? match[4]);
            if (
              secretField(value) ||
              secretField(value.toLowerCase()) ||
              value
                .trim()
                .split(/\s+/)
                .some((token) =>
                  /^(?:current-password|new-password|one-time-code|cc-.+)$/i.test(token),
                )
            )
              return '<input data-bsk-redacted="true">';
          }
          return tag;
        }),
        BODY_CHARS,
      );
    } else if (isFormMime) {
      // Preserve untouched bytes, ordering and duplicates (including signed form bodies).
      result = text
        .split("&")
        .map((field) => {
          const key = new URLSearchParams(field).keys().next().value;
          if (key === undefined || !secretField(key)) return field;
          return `${field.split("=", 1)[0]}=${encodeURIComponent(MASK)}`;
        })
        .join("&");
    } else if (!isCodeOrMarkupMime && /^[\s]*[\[{]/.test(text)) {
      const ndjson = redactNdjson(text, bounds);
      if (ndjson.kind === "ok") {
        result = ndjson.text;
      } else if (ndjson.kind === "malformed") {
        // Earlier lines already parsed as JSON records; fail closed rather than
        // dropping JSON redaction and leaking secrets through plain-text fallback.
        return {
          text: "",
          redacted: true,
          truncated: true,
          replay_safe: false,
          reason: "unparsed_json",
        };
      } else {
        bounds.truncated = false;
        result = redactText(text, BODY_CHARS);
      }
    } else {
      result = redactText(text, BODY_CHARS);
    }
  }
  return {
    text: result.slice(0, BODY_CHARS),
    redacted: result !== text,
    truncated: truncated || bounds.truncated || result.length > BODY_CHARS,
    replay_safe: !truncated && !bounds.truncated && result === text,
  };
}
