import type { CdpRunner } from "@/tools/shared";

export interface ScreencastFrame {
  data: string;
  metadata: { timestamp?: number };
  sessionId: number;
}

export interface ScreencastRequest {
  maxWidth: number;
  maxHeight: number;
  format: "png" | "jpeg";
  quality?: number;
  frame?: (frame: ScreencastFrame) => void;
}

export interface ScreencastLease {
  release(): Promise<void>;
}

interface Entry {
  attachment: string;
  requests: Set<ScreencastRequest>;
  subscription: { dispose(): void };
  configuration: string;
}

async function bounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal?.reason ?? new Error("Screencast request cancelled"));
        timer = setTimeout(() => reject(new Error("Screencast command timed out")), timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

/** One CDP stream and one ACK per frame, shared by video and render keepalive. */
export class ScreencastCoordinator {
  private readonly entries = new Map<number, Entry>();
  private readonly operations = new Map<number, Promise<void>>();

  constructor(private readonly cdp: CdpRunner) {}

  private serialize<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const result = (this.operations.get(tabId) ?? Promise.resolve()).then(operation);
    const settled = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        if (this.operations.get(tabId) === settled) this.operations.delete(tabId);
      });
    this.operations.set(tabId, settled);
    return result;
  }

  acquire(
    tabId: number,
    request: ScreencastRequest,
    signal?: AbortSignal,
  ): Promise<ScreencastLease> {
    return this.serialize(tabId, async () => {
      signal?.throwIfAborted();
      const attachment = this.cdp.getAttachmentId?.(tabId);
      if (!attachment || !this.cdp.onEvent)
        throw new Error("Screencast debugger connection is unavailable");
      let entry = this.entries.get(tabId);
      if (entry && entry.attachment !== attachment) {
        entry.subscription.dispose();
        this.entries.delete(tabId);
        entry = undefined;
      }
      if (!entry) {
        const created: Entry = {
          attachment,
          requests: new Set(),
          configuration: "",
          subscription: this.cdp.onEvent((source, method, params) => {
            if (
              source.tabId !== tabId ||
              source.sessionId ||
              method !== "Page.screencastFrame" ||
              this.cdp.getAttachmentId?.(tabId) !== attachment ||
              this.entries.get(tabId) !== created
            )
              return;
            const frame = params as ScreencastFrame;
            if (!Number.isInteger(frame.sessionId)) return;
            try {
              if (typeof frame.data === "string" && frame.metadata) {
                for (const consumer of created.requests) {
                  try {
                    consumer.frame?.(frame);
                  } catch {
                    /* A consumer cannot suppress another consumer's ACK. */
                  }
                }
              }
            } finally {
              if (this.cdp.getAttachmentId?.(tabId) === attachment)
                void this.cdp
                  .send(tabId, "Page.screencastFrameAck", { sessionId: frame.sessionId })
                  .catch(() => {});
            }
          }),
        };
        entry = created;
        this.entries.set(tabId, entry);
      }
      entry.requests.add(request);
      try {
        await this.configure(tabId, entry, signal);
      } catch (error) {
        entry.requests.delete(request);
        entry.configuration = "";
        await this.configure(tabId, entry).catch(() => {});
        throw error;
      }
      const owned = entry;
      let released = false;
      return {
        release: () =>
          this.serialize(tabId, async () => {
            if (released) return;
            released = true;
            owned.requests.delete(request);
            if (this.entries.get(tabId) === owned) await this.configure(tabId, owned);
          }),
      };
    });
  }

  private async configure(tabId: number, entry: Entry, signal?: AbortSignal): Promise<void> {
    if (!entry.requests.size || this.cdp.getAttachmentId?.(tabId) !== entry.attachment) {
      this.entries.delete(tabId);
      entry.subscription.dispose();
      if (this.cdp.getAttachmentId?.(tabId) === entry.attachment)
        await bounded(this.cdp.send(tabId, "Page.stopScreencast"), 1000);
      return;
    }
    const largest = [...entry.requests].sort(
      (a, b) => b.maxWidth * b.maxHeight - a.maxWidth * a.maxHeight,
    )[0];
    const { frame: _frame, ...config } = largest;
    const key = JSON.stringify(config);
    if (key === entry.configuration) return;
    if (entry.configuration)
      await bounded(this.cdp.send(tabId, "Page.stopScreencast"), 1000, signal);
    await bounded(this.cdp.send(tabId, "Page.startScreencast", config), 10_000, signal);
    if (this.cdp.getAttachmentId?.(tabId) !== entry.attachment)
      throw new Error("Screencast connection changed");
    entry.configuration = key;
  }
}

const coordinators = new WeakMap<CdpRunner, ScreencastCoordinator>();
export function screencasts(cdp: CdpRunner): ScreencastCoordinator {
  let coordinator = coordinators.get(cdp);
  if (!coordinator) {
    coordinator = new ScreencastCoordinator(cdp);
    coordinators.set(cdp, coordinator);
  }
  return coordinator;
}
