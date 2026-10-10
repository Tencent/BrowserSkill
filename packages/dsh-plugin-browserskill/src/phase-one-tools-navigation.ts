import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  appendTabId,
  appendWaitOptions,
  type PhaseOneRuntime,
  requireNonEmpty,
  requirePositive,
  runnerTimeout,
  type ToolRegistrar,
} from "./phase-one-runtime";
import {
  ELEMENT_WAIT_PARAMS,
  SESSION_PARAM,
  TAB_ID_PARAM,
  TIMEOUT_MS_PARAM,
  WAIT_UNTIL_PARAM,
} from "./tool-params";
import type { ToolDeps } from "./tools";

interface RawHistoryResult {
  tab_id: number;
  previous_url?: string;
  final_url?: string;
  reached: string;
  error_text?: string;
}

const HISTORY_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    session: { type: "string", required: true },
    tabId: { type: "integer", required: true },
    previousUrl: { type: "string" },
    finalUrl: { type: "string" },
    reached: { type: "string", required: true },
    errorText: { type: "string" },
  },
} as const;

function mapHistory(sessionId: string, reply: RawHistoryResult) {
  return {
    session: sessionId,
    tabId: reply.tab_id,
    ...(reply.previous_url !== undefined ? { previousUrl: reply.previous_url } : {}),
    ...(reply.final_url !== undefined ? { finalUrl: reply.final_url } : {}),
    reached: reply.reached,
    ...(reply.error_text !== undefined ? { errorText: reply.error_text } : {}),
  };
}

