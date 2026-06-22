// Build-time constants injected via Vite's `define` (see
// wxt.config.ts and vitest.config.ts). Declared globally so any module
// that wants to surface the extension's own semver to the daemon /
// popup / status panel can read it without re-importing package.json
// at runtime (review M3 fix to round-1).

declare const __BSK_EXT_VERSION__: string;
