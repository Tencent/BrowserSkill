import { createCaptureCheckpoint } from "./capture-abort";
import type { VisualCandidate, VisualDiscoveryResult } from "./visual-discovery";

export const MAX_VISUAL_DEDUP_KEYS = 50_000;

export interface VisualDedupResult extends VisualDiscoveryResult {
  /** Known valid candidates in this capture, not the total Canvas count on the page. */
  readonly candidateCount: number;
  /** Candidates actually removed by exact coverage deduplication. */
  readonly deduplicatedCount: number;
  readonly dedupDegraded: boolean;
}

/** Keep the first real anchor for each exact DOM/parent/crop key, in encounter order.
 * Once the key set is full, unknown keys pass through: capacity never drops candidates. */
export async function deduplicateVisualCandidates(
  discovery: VisualDiscoveryResult,
  signal?: AbortSignal,
): Promise<VisualDedupResult> {
  const checkpoint = createCaptureCheckpoint(signal);
  const keys = new Set<string>();
  const candidates: VisualCandidate[] = [];
  let deduplicatedCount = 0;
  let dedupDegraded = false;
  for (let i = 0; i < discovery.candidates.length; i++) {
    if (i % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    const candidate = discovery.candidates[i];
    const {
      document,
      region: { crop },
    } = candidate;
    const key = JSON.stringify([
      document.attachmentId,
      document.target.tabId,
      document.target.sessionId ?? null,
      document.frameId,
      document.documentElementBackendNodeId,
      candidate.parentBackendNodeId,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
    ]);
    if (keys.has(key)) {
      deduplicatedCount++;
      continue;
    }
    if (keys.size < MAX_VISUAL_DEDUP_KEYS) keys.add(key);
    else dedupDegraded = true;
    candidates.push(candidate);
  }
  const pending = checkpoint();
  if (pending) await pending;
  return {
    ...discovery,
    candidates,
    candidateCount: discovery.candidates.length,
    deduplicatedCount,
    dedupDegraded,
  };
}
