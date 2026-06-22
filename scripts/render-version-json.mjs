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
 *     --out version.json
 */

import { writeFileSync } from "node:fs";
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
    out: { type: "string" },
  },
});

const version = values.version?.replace(/^v/, "");
const repo = values.repo;
const serverUrl = values["server-url"]?.replace(/\/$/, "") ?? "https://github.com";
const branch = values.branch ?? "main";
const out = values.out;

if (!version || !repo || !out) {
  console.error(
    "Usage: --version <semver> --repo <owner/repo> --out <path> [--server-url URL] [--branch main]",
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

const assets = Object.fromEntries(
  Object.entries(PLATFORMS).map(([key, triple]) => [
    key,
    `${releaseBase}/${assetFilename(key, triple)}`,
  ]),
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
