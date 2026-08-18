import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";

const captureRecordingObservation = vi.hoisted(() => vi.fn());

vi.mock("../recording/observation-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recording/observation-capture")>();
  return { ...actual, captureRecordingObservation };
});

import { ObservationNodeIndex } from "../recording/observation-capture";
import { RecordingObservationRuntime } from "../recording/recording-runtime";

function observation() {
  return {
    rootFrameId: "root",
    index: new ObservationNodeIndex({ rootFrameId: "root", frameDocuments: [], refs: [] }),
    url: "https://example.com/",
    title: "Example",
    vomText: '@vom 1\nRootWebArea "Example"',
    truncated: false,
  };
}

function runtime(): RecordingObservationRuntime {
  return new RecordingObservationRuntime({
    cdp: { send: vi.fn() as unknown as CdpRunner["send"] },
    tabsApi: { get: vi.fn(), query: vi.fn() } as unknown as ChromeTabsApi,
  });
}

describe("RecordingObservationRuntime", () => {
  afterEach(() => captureRecordingObservation.mockReset());

  it("shares one initial capture and includes it in flush", async () => {
    let release!: (value: ReturnType<typeof observation>) => void;
    captureRecordingObservation.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const recording = runtime();

    const first = recording.captureInitial(7);
    const second = recording.captureInitial(7);
    const flushed = recording.flush();
    let flushCompleted = false;
    void flushed.then(() => {
      flushCompleted = true;
    });

    await Promise.resolve();
    expect(captureRecordingObservation).toHaveBeenCalledTimes(1);
    expect(flushCompleted).toBe(false);

    release(observation());
    await Promise.all([first, second, flushed]);
    expect(flushCompleted).toBe(true);
  });

  it("cancels an in-flight initial capture", async () => {
    captureRecordingObservation.mockImplementationOnce(
      (input: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("observation aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const recording = runtime();

    const pending = recording.captureInitial(7);
    recording.cancel();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("retries a failed initial capture when the recording settles at stop", async () => {
    captureRecordingObservation
      .mockRejectedValueOnce(new Error("document swapped"))
      .mockResolvedValueOnce(observation());
    const recording = runtime();

    await expect(recording.captureInitial(7)).rejects.toThrow("document swapped");
    await recording.settleTrailing(7, []);
    const trace = recording.buildTrace({
      drafts: [],
      startedAt: "2026-08-19T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "0.1.6",
    });

    expect(captureRecordingObservation).toHaveBeenCalledTimes(2);
    expect(trace.states).toHaveLength(1);
  });
});
