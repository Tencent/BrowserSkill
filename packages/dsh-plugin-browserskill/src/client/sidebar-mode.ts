/**
 * Carrier switch for the observation view: while the better-sidebar
 * integration fiber is alive (the dsh-better-sidebar plugin provides its
 * `betterSidebar` service), the tracking view lives in a sidebar tab and the
 * floating overlay card/capsule hides itself. The flag is a tiny external
 * store so the overlay can read it through useSyncExternalStore and flip
 * without a remount when the sidebar plugin (un)loads.
 */

let active = false;
const listeners = new Set<() => void>();

export function getSidebarMode(): boolean {
  return active;
}

export function subscribeSidebarMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSidebarMode(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of [...listeners]) listener();
}
