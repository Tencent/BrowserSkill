import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(scriptDir, "render-version-json.mjs");

test("renders asset URLs with sha256 checksums from dist files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bsk-version-json-"));
  const dist = join(tmp, "dist");
  const out = join(tmp, "version.json");
  const version = "9.8.7";
  const archive = `bsk-v${version}-aarch64-apple-darwin.tar.gz`;
  const archiveBytes = Buffer.from("fake darwin arm64 archive\n");
  mkdirSync(dist);
  writeFileSync(join(dist, archive), archiveBytes);
  writeFileSync(join(dist, `bsk-v${version}-x86_64-apple-darwin.tar.gz`), "darwin x64\n");
  writeFileSync(
    join(dist, `bsk-v${version}-x86_64-unknown-linux-musl.tar.gz`),
    "linux x64\n",
  );
  writeFileSync(
    join(dist, `bsk-v${version}-aarch64-unknown-linux-musl.tar.gz`),
    "linux arm64\n",
  );
  writeFileSync(join(dist, `bsk-v${version}-x86_64-pc-windows-msvc.zip`), "windows x64\n");

  execFileSync(process.execPath, [
    scriptPath,
    "--version",
    version,
    "--repo",
    "Tencent/BrowserSkill",
    "--dist",
    dist,
    "--out",
    out,
  ]);

  const manifest = JSON.parse(readFileSync(out, "utf8"));
  const expectedSha = createHash("sha256").update(archiveBytes).digest("hex");
  assert.equal(
    manifest.assets["darwin-arm64"].url,
    `https://github.com/Tencent/BrowserSkill/releases/download/cli-v${version}/${archive}`,
  );
  assert.equal(manifest.assets["darwin-arm64"].sha256, expectedSha);
});
