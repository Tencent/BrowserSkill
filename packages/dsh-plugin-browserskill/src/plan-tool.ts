import { defineTool, type ToolResult, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  appendSavedObservationOptions,
  SAVED_OBSERVATION_PARAMETERS,
} from "./gesture-observation-tools";
import {
  appendTabId,
  type PhaseOneRuntime,
  requireNonEmpty,
  runnerTimeout,
  type ToolRegistrar,
} from "./phase-one-runtime";
import { createStepReceiptHandler } from "./step-receipt";
import { SESSION_PARAM, TAB_ID_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

const MAX_STEPS = 20;
/** Identity and evidence belong to the outer tool call, never to one step. */
const RESERVED = ["session_id", "tab_id", "context_id", "observation_id", "depends_on"];

export const PLAN_PARAMETERS = {
  steps: {
    type: "array",
    items: { type: "object", additionalProperties: true },
    description:
      "plan: 1-20 actions already decided from one sync, in order. A step is action plus that action's protocol fields and optional expect: " +
      '{"action":"fill","ref":"@e3","value":"Ada"}, {"action":"select","ref":"@e4","values":["CN"]}, {"action":"click","ref":"@e5","expect":[...]}. ' +
      "Actions: click, fill, select, press, hover, scroll-to, wheel, drag, and wait-for-element (ref or selector, state, timeout_ms) for a condition later steps need.",
  },
} as const;

function presentPlanResult(_args: never, result: ToolResult) {
  if (result.isError) return undefined;
  const block = result.content.find((item) => item.type === "text");
  if (!block || block.type !== "text") return undefined;
  try {
    const value = JSON.parse(block.text) as { ok?: boolean };
    return { card: "terminal" as const, output: block.text, exitCode: value.ok === true ? 0 : 1 };
  } catch {
    return undefined;
  }
}

/** Several decided actions in one call; each keeps the checks of its own command. */
export function registerPlanTool(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  const receipt = createStepReceiptHandler("plan");
  register(
    defineTool({
      name: "interact.plan",
      description:
        "Run several input actions already decided from one sync, in order, then synchronize. The first step that fails stops the plan; nothing is retried or rolled back. Never repeat a step whose effect_state is unknown.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        ...PLAN_PARAMETERS,
        steps: { ...PLAN_PARAMETERS.steps, required: true },
        untilVisible: {
          type: "string",
          description:
            "CSS selector (main document and accessible iframes) expected to become visible after the last step.",
        },
        waitTimeoutMs: {
          type: "integer",
          description: "Readiness budget for untilVisible, 1..25000 ms; default 5000.",
        },
        ...SAVED_OBSERVATION_PARAMETERS,
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const context = exec as ToolRunContext & {
          observationDependencies?: unknown;
          actionExpectations?: unknown;
        };
        if (
          context.actionExpectations !== undefined ||
          context.observationDependencies !== undefined
        )
          throw new Error(
            "expect and dependsOn do not apply to a whole plan; put expect on the step it protects",
          );
        const steps = args.steps;
        if (steps.length < 1 || steps.length > MAX_STEPS)
          throw new Error(`a plan needs 1 to ${MAX_STEPS} steps`);
        steps.forEach((step, index) => {
          if (typeof step.action !== "string" || step.action.trim() === "")
            throw new Error(`step ${index} needs an action`);
          for (const key of RESERVED)
            if (Object.hasOwn(step, key))
              throw new Error(`step ${index}: ${key} must use the outer tool fields`);
        });
        if (args.untilVisible !== undefined) requireNonEmpty(args.untilVisible, "untilVisible");
        if (
          args.waitTimeoutMs !== undefined &&
          (!Number.isSafeInteger(args.waitTimeoutMs) ||
            args.waitTimeoutMs < 1 ||
            args.waitTimeoutMs > 25_000)
        )
          throw new Error("waitTimeoutMs must be an integer in 1..25000");
        const session = deps.registry.resolve(args.session, "bsk_interact(action=plan)");
        const command = ["plan", "--session", session, "--steps", JSON.stringify(steps)];
        appendTabId(command, args.tabId);
        if (args.untilVisible !== undefined) command.push("--until-visible", args.untilVisible);
        if (args.waitTimeoutMs !== undefined)
          command.push("--wait-timeout-ms", String(args.waitTimeoutMs));
        appendSavedObservationOptions(command, args);
        // The plan's own 120s budget is checked between steps, a step in flight keeps
        // its 35s IPC boundary, then readiness and the closing sync with its recovery.
        const budget =
          120_000 +
          35_000 +
          (args.untilVisible !== undefined ? (args.waitTimeoutMs ?? 5000) + 5000 : 0) +
          5 * 35_000;
        const reply = await runtime.run(
          exec,
          command,
          "plan",
          session,
          runnerTimeout(deps, budget),
          { allowPlanResult: true },
        );
        return receipt.complete(exec, reply) as never;
      },
      finalizeContent: receipt.finalizeContent,
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "plan",
          "--steps",
          `(${args.steps.length} steps)`,
          "--session",
          args.session ?? "(current)",
          ...(args.untilVisible === undefined ? [] : ["--until-visible", args.untilVisible]),
        ]),
        description: "Run decided actions in order, then inspect the synchronized state",
      }),
      presentResult: presentPlanResult,
    }),
  );
}
