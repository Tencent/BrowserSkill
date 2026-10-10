// Kept independent of capture-suppress: short screenshots use a reference count;
// video owns an idempotent lease that survives a content script remount.
export const VIDEO_OVERLAY = "bsk/video-overlay";
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

  constructor(
    private readonly send: (
      action: "query" | "interactive" | "clean",
    ) => Promise<{ recording_id: string | null }>,
    private readonly render: () => void,
    private readonly painted: () => Promise<void>,
  ) {}

  async initialize(): Promise<void> {
    const generation = ++this.generation;
    // A new or restored document must not assume that capture is inactive.
    // Navigation may resume capture before this script registers its listener.
    this.known = false;
    this.render();
    const response = await this.send("query");
    if (generation === this.generation) await this.set(response.recording_id);
  }

  async set(id: string | null): Promise<void> {
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
    if (!this.id || this.interactive) return;
    await this.painted();
    if (!this.interactive) await this.send("clean");
  }
}
