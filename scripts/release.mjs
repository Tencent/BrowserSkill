#!/usr/bin/env node
/**
 * Unified release script for BrowserSkill.
 *
 * Bumps CLI, Extension, and DSH Plugin to the same version, updates
 * CHANGELOG.md, commits, tags, and optionally pushes.
 *
 * Usage:
 *   node scripts/release.mjs <version>                  # bump + commit + tag
 *   node scripts/release.mjs <version> --dry-run        # preview changes only
 *   node scripts/release.mjs <version> --push           # also push to origin
 *   node scripts/release.mjs <version> --push --only ext          # push only ext tag
 *   node scripts/release.mjs <version> --push --only cli,dsh      # push only cli + dsh tags
 *   node scripts/release.mjs --push-tags --only ext     # push tag(s) for an already-committed release
 *
 * Options:
 *   --dry-run      Show what would change without writing anything
 *   --push         After commit+tag, push the branch and all release tags
 *   --push-tags    Push release tags only (skip version bump; useful for staged rollout)
 *   --only <list>  Comma-separated subset of: cli, ext, dsh  (default: all three)
 *   --no-commit    Write files but skip git commit and tagging
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const TAG_PREFIX = { cli: "cli-v", ext: "ext-v", dsh: "dsh-plugin-v" };
const ALL_COMPONENTS = ["cli", "ext", "dsh"];

const VERSION_FILES = {
  cargo: "Cargo.toml",
  extension: "apps/extension/package.json",
  dshPlugin: "packages/dsh-plugin-browserskill/package.json",
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    push: { type: "boolean", default: false },
    "push-tags": { type: "boolean", default: false },
    "no-commit": { type: "boolean", default: false },
    only: { type: "string", default: "" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(
    readFileSync(new URL(import.meta.url), "utf8").match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? "",
  );
  process.exit(0);
}

const dryRun = values["dry-run"];
const pushAfter = values.push;
const pushTagsOnly = values["push-tags"];
const noCommit = values["no-commit"];
const onlyRaw = values.only;
const components = onlyRaw ? onlyRaw.split(",").map((s) => s.trim().toLowerCase()) : ALL_COMPONENTS;

for (const c of components) {
  if (!ALL_COMPONENTS.includes(c)) {
    console.error(`Unknown component "${c}". Valid: ${ALL_COMPONENTS.join(", ")}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Push-tags-only mode (no version bump)
// ---------------------------------------------------------------------------

if (pushTagsOnly) {
  const currentVersion = readCurrentVersions();
  const ver = positionals[0] ?? currentVersion.cargo;
  for (const c of components) {
    const tag = `${TAG_PREFIX[c]}${ver}`;
    console.log(`  pushing tag ${tag}`);
    if (!dryRun) {
      run(`git push origin ${tag}`);
    }
  }
  console.log("\nDone.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Normal mode — require version argument
// ---------------------------------------------------------------------------

const newVersion = positionals[0];
if (!newVersion) {
  console.error(
    "Usage: node scripts/release.mjs <version> [--dry-run] [--push] [--only cli,ext,dsh]",
  );
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
  console.error(`Invalid semver: "${newVersion}"`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Read current versions
// ---------------------------------------------------------------------------

function readCurrentVersions() {
  const cargo = readFileSync(VERSION_FILES.cargo, "utf8");
  const cargoVer =
    cargo.match(/^\[workspace\.package\]\s*\nversion\s*=\s*"([^"]+)"/m)?.[1] ??
    cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

  const extPkg = JSON.parse(readFileSync(VERSION_FILES.extension, "utf8"));
  const dshPkg = JSON.parse(readFileSync(VERSION_FILES.dshPlugin, "utf8"));

  return { cargo: cargoVer, extension: extPkg.version, dshPlugin: dshPkg.version };
}

const current = readCurrentVersions();

console.log("Current versions:");
console.log(`  CLI/Daemon (Cargo.toml):         ${current.cargo}`);
console.log(`  Extension (package.json):         ${current.extension}`);
console.log(`  DSH Plugin (package.json):        ${current.dshPlugin}`);
console.log(`\nBumping all → ${newVersion}`);
if (dryRun) console.log("  (dry-run mode — no files will be written)\n");

// ---------------------------------------------------------------------------
// Bump Cargo.toml
// ---------------------------------------------------------------------------

function bumpCargo(version) {
  let content = readFileSync(VERSION_FILES.cargo, "utf8");

  // workspace.package version
  content = content.replace(
    /^(\[workspace\.package\]\s*\nversion\s*=\s*")([^"]+)(")/m,
    `$1${version}$3`,
  );

  // workspace.dependencies.bsk-protocol version (for cargo publish)
  content = content.replace(
    /(bsk-protocol\s*=\s*\{\s*version\s*=\s*")([^"]+)(")/,
    `$1${version}$3`,
  );

  return content;
}

function bumpPackageJson(filePath, version) {
  const pkg = JSON.parse(readFileSync(filePath, "utf8"));
  pkg.version = version;
  return JSON.stringify(pkg, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Update CHANGELOG.md
// ---------------------------------------------------------------------------

function updateChangelog(version) {
  const changelogPath = "CHANGELOG.md";
  let content;
  try {
    content = readFileSync(changelogPath, "utf8");
  } catch {
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);
  const escapedVer = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // First: fill in any date-placeholder line for this version (e.g. "## [0.2.0] - 2026-09-XX")
  const versionPlaceholder = new RegExp(`^## \\[${escapedVer}\\]\\s*-\\s*\\d{4}-\\d{2}-XX`, "m");
  if (versionPlaceholder.test(content)) {
    content = content.replace(versionPlaceholder, `## [${version}] - ${today}`);
  } else {
    // Otherwise: insert a new section after [Unreleased]
    const unreleased = /^## \[Unreleased\]/m;
    if (unreleased.test(content)) {
      content = content.replace(unreleased, `## [Unreleased]\n\n## [${version}] - ${today}`);
    }
  }

  return { path: changelogPath, content };
}

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------

const writes = [
  { path: VERSION_FILES.cargo, content: bumpCargo(newVersion), label: "Cargo.toml" },
  {
    path: VERSION_FILES.extension,
    content: bumpPackageJson(VERSION_FILES.extension, newVersion),
    label: "Extension package.json",
  },
  {
    path: VERSION_FILES.dshPlugin,
    content: bumpPackageJson(VERSION_FILES.dshPlugin, newVersion),
    label: "DSH Plugin package.json",
  },
];

const changelogUpdate = updateChangelog(newVersion);
if (changelogUpdate) {
  writes.push({
    path: changelogUpdate.path,
    content: changelogUpdate.content,
    label: "CHANGELOG.md",
  });
}

for (const w of writes) {
  console.log(`  ✓ ${w.label}`);
  if (!dryRun) {
    writeFileSync(w.path, w.content);
  }
}

// ---------------------------------------------------------------------------
// Update Cargo.lock (cargo check triggers it)
// ---------------------------------------------------------------------------

if (!dryRun) {
  console.log("\n  Updating Cargo.lock...");
  run("cargo check --workspace 2>&1 || true");
}

// ---------------------------------------------------------------------------
// Git commit + tag
// ---------------------------------------------------------------------------

if (noCommit || dryRun) {
  if (dryRun) {
    console.log(`\nWould commit: "chore(release): ${newVersion}"`);
    console.log("Would create tags:");
    for (const c of components) {
      console.log(`  ${TAG_PREFIX[c]}${newVersion}`);
    }
  }
  console.log("\nDone.");
  process.exit(0);
}

console.log("\nCommitting...");
run(
  "git add Cargo.toml Cargo.lock apps/extension/package.json packages/dsh-plugin-browserskill/package.json CHANGELOG.md 2>/dev/null || true",
);
run(`git commit -m "chore(release): ${newVersion}"`);

console.log("Tagging...");
for (const c of components) {
  const tag = `${TAG_PREFIX[c]}${newVersion}`;
  run(`git tag ${tag}`);
  console.log(`  ✓ ${tag}`);
}

// ---------------------------------------------------------------------------
// Push (optional)
// ---------------------------------------------------------------------------

if (pushAfter) {
  console.log("\nPushing...");
  run("git push origin HEAD");
  for (const c of components) {
    const tag = `${TAG_PREFIX[c]}${newVersion}`;
    console.log(`  pushing tag ${tag}`);
    run(`git push origin ${tag}`);
  }
}

console.log(`\nRelease ${newVersion} prepared successfully.`);
if (!pushAfter) {
  console.log("\nNext steps:");
  console.log("  # Push branch");
  console.log("  git push origin main");
  console.log("");
  console.log("  # Push extension tag first (store review takes time)");
  console.log(`  git push origin ext-v${newVersion}`);
  console.log("");
  console.log("  # Then push CLI and DSH plugin tags");
  console.log(`  git push origin cli-v${newVersion}`);
  console.log(`  git push origin dsh-plugin-v${newVersion}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}
