import { Context } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { registerBrowserTools } from "../../src/browser-tools";
import { ObservationService } from "../../src/observation";
import { KeyedExecutor } from "../../src/queue";
import type { BskRunner, BskRunResult } from "../../src/runner";
import { SessionRegistry } from "../../src/sessions";

export const STEP_SUCCESS = {
  ok: true,
  phase: "observed",
  action: { result: { tab_id: 7, used_ref: "e1" } },
  readiness: { requested: false },
  post: { tab_id: 7, context_id: "ctx-after", kind: "baseline" },
  action_replayed: false,
  rpc_calls: 2,
  timing_ms: { action: 1, readiness: 0, sync: 1, total: 2 },
};

export const STEP_PARTIAL = {
  ...STEP_SUCCESS,
  ok: false,
  phase: "needs_attention",
  readiness: { tab_id: 7, satisfied: false },
  rpc_calls: 3,
};

export const STEP_CANCELLED = {
  ...STEP_PARTIAL,
  phase: "cancelled",
  cancelled: true,
};

export function stepReply(
  receipt: unknown,
  code: number,
  overrides: Partial<BskRunResult> = {},
): BskRunResult {
  return {
    code,
    stdout: JSON.stringify(receipt),
    stderr: "",
    timedOut: false,
    aborted: false,
    ...overrides,
  };
}

/** Actual SDK runtime, public BrowserSkill dispatch and parsing; only CLI I/O is a fixture. */
export async function createStepRuntime(run: BskRunner["run"], mode: "native" | "ptc" = "native") {
  const root = new Context();
  root.provide("systemPrompt", {
    tools: () => () => {},
    section: () => () => {},
    getSectionOrder: () => 0,
  });
  const runtime = root.plugin(ToolRuntime, { mode });
  await runtime;
  const runner: BskRunner = { run, killAll() {}, killFor: () => 0 };
  const registry = new SessionRegistry(5);
  for (const sessionId of ["s1", "s2"]) registry.completeStart({ sessionId, startedAtMs: 0 });
  const queue = new KeyedExecutor();
  const observation = new ObservationService({
    ctx: root,
    runner,
    registry,
    queue,
    options: { enabled: false, thumbnailIntervalMs: 1500, idleIntervalMs: 8000 },
  });
  const unregister = registerBrowserTools({
    ctx: root,
    runner,
    registry,
    queue,
    observation,
    config: {
      bskPath: "bsk",
      defaultTimeoutMs: 120_000,
      maxSessions: 5,
      observationEnabled: false,
      thumbnailIntervalMs: 1500,
      idleIntervalMs: 8000,
      lazyTools: false,
    },
  });
  let sequence = 0;
  return {
    root,
    execute(
      controller = new AbortController(),
      args: Record<string, unknown> = {},
      callId = `step-${++sequence}`,
    ) {
      return root.tools.execute({
        callId: ToolCallId(callId),
        name: "bsk_interact",
        arguments: {
          action: "step",
          stepAction: "click",
          params: '{"ref":"e1"}',
          session: "s1",
          ...args,
        },
        signal: controller.signal,
      });
    },
    async dispose() {
      unregister();
      await runtime.dispose();
    },
  };
}
