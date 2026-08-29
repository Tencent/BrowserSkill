import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  appendTabId,
  appendTarget,
  type PhaseOneRuntime,
  requireNonEmpty,
  requirePositive,
  runnerTimeout,
  type ToolRegistrar,
} from "./phase-one-runtime";
import { SESSION_PARAM, TAB_ID_PARAM, TIMEOUT_MS_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

const MODIFIERS = ["alt", "ctrl", "meta", "shift"] as const;

/** Add hover and select without bypassing session ownership or observation. */
export function registerPhaseOneInteractionTools(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  const { registry } = deps;

  register(
    defineTool({
      name: "interact.hover",
      description:
        "Move the mouse over a snapshot ref or CSS selector to reveal hover-triggered UI. " +
        "Run browser_inspect action=observe or snapshot afterwards to discover newly visible refs.",
      parameters: {
        target: {
          type: "string",
          required: true,
          description: "Snapshot ref (@e3 / e3) or CSS selector of the element to hover.",
        },
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        modifiers: {
          type: "array",
          items: { type: "string", enum: MODIFIERS },
          description: "Keyboard modifiers held during the mouse move.",
        },
        settleMs: {
          type: "integer",
          description: "Milliseconds to wait for hover-triggered UI to settle (default: 200).",
        },
        timeoutMs: TIMEOUT_MS_PARAM,
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            x: { type: "number", required: true },
            y: { type: "number", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[session ${value.session}] hovered at (${value.x}, ${value.y}) on tab ${value.tabId}`,
          },
        ],
      },
      async execute(args, exec) {
        requireNonEmpty(args.target, "target");
        requirePositive(args.timeoutMs, "timeoutMs");
        requirePositive(args.settleMs, "settleMs");
        const sessionId = registry.resolve(args.session, "browser_interact(action=hover)");
        const cmdArgs = ["hover", "--session", sessionId];
        appendTabId(cmdArgs, args.tabId);
        if (args.modifiers !== undefined && args.modifiers.length > 0) {
          cmdArgs.push("--modifiers", args.modifiers.join(","));
        }
        if (args.settleMs !== undefined) cmdArgs.push("--settle", `${args.settleMs}ms`);
        if (args.timeoutMs !== undefined) cmdArgs.push("--timeout", `${args.timeoutMs}ms`);
        appendTarget(cmdArgs, args.target);
        const reply = (await runtime.run(
          exec,
          cmdArgs,
          "hover",
          sessionId,
          runnerTimeout(deps, args.timeoutMs),
        )) as { tab_id: number; x: number; y: number };
        return { session: sessionId, tabId: reply.tab_id, x: reply.x, y: reply.y };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "hover",
          args.target,
          "--session",
          args.session ?? "(current)",
        ]),
        description: "Hover an element",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "interact.select",
      description:
        "Set a select element's option values. Pass one value for a normal select or multiple " +
        "values for a multi-select; values replace the current selection.",
      parameters: {
        target: {
          type: "string",
          required: true,
          description: "Snapshot ref (@e3 / e3) or CSS selector of the select element.",
        },
        values: {
          type: "array",
          required: true,
          items: { type: "string" },
          description: "Option value attributes to select; at least one value is required.",
        },
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        timeoutMs: TIMEOUT_MS_PARAM,
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            multiple: { type: "boolean", required: true },
            selectedValues: {
              type: "array",
              required: true,
              items: { type: "string" },
            },
            selectedLabels: {
              type: "array",
              required: true,
              items: { type: "string" },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `[session ${value.session}] selected ` +
              `${value.selectedValues.join(", ") || "(none)"} on tab ${value.tabId}`,
          },
        ],
      },
      async execute(args, exec) {
        requireNonEmpty(args.target, "target");
        requirePositive(args.timeoutMs, "timeoutMs");
        if (args.values.length === 0) throw new Error("values must contain at least one option");
        const sessionId = registry.resolve(args.session, "browser_interact(action=select)");
        const cmdArgs = ["select", "--session", sessionId];
        appendTabId(cmdArgs, args.tabId);
        for (const value of args.values) cmdArgs.push("--value", value);
        if (args.timeoutMs !== undefined) cmdArgs.push("--timeout", `${args.timeoutMs}ms`);
        appendTarget(cmdArgs, args.target);
        const reply = (await runtime.run(
          exec,
          cmdArgs,
          "select",
          sessionId,
          runnerTimeout(deps, args.timeoutMs),
        )) as {
          tab_id: number;
          multiple: boolean;
          selected_values: string[];
          selected_labels: string[];
        };
        return {
          session: sessionId,
          tabId: reply.tab_id,
          multiple: reply.multiple,
          selectedValues: reply.selected_values,
          selectedLabels: reply.selected_labels,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "select",
          args.target,
          "--session",
          args.session ?? "(current)",
        ]),
        description: `Select ${args.values.length} option${args.values.length === 1 ? "" : "s"}`,
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );
}
