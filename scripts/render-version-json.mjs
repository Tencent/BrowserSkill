#!/usr/bin/env node
/**
 * Render version.json for bsk CLI GitHub releases (auto-update manifest).
 *
 * Usage:
 *   node scripts/render-version-json.mjs \
 *     --version 0.1.5 \
 *     --repo Tencent/BrowserSkill \
 *     --server-url https://github.com \
 *     --branch main \
 *     --dist dist \
 *     --out version.json
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** Platform key -> Rust target triple */
const PLATFORMS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "windows-x64": "x86_64-pc-windows-msvc",
};

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    repo: { type: "string" },
    "server-url": { type: "string", default: "https://github.com" },
    branch: { type: "string", default: "main" },
    dist: { type: "string" },
    out: { type: "string" },
  },
});

const version = values.version?.replace(/^v/, "");
const repo = values.repo;
const serverUrl = values["server-url"]?.replace(/\/$/, "") ?? "https://github.com";
const branch = values.branch ?? "main";
const dist = values.dist;
const out = values.out;

if (!version || !repo || !out) {
  console.error(
    "Usage: --version <semver> --repo <owner/repo> --out <path> [--server-url URL] [--branch main] [--dist dist]",
  );
  process.exit(1);
}

const tag = `cli-v${version}`;
const releaseBase = `${serverUrl}/${repo}/releases/download/${tag}`;

function assetFilename(platformKey, triple) {
  if (platformKey === "windows-x64") {
    return `bsk-v${version}-${triple}.zip`;
  }
  return `bsk-v${version}-${triple}.tar.gz`;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assetEntry(platformKey, triple) {
  const filename = assetFilename(platformKey, triple);
  const url = `${releaseBase}/${filename}`;
  if (!dist) {
    return url;
  }

  const path = join(dist, filename);
  if (!existsSync(path)) {
    console.error(`missing release asset for checksum: ${path}`);
    process.exit(1);
  }

  return {
    url,
    sha256: sha256File(path),
  };
}

const assets = Object.fromEntries(
  Object.entries(PLATFORMS).map(([key, triple]) => [key, assetEntry(key, triple)]),
);

const manifest = {
  name: "bsk",
  version,
  tag,
  released_at: new Date().toISOString(),
  release_url: `${serverUrl}/${repo}/releases/tag/${tag}`,
  install_sh: `https://raw.githubusercontent.com/${repo}/${branch}/install.sh`,
  assets,
};

writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
