// @vitest-environment node
// Static regression pin for Tencent/BrowserSkill#832.
//
// The `settlement.browser.test.ts` record-start scenario can only run under a
// real Chrome (BSK_TEST_CHROME), so a tightening of its bounds that re-introduces
// the #832 flake would otherwise only surface as an intermittent CI failure:
// when the hidden cross-origin OOPIF of `/record-wedged-child` wedges before
// arming, `bsk record start` drains five sequential ~3 s bounded waits —
//   1. bypassOverlay `sendTabMessageBounded` (entrypoints/background.ts)
//   2. `injectRecordFrameAllFrames` `executeScriptBounded` (lib/runtime-content-scripts.ts)
//   3. child `#startFrame` with RECORD_FRAME_START_TIMEOUT_MS (lib/recording/frame-coordinator.ts)
//   4. `injectCooperationAllFrames` arm (cooperation/controller.ts)
//   5. the follow-up `observeTab` frame read with FRAME_REPLY_TIMEOUT_MS (cooperation/browser-bridge.ts)
// — measured at 15.5-16.8 s on unchanged `main` (issue #832). The bounds must
// stay above that ceiling or the case fails exactly like the reported flake.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Measured wedged-first slow-path ceiling on unchanged `main` (#832). */
const RECORD_START_SLOW_PATH_MS = 16_800;

function readRecordStartBlock(): string {
  const source = readFileSync(
    fileURLToPath(new URL("./settlement.browser.test.ts", import.meta.url)),
    "utf8",
  );
  const startMarker = "const recordProc = spawn(";
  const endMarker = "const recStopped = await runCli(";
  const start = source.indexOf(startMarker);
  expect(start, "record start block missing from settlement.browser.test.ts").toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(
    end,
    "record start elapsed bound block missing from settlement.browser.test.ts",
  ).toBeGreaterThan(-1);
  return source.slice(start, end);
}

describe("settlement browser record-start bounds (#832)", () => {
  it("poll timeout and elapsed bound exceed the measured wedged-child slow path", () => {
    const block = readRecordStartBlock();
    const pollTimeout = Number(block.match(/\{ timeout: (\d+) \}/)?.[1]);
    const elapsedBound = Number(block.match(/toBeLessThan\((\d+)\)/)?.[1]);
    expect(Number.isFinite(pollTimeout), `poll timeout not parsed: ${pollTimeout}`).toBe(true);
    expect(Number.isFinite(elapsedBound), `elapsed bound not parsed: ${elapsedBound}`).toBe(true);
    // Both gates must tolerate the 16.8 s wedged-first slow path.
    expect(pollTimeout).toBeGreaterThanOrEqual(RECORD_START_SLOW_PATH_MS);
    expect(elapsedBound).toBeGreaterThanOrEqual(RECORD_START_SLOW_PATH_MS);
    // The poll must not starve before the elapsed assertion can produce a
    // useful bound failure (poll timeout strictly above the elapsed bound).
    expect(pollTimeout).toBeGreaterThan(elapsedBound);
  });
});
