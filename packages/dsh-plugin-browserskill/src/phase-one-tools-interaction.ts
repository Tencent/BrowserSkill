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

/** Add interaction primitives without bypassing session ownership or observation. */
export function registerPhaseOneInteractionTools(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  const { registry } = deps;

  register(
    defineTool({
      name: "interact.wheel",
      description:
        "Send native wheel input at the viewport centre or an optional target. " +
        "A target is scrolled into view first. Deltas are input CSS pixels, not measured scroll " +
        "distance; observe afterwards to check the page's response.",
      parameters: {
        target: {
          type: "string",
          description: "Optional snapshot ref or main-document CSS selector.",
        },
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        deltaX: { type: "number", description: "Horizontal input in CSS pixels; defaults to 0." },
        deltaY: { type: "number", description: "Vertical input in CSS pixels; defaults to 0." },
        modifiers: { type: "array", items: { type: "string", enum: MODIFIERS } },
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
            deltaX: { type: "number", required: true },
            deltaY: { type: "number", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[session ${value.session}] wheel input (${value.deltaX}, ${value.deltaY}) sent at (${value.x}, ${value.y}) on tab ${value.tabId}`,
          },
        ],
      },
      async execute(args, exec) {
        if (args.target !== undefined) requireNonEmpty(args.target, "target");
        requirePositive(args.timeoutMs, "timeoutMs");
        const deltaX = args.deltaX ?? 0;
        const deltaY = args.deltaY ?? 0;
        if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY))
          throw new Error("wheel deltas must be finite numbers");
        if (deltaX === 0 && deltaY === 0)
          throw new Error("at least one wheel delta must be non-zero");
        const sessionId = registry.resolve(args.session, "browser_interact(action=wheel)");
        const cmdArgs = [
          "wheel",
          "--session",
          sessionId,
          "--delta-x",
          String(deltaX),
          "--delta-y",
          String(deltaY),
        ];
        appendTabId(cmdArgs, args.tabId);
        if (args.modifiers?.length) cmdArgs.push("--modifiers", args.modifiers.join(","));
        if (args.timeoutMs !== undefined) cmdArgs.push("--timeout", `${args.timeoutMs}ms`);
        if (args.target !== undefined) appendTarget(cmdArgs, args.target);
        const reply = (await runtime.run(
          exec,
          cmdArgs,
          "wheel",
          sessionId,
          runnerTimeout(deps, args.timeoutMs),
        )) as {
          tab_id: number;
          x: number;
          y: number;
          delta_x: number;
          delta_y: number;
        };
        return {
          session: sessionId,
          tabId: reply.tab_id,
          x: reply.x,
          y: reply.y,
          deltaX: reply.delta_x,
          deltaY: reply.delta_y,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "wheel",
          "--delta-x",
          String(args.deltaX ?? 0),
          "--delta-y",
          String(args.deltaY ?? 0),
          ...(args.target === undefined ? [] : [args.target]),
        ]),
        description: "Send native wheel input",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

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
      name: "interact.scroll-to",
      description:
        "Scroll an element and its frame owners into view. Returns the visible portion's " +
        "bounds in top-level viewport CSS pixels; fails if no visible area remains. " +
        "Use a fresh ref for iframe targets; selectors search the main document.",
      parameters: {
        target: {
          type: "string",
          required: true,
          description: "Element ref (@e3 / e3) or main-document CSS selector to scroll into view.",
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
            x: { type: "number", required: true },
            y: { type: "number", required: true },
            width: { type: "number", required: true },
            height: { type: "number", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `[session ${value.session}] scrolled into view on tab ${value.tabId}: ` +
              `(${value.x}, ${value.y}, ${value.width}, ${value.height})`,
          },
        ],
      },
      async execute(args, exec) {
        requireNonEmpty(args.target, "target");
        requirePositive(args.timeoutMs, "timeoutMs");
        const sessionId = registry.resolve(args.session, "browser_interact(action=scroll-to)");
        const cmdArgs = ["scroll-to", "--session", sessionId];
        appendTabId(cmdArgs, args.tabId);
        if (args.timeoutMs !== undefined) cmdArgs.push("--timeout", `${args.timeoutMs}ms`);
        appendTarget(cmdArgs, args.target);
        const reply = (await runtime.run(
          exec,
          cmdArgs,
          "scroll-to",
          sessionId,
          runnerTimeout(deps, args.timeoutMs),
        )) as {
          tab_id: number;
          x: number;
          y: number;
          width: number;
          height: number;
        };
        return {
          session: sessionId,
          tabId: reply.tab_id,
          x: reply.x,
          y: reply.y,
          width: reply.width,
          height: reply.height,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "scroll-to",
          args.target,
          "--session",
          args.session ?? "(current)",
        ]),
        description: "Scroll an element into view",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  for (const action of ["focus", "blur"] as const) {
    register(
      defineTool({
        name: `interact.${action}`,
        description:
          action === "focus"
            ? "Focus an element and verify its DOM focus state."
            : "Remove focus from an element and report whether it was focused.",
        parameters: {
          target: {
            type: "string",
            required: true,
            description: "Snapshot ref (@e3 / e3) or CSS selector of the element.",
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
              focused: { type: "boolean", required: true },
              wasFocused: {
                type: "boolean",
                description: "Whether the target was focused before blur.",
              },
            },
          },
          render: (_args, value) => [
            {
              type: "text",
              text:
                `[session ${value.session}] ${action} on tab ${value.tabId}: focused=${value.focused}` +
                (value.wasFocused === undefined ? "" : `, wasFocused=${value.wasFocused}`),
            },
          ],
        },
        async execute(args, exec) {
          requireNonEmpty(args.target, "target");
          requirePositive(args.timeoutMs, "timeoutMs");
          const sessionId = registry.resolve(args.session, `browser_interact(action=${action})`);
          const cmdArgs = [action, "--session", sessionId];
          appendTabId(cmdArgs, args.tabId);
          if (args.timeoutMs !== undefined) cmdArgs.push("--timeout", `${args.timeoutMs}ms`);
          appendTarget(cmdArgs, args.target);
          const reply = (await runtime.run(
            exec,
            cmdArgs,
            action,
            sessionId,
            runnerTimeout(deps, args.timeoutMs),
          )) as {
            tab_id: number;
            focused: boolean;
            was_focused?: boolean;
          };
          return {
            session: sessionId,
            tabId: reply.tab_id,
            focused: reply.focused,
            ...(action === "blur" ? { wasFocused: reply.was_focused } : {}),
          };
        },
        presentCall: (args) => ({
          card: "terminal",
          title: runtime.commandLine([
            action,
            args.target,
            "--session",
            args.session ?? "(current)",
          ]),
          description: action === "focus" ? "Focus an element" : "Remove focus from an element",
        }),
        presentResult: runtime.presentTerminalResult,
      }),
    );
  }

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
