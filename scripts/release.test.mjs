import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./release.mjs", import.meta.url));

function prepareRelease(t, changelog, extraArgs = []) {
  const cwd = mkdtempSync(join(tmpdir(), "bsk-release-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const dir of ["apps/extension", "packages/dsh-plugin-browserskill", "bin"]) {
    mkdirSync(join(cwd, dir), { recursive: true });
  }
  writeFileSync(join(cwd, "Cargo.toml"), '[workspace.package]\nversion = "0.2.1"\n');
  for (const dir of ["apps/extension", "packages/dsh-plugin-browserskill"]) {
    writeFileSync(join(cwd, dir, "package.json"), '{"version":"0.2.1"}\n');
  }
  writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
  // Exercise the real file-writing path without compiling Rust or creating Git tags.
  const windows = process.platform === "win32";
  writeFileSync(
    join(cwd, "bin", windows ? "cargo.cmd" : "cargo"),
    windows ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    { mode: 0o755 },
  );
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  execFileSync(process.execPath, [scriptPath, "0.3.0", "--no-commit", ...extraArgs], {
    cwd,
    env: {
      ...process.env,
      [pathKey]: `${join(cwd, "bin")}${windows ? ";" : ":"}${process.env[pathKey] ?? ""}`,
    },
  });
  return readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
}

const history = "## [0.2.1] - 2026-09-09\n\n### Fixed\n\n- Previous fix.\n";
const notes = "### Added\n\n- New release feature.\n\n";
const prepared = `## [0.3.0] - 2026-09-16\n\n${notes}${history}`;

test("moves unreleased notes into the release without an empty heading", (t) => {
  const actual = prepareRelease(t, `# Changelog\n\n## [Unreleased]\n\n${notes}${history}`);
  assert.match(actual, /^# Changelog\n\n## \[0\.3\.0\] - \d{4}-\d{2}-\d{2}\n\n/);
  assert.ok(actual.endsWith(`${notes}${history}`));
  assert.doesNotMatch(actual, /\[Unreleased\]/);
});

test("removes an empty heading without changing a prepared release", (t) => {
  const actual = prepareRelease(t, `# Changelog\n\n## [Unreleased]\n \t\n${prepared}`);
  assert.equal(actual, `# Changelog\n\n${prepared}`);
});

test("preserves future unreleased notes when the target release is already prepared", (t) => {
  const changelog = `# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- Future feature.\n\n${prepared}`;
  assert.equal(prepareRelease(t, changelog), changelog);
});

test("fills a prepared release date and removes its empty unreleased placeholder", (t) => {
  const actual = prepareRelease(
    t,
    `# Changelog\n\n## [Unreleased]\n\n## [0.3.0] - 2026-09-XX\n\n${notes}${history}`,
  );
  assert.match(actual, /^# Changelog\n\n## \[0\.3\.0\] - \d{4}-\d{2}-\d{2}\n\n/);
  assert.ok(actual.endsWith(`${notes}${history}`));
  assert.doesNotMatch(actual, /\[Unreleased\]/);
});

test("leaves a prepared release unchanged when there is no unreleased heading", (t) => {
  const changelog = `# Changelog\n\n${prepared}`;
  assert.equal(prepareRelease(t, changelog), changelog);
});

test("dry run preserves the original changelog", (t) => {
  const changelog = `# Changelog\n\n## [Unreleased]\n\n${notes}${history}`;
  assert.equal(prepareRelease(t, changelog, ["--dry-run"]), changelog);
});
