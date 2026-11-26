import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureManagedDaemon } from "../src/daemon.mjs";
import * as BrowserSkillPlugin from "../src/index.mjs";

const isWin = process.platform === "win32";
const exeName = isWin ? "bsk.exe" : "bsk";

/**
 * Fake `bsk` used by these tests. It answers `status --json` only after a
 * marker exists and simulates `daemon start --foreground` by writing its argv,
 * pid, and inherited env, then staying alive until it is killed.
 *
 * On Windows the only real PE executable available without a compiler is
 * `node.exe`, so the fake binary is a copy of it and Node resolves the
 * `status` / `daemon` arguments as CJS main scripts relative to the child's
 * working directory (the state directory). POSIX gets one shell script.
 */
const STATUS_JS = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  // Record the probe environment so tests can prove BSK_AUTO_START=0 was set.
  'fs.appendFileSync(path.join(__dirname, "probe.log"), "probe BSK_AUTO_START=" + process.env.BSK_AUTO_START + " BSK_BROWSER_WAIT_MS=" + process.env.BSK_BROWSER_WAIT_MS + "\\n");',
  'if (!fs.existsSync(path.join(__dirname, "daemon.ready"))) {',
  "  process.exit(1);",
  "}",
  'process.stdout.write(JSON.stringify({ pid: 4242, daemon_version: "0.0.0-fake" }));',
].join("\n");

const DAEMON_JS = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const state = __dirname;",
  'fs.writeFileSync(path.join(state, "daemon.argv"), ["daemon", ...process.argv.slice(2)].join("\\n"));',
  'fs.writeFileSync(path.join(state, "daemon.pid"), String(process.pid));',
  'fs.writeFileSync(path.join(state, "daemon.env"), "BSK_AUTO_START=" + process.env.BSK_AUTO_START + "\\nBSK_TEST_READY_DELAY_MS=" + (process.env.BSK_TEST_READY_DELAY_MS || ""));',
  'const readyDelayMs = Number(process.env.BSK_TEST_READY_DELAY_MS || "0");',
  'setTimeout(() => fs.writeFileSync(path.join(state, "daemon.ready"), "ready"), Number.isFinite(readyDelayMs) ? readyDelayMs : 0);',
  "setInterval(() => {}, 1000);",
].join("\n");

const POSIX_SCRIPT = `#!/bin/sh
state=$(cd "$(dirname "$0")" && pwd)
case "$1" in
  status)
    printf 'probe BSK_AUTO_START=%s BSK_BROWSER_WAIT_MS=%s\\n' "$BSK_AUTO_START" "$BSK_BROWSER_WAIT_MS" >> "$state/probe.log"
    if [ -f "$state/daemon.ready" ]; then
      printf '{"pid":4242,"daemon_version":"0.0.0-fake"}'
      exit 0
    fi
    exit 1
    ;;
  daemon)
    printf '%s\\n' "$@" > "$state/daemon.argv"
    echo "$$" > "$state/daemon.pid"
    printf 'BSK_AUTO_START=%s\\nBSK_TEST_READY_DELAY_MS=%s\\n' "$BSK_AUTO_START" "\${BSK_TEST_READY_DELAY_MS:-}" > "$state/daemon.env"
    if [ -n "\${BSK_TEST_READY_DELAY_MS:-}" ] && [ "$BSK_TEST_READY_DELAY_MS" -gt 0 ] 2>/dev/null; then
      sleep 0.3
    fi
    : > "$state/daemon.ready"
    while :; do sleep 1; done
    ;;
esac
exit 1
`;

function writeFakeBsk(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, exeName);
  if (isWin) {
    writeFileSync(join(dir, "status.js"), STATUS_JS);
    writeFileSync(join(dir, "daemon.js"), DAEMON_JS);
    copyFileSync(process.execPath, target);
  } else {
    writeFileSync(target, POSIX_SCRIPT, { mode: 0o755 });
    chmodSync(target, 0o755);
  }
  return target;
}

const STATE_FILES = ["daemon.ready", "daemon.argv", "daemon.pid", "daemon.env", "probe.log"];

