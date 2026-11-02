import { readTile, screenshotDirectory, type TiledScreenshot } from "./tiles";

const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c;
}
export function pngChunk(type: string, data: Uint8Array) {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < chunk.length - 4; i++) crc = table[(crc ^ chunk[i]) & 255] ^ (crc >>> 8);
  view.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

/** Encode scanlines through the native streaming zlib encoder. No full-image
 * canvas, concatenated pixel buffer, base64 result or in-memory PNG is created. */
export async function streamPng(
  width: number,
  height: number,
  rows: AsyncIterable<Uint8Array>,
  write: (data: Uint8Array) => Promise<void>,
  signal?: AbortSignal,
) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 0x7fffffff ||
    height > 0x7fffffff
  )
    throw new Error("Invalid PNG dimensions");
  await write(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  await write(pngChunk("IHDR", header));
  const compression = new CompressionStream("deflate");
  const input = compression.writable.getWriter();
  const output = compression.readable.getReader();
  const abort = () => {
    void input.abort(signal?.reason).catch(() => {});
    void output.cancel(signal?.reason).catch(() => {});
  };
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  // Read and write concurrently to respect compression-stream backpressure.
  const consume = (async () => {
    try {
      for (;;) {
        const { done, value } = await output.read();
        if (done) break;
        signal?.throwIfAborted();
        await write(pngChunk("IDAT", value));
      }
    } catch (error) {
      await input.abort(error).catch(() => {});
      throw error;
    }
  })();
  // Mark the consumer handled immediately, even while producing its input.
  void consume.catch(() => {});
  try {
    let count = 0;
    let previous: Uint8Array = new Uint8Array(width * 4);
    for await (const pixels of rows) {
      signal?.throwIfAborted();
      if (pixels.length % (width * 4)) throw new Error("Incomplete PNG scanline");
      const rowCount = pixels.length / (width * 4);
      const filtered = new Uint8Array(pixels.length + rowCount);
      for (let row = 0; row < rowCount; row++) {
        const start = row * width * 4;
        const out = row * (width * 4 + 1);
        filtered[out] = 2; // Up filter: preserves text and compresses repeated rows well.
        for (let x = 0; x < previous.length; x++)
          filtered[out + 1 + x] = (pixels[start + x] - previous[x]) & 255;
        previous = pixels.subarray(start, start + width * 4);
      }
      count += rowCount;
      if (count > height) throw new Error("Too many PNG rows");
      await input.write(filtered);
    }
    if (count !== height) throw new Error("Missing PNG rows");
    await input.close();
    await consume;
    signal?.throwIfAborted();
    await write(pngChunk("IEND", new Uint8Array()));
  } catch (error) {
    await Promise.allSettled([input.abort(error), output.cancel(error)]);
    await consume.catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export async function exportPng(
  shot: TiledScreenshot,
  signal?: AbortSignal,
  progress: (value: number) => void = () => {},
) {
  const directory = await screenshotDirectory(shot.id);
  const file = await directory.getFileHandle("export.png", { create: true });
  const output = await file.createWritable();
  const canvas = new OffscreenCanvas(shot.width, shot.tileHeight);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    await output.abort();
    throw new Error("Canvas unavailable");
  }
  async function* rows() {
    for (let y = 0; y < shot.height; y += shot.tileHeight) {
      signal?.throwIfAborted();
      const bitmap = await createImageBitmap(await readTile(shot, y / shot.tileHeight));
      try {
        context!.clearRect(0, 0, shot.width, shot.tileHeight);
        context!.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
      const count = Math.min(shot.tileHeight, shot.height - y);
      yield new Uint8Array(context!.getImageData(0, 0, shot.width, count).data.buffer);
      progress(Math.round(((y + count) / shot.height) * 100));
    }
  }
  try {
    await streamPng(
      shot.width,
      shot.height,
      rows(),
      async (bytes) => {
        await output.write(bytes as Uint8Array<ArrayBuffer>);
      },
      signal,
    );
    await output.close();
    return await file.getFile();
  } catch (error) {
    await output.abort().catch(() => {});
    throw error;
  } finally {
    canvas.width = canvas.height = 1;
  }
}
