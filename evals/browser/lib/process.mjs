import { spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

function appendCaptured(current, chunk) {
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  return `${current}${chunk}`.slice(0, MAX_CAPTURE_BYTES);
}

export function runProcess(command, args, { cwd, env, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      stdout = appendCaptured(stdout, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendCaptured(stderr, chunk.toString());
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        command,
        args,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...result,
      });
    };

    child.once("error", (error) => finish({ exitCode: null, signal: null, error: error.message }));
    child.once("close", (exitCode, signal) => finish({ exitCode, signal }));
  });
}

export function substituteArgs(args, values) {
  return args.map((argument) => {
    let result = argument;
    for (const [key, value] of Object.entries(values)) {
      result = result.replaceAll(`{${key}}`, String(value));
    }
    return result;
  });
}

export function countPattern(text, pattern) {
  if (!pattern) return null;
  const matches = text.match(new RegExp(pattern, "g"));
  return matches?.length ?? 0;
}
