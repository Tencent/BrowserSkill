// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { saveVideoEvidence } from "./browser-fixture";

let directory: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function evidence() {
  directory = await mkdtemp(path.join(tmpdir(), "bsk-video-evidence-test-"));
  vi.stubEnv("BSK_VIDEO_ARTIFACTS", directory);
  return { directory, warning: vi.spyOn(console, "warn").mockImplementation(() => {}) };
}

it("does not load optional video evidence when collection is disabled", async () => {
  vi.stubEnv("BSK_VIDEO_ARTIFACTS", "");
  const load = vi.fn();
  await saveVideoEvidence("disabled", {}, load);
  expect(load).not.toHaveBeenCalled();
});

it("preserves the MP4 before a serialization failure without rejecting", async () => {
  const { directory, warning } = await evidence();
  const details: { cycle?: unknown } = {};
  details.cycle = details;
  await expect(
    saveVideoEvidence("cycle", details, new Uint8Array([1, 2])),
  ).resolves.toBeUndefined();
  expect(await readFile(path.join(directory, "cycle.mp4"))).toEqual(Buffer.from([1, 2]));
  expect(warning).toHaveBeenCalled();
});

it("warns without rejecting when the evidence directory is not writable", async () => {
  const { directory, warning } = await evidence();
  const file = path.join(directory, "not-a-directory");
  await writeFile(file, "fixture");
  vi.stubEnv("BSK_VIDEO_ARTIFACTS", file);
  await expect(saveVideoEvidence("disk-error", {})).resolves.toBeUndefined();
  expect(warning).toHaveBeenCalled();
});

it("does not let optional browser export failures replace the test result", async () => {
  const { warning } = await evidence();
  await expect(
    saveVideoEvidence("export-error", {}, async () => {
      throw new Error("CDP export failed");
    }),
  ).resolves.toBeUndefined();
  expect(warning).toHaveBeenCalled();
});
