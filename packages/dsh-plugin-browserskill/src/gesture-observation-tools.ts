import { resolve } from "node:path";
import { defineTool, type ToolResult, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  appendTabId,
  type PhaseOneRuntime,
  requireNonEmpty,
  runnerTimeout,
  type ToolRegistrar,
} from "./phase-one-runtime";
import { SESSION_PARAM, TAB_ID_PARAM, TIMEOUT_MS_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

export const SAVED_OBSERVATION_PARAMETERS = {
  saveFull: {
    type: "string",
    description: "New local JSON path for the complete reply; never overwrites an existing file.",
  },
  baseline: {
    type: "string",
    description:
      "Explicit saved predecessor; reuse requires unchanged evidence in the same session and tab.",
  },
  matchText: {
    type: "array",
    items: { type: "string" },
    description:
      "Literal strings whose nearby plain stateless numbered buttons should remain visible. Preserves business text, named/stateful controls and forms/dialogs. For text search use bsk_inspect view with find.",
  },
  contextLines: {
    type: "integer",
    description: "Numbered-control retention window around each match, 0..200; requires matchText.",
  },
} as const;

export const DRAG_PARAMETERS = {
  target: {
    type: "string",
    description: "Drag source: fresh VOM ref or unambiguous CSS selector.",
  },
  to: {
    type: "string",
    description: "Drag destination ref or selector; exclusive with deltaX/deltaY.",
  },
  dragMode: {
    type: "string",
    enum: ["press-move-release", "click-move-click"],
    description:
      "Default held drag, or click/release, move, click/release. Click-move-click requires to and zero holdMs.",
  },
  deltaX: {
    type: "number",
    description: "Relative horizontal drag movement in viewport CSS pixels.",
  },
  deltaY: {
    type: "number",
    description: "Relative vertical drag movement in viewport CSS pixels.",
  },
  fromOffsetX: { type: "number", description: "Source offset X from the visible action point." },
  fromOffsetY: { type: "number", description: "Source offset Y from the visible action point." },
  toOffsetX: { type: "number", description: "Destination offset X; requires to." },
  toOffsetY: { type: "number", description: "Destination offset Y; requires to." },
  durationMs: { type: "integer", description: "Drag movement duration, 1..5000 ms; default 500." },
  holdMs: { type: "integer", description: "Hold before moving, 0..5000 ms; default 0." },
  observationId: {
    type: "string",
    description: "Optional observation_id from the source VOM; rejects expired observations.",
  },
  button: {
    type: "string",
    enum: ["left", "middle", "right"],
    description: "Mouse button; default left.",
  },
  modifiers: { type: "array", items: { type: "string", enum: ["alt", "ctrl", "meta", "shift"] } },
} as const;

export const STEP_PARAMETERS = {
  stepAction: {
    type: "string",
    enum: ["click", "press", "fill", "hover", "select", "drag", "scroll-to", "wheel", "navigate"],
    description:
      "One already-decided browser action, executed once before optional readiness and synchronization.",
  },
  params: {
    type: "string",
    description:
      "Action protocol JSON object (ref/selector/value/key/etc.). Session, tab, context and dependencies must use the outer tool fields.",
  },
  untilVisible: {
    type: "string",
    description:
      "Known main-document CSS selector expected to become visible; visibility alone does not prove business success.",
  },
  waitTimeoutMs: {
    type: "integer",
    description: "Optional readiness budget, 1..25000 ms; default 5000.",
  },
  ...SAVED_OBSERVATION_PARAMETERS,
} as const;

export const VIEW_PARAMETERS = {
  file: {
    type: "string",
    description:
      "Explicit local JSON file saved by sync or step. Historical evidence only; no browser session is required.",
  },
  find: {
    type: "string",
    description: "Case-sensitive literal search; reports all matching line numbers.",
  },
  startLine: { type: "integer", description: "First VOM line, 1-based; default 1." },
  lineCount: { type: "integer", description: "Maximum displayed VOM lines, 1..2000; default 120." },
} as const;

interface SavedObservationArgs {
  saveFull?: string;
  baseline?: string;
  matchText?: string[];
  contextLines?: number;
}

function integerInRange(value: number | undefined, name: string, min: number, max: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max))
    throw new Error(`${name} must be an integer in ${min}..${max}`);
}

