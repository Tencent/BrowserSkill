import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, vi } from "vitest";
import { registerBrowserTools } from "../src/browser-tools";
import { ObservationService } from "../src/observation";
import { KeyedExecutor } from "../src/queue";
import type { BskRunOptions, BskRunResult } from "../src/runner";
import { SessionStarts } from "../src/session-starts";
import { SessionRegistry } from "../src/sessions";
import { memoryStartJournal, type StartJournal } from "../src/start-journal";
import type { ToolDeps } from "../src/tools";

export const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.useRealTimers();
  }
});
export const ok = (body: unknown): BskRunResult => ({
  code: 0,
  stdout: JSON.stringify(body),
  stderr: "",
  aborted: false,
  timedOut: false,
});
export const failed = (message: string): BskRunResult => ({
  code: 2,
  stdout: JSON.stringify({ code: "protocol_error", message }),
  stderr: "",
  aborted: false,
  timedOut: false,
});
export const exec = (signal = new AbortController().signal) =>
  ({
    callId: "call",
    name: "browser_session",
    signal,
    agent: { id: "conversation" },
  }) as ToolRunContext;

export function harness(
  run: (args: string[], options: BskRunOptions) => Promise<BskRunResult>,
  journal: StartJournal = memoryStartJournal(),
) {
  const calls: Array<{ args: string[]; options: BskRunOptions }> = [];
  const tools = new Map<string, ToolDefinition>();
  const ctx = {
    tools: {
      register: (tool: ToolDefinition) => {
        tools.set(tool.name, tool);
        return () => {};
      },
    },
    get: () => undefined,
  };
  const prepare = vi.fn(async () => ok({ state: "prepared" }));
  const runner = {
    run: async (args: string[], options: BskRunOptions = {}) => {
      calls.push({ args, options });
      if (args.includes("--prepare")) return prepare();
      return run(args, options);
    },
    killAll: vi.fn(),
    killFor: vi.fn((_tag: string) => 0),
  };
  const registry = new SessionRegistry(5);
  const queue = new KeyedExecutor();
  const observation = new ObservationService({
    ctx: ctx as never,
    runner,
    registry,
    queue,
    options: { enabled: true, thumbnailIntervalMs: 1500, idleIntervalMs: 8000 },
  });
  const deps: ToolDeps = {
    ctx: ctx as never,
    runner,
    registry,
    queue,
    observation,
    config: {
      bskPath: "bsk",
      defaultTimeoutMs: 120000,
      maxSessions: 5,
      observationEnabled: true,
      thumbnailIntervalMs: 1500,
      idleIntervalMs: 8000,
      lazyTools: false,
    },
  };
  const starts = (deps.starts = new SessionStarts(deps, journal));
  registerBrowserTools(deps);
  const session = (args: Record<string, unknown>, context = exec()) =>
    tools.get("browser_session")!.execute(args, context);
  cleanups.push(async () => {
    await starts.dispose();
    observation.dispose();
  });
  return { starts, registry, journal, calls, session, runner, prepare, tools, observation, queue };
}
