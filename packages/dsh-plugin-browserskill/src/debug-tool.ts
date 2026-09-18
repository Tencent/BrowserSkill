import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendTabId, type PhaseOneRuntime, type ToolRegistrar } from "./phase-one-runtime";
import { SESSION_PARAM, TAB_ID_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

export const DEBUG_PARAMETERS = {
  debugAction: {
    type: "string",
    enum: [
      "start",
      "stop",
      "status",
      "requests",
      "request",
      "operations",
      "operation",
      "console",
      "pages",
      "export",
      "rules",
      "rule_add",
      "rule_enable",
      "rule_disable",
      "rule_remove",
      "replay",
    ],
    description:
      "Start capture before visiting the page; inspect requests, console, page context and operations, or export the recording.",
  },
  rule: {
    type: "string",
    description:
      "JSON for rule_add: {match:{url,method?,resource_type?},effect:{type,...},times?:1}. URL is absolute; * matches path/query. Default scope Fetch/XHR; optional Document. Effects: block; modify with same-origin url?,method?,headers? (null removes),body? or json?:{set?,remove?,rename?} for top-level JSON fields; mock with status,body,headers?,delay_ms? (0..10000). Text bodies only. times=0 lasts until disabled/capture ends. Rules run locally; first match wins.",
  },
  replay: {
    type: "string",
    description:
      'JSON for replay: {key:"unique-attempt",url?,method?,headers?,body?}. Sends once; reuse key on retry. Same-origin only; missing/redacted data must be replaced. A replay may write server data.',
  },
  runId: { type: "string", description: "Capture ID; defaults to the latest capture." },
  id: {
    type: "string",
    description: "Request/operation/rule ID; required for detail, rule updates or replay.",
  },
  name: { type: "string", description: "Short capture name for start." },
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
        "Opt-in, task-scoped website debugging. Correlate requests, console and page changes with agent operations; correlation is not causation. Export recordings for later analysis. Explicitly add task-local block/modify/mock rules or replay a complete same-origin request. Paused requests are handled locally; never poll the agent for each request.",
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
        if (!DEBUG_PARAMETERS.debugAction.enum.includes(args.debugAction))
          throw new Error("invalid debug action");
        if (
          ["request", "operation", "rule_enable", "rule_disable", "rule_remove", "replay"].includes(
            args.debugAction,
          ) &&
          !args.id?.trim()
        )
          throw new Error("id is required");
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
        if ((args.debugAction === "rule_add") !== (args.rule !== undefined))
          throw new Error("rule_add requires rule JSON");
        if ((args.debugAction === "replay") !== (args.replay !== undefined))
          throw new Error("replay requires replay JSON");
        for (const value of [args.rule, args.replay])
          if (value !== undefined) {
            if (value.length > 81920) throw new Error("control options exceed 80 KiB");
            JSON.parse(value);
          }
        const session = deps.registry.resolve(args.session, "browser_inspect(action=debug)");
        const command = ["debug", args.debugAction];
        if (args.id !== undefined) command.push(args.id);
        command.push("--session", session);
        appendTabId(command, args.tabId);
        for (const [key, flag] of [
          ["runId", "run-id"],
          ["rule", "rule"],
          ["replay", "replay"],
          ["name", "name"],
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
