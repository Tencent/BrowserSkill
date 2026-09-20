import { describe, expect, it, vi } from "vitest";
import type { DebugArchive } from "../archive";
import { DebugJournal, mergeRequest } from "../journal";
import type { DebugRequest, DebugRun } from "../types";

const run = { id: "d", session_id: "s", state: "capturing" } as DebugRun;
const entry = (i: number): DebugRequest => ({
  id: `d:n${i}`,
  run_id: "d",
  sequence: i,
  started_at: i,
  method: "GET",
  url: "https://site.test",
  state: "complete",
  request_body: { state: "empty" },
  response_body: { state: "available", text: "saved" },
});
describe("bounded evidence journal", () => {
  it("coalesces updates while preserving captured bodies across memory eviction", async () => {
    const retain = vi.fn(async () => {}),
      failed = vi.fn();
    const journal = new DebugJournal({ retain } as unknown as DebugArchive, () => run, failed);
    const source = entry(1);
    journal.retain(source);
    source.response_body = { state: "evicted" };
    source.sequence++;
    journal.retain(source);
    await journal.flush();
    expect(retain).toHaveBeenCalledTimes(1);
    expect((retain.mock.calls[0] as unknown[])[1]).toEqual([
      expect.objectContaining({ response_body: { state: "available", text: "saved" } }),
    ]);
    expect(failed).not.toHaveBeenCalled();
    await journal.stop();
  });
  it("reports storage failures and bounds the queue while a transaction is stalled", async () => {
    let release: () => void = () => {};
    const retain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const failed = vi.fn();
    const journal = new DebugJournal({ retain } as unknown as DebugArchive, () => run, failed);
    for (let i = 0; i < 500; i++) journal.retain(entry(i));
    expect(retain).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith("evidence_write_backlog");
    retain.mockImplementation(async () => {
      throw new Error("disk full");
    });
    release();
    await journal.stop();
    expect(failed).toHaveBeenCalledWith("evidence_write_failed");
  });
  it("preserves pins and complete stored bodies when merging a metadata-only read", () => {
    const saved = { ...entry(1), pinned: true };
    expect(
      mergeRequest(saved, { ...entry(1), response_body: { state: "available", chars: 5 } }),
    ).toMatchObject({ pinned: true, response_body: { text: "saved" } });
  });
});
