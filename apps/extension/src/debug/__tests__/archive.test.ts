import { describe, expect, it } from "vitest";
import {
  expiredHistory,
  HISTORY_AGE_MS,
  HISTORY_BYTES,
  HISTORY_LIMIT,
  interrupted,
} from "../archive";
import type { DebugRecording, DebugRun } from "../types";

const now = 2 * HISTORY_AGE_MS;
function run(id: string, at: number, state: "capturing" | "stopped" = "stopped"): DebugRun {
  return {
    id,
    session_id: "s1",
    tab_id: 7,
    name: "App",
    url: "https://site.test",
    started_at: at,
    stopped_at: at,
    state,
    requests: 0,
    operations: 0,
    errors: 0,
    dropped_requests: 0,
    dropped_operations: 0,
    dropped_console: 0,
    coverage: [],
    next_since: 0,
  };
}

describe("debug history retention", () => {
  it("reserves count and bytes for active captures, evicting older stopped records first", () => {
    const values = Array.from({ length: HISTORY_LIMIT }, (_, i) => ({
      run: run(`d${i}`, now + i),
      bytes: 100,
    }));
    values.push({ run: run("dactive", now - HISTORY_AGE_MS - 1, "capturing"), bytes: 100 });
    expect(expiredHistory(values, now)).toEqual(["d0"]);
    expect(
      expiredHistory(
        [
          { run: run("dactive", now - 2, "capturing"), bytes: HISTORY_BYTES - 100 },
          { run: run("dold", now - 1), bytes: 100 },
          { run: run("dnew", now), bytes: 100 },
        ],
        now,
      ),
    ).toEqual(["dold"]);
  });

  it("expires stopped records by their stop time rather than the time they were opened", () => {
    expect(
      expiredHistory(
        [
          { run: run("dold", now - HISTORY_AGE_MS - 1), bytes: 100 },
          { run: { ...run("drecent", now - HISTORY_AGE_MS - 1), stopped_at: now }, bytes: 100 },
        ],
        now,
      ),
    ).toEqual(["dold"]);
  });

  it("preserves completed data while marking only interrupted work unavailable", () => {
    const record: DebugRecording = {
      version: 1,
      saved_at: now,
      run: run("d1", now - 1000, "capturing"),
      pages: [],
      console: [],
      operations: [],
      requests: [
        {
          id: "d1:n1",
          run_id: "d1",
          sequence: 1,
          started_at: now - 1000,
          method: "GET",
          url: "https://site.test",
          state: "complete",
          request_body: { state: "empty" },
          response_body: { state: "available", text: "saved" },
        },
        {
          id: "d1:n2",
          run_id: "d1",
          sequence: 2,
          started_at: now - 100,
          method: "GET",
          url: "https://site.test/pending",
          state: "pending",
          request_body: { state: "empty" },
          response_body: { state: "pending" },
        },
      ],
    };
    const recovered = interrupted(record);
    expect(recovered.run.stopped_at).toBe(now);
    expect(recovered.run.coverage).toContain("interrupted_checkpoint");
    expect(recovered.requests[0].response_body.text).toBe("saved");
    expect(recovered.requests[1].state).toBe("interrupted");
    expect(recovered.requests[1].response_body).toEqual({
      state: "unavailable",
      reason: "browser_restarted",
    });
    expect(interrupted(recovered)).toBe(recovered);
  });
});
