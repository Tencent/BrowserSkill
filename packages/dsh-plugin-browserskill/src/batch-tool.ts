import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { type PhaseOneRuntime, runnerTimeout, type ToolRegistrar } from "./phase-one-runtime";
import { BskError } from "./runner";
import { SESSION_PARAM, TAB_ID_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

const MAX_STEPS = 20;
const MAX_BYTES = 65_536;
const MAX_TIMEOUT_MS = 120_000;
const ACTIONS = [
  "fill",
  "select",
  "click",
  "press",
  "focus",
  "blur",
  "hover",
  "scroll-to",
] as const;

export const BATCH_TIMEOUT_PARAM = {
  type: "integer",
  description:
    "Command timeout in ms; for batch, total execution/observation budget (default 30000, max 120000).",
} as const;

export const BATCH_PARAMETERS = {
  steps: {
    type: "array",
    description:
      "Batch only: 1..20 known actions on fresh DOM refs; requires tabId. End at a new decision or page change.",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", required: true, enum: ACTIONS },
        target: { type: "string", required: true, description: "Observed DOM ref, e.g. @e3." },
        value: { type: "string" },
        values: { type: "array", items: { type: "string" } },
        noClear: { type: "boolean" },
        key: { type: "string" },
        button: { type: "string", enum: ["left", "middle", "right"] },
        clickCount: { type: "integer" },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["alt", "ctrl", "meta", "shift"] },
        },
        holdMs: { type: "integer" },
      },
    },
  },
} as const;

type Step = {
  action: (typeof ACTIONS)[number];
  target: string;
  value?: string;
  values?: string[];
  noClear?: boolean;
  key?: string;
  button?: string;
  clickCount?: number;
  modifiers?: string[];
  holdMs?: number;
};
const ACTION_FIELDS: Record<Step["action"], readonly string[]> = {
  fill: ["value", "noClear"],
  select: ["values"],
  click: ["button", "clickCount", "modifiers"],
  press: ["key", "modifiers", "holdMs"],
  focus: [],
  blur: [],
  hover: [],
  "scroll-to": [],
};

/** Structural validation before any input. Existing single-action handlers own page validation. */
function compilePlan(steps: Step[] | undefined): string[][] {
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS)
    throw new Error("batch requires 1..20 steps; existing single actions remain available");
  if (Buffer.byteLength(JSON.stringify(steps), "utf8") > MAX_BYTES)
    throw new Error("batch steps exceed 64 KiB");
  return steps.map((step, index) => {
    const fail = (message: string): never => {
      throw new Error(`batch step ${index + 1}: ${message}`);
    };
    if (!step || !Object.hasOwn(ACTION_FIELDS, step.action)) fail("unsupported action");
    if (typeof step.target !== "string" || !/^@?e\d+$/.test(step.target))
      fail("target must be a fresh DOM ref");
    const allowed = ["action", "target", ...ACTION_FIELDS[step.action]];
    if (Object.keys(step).some((key) => !allowed.includes(key)))
      fail("unexpected action parameter");
    const args: string[] = [step.action, step.target];
    if (step.action === "fill") {
      if (typeof step.value !== "string") fail("fill requires value");
      if (step.noClear !== undefined && typeof step.noClear !== "boolean") fail("invalid noClear");
      args.push("--value", step.value!);
      if (step.noClear) args.push("--no-clear");
    }
    if (step.action === "select") {
      if (
        !Array.isArray(step.values) ||
        !step.values.length ||
        step.values.some((v) => typeof v !== "string")
      )
        fail("select requires option values");
      for (const value of step.values!) args.push("--value", value);
    }
    if (step.action === "press") {
      if (typeof step.key !== "string" || !step.key.trim()) fail("press requires key");
      // press takes key positionally; target is an explicit option.
      args.splice(1, 1, step.key!, "--ref", step.target);
      if (step.holdMs !== undefined) {
        if (!Number.isInteger(step.holdMs) || step.holdMs < 0 || step.holdMs > 5000)
          fail("holdMs must be in 0..5000");
        args.push("--hold-ms", String(step.holdMs));
      }
    }
    if (step.button !== undefined) {
      if (!["left", "middle", "right"].includes(step.button)) fail("invalid button");
      args.push("--button", step.button);
    }
    if (step.clickCount !== undefined) {
      if (!Number.isInteger(step.clickCount) || step.clickCount < 1 || step.clickCount > 3)
        fail("clickCount must be in 1..3");
      args.push("--click-count", String(step.clickCount));
    }
    if (step.modifiers !== undefined) {
      if (
        !Array.isArray(step.modifiers) ||
        step.modifiers.some((v) => !["alt", "ctrl", "meta", "shift"].includes(v))
      )
        fail("invalid modifiers");
      if (step.modifiers.length) args.push("--modifiers", step.modifiers.join(","));
    }
    return args;
  });
}

