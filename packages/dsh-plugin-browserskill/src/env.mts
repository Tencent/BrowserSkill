import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function expandHome(rawPath: string, homeDir: string): string {
  if (rawPath === "~") return homeDir;
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return join(homeDir, rawPath.slice(2));
  }
  return rawPath;
}

function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir();
}

export function defaultInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHomeDir(env);
  const override = env.BSK_INSTALL_DIR?.trim();
  return override ? resolve(expandHome(override, home)) : join(home, ".local", "bin");
}

function findPathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function normalizeDir(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (process.platform !== "win32") {
      accessSync(filePath, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function isDefaultBskCommand(bskPath: string | undefined): boolean {
  const trimmed = bskPath?.trim();
  return !trimmed || trimmed === "bsk" || trimmed.toLowerCase() === "bsk.exe";
}

/**
 * Synchronously locate the `bsk` binary without spawning a child process or daemon.
 * Returns the resolved executable path when present, or `null` when missing.
 */
export function resolveBskExecutable(bskPath?: string): string | null {
  const env = process.env;
  const isWin = process.platform === "win32";
  const home = resolveHomeDir(env);
  const exeName = isWin ? "bsk.exe" : "bsk";

  if (!isDefaultBskCommand(bskPath)) {
    const target = resolve(expandHome(bskPath!.trim(), home));
    try {
      const stat = statSync(target);
      if (stat.isDirectory()) {
        const inDir = join(target, exeName);
        return isExecutableFile(inDir) ? inDir : null;
      }
      if (stat.isFile()) {
        return isExecutableFile(target) ? target : null;
      }
    } catch {
      if (isWin && !target.toLowerCase().endsWith(".exe")) {
        const withExe = `${target}.exe`;
        if (isExecutableFile(withExe)) return withExe;
      }
      return null;
    }
    return null;
  }

  const sep = isWin ? ";" : ":";
  const pathKey = findPathKey(env);
  const pathEntries = (env[pathKey] ?? "")
    .split(sep)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const dir of [...pathEntries, defaultInstallDir(env)]) {
    const candidate = join(dir, exeName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Ensure the DSH host process `PATH` includes the default `bsk` install directory
 * (`$BSK_INSTALL_DIR` or `~/.local/bin`) and, when an explicit `bskPath` is configured,
 * prepends its directory so shell invocations of `bsk` resolve consistently.
 */
export function ensureBskInPath(bskPath?: string): () => void {
  const env = process.env;
  const isWin = process.platform === "win32";
  const sep = isWin ? ";" : ":";
  const home = resolveHomeDir(env);
  const pathKey = findPathKey(env);

  const splitEntries = () =>
    (env[pathKey] ?? "")
      .split(sep)
      .map((entry) => entry.trim())
      .filter(Boolean);

  const installDir = defaultInstallDir(env);
  const installNorm = normalizeDir(installDir);
  const initialEntries = splitEntries();
  if (!initialEntries.some((entry) => normalizeDir(entry) === installNorm)) {
    env[pathKey] = [...initialEntries, installDir].join(sep);
  }

  if (isDefaultBskCommand(bskPath)) {
    return () => {};
  }

  const rawTarget = resolve(expandHome(bskPath!.trim(), home));
  let customDir = dirname(rawTarget);
  try {
    if (statSync(rawTarget).isDirectory()) {
      customDir = rawTarget;
    }
  } catch {
    // Keep dirname(rawTarget) when rawTarget points to a not-yet-installed binary path.
  }

  const customNorm = normalizeDir(customDir);
  const currentEntries = splitEntries();
  if (currentEntries[0] && normalizeDir(currentEntries[0]) === customNorm) {
    return () => {};
  }

  const filtered = currentEntries.filter((entry) => normalizeDir(entry) !== customNorm);
  env[pathKey] = [customDir, ...filtered].join(sep);

  return () => {
    const latest = splitEntries();
    const restored = latest.filter((entry) => normalizeDir(entry) !== customNorm);
    env[pathKey] = restored.join(sep);
  };
}
