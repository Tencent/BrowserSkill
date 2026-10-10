import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { type PhaseOneRuntime, runnerTimeout, type ToolRegistrar } from "./phase-one-runtime";
import { BskError } from "./runner";
import { SESSION_PARAM, TAB_ID_PARAM, TIMEOUT_MS_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

export const BATCH_PARAMETERS = {
  observationId: {
    type: "string",
    description:
      "Exact observationId from the latest observe/snapshot. If absent, use single actions.",
  },
  requestId: {
    type: "string",
    description:
      "Batch receipt id; required for batch-status. Reusing a batch id never replays it.",
  },
  steps: {
    type: "array",
    description:
      "1..20 known actions on current observed DOM refs. Stop the plan where a new observation or decision is needed.",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          required: true,
          enum: ["fill", "select", "click", "press", "focus", "blur", "hover", "scroll-to"],
        },
        target: { type: "string", required: true, description: "An observed DOM ref such as @e3." },
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

type ToolValue = Parameters<ToolDefinition["output"]["render"]>[1];

/** Runtime replies have already crossed the JSON CLI boundary. */
function toolValue(value: unknown): ToolValue {
  return JSON.parse(JSON.stringify(value)) as ToolValue;
}

const RECOVERY =
  "Inspect the receipt and current page, then continue with existing single actions. Never replay completed or uncertain steps. Batch failure does not disable the session. If the user cancelled, stop until they resume the task.";

export function registerBatchTools(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  register(
    defineTool({
      name: "interact.batch",
      description:
        "Execute known interactions sequentially on one observed page; stop at the first failure and return partial results plus a final observation. Existing single actions remain available.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        timeoutMs: TIMEOUT_MS_PARAM,
        ...BATCH_PARAMETERS,
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const session = deps.registry.resolve(args.session, "browser_interact(action=batch)");
        const requestId = args.requestId ?? randomUUID();
        if (!args.observationId || !args.steps?.length || args.steps.length > 20) {
          return {
            status: "not_started",
            request_id: requestId,
            recovery:
              "Supply observationId and 1..20 known steps, or use existing single actions. No actions were dispatched.",
          };
        }
        // Keep task inputs out of process arguments and delete the private plan on every exit path.
        const directory = await mkdtemp(join(tmpdir(), "bsk-batch-"));
        try {
          const path = join(directory, "plan.json");
          const steps = args.steps.map((step) => {
            const { noClear, clickCount, holdMs, ...rest } = step;
            return {
              ...rest,
              action: step.action === "scroll-to" ? "scroll_to" : step.action,
              ...(noClear !== undefined ? { clear_before: !noClear } : {}),
              ...(clickCount !== undefined ? { click_count: clickCount } : {}),
              ...(holdMs !== undefined ? { hold_ms: holdMs } : {}),
            };
          });
          await writeFile(path, JSON.stringify({ observation_id: args.observationId, steps }), {
            mode: 0o600,
          });
          const timeout = args.timeoutMs ?? 30_000;
          const command = [
            "batch",
            "--file",
            path,
            "--session",
            session,
            "--request-id",
            requestId,
            "--timeout",
            `${timeout}ms`,
          ];
          if (args.tabId !== undefined) command.push("--tab-id", String(args.tabId));
          return toolValue(
            await runtime.run(exec, command, "batch", session, runnerTimeout(deps, timeout)),
          );
        } catch (error) {
          const data = error instanceof BskError ? error.data : undefined;
          if (typeof data === "object" && data !== null && "batch" in data) {
            return toolValue({ ...(data.batch as Record<string, unknown>), recovery: RECOVERY });
          }
          return {
            status: "unconfirmed",
            request_id: requestId,
            error: error instanceof Error ? error.message : String(error),
            ...(data === undefined ? {} : { details: toolValue(data) }),
            recovery: `If dispatch was rejected before execution, use single actions. Otherwise query browser_interact(action=batch-status, requestId=${requestId}) and inspect the page first. ${RECOVERY}`,
          };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      presentCall: (args) => ({
        card: "terminal",
        title: `Run ${args.steps?.length ?? 0} known browser actions`,
        description: "Sequential execution with partial results",
      }),
    }),
  );

  register(
    defineTool({
      name: "interact.batch-status",
      description:
        "Read a batch receipt, including while it runs. This never dispatches page input or resumes the batch.",
      parameters: {
        session: SESSION_PARAM,
        requestId: { ...BATCH_PARAMETERS.requestId, required: true },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const session = deps.registry.resolve(
          args.session,
          "browser_interact(action=batch-status)",
        );
        deps.registry.assertUsable(session, "batch-status");
        // Status must remain accessible while the foreground batch owns the queue.
        return toolValue(
          await runtime.run(
            exec,
            ["batch-status", "--session", session, "--request-id", args.requestId],
            "batch-status",
          ),
        );
      },
      presentCall: () => ({ card: "terminal", title: "Read browser batch progress" }),
    }),
  );
}
