/**
 * Normalize page URLs into LLM-friendly patterns (drop tracking noise,
 * collapse numeric path ids).
 */

const TRACKING_QUERY_KEYS = new Set([
  "gs_lcrp",
  "oq",
  "sourceid",
  "source",
  "ie",
  "ei",
  "ved",
  "uact",
  "sxsrf",
  "biw",
  "bih",
  "dpr",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "_ga",
  "mc_cid",
  "mc_eid",
]);

/** Business query keys worth keeping in a pattern. */
const KEEP_QUERY_KEYS = new Set(["q", "query", "search", "keyword", "id", "docid", "page"]);

export function siteFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const next = new URLSearchParams();
    for (const [key, value] of u.searchParams.entries()) {
      const lower = key.toLowerCase();
      if (TRACKING_QUERY_KEYS.has(lower)) continue;
      if (KEEP_QUERY_KEYS.has(lower)) {
        next.set(key, value);
      }
    }
    u.search = next.toString() ? `?${next.toString()}` : "";
    return u.toString();
  } catch {
    return url;
  }
}

/** Replace long digit / hex path segments with `*`. */
export function urlPatternFromUrl(url: string): string {
  const clean = canonicalizeUrl(url);
  try {
    const u = new URL(clean);
    u.pathname = u.pathname
      .split("/")
      .map((seg) => {
        if (!seg) return seg;
        if (/^\d+$/.test(seg)) return "*";
        if (/^[0-9a-f]{8,}$/i.test(seg)) return "*";
        return seg;
      })
      .join("/");
    for (const key of [...u.searchParams.keys()]) {
      if (KEEP_QUERY_KEYS.has(key.toLowerCase()) && (u.searchParams.get(key) ?? "").length > 48) {
        u.searchParams.set(key, "*");
      }
    }
    return u.toString();
  } catch {
    return clean;
  }
}

export type PageRole = "home" | "list" | "editor" | "dialog" | "other";

export function inferPageRole(url: string): PageRole {
  const lower = url.toLowerCase();
  if (lower.includes("/edit") || /\/(editor|compose|write)\b/.test(lower)) return "editor";
  if (lower.includes("/dashboard") || lower.includes("/home")) return "home";
  if (/\/(list|search|results|explore)\b/.test(lower)) return "list";
  if (/[?&](modal|dialog)=/.test(lower)) return "dialog";
  try {
    const path = new URL(url).pathname;
    if (path === "/" || path === "") return "home";
  } catch {
    // ignore
  }
  return "other";
}

export function summarizeNavigateShort(url: string): string {
  const pattern = urlPatternFromUrl(url);
  const site = siteFromUrl(pattern);
  try {
    const path = new URL(pattern).pathname;
    if (site && (path === "/" || path === "")) return `打开 ${site}`;
    if (site) return `打开 ${site}${path}`;
  } catch {
    // fall through
  }
  return `打开 ${pattern}`;
}