/** Shared CLI presentation/storage flags, never browser authority. */
export function appendSavedObservationOptions(command: string[], args: SavedObservationArgs): void {
  integerInRange(args.contextLines, "contextLines", 0, 200);
  if (args.contextLines !== undefined && !args.matchText?.length)
    throw new Error("contextLines requires matchText");
  for (const [value, flag] of [
    [args.saveFull, "--save-full"],
    [args.baseline, "--baseline"],
  ] as const) {
    if (value === undefined) continue;
    requireNonEmpty(value, flag);
    command.push(flag, resolve(value));
  }
  for (const text of args.matchText ?? []) {
    requireNonEmpty(text, "matchText");
    if (/[\r\n]/.test(text)) throw new Error("matchText must contain single-line literals");
    command.push("--match-text", text);
  }
  if (args.contextLines !== undefined) command.push("--context-lines", String(args.contextLines));
}

function presentStepResult(_args: never, result: ToolResult) {
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

/** Route through the ordinary session runtime; only historical view is session-free. */
export function registerGestureObservationTools(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  const output = {
    schema: { type: "json" as const },
    render: (_args: unknown, value: unknown) => [
      { type: "text" as const, text: JSON.stringify(value) },
    ],
  };
  register(
    defineTool({
      name: "interact.drag",
      description:
        "Execute one bounded native drag or click-move-click range gesture. Observe application state afterwards; uncertain effects must not be retried blindly.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        timeoutMs: TIMEOUT_MS_PARAM,
        ...DRAG_PARAMETERS,
        target: { ...DRAG_PARAMETERS.target, required: true },
      },
      output,
      async execute(args, exec) {
        requireNonEmpty(args.target, "target");
        if (args.to !== undefined) requireNonEmpty(args.to, "to");
        if (args.observationId !== undefined) requireNonEmpty(args.observationId, "observationId");
        const hasDelta = args.deltaX !== undefined || args.deltaY !== undefined;
        if ((args.to !== undefined) === hasDelta)
          throw new Error("drag requires exactly one of to or deltaX/deltaY");
        if (!args.to && (args.toOffsetX !== undefined || args.toOffsetY !== undefined))
          throw new Error("destination offsets require to");
        for (const name of [
          "deltaX",
          "deltaY",
          "fromOffsetX",
          "fromOffsetY",
          "toOffsetX",
          "toOffsetY",
        ] as const)
          if (args[name] !== undefined && !Number.isFinite(args[name]))
            throw new Error(`${name} must be finite`);
        if (hasDelta && (args.deltaX ?? 0) === 0 && (args.deltaY ?? 0) === 0)
          throw new Error("drag movement must be nonzero");
        integerInRange(args.durationMs, "durationMs", 1, 5000);
        integerInRange(args.holdMs, "holdMs", 0, 5000);
        integerInRange(args.timeoutMs, "timeoutMs", 1, 2_147_483_647);
        if (
          args.dragMode === "click-move-click" &&
          (args.to === undefined || (args.holdMs ?? 0) !== 0)
        )
          throw new Error("click-move-click requires to and zero holdMs");
        const session = deps.registry.resolve(args.session, "bsk_interact(action=drag)");
        const command = ["drag", args.target, "--session", session];
        appendTabId(command, args.tabId);
        for (const [value, flag] of [
          [args.to, "--to"],
          [args.dragMode, "--mode"],
          [args.deltaX, "--dx"],
          [args.deltaY, "--dy"],
          [args.fromOffsetX, "--from-offset-x"],
          [args.fromOffsetY, "--from-offset-y"],
          [args.toOffsetX, "--to-offset-x"],
          [args.toOffsetY, "--to-offset-y"],
          [args.observationId, "--observation-id"],
          [args.button, "--button"],
        ] as const)
          if (value !== undefined) command.push(flag, String(value));
        if (args.modifiers?.length) command.push("--modifiers", args.modifiers.join(","));
        for (const [value, flag] of [
          [args.durationMs, "--duration"],
          [args.holdMs, "--hold"],
          [args.timeoutMs, "--timeout"],
        ] as const)
          if (value !== undefined) command.push(flag, `${value}ms`);
        return (await runtime.run(
          exec,
          command,
          "drag",
          session,
          runnerTimeout(deps, args.timeoutMs ?? 30_000),
        )) as never;
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "drag",
          args.target,
          ...(args.to === undefined ? [] : ["--to", args.to]),
          ...(args.deltaX === undefined ? [] : ["--dx", String(args.deltaX)]),
          ...(args.deltaY === undefined ? [] : ["--dy", String(args.deltaY)]),
          ...(args.dragMode === undefined ? [] : ["--mode", args.dragMode]),
          "--session",
          args.session ?? "(current)",
        ]),
        description:
          args.dragMode === "click-move-click"
            ? "Select a range with released movement"
            : "Drag between observed targets",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "interact.step",
      description:
        "Execute one decided action once, optionally wait, then synchronize. Read ok, action, readiness and post separately; a failed later stage does not undo the action. Never replay a partial result.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        ...STEP_PARAMETERS,
        stepAction: { ...STEP_PARAMETERS.stepAction, required: true },
        params: { ...STEP_PARAMETERS.params, required: true },
      },
      output,
      async execute(args, exec) {
        const params: unknown = JSON.parse(args.params);
        if (!params || typeof params !== "object" || Array.isArray(params))
          throw new Error("params must be a JSON object");
        for (const key of ["session_id", "tab_id", "context_id", "depends_on"])
          if (Object.hasOwn(params, key)) throw new Error(`${key} must use outer tool fields`);
        if (args.untilVisible !== undefined) requireNonEmpty(args.untilVisible, "untilVisible");
        integerInRange(args.waitTimeoutMs, "waitTimeoutMs", 1, 25_000);
        const session = deps.registry.resolve(args.session, "bsk_interact(action=step)");
        const command = [
          "step",
          "--session",
          session,
          "--action",
          args.stepAction,
          "--params",
          JSON.stringify(params),
        ];
        appendTabId(command, args.tabId);
        if (args.untilVisible !== undefined) command.push("--until-visible", args.untilVisible);
        if (args.waitTimeoutMs !== undefined)
          command.push("--wait-timeout-ms", String(args.waitTimeoutMs));
        appendSavedObservationOptions(command, args);
        // One action, optional readiness, and at most three sync/two wait RPCs.
        // Each ordinary RPC has a 35s IPC boundary; keep the process alive for its receipt.
        const budget =
          35_000 +
          (args.untilVisible !== undefined ? (args.waitTimeoutMs ?? 5000) + 5000 : 0) +
          5 * 35_000;
        return (await runtime.run(exec, command, "step", session, runnerTimeout(deps, budget), {
          allowStepResult: true,
        })) as never;
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "step",
          "--action",
          args.stepAction,
          "--params",
          args.params,
          "--session",
          args.session ?? "(current)",
          ...(args.untilVisible === undefined ? [] : ["--until-visible", args.untilVisible]),
        ]),
        description: "Execute one action, then inspect readiness and synchronized state",
      }),
      presentResult: presentStepResult,
    }),
  );

  register(
    defineTool({
      name: "inspect.view",
      description:
        "Read a saved observation locally with zero browser calls. Historical refs and source_context_id do not authorize another action. Works after the original session has stopped.",
      parameters: { ...VIEW_PARAMETERS, file: { ...VIEW_PARAMETERS.file, required: true } },
      output,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const extra = args as Record<string, unknown>;
        const context = exec as ToolRunContext & {
          observationContext?: unknown;
          observationDependencies?: unknown;
        };
        if (
          [
            extra.session,
            extra.tabId,
            extra.contextId,
            extra.dependsOn,
            context.observationContext,
            context.observationDependencies,
          ].some((value) => value !== undefined)
        )
          throw new Error(
            "view is historical and does not accept session, tabId, contextId or dependsOn",
          );
        requireNonEmpty(args.file, "file");
        if (args.find !== undefined) requireNonEmpty(args.find, "find");
        integerInRange(args.startLine, "startLine", 1, 4_294_967_295);
        integerInRange(args.lineCount, "lineCount", 1, 2000);
        const command = ["view", resolve(args.file)];
        if (args.find !== undefined) command.push("--find", args.find);
        if (args.startLine !== undefined) command.push("--start-line", String(args.startLine));
        if (args.lineCount !== undefined) command.push("--line-count", String(args.lineCount));
        return (await runtime.run(exec, command, "view")) as never;
      },
      presentResult: runtime.presentTerminalResult,
    }),
  );
}
