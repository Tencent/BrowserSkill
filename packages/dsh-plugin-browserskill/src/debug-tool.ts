import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendTabId, type PhaseOneRuntime, type ToolRegistrar } from "./phase-one-runtime";
import { SESSION_PARAM, TAB_ID_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

export const DEBUG_PARAMETERS = {
  debugAction: {
    type: "string",
    enum: ["start", "stop", "status", "requests", "request", "operations", "operation", "compare"],
    description:
      "Start capture before reproduction; inspect summaries, drill into IDs, compare two operations, then stop.",
  },
  runId: { type: "string", description: "Capture ID; defaults to the latest capture." },
  id: { type: "string", description: "Request/operation ID; required for request or operation." },
  name: { type: "string", description: "Short capture name for start." },
  before: { type: "string", description: "Before operation ID for compare." },
  after: { type: "string", description: "After operation ID for compare." },
  part: {
    type: "string",
    enum: ["metadata", "request", "response", "headers", "timing"],
    description: "Request detail projection; defaults to metadata without body text.",
  },
  offset: { type: "integer", description: "Body character offset, 0..65536." },
  maxChars: { type: "integer", description: "Body slice size, 1..16384; default 4096." },
  pointer: {
    type: "string",
    description: "RFC 6901 pointer into a complete redacted request/response JSON body.",
  },
} as const;

export function registerDebugTool(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  register(
    defineTool({
      name: "inspect.debug",
      description:
        "Opt-in, task-scoped website debugging. Correlate requests, console and page changes with agent operations; correlation is not causation. Compare identical inputs before claiming a fix.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        ...DEBUG_PARAMETERS,
        debugAction: { ...DEBUG_PARAMETERS.debugAction, required: true },
        since: { type: "integer", description: "Incremental cursor; deduplicate updates by ID." },
        limit: { type: "integer", description: "Summary page size, 1..100." },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      },
      // Keep observation/capture ordering in the existing per-session queue.
      async execute(args, exec) {
        if (["request", "operation"].includes(args.debugAction) && !args.id?.trim())
          throw new Error("id is required");
        if (args.debugAction === "compare" && (!args.before || !args.after))
          throw new Error("before and after operation IDs are required");
        if (args.pointer !== undefined && !["request", "response"].includes(args.part ?? ""))
          throw new Error("pointer requires request or response part");
        for (const [key, min, max] of [
          ["since", 0, Number.MAX_SAFE_INTEGER],
          ["limit", 1, 100],
          ["offset", 0, 65536],
          ["maxChars", 1, 16384],
        ] as const) {
          const value = args[key];
          if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max))
            throw new Error(`${key} must be ${min}..${max}`);
        }
        const session = deps.registry.resolve(args.session, "browser_inspect(action=debug)");
        const command = ["debug", args.debugAction];
        if (args.id !== undefined) command.push(args.id);
        command.push("--session", session);
        appendTabId(command, args.tabId);
        for (const [key, flag] of [
          ["runId", "run-id"],
          ["name", "name"],
          ["before", "before"],
          ["after", "after"],
          ["part", "part"],
          ["offset", "offset"],
          ["maxChars", "max-chars"],
          ["pointer", "pointer"],
          ["since", "since"],
          ["limit", "limit"],
        ] as const)
          if (args[key] !== undefined) command.push(`--${flag}`, String(args[key]));
        return (await runtime.run(exec, command, "debug", session)) as never;
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "debug",
          args.debugAction,
          "--session",
          args.session ?? "(current)",
        ]),
        description: "Inspect task-owned website evidence",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );
}