function clearFakeState(dir: string): void {
  for (const name of STATE_FILES) {
    rmSync(join(dir, name), { force: true });
  }
}

function readFakeFile(dir: string, name: string): string | null {
  const file = join(dir, name);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function daemonArgv(dir: string): string[] {
  const raw = readFakeFile(dir, "daemon.argv");
  return raw === null ? [] : raw.split(/\r?\n/).filter(Boolean);
}

function daemonEnv(dir: string): string {
  return readFakeFile(dir, "daemon.env") ?? "";
}

function probeLog(dir: string): string {
  return readFakeFile(dir, "probe.log") ?? "";
}

function probeCount(dir: string): number {
  return probeLog(dir).split(/\r?\n/).filter(Boolean).length;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<void> {
  await waitFor(() => !isAlive(pid), timeoutMs);
}

describe("foreground bsk daemon supervision", () => {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    BSK_INSTALL_DIR: process.env.BSK_INSTALL_DIR,
    BSK_TEST_READY_DELAY_MS: process.env.BSK_TEST_READY_DELAY_MS,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    PATH: process.env[pathKey],
  };
  const savedCwd = process.cwd();
  const tempDirs: string[] = [];
  const externalPids: number[] = [];
  let fakeDir = "";
  let fakeExe = "";

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeAll(() => {
    fakeDir = makeTempDir("bsk-dsh-daemon-");
    fakeExe = writeFakeBsk(fakeDir);
  });

  beforeEach(() => {
    clearFakeState(fakeDir);
    // The Windows fake relies on Node resolving `status` / `daemon` as main
    // scripts relative to the child's working directory.
    if (isWin) process.chdir(fakeDir);
    const home = makeTempDir("bsk-dsh-daemon-home-");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.BSK_INSTALL_DIR = join(home, ".local", "bin");
    process.env.BSK_TEST_READY_DELAY_MS = "0";
    // The Windows fake is node.exe under another name; inherited preloads
    // would run before its `status` / `daemon` main script.
    delete process.env.NODE_OPTIONS;
  });

  afterEach(() => {
    for (const pid of externalPids.splice(0)) {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    }
    process.chdir(savedCwd);
    for (const key of [
      "HOME",
      "USERPROFILE",
      "BSK_INSTALL_DIR",
      "BSK_TEST_READY_DELAY_MS",
      "NODE_OPTIONS",
    ] as const) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (savedEnv.PATH === undefined) delete process.env[pathKey];
    else process.env[pathKey] = savedEnv.PATH;
  });

  afterAll(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("reuses a daemon that already answers and owns nothing", async () => {
    writeFileSync(join(fakeDir, "daemon.ready"), "ready");

    const handle = await ensureManagedDaemon({
      executable: fakeExe,
      readyDeadlineMs: 2_000,
      pollIntervalMs: 50,
    });

    try {
      expect(handle.owned).toBe(false);
      expect(handle.child).toBeNull();
      expect(probeCount(fakeDir)).toBe(1);
      // The readiness probe must never let bsk start a daemon on its own.
      expect(probeLog(fakeDir)).toContain("BSK_AUTO_START=0");
    } finally {
      handle.dispose();
    }
    // Disposal of an external daemon starts and stops nothing.
    expect(daemonArgv(fakeDir)).toEqual([]);
  });

  it("starts a foreground daemon when no daemon answers, polls readiness, and owns the child", async () => {
    // Delay readiness so at least one poll runs before the daemon answers.
    process.env.BSK_TEST_READY_DELAY_MS = "300";

    const handle = await ensureManagedDaemon({
      executable: fakeExe,
      readyDeadlineMs: 5_000,
      pollIntervalMs: 50,
      probeTimeoutMs: 2_000,
    });
    const pid = handle.child?.pid;

    try {
      expect(handle.owned).toBe(true);
      expect(handle.child).not.toBeNull();
      expect(pid).toBeTypeOf("number");
      expect(daemonArgv(fakeDir)).toEqual(
        expect.arrayContaining(["daemon", "start", "--foreground", "--daemon-idle", "24h"]),
      );
      // No daemon answered at first, so the plugin polled before it was ready.
      expect(probeCount(fakeDir)).toBeGreaterThanOrEqual(2);
      expect(existsSync(join(fakeDir, "daemon.ready"))).toBe(true);
      // The daemon inherits the host environment plus BSK_AUTO_START=0.
      expect(daemonEnv(fakeDir)).toContain("BSK_AUTO_START=0");
      expect(daemonEnv(fakeDir)).toContain("BSK_TEST_READY_DELAY_MS=300");
    } finally {
      handle.dispose();
    }
    await waitUntilDead(pid!);
  });

  it("does not start a daemon when manageDaemon is disabled", async () => {
    const root = new Context();
    const pluginFiber = root.plugin(BrowserSkillPlugin, {
      bskPath: fakeExe,
      manageDaemon: false,
    });
    await pluginFiber;

    try {
      await delay(400);
      expect(probeCount(fakeDir)).toBe(0);
      expect(daemonArgv(fakeDir)).toEqual([]);
      expect(existsSync(join(fakeDir, "daemon.ready"))).toBe(false);
    } finally {
      await pluginFiber.dispose();
    }
  });

  it.runIf(isWin)("supervises a foreground daemon by default on Windows", async () => {
    process.env.BSK_TEST_READY_DELAY_MS = "100";

    const root = new Context();
    const pluginFiber = root.plugin(BrowserSkillPlugin, { bskPath: fakeExe });
    await pluginFiber;

    let daemonPid: number | undefined;
    try {
      await waitFor(() => existsSync(join(fakeDir, "daemon.pid")));
      expect(daemonArgv(fakeDir)).toContain("--foreground");
      daemonPid = Number((readFakeFile(fakeDir, "daemon.pid") ?? "").trim());
      expect(isAlive(daemonPid)).toBe(true);
    } finally {
      await pluginFiber.dispose();
    }
    // Plugin disposal stops the daemon this plugin owns.
    await waitUntilDead(daemonPid!);
  });

  it("stops only a daemon it started and leaves an external daemon alone", async () => {
    const owned = await ensureManagedDaemon({
      executable: fakeExe,
      readyDeadlineMs: 5_000,
      pollIntervalMs: 50,
    });
    const ownedPid = owned.child?.pid;
    expect(owned.owned).toBe(true);
    expect(ownedPid).toBeTypeOf("number");

    owned.dispose();
    await waitUntilDead(ownedPid!);

    // An external daemon: a process this plugin never spawned, plus a marker
    // that makes the readiness probe answer.
    clearFakeState(fakeDir);
    writeFileSync(join(fakeDir, "daemon.ready"), "ready");
    const external = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    external.unref();
    const externalPid = external.pid!;
    externalPids.push(externalPid);

    const reused = await ensureManagedDaemon({
      executable: fakeExe,
      readyDeadlineMs: 2_000,
      pollIntervalMs: 50,
    });
    reused.dispose();

    expect(reused.owned).toBe(false);
    expect(reused.child).toBeNull();
    expect(daemonArgv(fakeDir)).toEqual([]);
    expect(isAlive(externalPid)).toBe(true);
  });

  it("stays inert without throwing when the bsk executable is missing", async () => {
    const missing = join(fakeDir, "missing", exeName);
    const root = new Context();
    const pluginFiber = root.plugin(BrowserSkillPlugin, { bskPath: missing, manageDaemon: true });

    // Plugin startup must not reject when bsk cannot be resolved.
    await pluginFiber;
    try {
      await delay(200);
      expect(probeCount(fakeDir)).toBe(0);
      expect(daemonArgv(fakeDir)).toEqual([]);
    } finally {
      await pluginFiber.dispose();
    }

    const handle = await ensureManagedDaemon({ executable: null, readyDeadlineMs: 500 });
    try {
      expect(handle.owned).toBe(false);
      expect(handle.child).toBeNull();
    } finally {
      handle.dispose();
    }
  });
});
