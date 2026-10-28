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
    let forceKillTimeout;
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout = appendCaptured(stdout, chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = appendCaptured(stderr, chunk);
    });

    function terminate(signal) {
      if (!useProcessGroup || !child.pid) {
        child.kill(signal);
        return;
      }
      try {
        // Descendants may keep the pipes open even after the launcher exits.
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") child.kill(signal);
      }
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      forceKillTimeout = setTimeout(() => terminate("SIGKILL"), 2_000);
      forceKillTimeout.unref();
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
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
