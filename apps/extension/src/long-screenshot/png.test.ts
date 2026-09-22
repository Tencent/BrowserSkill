// @vitest-environment node
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { streamPng } from "./png";

function decode(parts: Uint8Array[], width: number, height: number) {
  const png = Buffer.concat(parts);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.readUInt32BE(16)).toBe(width);
  expect(png.readUInt32BE(20)).toBe(height);
  const data = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT")
      data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(data));
  expect(rows.length).toBe((width * 4 + 1) * height);
  const previous = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 4 + 1);
    expect(rows[at]).toBe(2);
    for (let x = 0; x < previous.length; x++) {
      previous[x] = (previous[x] + rows[at + x + 1]) & 255;
      if (previous[x] !== (x * 13 + y * 7) % 256) throw new Error(`Pixel mismatch at ${x},${y}`);
    }
  }
}
function* pixels(width: number, height: number) {
  for (let y = 0; y < height; y += 127) {
    const count = Math.min(127, height - y);
    const buffer = new Uint8Array(width * 4 * count);
    for (let row = 0; row < count; row++)
      for (let x = 0; x < width * 4; x++)
        buffer[row * width * 4 + x] = (x * 13 + (y + row) * 7) % 256;
    yield buffer;
  }
}
async function* rows(width: number, height: number) {
  yield* pixels(width, height);
}

describe("streaming PNG export", () => {
  it("encodes 120,000 exact scanlines across tile and compression boundaries", async () => {
    const parts: Uint8Array[] = [];
    await streamPng(17, 120_000, rows(17, 120_000), async (part) => {
      parts.push(part);
    });
    decode(parts, 17, 120_000);
  });
  it("rejects truncated input instead of producing a valid-looking incomplete image", async () => {
    await expect(streamPng(3, 8, rows(3, 7), async () => {})).rejects.toThrow("Missing PNG rows");
  });
  it("propagates disk write failures without deadlocking compression backpressure", async () => {
    let count = 0;
    await expect(
      streamPng(10, 10000, rows(10, 10000), async () => {
        if (++count > 2) throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
  });
  it("cancels an export while scanlines are being produced", async () => {
    const controller = new AbortController();
    async function* cancelled() {
      yield new Uint8Array(4);
      controller.abort();
      yield new Uint8Array(4);
    }
    await expect(
      streamPng(1, 2, cancelled(), async () => {}, controller.signal),
    ).rejects.toBeDefined();
  });
});
