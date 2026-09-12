import { type CaptureError, ScreenshotError } from "./types";

// This is a working-buffer size, not a limit on the final image.
export const TILE_HEIGHT = 512;
const ROOT = "long-screenshots";
export interface TiledScreenshot {
  kind: "tiles";
  id: string;
  title: string;
  createdAt: number;
  width: number;
  height: number;
  tileHeight: number;
  bytes: number;
  notice?: CaptureError;
}

export async function screenshotDirectory(id: string, create = false) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid screenshot id");
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create });
  return root.getDirectoryHandle(id, { create });
}
async function writeFile(directory: FileSystemDirectoryHandle, name: string, data: Blob | string) {
  const file = await directory.getFileHandle(name, { create: true });
  const stream = await file.createWritable();
  try {
    await stream.write(data);
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => {});
    throw error;
  }
}
export async function readTiledScreenshot(id: string): Promise<TiledScreenshot | undefined> {
  try {
    const directory = await screenshotDirectory(id);
    const file = await (await directory.getFileHandle("index.json")).getFile();
    return JSON.parse(await file.text()) as TiledScreenshot;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
    throw error;
  }
}
export async function removeTiledScreenshot(id: string) {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT);
  await root.removeEntry(id, { recursive: true });
}
export async function readTile(shot: TiledScreenshot, index: number, preview = false) {
  const directory = await screenshotDirectory(shot.id);
  return (
    await directory.getFileHandle(`${index}${preview && shot.width > 1200 ? ".preview" : ""}.png`)
  ).getFile();
}

/** A disk-backed image. Only the incoming viewport and one small tile are decoded.
 * Fixed-footer overlap can replace already-written rows without a full canvas. */
export class TileWriter {
  private directory?: FileSystemDirectoryHandle;
  private sizes = new Map<number, number>();
  readonly shot: TiledScreenshot;
  constructor(id: string, title: string) {
    this.shot = {
      kind: "tiles",
      id,
      title,
      createdAt: Date.now(),
      width: 0,
      height: 0,
      tileHeight: TILE_HEIGHT,
      bytes: 0,
    };
  }
  async finish(notice?: CaptureError) {
    if (!this.directory || !this.shot.height) return;
    const next = { ...this.shot, notice };
    await writeFile(this.directory, "index.json", JSON.stringify(next));
    Object.assign(this.shot, next);
  }
  async write(
    bitmap: ImageBitmap,
    width: number,
    sourceY: number,
    targetY: number,
    height: number,
    signal?: AbortSignal,
  ) {
    if (
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(targetY + height) ||
      targetY < 0 ||
      height <= 0 ||
      targetY > this.shot.height ||
      (this.shot.width && this.shot.width !== width)
    )
      throw new ScreenshotError("changed");
    this.directory ??= await screenshotDirectory(this.shot.id, true);
    this.shot.width = width;
    const canvas = new OffscreenCanvas(width, TILE_HEIGHT);
    const context = canvas.getContext("2d");
    if (!context) throw new ScreenshotError("captureFailed");
    try {
      for (let offset = 0; offset < height; ) {
        signal?.throwIfAborted();
        const y = targetY + offset;
        const index = Math.floor(y / TILE_HEIGHT);
        const inside = y % TILE_HEIGHT;
        const count = Math.min(TILE_HEIGHT - inside, height - offset);
        context.clearRect(0, 0, width, TILE_HEIGHT);
        if (index * TILE_HEIGHT < this.shot.height && (inside || count < TILE_HEIGHT)) {
          const existing = await createImageBitmap(await readTile(this.shot, index));
          try {
            context.drawImage(existing, 0, 0);
          } finally {
            existing.close();
          }
        }
        context.drawImage(bitmap, 0, sourceY + offset, width, count, 0, inside, width, count);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        signal?.throwIfAborted();
        await writeFile(this.directory, `${index}.png`, blob);
        if (width > 1200) {
          const thumbnail = new OffscreenCanvas(1200, Math.ceil((TILE_HEIGHT * 1200) / width));
          try {
            const thumbContext = thumbnail.getContext("2d");
            if (!thumbContext) throw new ScreenshotError("captureFailed");
            thumbContext.drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
            await writeFile(
              this.directory,
              `${index}.preview.png`,
              await thumbnail.convertToBlob({ type: "image/png" }),
            );
          } finally {
            thumbnail.width = thumbnail.height = 1;
          }
        }
        const next = {
          ...this.shot,
          bytes: this.shot.bytes + blob.size - (this.sizes.get(index) ?? 0),
          height: Math.max(this.shot.height, y + count),
        };
        // Only advertise a durable checkpoint after its manifest has committed.
        await writeFile(this.directory, "index.json", JSON.stringify(next));
        Object.assign(this.shot, next);
        this.sizes.set(index, blob.size);
        offset += count;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "QuotaExceededError")
        throw new ScreenshotError("storageFull");
      throw error;
    } finally {
      canvas.width = canvas.height = 1;
    }
  }
}
