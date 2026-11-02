/** Page-local presentation choice. Nothing is persisted or shared between client instances. */
export class ObservationPresentation {
  private readonly listeners = new Set<() => void>();
  private reveal: (() => void) | undefined;
  private floating = false;
  private snapshot = { sidebarAvailable: false, floating: true };

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A successfully registered native carrier; removing it restores the overlay. */
  connectSidebar(reveal: () => void): () => void {
    this.reveal = reveal;
    this.publish();
    return () => {
      if (this.reveal !== reveal) return;
      this.reveal = undefined;
      this.publish();
    };
  }

  showFloating = (): void => {
    this.floating = true;
    this.publish();
  };

  showSidebar = (): void => {
    if (this.reveal === undefined) return;
    this.floating = false;
    this.publish();
    this.reveal();
  };

  private publish(): void {
    const sidebarAvailable = this.reveal !== undefined;
    const floating = this.floating || !sidebarAvailable;
    if (sidebarAvailable === this.snapshot.sidebarAvailable && floating === this.snapshot.floating)
      return;
    this.snapshot = { sidebarAvailable, floating };
    for (const listener of [...this.listeners]) listener();
  }
}
