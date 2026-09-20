import type { DebugArchive } from "./archive";
import type { DebugRequest, DebugRun } from "./types";

export const JOURNAL_REQUESTS = 2000;
export const JOURNAL_BYTES = 8 * 1024 * 1024;
export const JOURNAL_PINS = 20;
const PENDING_BYTES = 4 * 1024 * 1024;
const PENDING_COUNT = 256;
export const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Memory eviction must not erase evidence already captured or saved. */
export function mergeRequest(
  previous: DebugRequest | undefined,
  current: DebugRequest,
): DebugRequest {
  if (!previous) return current;
  const merged = { ...previous, ...current, pinned: previous.pinned ?? current.pinned };
  for (const key of ["request_body", "response_body"] as const)
    if (
      (current[key].state === "evicted" && previous[key].state !== "pending") ||
      (current[key].state === previous[key].state &&
        current[key].text === undefined &&
        previous[key].text !== undefined)
    )
      merged[key] = previous[key];
  merged.request_headers = current.request_headers ?? previous.request_headers;
  merged.response_headers = current.response_headers ?? previous.response_headers;
  return merged;
}
export function retentionPriority(entry: DebugRequest): number {
  if (entry.pinned) return 9;
  if (
    entry.state === "failed" ||
    (entry.status ?? 0) >= 400 ||
    entry.intervention ||
    entry.replay_id
  )
    return 4;
  return ["Fetch", "XHR"].includes(entry.resource_type ?? "") || /json/i.test(entry.mime_type ?? "")
    ? 2
    : 0;
}

/** One bounded pending batch and one transaction in flight; never blocks CDP. */
export class DebugJournal {
  private pending = new Map<string, { entry: DebugRequest; bytes: number }>();
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly archive: DebugArchive,
    private readonly run: () => DebugRun,
    private readonly failed: (reason: string) => void,
  ) {}
  retain = (value: DebugRequest): void => {
    if (this.stopped) return;
    const entry = structuredClone(mergeRequest(this.pending.get(value.id)?.entry, value));
    const bytes = jsonBytes(entry);
    const previous = this.pending.get(entry.id);
    if (
      (!previous && this.pending.size >= PENDING_COUNT) ||
      this.bytes - (previous?.bytes ?? 0) + bytes > PENDING_BYTES
    ) {
      this.failed("evidence_write_backlog");
      if (!this.writing) void this.flush();
      return;
    }
    this.bytes += bytes - (previous?.bytes ?? 0);
    this.pending.set(entry.id, { entry, bytes });
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 100);
    if (this.pending.size >= 32 && !this.writing) void this.flush();
  };
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.writing) {
      await this.writing;
      return this.flush();
    }
    if (!this.pending.size) return;
    const entries = [...this.pending.values()].map(({ entry }) => entry);
    this.pending.clear();
    this.bytes = 0;
    const writing = this.archive.retain!(this.run(), entries).catch(() =>
      this.failed("evidence_write_failed"),
    );
    this.writing = writing;
    await writing;
    if (this.writing === writing) this.writing = undefined;
    if (this.pending.size) await this.flush();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.flush();
  }
}
