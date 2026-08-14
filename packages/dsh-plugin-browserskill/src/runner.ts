/**
 * Process runner for the `bsk` CLI. Every model-facing tool in this plugin
 * maps to one `bsk <cmd> --json` invocation: spawn the child, capture
 * stdout/stderr, honor the dsh cancellation signal by killing the child, and
 * map the CLI's JSON error envelope onto a thrown `BskError`.
 */

import { type ChildProcess, spawn } from "node:child_process";

/** Shape of the JSON error envelope `bsk --json` prints on failure. */
export interface BskErrorBody {
  code?: string;
  message?: string;
  hint?: string;
  exit_code?: number;
  data?: unknown;
}

/** A failed `bsk` invocation (non-zero exit, timeout, or spawn failure). */
export class BskError extends Error {
  readonly code?: string;
  readonly hint?: string;
  readonly exitCode?: number | null;
  readonly timedOut: boolean;

  constructor(
    message: string,
    options: { code?: string; hint?: string; exitCode?: number | null; timedOut?: boolean } = {},
  ) {
    super(message);
    this.name = "BskError";
    this.code = options.code;
    this.hint = options.hint;
    this.exitCode = options.exitCode;
    this.timedOut = options.timedOut ?? false;
  }
}

export interface BskRunResult {
  /** Process exit code, or null when killed by a signal / never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface BskRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Opaque routing tag (e.g. a session id) enabling per-tag kills. */
  tag?: string;
}

/** Minimal spawn signature so tests can substitute a fake child process. */
export type SpawnImpl = (command: string, args: string[]) => ChildProcess;

export interface BskRunner {
  /** Run `bsk <args...> --json` and collect its output. */
  run(args: string[], options?: BskRunOptions): Promise<BskRunResult>;
  /** Kill every in-flight child (used when the plugin unloads). */
  killAll(): void;
  /** Kill only the in-flight children carrying this tag; returns how many were killed. */
  killFor(tag: string): number;
}

const KILL_GRACE_MS = 2000;

export function createBskRunner(bskPath: string, spawnImpl: SpawnImpl = spawn): BskRunner {
  const live = new Map<ChildProcess, string | undefined>();

  function killChild(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    force.unref();
  }

  return {
    run(args, options = {}) {
      return new Promise<BskRunResult>((resolve, reject) => {
        let child: ChildProcess;
        try {
          child = spawnImpl(bskPath, [...args, "--json"]);
        } catch (error) {
          reject(error);
          return;
        }
        live.set(child, options.tag);

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let aborted = false;
        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += chunk;
        });

        const timeoutMs = options.timeoutMs;
        const timer =
          timeoutMs !== undefined && timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                killChild(child);
              }, timeoutMs)
            : undefined;
        timer?.unref();

        const onAbort = () => {
          aborted = true;
          killChild(child);
        };
        if (options.signal?.aborted) {
          onAbort();
        } else {
          options.signal?.addEventListener("abort", onAbort, { once: true });
        }

        const settle = () => {
          if (timer !== undefined) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          live.delete(child);
        };

        child.on("error", (error) => {
          settle();
          reject(error);
        });
        child.on("close", (code) => {
          settle();
          resolve({ code, stdout, stderr, timedOut, aborted });
        });
      });
    },
    killAll() {
      for (const child of live.keys()) killChild(child);
    },
    killFor(tag: string) {
      let killed = 0;
      for (const [child, childTag] of live) {
        if (childTag === tag) {
          killChild(child);
          killed += 1;
        }
      }
      return killed;
    },
  };
}

/** True when the spawn failure means the bsk binary itself is missing. */
export function isCommandNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Install guidance shown when the bsk CLI cannot be spawned. */
export function bskInstallMessage(bskPath: string): string {
  return (
    `the bsk CLI ("${bskPath}") was not found. BrowserSkill must be installed and on PATH ` +
    "for browser tools to work — install it from https://github.com/Tencent/BrowserSkill " +
    "(see the README install script or `cargo install`), then retry."
  );
}

/**
 * Interpret one finished run: throw `BskError` on timeout / non-zero exit
 * (parsing the CLI's JSON error envelope when present), otherwise parse and
 * return the stdout JSON payload.
 */
export function parseBskJson(result: BskRunResult, commandLabel: string): unknown {
  if (result.timedOut) {
    throw new BskError(`bsk ${commandLabel} timed out`, { timedOut: true });
  }
  const body = result.stdout.trim();
  // Killed by our own interrupt (SIGTERM from killFor), not by the abort path:
  // say so instead of doubling the generic label into the message.
  if (result.code === null && !result.aborted && !result.timedOut) {
    throw new BskError(`bsk ${commandLabel} was interrupted (process killed)`);
  }
  if (result.code !== 0) {
    let parsed: BskErrorBody | undefined;
    try {
      parsed = JSON.parse(body) as BskErrorBody;
    } catch {
      parsed = undefined;
    }
    const message =
      parsed?.message ?? (result.stderr.trim() || body || `bsk ${commandLabel} failed`);
    // Surface the envelope's actionable hint in the model-facing message; a
    // hint the model cannot see cannot be followed.
    const withHint = parsed?.hint !== undefined ? `${message} (hint: ${parsed.hint})` : message;
    throw new BskError(`bsk ${commandLabel} failed: ${withHint}`, {
      code: parsed?.code,
      hint: parsed?.hint,
      exitCode: result.code,
    });
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new BskError(
      `bsk ${commandLabel} did not produce JSON output: ${body.slice(0, 200) || "(empty)"}`,
      { exitCode: result.code },
    );
  }
}
