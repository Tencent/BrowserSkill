// Build-time constants injected via Vite's `define` (see
// wxt.config.ts and vitest.config.ts). Declared globally so any module
// that wants to surface the extension's own semver to the daemon /
// popup / status panel can read it without re-importing package.json
// at runtime (review M3 fix to round-1).

declare const __BSK_EXT_VERSION__: string;

/**
 * WebSocket URL the extension uses to connect to the local bsk daemon.
 * Defaults to {@code ws://127.0.0.1:52800}. Override at build time by
 * setting the {@code BSK_DAEMON_WS_URL} environment variable.
 */
declare const __BSK_DAEMON_WS_URL__: string;