/** Add browser history, reload, and lifecycle/element waiting. */
export function registerPhaseOneNavigationTools(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  const { registry } = deps;

  register(
    defineTool({
      name: "page.wait-for-element",
      description: "Wait for one observed element condition; a timeout returns satisfied=false.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        timeoutMs: TIMEOUT_MS_PARAM,
        ...ELEMENT_WAIT_PARAMS,
        target: { ...ELEMENT_WAIT_PARAMS.target, required: true },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            target: { type: "string", required: true },
            state: { ...ELEMENT_WAIT_PARAMS.state, required: true },
            satisfied: { type: "boolean", required: true },
            attached: { oneOf: [{ type: "boolean" }, { type: "null" }], required: true },
            visible: { oneOf: [{ type: "boolean" }, { type: "null" }], required: true },
            elapsedMs: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `[session ${value.session}] element wait on tab ${value.tabId}: ` +
              `target=${value.target} state=${value.state} satisfied=${value.satisfied} ` +
              `attached=${value.attached ?? "unknown"} visible=${value.visible ?? "unknown"} ` +
              `elapsedMs=${value.elapsedMs}. ` +
              (value.satisfied
                ? "Condition matched. Observe for fresh refs before choosing the next action."
                : "Timed out; the condition was not met. Observe the current page before deciding how to continue."),
          },
        ],
      },
      async execute(args, exec) {
        requireNonEmpty(args.target, "target");
        const timeoutMs = args.timeoutMs ?? 10_000;
        if (timeoutMs < 1 || timeoutMs > 300_000) {
          throw new Error("timeoutMs must be in 1..300000 for wait-for-element");
        }
        if (args.pollMs !== undefined && (args.pollMs < 16 || args.pollMs > 2000)) {
          throw new Error("pollMs must be in 16..2000");
        }
        const sessionId = registry.resolve(args.session, "browser_page(action=wait-for-element)");
        const state = args.state ?? "visible";
        const cmdArgs = [
          "wait-for-element",
          "--session",
          sessionId,
          "--state",
          state,
          "--timeout",
          `${timeoutMs}ms`,
        ];
        appendTabId(cmdArgs, args.tabId);
        if (args.pollMs !== undefined) cmdArgs.push("--poll-ms", String(args.pollMs));
        cmdArgs.push(args.target);
        const reply = (await runtime.run(
          exec,
          cmdArgs,
          "wait-for-element",
          sessionId,
          runnerTimeout(deps, timeoutMs),
        )) as {
          tab_id: number;
          satisfied: boolean;
          attached: boolean | null;
          visible: boolean | null;
          elapsed_ms: number;
        };
        return {
          session: sessionId,
          tabId: reply.tab_id,
          target: args.target,
          state,
          satisfied: reply.satisfied,
          attached: reply.attached,
          visible: reply.visible,
          elapsedMs: reply.elapsed_ms,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "wait-for-element",
          args.target,
          "--state",
          args.state ?? "visible",
          "--session",
          args.session ?? "(current)",
        ]),
        description: "Wait for an element condition",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  const registerHistory = (direction: "back" | "forward") => {
    const toolName = `page.${direction}` as const;
    const command = `navigate-${direction}`;
    register(
      defineTool({
        name: toolName,
        description: `Navigate the active Agent Window tab ${direction} by one history entry.`,
        parameters: {
          session: SESSION_PARAM,
          tabId: TAB_ID_PARAM,
          waitUntil: WAIT_UNTIL_PARAM,
          timeoutMs: TIMEOUT_MS_PARAM,
        },
        output: {
          schema: HISTORY_OUTPUT,
          render: (_args, value) => [
            {
              type: "text",
              text:
                `[session ${value.session}] navigated ${direction} on tab ${value.tabId}` +
                (value.finalUrl !== undefined ? ` to ${value.finalUrl}` : "") +
                ` (reached: ${value.reached})` +
                (value.errorText !== undefined ? ` — ${value.errorText}` : ""),
            },
          ],
        },
        async execute(args, exec) {
          requirePositive(args.timeoutMs, "timeoutMs");
          const sessionId = registry.resolve(args.session, toolName);
          const cmdArgs = [command, "--session", sessionId];
          appendTabId(cmdArgs, args.tabId);
          appendWaitOptions(cmdArgs, args.waitUntil, args.timeoutMs);
          const reply = (await runtime.run(
            exec,
            cmdArgs,
            command,
            sessionId,
            runnerTimeout(deps, args.timeoutMs),
          )) as RawHistoryResult;
          if (reply.final_url !== undefined) deps.observation.setUrl(sessionId, reply.final_url);
          return mapHistory(sessionId, reply);
        },
        presentCall: (args) => ({
          card: "terminal",
          title: runtime.commandLine([command, "--session", args.session ?? "(current)"]),
          description: `Navigate ${direction}`,
        }),
        presentResult: runtime.presentTerminalResult,
      }),
    );
  };
  registerHistory("back");
  registerHistory("forward");

  register(
    defineTool({
      name: "page.reload",
      description:
        "Reload the active Agent Window tab and wait for a lifecycle phase. Set hard=true to " +
        "bypass the HTTP cache.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        waitUntil: WAIT_UNTIL_PARAM,
        timeoutMs: TIMEOUT_MS_PARAM,
        hard: { type: "boolean", description: "Bypass the HTTP cache while reloading." },
      },
      output: {
        schema: HISTORY_OUTPUT,
        render: (_args, value) => [
          {
            type: "text",
            text:
              `[session ${value.session}] reloaded tab ${value.tabId}` +
              (value.finalUrl !== undefined ? ` at ${value.finalUrl}` : "") +
              ` (reached: ${value.reached})` +
              (value.errorText !== undefined ? ` — ${value.errorText}` : ""),
          },
        ],
      },
      async execute(args, exec) {
        requirePositive(args.timeoutMs, "timeoutMs");
        const sessionId = registry.resolve(args.session, "browser_page(action=reload)");
        const cmdArgs = ["reload", "--session", sessionId];
        appendTabId(cmdArgs, args.tabId);
        appendWaitOptions(cmdArgs, args.waitUntil, args.timeoutMs);
        if (args.hard === true) cmdArgs.push("--hard");
        const reply = (await runtime.run(
          exec,
          cmdArgs,
          "reload",
          sessionId,
          runnerTimeout(deps, args.timeoutMs),
        )) as RawHistoryResult;
        if (reply.final_url !== undefined) deps.observation.setUrl(sessionId, reply.final_url);
        return mapHistory(sessionId, reply);
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "reload",
          "--session",
          args.session ?? "(current)",
          ...(args.hard === true ? ["--hard"] : []),
        ]),
        description: "Reload the active tab",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "page.wait",
      description:
        "Wait for a page lifecycle event on the active Agent Window tab. Use after an action " +
        "that may navigate when the action result itself does not wait for navigation.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        waitUntil: WAIT_UNTIL_PARAM,
        timeoutMs: TIMEOUT_MS_PARAM,
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            reached: { type: "string", required: true },
            errorText: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `[session ${value.session}] navigation wait on tab ${value.tabId}: ${value.reached}` +
              (value.errorText !== undefined ? ` — ${value.errorText}` : ""),
          },
        ],
      },
      async execute(args, exec) {
        requirePositive(args.timeoutMs, "timeoutMs");
        const sessionId = registry.resolve(args.session, "browser_page(action=wait)");
        const timeoutMs = args.timeoutMs ?? 30_000;
        const cmdArgs = ["wait-for-navigation", "--session", sessionId];
        appendTabId(cmdArgs, args.tabId);
        if (args.waitUntil !== undefined) cmdArgs.push("--wait-until", args.waitUntil);
        cmdArgs.push("--timeout", `${timeoutMs}ms`);
        const reply = (await runtime.run(
          exec,
          cmdArgs,
          "wait-for-navigation",
          sessionId,
          runnerTimeout(deps, timeoutMs),
        )) as { tab_id: number; reached: string; error_text?: string };
        return {
          session: sessionId,
          tabId: reply.tab_id,
          reached: reply.reached,
          ...(reply.error_text !== undefined ? { errorText: reply.error_text } : {}),
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "wait-for-navigation",
          "--session",
          args.session ?? "(current)",
        ]),
        description: "Wait for page navigation",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );
}
