#!/usr/bin/env node
/**
 * Cross-platform on-demand installer for the `bsk` CLI bundled inside
 * `@wxg-prc-cpg/browser-skill-dsh-plugin`.
 *
 * Usage:
 *   node bin/install-bsk.mjs           # install if missing, reuse if already present
 *   node bin/install-bsk.mjs --check   # exit 0 if `bsk --version` succeeds, 1 otherwise
 *   node bin/install-bsk.mjs --force   # run bundled platform installer unconditionally
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const forceInstall = args.has("--force");
const isWin = process.platform === "win32";
const exeName = isWin ? "bsk.exe" : "bsk";

function expandHome(rawPath, home) {
  if (rawPath === "~") return home;
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return join(home, rawPath.slice(2));
  }
  return rawPath;
}

function resolveInstallDir() {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const custom = process.env.BSK_INSTALL_DIR?.trim();
  return custom ? resolve(expandHome(custom, home)) : join(home, ".local", "bin");
}

function probeBinary(candidate) {
  const res = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (res.error || res.status !== 0) return null;
  return (res.stdout || res.stderr || "").trim() || "ok";
}

function findInstalledBsk() {
  const installCandidate = join(resolveInstallDir(), exeName);
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const entries = (process.env[pathKey] ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const candidates = [...entries.map((dir) => join(dir, exeName)), installCandidate];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = isWin ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!existsSync(candidate)) continue;
    const version = probeBinary(candidate);
    if (version !== null) {
      return { path: candidate, version };
    }
  }
  return null;
}

function runPlatformInstaller() {
  if (isWin) {
    const script = join(pkgRoot, "install.ps1");
    if (!existsSync(script)) {
      console.error(`error: bundled installer missing at ${script}`);
      process.exit(1);
    }
    for (const shell of ["powershell.exe", "pwsh"]) {
      const res = spawnSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
        stdio: "inherit",
      });
      if (res.error && "code" in res.error && res.error.code === "ENOENT") {
        continue;
      }
      if (res.status !== 0) {
        process.exit(res.status ?? 1);
      }
      return;
    }
    console.error("error: neither powershell.exe nor pwsh was found on PATH");
    process.exit(1);
  }

  const script = join(pkgRoot, "install.sh");
  if (!existsSync(script)) {
    console.error(`error: bundled installer missing at ${script}`);
    process.exit(1);
  }
  const res = spawnSync("sh", [script], { stdio: "inherit" });
  if (res.error) {
    console.error(`error: failed to launch sh: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

const existing = findInstalledBsk();

if (checkOnly) {
  if (existing) {
    console.log(`${existing.path} (${existing.version})`);
    process.exit(0);
  }
  console.error("bsk CLI is not installed");
  process.exit(1);
}

const agentGuidePath = join(pkgRoot, "AGENT_INSTALL.md");

if (existing && !forceInstall) {
  console.log(`==> bsk is already installed at ${existing.path} (${existing.version})`);
  console.log(
    `==> Next: run 'bsk doctor' and follow ${agentGuidePath} (Steps 3-5) to verify browser connection.`,
  );
  process.exit(0);
}

runPlatformInstaller();

const installed = findInstalledBsk();
if (!installed) {
  console.error("error: installer finished, but bsk executable could not be verified");
  process.exit(1);
}

console.log(`==> Verified ${installed.path} (${installed.version})`);
console.log(
  `==> Next: run 'bsk doctor' and follow ${agentGuidePath} (Steps 3-5) to verify browser connection.`,
);