function errorDetails(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof BskError && error.code ? { code: error.code } : {}),
  };
}

function effectState(error: unknown): "none" | "committed" | "unknown" {
  const data = error instanceof BskError ? error.data : undefined;
  if (
    data &&
    typeof data === "object" &&
    "effect_state" in data &&
    (data.effect_state === "none" || data.effect_state === "committed")
  )
    return data.effect_state;
  return "unknown";
}

interface StepResult {
  index: number;
  action: Step["action"];
  target: string;
  status: "not_run" | "completed" | "failed";
  effect_state: "none" | "committed" | "unknown";
  result?: unknown;
  error?: ReturnType<typeof errorDetails>;
}
interface BatchResult {
  session: string;
  tab_id: number;
  status: "completed" | "stopped";
  steps: StepResult[];
  elapsed_ms?: number;
  error?: ReturnType<typeof errorDetails>;
  observation?: unknown;
  observation_error?: ReturnType<typeof errorDetails>;
  recovery?: string;
}

type ToolValue = Parameters<ToolDefinition["output"]["render"]>[1];
const RECOVERY =
  "Inspect partial results and the page, then continue with single actions. Never replay completed or uncertain steps. After user cancellation, wait for the user to resume.";

export function registerBatchTools(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  register(
    defineTool({
      name: "interact.batch",
      description:
        "Run known interactions through existing single-action commands, stop on failure with partial results; observe after success. No automatic replay or rollback.",
      parameters: {
        session: SESSION_PARAM,
        tabId: { ...TAB_ID_PARAM, required: true },
        timeoutMs: BATCH_TIMEOUT_PARAM,
        ...BATCH_PARAMETERS,
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const commands = compilePlan(args.steps);
        if (!Number.isSafeInteger(args.tabId) || args.tabId <= 0)
          throw new Error("batch requires tabId from the current observation");
        const timeout = args.timeoutMs ?? 30_000;
        if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS)
          throw new Error("batch timeoutMs must be in 1..120000");
        const session = deps.registry.resolve(args.session, "browser_interact(action=batch)");
        const controller = new AbortController();
        const signal = AbortSignal.any([exec.signal, controller.signal]);
        return runtime.sequence({ ...exec, signal }, session, async (run) => {
          const started = Date.now();
          const timer = setTimeout(
            () => controller.abort(new Error("batch total timeout reached")),
            timeout,
          );
          const checkActive = () => {
            if (Date.now() - started >= timeout)
              controller.abort(new Error("batch total timeout reached"));
            signal.throwIfAborted();
          };
          const remaining = () => Math.max(1, timeout - (Date.now() - started));
          const scoped = ["--session", session, "--tab-id", String(args.tabId)];
          const steps = args.steps!.map<StepResult>((step, index) => ({
            index,
            action: step.action,
            target: step.target,
            status: "not_run",
            effect_state: "none",
          }));
          const result: BatchResult = {
            session,
            tab_id: args.tabId,
            status: "completed",
            steps,
          };
          try {
            for (const [index, command] of commands.entries()) {
              checkActive();
              const step = steps[index];
              try {
                step.result = await run(
                  [...command, ...scoped, "--timeout", `${remaining()}ms`],
                  command[0],
                  runnerTimeout(deps, remaining()),
                );
                step.status = "completed";
                step.effect_state = "committed";
              } catch (error) {
                step.status = "failed";
                step.effect_state = effectState(error);
                step.error = errorDetails(error);
                throw error;
              }
            }
          } catch (error) {
            result.status = "stopped";
            result.error = errorDetails(error);
          }
          try {
            // An action failure ends all work, including reads: a UI interrupt may
            // kill the child without aborting the tool context's signal.
            if (result.status === "completed") {
              checkActive();
              result.observation = await run(
                ["observe", ...scoped, "--max-tokens", "2000"],
                "observe",
                runnerTimeout(deps, remaining()),
              );
            }
          } catch (error) {
            result.observation_error = errorDetails(error);
          } finally {
            clearTimeout(timer);
          }
          result.elapsed_ms = Date.now() - started;
          if (result.error || result.observation_error) result.recovery = RECOVERY;
          return JSON.parse(JSON.stringify(result)) as ToolValue;
        });
      },
      presentCall: (args) => ({
        card: "terminal",
        title: `Run ${args.steps?.length ?? 0} known browser actions`,
        description: "Stop on failure; single actions remain available",
      }),
    }),
  );
}
