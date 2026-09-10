/**
 * Generate a UUID v4 in browser contexts where randomUUID() is unavailable.
 *
 * Crypto.randomUUID() is restricted to secure contexts, while
 * crypto.getRandomValues() is available to content scripts on ordinary HTTP
 * origins. BrowserSkill records many intranet pages served over HTTP, so the
 * fallback is required for recording to work on those pages.
 */
export function createRandomUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
