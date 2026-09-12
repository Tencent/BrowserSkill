import { describe, expect, it } from "vitest";
import { deduplicateVisualCandidates, MAX_VISUAL_DEDUP_KEYS } from "../visual-dedup";
import type { VisualCandidate, VisualDiscoveryResult } from "../visual-discovery";

function candidate(id: number, width = 100, parent = 1): VisualCandidate {
  const crop = { x: 0, y: 0, width, height: 100 };
  return {
    document: {
      attachmentId: "a",
      target: { tabId: 1 },
      frameId: "main",
      documentElementBackendNodeId: 1,
    },
    backendNodeId: id,
    parentBackendNodeId: parent,
    region: { status: "available", borderBox: crop, crop },
  };
}
function discovery(candidates: VisualCandidate[]): VisualDiscoveryResult {
  return { candidates, complete: true, issues: [], captureIssues: [] };
}

describe("visual candidate deduplication", () => {
  it("preserves small, unnamed and labelled candidates and their original evidence", async () => {
    const small = { ...candidate(3, 1), label: '  A "label"\n😀' };
    const large = candidate(2, 1000);
    const input = discovery([small, large]);
    Object.freeze(input.candidates);
    Object.freeze(small);
    Object.freeze(large);
    for (let i = 0; i < 2; i++) {
      const result = await deduplicateVisualCandidates(input);
      expect(result.candidates).toEqual([small, large]);
      expect(result.candidates[0]).toBe(small);
      expect(result.candidates[1]).toBe(large);
      expect(result).toMatchObject({
        candidateCount: 2,
        deduplicatedCount: 0,
        dedupDegraded: false,
      });
    }
  });

  it("only deduplicates the same Canvas identity, direct parent and exact crop", async () => {
    const base = candidate(20);
    const variants = [
      candidate(20, 100, 2),
      { ...base, parentBackendNodeId: null },
      ...["x", "y", "width", "height"].map((axis) => ({
        ...base,
        region: {
          ...base.region,
          crop: {
            ...base.region.crop,
            [axis]: base.region.crop[axis as keyof typeof base.region.crop] + 0.001,
          },
        },
      })),
      ...[
        { frameId: "child" },
        { target: { tabId: 2 } },
        { target: { tabId: 1, sessionId: "remote" } },
        { documentElementBackendNodeId: 9 },
        { attachmentId: "b" },
      ].map((identity) => ({ ...base, document: { ...base.document, ...identity } })),
    ];
    const duplicate = { ...base, label: "Repeated record" };
    const result = await deduplicateVisualCandidates(discovery([base, ...variants, duplicate]));
    expect(result.candidates).toEqual([base, ...variants]);
    expect(result.candidates[0]).toBe(base);
    expect(result.deduplicatedCount).toBe(1);
  });

  it("preserves distinct overlapping Canvas anchors in either encounter order", async () => {
    const first = candidate(20);
    const second = candidate(30);
    for (const ordered of [
      [first, second],
      [second, first],
    ]) {
      const result = await deduplicateVisualCandidates(discovery([...ordered, { ...ordered[0] }]));
      expect(result.candidates).toEqual(ordered);
      expect(result.candidates[0]).toBe(ordered[0]);
      expect(result.candidates[1]).toBe(ordered[1]);
      expect(result).toMatchObject({ candidateCount: 3, deduplicatedCount: 1 });
    }
  });

  it.each([
    50_001, 100_000,
  ])("keeps all %s distinct candidates including the last tiny Canvas", async (count) => {
    const input = Array.from({ length: count }, (_, i) => candidate(i + 1, 100, i + 1));
    input[count - 1] = candidate(count, 1, count);
    // A remembered key still deduplicates; an unremembered key passes through.
    input.push({ ...input[0] }, { ...input[count - 1] });
    const result = await deduplicateVisualCandidates(discovery(input));
    expect(result.candidates).toEqual([...input.slice(0, count), input[count + 1]]);
    expect(result.candidates[count - 1]).toBe(input[count - 1]);
    expect(result).toMatchObject({
      candidateCount: count + 2,
      deduplicatedCount: 1,
      dedupDegraded: true,
    });
  });

  it("does not report degradation when every key fits", async () => {
    const input = Array.from({ length: MAX_VISUAL_DEDUP_KEYS }, (_, i) => candidate(i, 1, i));
    input.push({ ...input[0] });
    const result = await deduplicateVisualCandidates(discovery(input));
    expect(result.candidates).toHaveLength(MAX_VISUAL_DEDUP_KEYS);
    expect(result.dedupDegraded).toBe(false);
    expect(result.deduplicatedCount).toBe(1);
  });

  it("preserves upstream unknowns without counting issues as Canvas nodes", async () => {
    const input: VisualDiscoveryResult = {
      ...discovery([candidate(2)]),
      complete: false,
      issues: [{ reason: "geometry-unavailable", target: { tabId: 1 }, frameId: "missing" }],
      captureIssues: [{ stage: "ax", reason: "capture-unavailable", target: { tabId: 1 } }],
    };
    const result = await deduplicateVisualCandidates(input);
    expect(result.complete).toBe(false);
    expect(result.candidateCount).toBe(1);
    expect(result.issues).toBe(input.issues);
    expect(result.captureIssues).toBe(input.captureIssues);
    const absent = await deduplicateVisualCandidates({
      ...input,
      candidates: [],
      issues: [{ reason: "visual-facts-not-collected" }],
    });
    expect(absent).toMatchObject({
      complete: false,
      candidateCount: 0,
      issues: [{ reason: "visual-facts-not-collected" }],
    });
    expect(await deduplicateVisualCandidates(discovery([]))).toMatchObject({
      complete: true,
      candidates: [],
      candidateCount: 0,
      dedupDegraded: false,
    });
  });

  it("drains cancellation through the shared checkpoint", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      deduplicateVisualCandidates(discovery([]), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    const during = new AbortController();
    const input = discovery(Array.from({ length: 100_000 }, (_, i) => candidate(i, 100, i)));
    const timer = setTimeout(() => during.abort(), 0);
    try {
      await expect(deduplicateVisualCandidates(input, during.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      clearTimeout(timer);
    }
  });
});
