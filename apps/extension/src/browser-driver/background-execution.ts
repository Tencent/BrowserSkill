/** Desired control is independent of a debugger attachment (which Chrome can drop).
 * Serialize toggles per tab so a late enable cannot outlive its last owner. */
export class BackgroundExecution {
  private readonly owners = new Map<number, Set<string>>();
  private readonly applied = new Map<number, { attachment: string; enabled: boolean }>();
  private readonly pending = new Map<number, Promise<void>>();

  constructor(
    private readonly attachment: (tabId: number) => string | undefined,
    private readonly toggle: (tabId: number, enabled: boolean) => Promise<unknown>,
  ) {}

  retain(sessionId: string, tabId: number): void {
    const owners = this.owners.get(tabId) ?? new Set<string>();
    owners.add(sessionId);
    this.owners.set(tabId, owners);
  }

  has(sessionId: string, tabId: number): boolean {
    return this.owners.get(tabId)?.has(sessionId) ?? false;
  }

  release(sessionId: string, tabId: number): void {
    const owners = this.owners.get(tabId);
    owners?.delete(sessionId);
    if (owners?.size === 0) this.owners.delete(tabId);
  }

  forget(tabId: number): void {
    this.owners.delete(tabId);
    this.applied.delete(tabId);
  }

  invalidate(tabId: number): void {
    this.applied.delete(tabId);
  }

  clear(): void {
    this.owners.clear();
    this.applied.clear();
  }

  async synchronize(tabId: number): Promise<void> {
    // Join the preceding toggle, but retry a failed toggle on a subsequent call.
    const previous = this.pending.get(tabId);
    const next = (async () => {
      await previous?.catch(() => {});
      for (;;) {
        const attachment = this.attachment(tabId);
        if (!attachment) return;
        const enabled = this.owners.has(tabId);
        const applied = this.applied.get(tabId);
        if (applied?.attachment === attachment && applied.enabled === enabled) return;
        if (!enabled && applied?.attachment !== attachment) return;
        await this.toggle(tabId, enabled);
        if (this.attachment(tabId) !== attachment) {
          throw new Error("Background execution attachment changed during setup");
        }
        this.applied.set(tabId, { attachment, enabled });
        // A release may have arrived while Chrome processed the toggle.
      }
    })();
    this.pending.set(tabId, next);
    try {
      await next;
    } finally {
      if (this.pending.get(tabId) === next) this.pending.delete(tabId);
    }
  }
}
