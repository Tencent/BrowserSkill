import type {
  RpcError,
  ScreenshotReadParams,
  ScreenshotReadResult,
  ScreenshotReleaseParams,
  ScreenshotReleaseResult,
} from "@/transport/types";
import { removeTiledScreenshot } from "./tiles";

export const SCREENSHOT_CHUNK_BYTES = 256 * 1024;
const EXPORT_IDLE_MS = 10 * 60_000;

type Entry = { sessionId: string; file: Blob; touched: number };

/** Private Agent exports. Popup previews never enter this store. Files stay on
 * disk; only one bounded slice is materialized for each transport response. */
export class ScreenshotExports {
  private readonly entries = new Map<string, Entry>();
  private readonly pendingDeletes = new Set<string>();
  private ready?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly hasSession: (id: string) => boolean) {}

  prepare(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Screenshot exports closed"));
    this.ready ??= this.removeOrphans()
      .then(() => {
        if (this.closed) throw new Error("Screenshot exports closed");
        this.timer = setInterval(() => void this.sweep(), 60_000);
      })
      .catch((error) => {
        this.ready = undefined;
        throw error;
      });
    return this.ready;
  }

  private async removeOrphans() {
    const root = await navigator.storage.getDirectory();
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await root.getDirectoryHandle("long-screenshots");
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return;
      throw error;
    }
    // No entries survive a worker/transport restart. Remove only Agent scratch
    // directories before accepting the first new capture in this dispatcher.
    for await (const name of directory.keys()) {
      if (name.startsWith("agent-")) await directory.removeEntry(name, { recursive: true });
    }
  }

  put(sessionId: string, id: string, file: Blob) {
    if (this.closed || !this.hasSession(sessionId)) throw new Error("Screenshot session ended");
    this.entries.set(id, { sessionId, file, touched: Date.now() });
  }

  async read(params: ScreenshotReadParams): Promise<ScreenshotReadResult | RpcError> {
    const entry = this.get(params);
    if (!entry)
      return {
        code: "not_found",
        message: "Screenshot export expired or not owned by this session",
      };
    if (
      !Number.isSafeInteger(params.offset) ||
      params.offset < 0 ||
      params.offset > entry.file.size
    )
      return { code: "invalid_params", message: "Invalid screenshot byte offset" };
    entry.touched = Date.now();
    const next = Math.min(entry.file.size, params.offset + SCREENSHOT_CHUNK_BYTES);
    const bytes = new Uint8Array(await entry.file.slice(params.offset, next).arrayBuffer());
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += 8192)
      parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
    return { data_base64: btoa(parts.join("")), next_offset: next, eof: next === entry.file.size };
  }

  async release(params: ScreenshotReleaseParams): Promise<ScreenshotReleaseResult> {
    if (!this.get(params)) return { released: false };
    await this.discard(params.capture_id);
    return { released: true };
  }

  private get(params: ScreenshotReleaseParams) {
    const entry = this.entries.get(params.capture_id);
    return entry &&
      entry.sessionId === params.session_id &&
      this.hasSession(params.session_id) &&
      Date.now() - entry.touched < EXPORT_IDLE_MS
      ? entry
      : undefined;
  }

  /** Revoke reads immediately; retry failed disk cleanup without retaining the Blob. */
  async discard(id: string) {
    this.entries.delete(id);
    this.pendingDeletes.add(id);
    try {
      await removeTiledScreenshot(id);
      this.pendingDeletes.delete(id);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError")
        this.pendingDeletes.delete(id);
    }
  }

  async releaseSession(sessionId: string) {
    for (const [id, entry] of this.entries)
      if (entry.sessionId === sessionId) await this.discard(id);
  }

  private async sweep() {
    for (const id of this.pendingDeletes) await this.discard(id);
    for (const [id, entry] of this.entries)
      if (!this.hasSession(entry.sessionId) || Date.now() - entry.touched >= EXPORT_IDLE_MS)
        await this.discard(id);
  }

  async dispose() {
    this.closed = true;
    clearInterval(this.timer);
    for (const id of new Set([...this.entries.keys(), ...this.pendingDeletes]))
      await this.discard(id);
  }
}
