import type { OverlayVersion } from "./overlay-bridge";

// Names this worker instance. A restarted worker counts from zero again, and
// its new epoch tells a page that kept the old counter that it is not stale.
const epoch = crypto.randomUUID();
let generation = 0;

/**
 * The version of the next overlay state or reset message the background
 * worker sends to a page. Every message gets its own, so the page can order
 * any two of them, including two different states for the same change.
 */
export function nextOverlayVersion(): OverlayVersion {
  generation += 1;
  return { epoch, generation };
}
