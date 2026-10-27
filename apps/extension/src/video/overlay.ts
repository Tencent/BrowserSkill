// Kept independent of capture-suppress: short screenshots use a reference count;
// video owns an idempotent lease that survives a content script remount.
export const VIDEO_OVERLAY = "bsk/video-overlay";
export const VIDEO_OVERLAY_QUERY_TIMEOUT_MS = 3_000;
const DISCOVERY_DELAYS_MS = [0, 250, 1_000];
export interface VideoOverlayMessage {
  type: typeof VIDEO_OVERLAY;
  recording_id: string | null;
}

export class VideoOverlayGate {
  id: string | null = null;
  private known = false;
  private interactive = false;
  private allowed = false;
  private generation = 0;
  private pending = false;
  private disposed = false;
  private discovery?: { controller: AbortController; promise: Promise<void> };

  constructor(
    private readonly send: (
      action: "query" | "interactive" | "clean",
    ) => Promise<{ recording_id: string | null }>,
    private readonly render: () => void,
    private readonly painted: () => Promise<void>,
  ) {}

  initialize(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.discovery) return this.discovery.promise;
    const generation = ++this.generation;
    // A new or restored document must not assume that capture is inactive.
    // Navigation may resume capture before this script registers its listener.
    this.known = false;
    this.render();
    const controller = new AbortController();
    const promise = this.discover(generation, controller.signal).finally(() => {
      if (this.discovery?.controller === controller) this.discovery = undefined;
    });
    this.discovery = { controller, promise };
    return promise;
  }

  /** A later foreground transition or overlay request can restart an exhausted
   * discovery, without polling healthy pages or duplicating in-flight queries. */
  needsDiscovery(): boolean {
    return !this.disposed && !this.known && !this.discovery;
  }

  private async discover(generation: number, signal: AbortSignal): Promise<void> {
    for (const [attempt, delay] of DISCOVERY_DELAYS_MS.entries()) {
      try {
        if (delay) await discoveryDelay(delay, signal);
        if (signal.aborted) return;
        const response = await discoveryReply(this.send("query"), signal);
        if (generation === this.generation) await this.set(response.recording_id);
        return;
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return;
        if (attempt === DISCOVERY_DELAYS_MS.length - 1) throw error;
      }
    }
  }

  private cancelDiscovery(): void {
    this.discovery?.controller.abort();
    this.discovery = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.cancelDiscovery();
  }

  async set(id: string | null): Promise<void> {
    if (this.disposed) return;
    this.cancelDiscovery();
    this.id = id;
    this.known = true;
    this.allowed = false;
    this.pending = false;
    this.generation++;
    this.render();
    await this.painted();
  }

  canRenderControl(): boolean {
    return this.known && this.id === null;
  }

  canRenderInteractive(visible: boolean): boolean {
    if (!this.known) return false;
    if (!this.id) return true;
    if (visible !== this.interactive || (visible && !this.allowed && !this.pending)) {
      this.interactive = visible;
      const generation = ++this.generation;
      if (visible) {
        this.pending = true;
        // The background closes frame intake and paints a neutral slate before
        // acknowledging. A failed handshake must never expose an overlay frame.
        void this.send("interactive")
          .then(() => {
            if (generation !== this.generation) return;
            this.pending = false;
            this.allowed = true;
            this.render();
          })
          .catch(() => {
            if (generation === this.generation) this.pending = false;
          });
      } else {
        this.allowed = false;
        this.pending = false;
        void this.painted()
          .then(() => {
            if (generation === this.generation) return this.send("clean");
          })
          .catch(() => {});
      }
    }
    return !visible || this.allowed;
  }

  async clean(): Promise<void> {
    if (this.disposed || !this.id || this.interactive) return;
    await this.painted();
    if (!this.disposed && !this.interactive) await this.send("clean");
  }
}

function discoveryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

async function discoveryReply<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Video overlay discovery cancelled"));
        timer = setTimeout(
          () => reject(new Error("Video overlay discovery timed out")),
          VIDEO_OVERLAY_QUERY_TIMEOUT_MS,
        );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}
