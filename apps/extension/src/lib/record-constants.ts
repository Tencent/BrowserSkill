import type { FillCommit, NavigationCause } from "@/transport/types";

/**
 * Floor before a post-action observation may be taken. A page usually has not
 * started reacting in the first frames after an action, and capturing then
 * would record the page as it was, not as the action left it.
 */
export const SETTLE_MIN_MS = 150;

/** How long the DOM must stop changing before a page counts as settled. */
export const SETTLE_QUIET_MS = 250;

/** Upper bound on waiting for a page to settle; animations never stop. */
export const SETTLE_MAX_MS = 2_000;

/** How often to ask the page whether it has gone quiet. */
export const SETTLE_POLL_MS = 60;

/** Minimum interval between consecutive observations on the same tab. */
export const OBSERVATION_MIN_INTERVAL_MS = 200;

/** Delay before retrying a capture that lost its execution context. */
export const CAPTURE_RETRY_DELAY_MS = 250;

/** Document-coordinate matching tolerance in CSS pixels. */
export const GEOM_MATCH_TOLERANCE_PX = 2;

/** Default max tokens per page observation when CLI omits `--max-page-tokens`. */
export const DEFAULT_MAX_PAGE_TOKENS = 3000;

/** VOM observation file format version (front matter header). */
export const OBSERVATION_FILE_VERSION = 1;

/** FNV-1a 64-bit offset basis. */
const FNV_OFFSET = 0xcbf29ce484222325n;
/** FNV-1a 64-bit prime. */
const FNV_PRIME = 0x100000001b3n;

/** Content-hash for state deduplication (sync, non-cryptographic). */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

let nextStateSerial = 0;

/** Monotonic state id generator (`s1`, `s2`, …). */
export function nextStateId(): string {
  nextStateSerial += 1;
  return `s${nextStateSerial}`;
}

/** Test seam: reset the state id counter. */
export function resetStateIdCounterForTests(): void {
  nextStateSerial = 0;
}

const REDIRECT_QUALIFIERS = new Set(["client_redirect", "server_redirect"]);

const TRANSITION_TO_CAUSE: Record<string, NavigationCause> = {
  typed: "user_typed",
  generated: "user_typed",
  keyword: "user_typed",
  keyword_generated: "user_typed",
  link: "link",
  form_submit: "form_submit",
  reload: "reload",
  auto_bookmark: "browser",
  start_page: "browser",
};

export interface NavigationTransitionMeta {
  transitionType?: string;
  transitionQualifiers?: string[];
  navigationActionPending?: boolean;
}

/** Map webNavigation metadata to protocol `NavigationCause`. Returns null for redirects. */
export function mapNavigationCause(meta: NavigationTransitionMeta): NavigationCause | null {
  const qualifiers = meta.transitionQualifiers ?? [];
  if (qualifiers.includes("forward_back")) return "history";
  if (qualifiers.some((q) => REDIRECT_QUALIFIERS.has(q))) return null;
  if (qualifiers.includes("from_address_bar")) return "user_typed";

  const type = meta.transitionType ?? "";
  const mapped = TRANSITION_TO_CAUSE[type];
  if (mapped) return mapped;

  if (!type && meta.navigationActionPending === false) return "script";
  return "browser";
}

export const DEFAULT_FILL_COMMIT: FillCommit = "blur";
