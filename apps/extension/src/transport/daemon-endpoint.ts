/** Build-time default WebSocket URL (see wxt.config.ts). */
const base = new URL(__BSK_DAEMON_WS_URL__);

export const DEFAULT_DAEMON_PORT = Number(base.port) || 52800;

const MIN_PORT = 1;
const MAX_PORT = 65535;

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;
}

/**
 * Compose the daemon WebSocket URL for a loopback port, preserving the
 * build-time host and path from {@link __BSK_DAEMON_WS_URL__}.
 */
export function resolveDaemonWsUrl(port: number): string {
  const path = base.pathname === "/" ? "" : base.pathname;
  return `${base.protocol}//${base.hostname}:${port}${path}`;
}

/** Non-integer / out-of-range / unset → {@link DEFAULT_DAEMON_PORT}. */
export function normalizeDaemonPort(raw: unknown): number {
  if (typeof raw === "number" && isValidPort(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (isValidPort(parsed)) return parsed;
  }
  return DEFAULT_DAEMON_PORT;
}

/** Input semantics: empty string → default port; invalid → null. */
export function parseDaemonPortInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return DEFAULT_DAEMON_PORT;
  const parsed = Number.parseInt(trimmed, 10);
  if (!isValidPort(parsed)) return null;
  return parsed;
}
