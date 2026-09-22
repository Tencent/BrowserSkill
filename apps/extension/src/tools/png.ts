/**
 * Parse a PNG's IHDR chunk and return `(width, height)`. Returns
 * `null` on any malformed input so callers fall back to `0/0` instead
 * of throwing.
 *
 * PNG layout: 8-byte signature, then a 4-byte length, 4-byte type
 * ("IHDR"), then the chunk data — width is bytes 16-19 BE, height is
 * 20-23 BE.
 */
export function parsePngDimensions(base64: string): { width: number; height: number } | null {
  try {
    // atob is available in MV3 service workers.
    const head = base64.length > 64 ? base64.slice(0, 64) : base64;
    const bin = atob(head);
    if (bin.length < 33) return null;
    if (bin.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || bin.slice(8, 16) !== "\x00\x00\x00\x0dIHDR") {
      return null;
    }
    const u32 = (off: number) =>
      (bin.charCodeAt(off) << 24) |
      (bin.charCodeAt(off + 1) << 16) |
      (bin.charCodeAt(off + 2) << 8) |
      bin.charCodeAt(off + 3);
    const width = u32(16) >>> 0;
    const height = u32(20) >>> 0;
    if (width === 0 || height === 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}
