/**
 * Foreground `bsk` daemon supervision for hosts that cannot detach one.
 *
 * Windows GUI hosts (DSH Desktop / Electron) run the host process inside a Job
 * Object that does not allow breakaway, so `bsk`'s detached auto-start fails
 * with `os error 5` (`cannot start an independent Windows daemon`). The
 * documented remedy is to keep `bsk daemon start --foreground` alive in a
 * persistent host task and to probe readiness with
 * `BSK_AUTO_START=0 bsk status --json`
 * (`docs/sandboxed-agents.md#windows-gui-hosts`).
 *
 * The long-lived Cordis plugin host is that task. This module reuses a daemon
 * that already answers, otherwise owns exactly one foreground child, and stops
 * only a child it started itself.
 */

import { type ChildProcess, spawn } from "node:child_process";

/** Readiness probe budget for one `bsk status --json` child. */
const PROBE_TIMEOUT_MS = 3_000;
/** Upper bound on waiting for a freshly spawned daemon to answer on IPC. */
const READY_DEADLINE_MS = 10_000;
/** Delay between readiness probes. */
const READY_POLL_INTERVAL_MS = 250;
/**
 * The plugin owns this daemon for the host's lifetime, so keep it past the
 * CLI's 10-minute idle exit: a later client would otherwise run into the very
 * breakaway failure this supervision exists to avoid.
 */
const MANAGED_DAEMON_IDLE = "24h";
/** Ignore absurdly large status output rather than buffering it forever. */
const MAX_STATUS_BYTES = 64 * 1024;

/** Handle for the daemon reached through one call to {@link ensureManagedDaemon}. */
export interface DaemonHandle {
  /** `true` only when this plugin started the daemon and therefore must stop it. */
  readonly owned: boolean;
  /** The foreground child owned by this plugin, or `null` when not owned. */
  readonly child: ChildProcess | null;
  /** Stop an owned daemon. Never touches a reused external daemon; safe to call twice. */
  dispose(): void;
}

/** Options for {@link ensureManagedDaemon}. */
export interface EnsureManagedDaemonOptions {
  /** Resolved `bsk` executable, or `null` when the binary is missing. */
  executable: string | null;
  /** Environment inherited by both the probe and the daemon; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** How long to wait for a spawned daemon to answer; defaults to 10s. */
  readyDeadlineMs?: number;
  /** Delay between readiness probes; defaults to 250ms. */
  pollIntervalMs?: number;
  /** Budget for one readiness probe; defaults to 3s. */
  probeTimeoutMs?: number;
  /** Receives skip/failure reasons; defaults to no logging. */
  log?: (message: string) => void;
}

/** A handle that owns nothing: reused (external) daemon, missing binary, or failed start. */
function inertHandle(): DaemonHandle {
  return {
    owned: false,
    child: null,
    dispose() {
      // An external daemon is not ours to stop.
    },
  };
}

function ownedHandle(child: ChildProcess): DaemonHandle {
  let disposed = false;
  return {
    owned: true,
    child,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill();
      } catch {
        // Best effort: a daemon that already exited needs no stop.
      }
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `bsk status --json` is the narrowest proof that the daemon answers on its IPC
 * endpoint, which is exactly what later `bsk` client invocations need. With
 * `BSK_AUTO_START=0` it never falls back to the breakaway-prone auto-start, and
 * `BSK_BROWSER_WAIT_MS=0` skips the 5s "wait for a browser to connect" that
 * `bsk status` otherwise performs when no extension is attached.
 */
function probeDaemon(
  executable: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(ready);
    };

    let child: ChildProcess;
    try {
      child = spawn(executable, ["status", "--json"], {
        env: { ...env, BSK_AUTO_START: "0", BSK_BROWSER_WAIT_MS: "0" },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(false);
      return;
    }

    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_STATUS_BYTES) stdout += chunk;
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0 && isReadyStatus(stdout)));
    timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
  });
}

/** A status snapshot carrying a live daemon pid; a wrapper's noise does not count. */
function isReadyStatus(stdout: string): boolean {
  try {
    const status = JSON.parse(stdout) as { pid?: unknown } | null;
    return typeof status?.pid === "number" && status.pid > 0;
  } catch {
    return false;
  }
}

/**
 * Start one hidden foreground daemon. It inherits this process's environment
 * (so `BSK_HOME`, when set, points at the same discovery directory later
 * clients use) plus `BSK_AUTO_START=0`.
 */
function spawnForegroundDaemon(
  executable: string,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): ChildProcess | null {
  try {
    const child = spawn(
      executable,
      ["daemon", "start", "--foreground", "--daemon-idle", MANAGED_DAEMON_IDLE],
      {
        env: { ...env, BSK_AUTO_START: "0" },
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    // The daemon must outlive tool calls, but must not keep the host's event
    // loop alive on its own; disposal still stops this child.
    child.unref();
    return child;
  } catch (error) {
    log(`browser-skill: could not start the foreground bsk daemon: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Reuse a daemon that already answers, or start and own a foreground daemon.
 *
 * Never throws and never kills an external daemon. When a spawned daemon does
 * not answer within the deadline it is still returned as owned: publication can
 * race the final probe, so an unanswered probe is not cancellation authority.
 * The caller's disposal stops it.
 */
export async function ensureManagedDaemon(
  options: EnsureManagedDaemonOptions,
): Promise<DaemonHandle> {
  const {
    executable,
    env = process.env,
    readyDeadlineMs = READY_DEADLINE_MS,
    pollIntervalMs = READY_POLL_INTERVAL_MS,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
    log = () => {},
  } = options;

  if (executable === null) {
    log("browser-skill: bsk executable not found; foreground daemon supervision skipped");
    return inertHandle();
  }

  if (await probeDaemon(executable, env, probeTimeoutMs)) {
    log("browser-skill: reusing the daemon that already answers bsk status");
    return inertHandle();
  }

  const child = spawnForegroundDaemon(executable, env, log);
  if (child === null) {
    return inertHandle();
  }
  log(`browser-skill: started bsk daemon start --foreground (pid ${child.pid ?? "unknown"})`);

  let spawnError: Error | null = null;
  child.on("error", (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + readyDeadlineMs;
  while (Date.now() < deadline) {
    await delay(pollIntervalMs);
    if (spawnError !== null || child.exitCode !== null || child.signalCode !== null) break;
    const remaining = Math.max(1, deadline - Date.now());
    if (await probeDaemon(executable, env, Math.min(probeTimeoutMs, remaining))) {
      log("browser-skill: foreground bsk daemon is ready");
      return ownedHandle(child);
    }
  }

  if (spawnError !== null || child.exitCode !== null || child.signalCode !== null) {
    const reason = spawnError !== null ? `: ${errorMessage(spawnError)}` : "";
    log(`browser-skill: foreground bsk daemon exited before it became ready${reason}`);
    return inertHandle();
  }

  log(
    `browser-skill: foreground bsk daemon did not answer within ${readyDeadlineMs}ms; ` +
      "leaving it to plugin disposal",
  );
  return ownedHandle(child);
}
