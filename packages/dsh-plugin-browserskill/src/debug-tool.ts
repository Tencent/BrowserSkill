import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendTabId, type PhaseOneRuntime, type ToolRegistrar } from "./phase-one-runtime";
import { SESSION_PARAM, TAB_ID_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

export const DEBUG_PARAMETERS = {
  debugAction: {
    type: "string",
    enum: [
      "performance",
      "aggregate",
      "duplicates",
      "capabilities",
      "activity",
      "wait",
      "pin",
      "unpin",
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
      "Start capture before visiting the page; read/export evidence. rule_add/rule_enable can block, modify or mock live traffic; replay sends a new request and may change server data.",
  },
  rule: {
    type: "string",
    description:
      "JSON for rule_add: {match:{url,method?,resource_type?},effect:{type,...},times?:1}. URL is absolute; * matches path/query. Default scope Fetch/XHR; optional Document. Effects: block; modify with same-origin url?,method?,headers? (null removes),body? or json?:{set?,remove?,rename?} for top-level JSON fields; mock with status,body,headers?,delay_ms? (0..10000). Text bodies only. times=0 lasts until disabled/capture ends. Rules run locally; first match wins.",
  },
  replay: {
    type: "string",
    description:
      'JSON for replay: {key:"unique-attempt",url?,method?,headers?,body?}. Sends once; reuse key on retry. Same-origin only; changed, truncated or unverified URL/body require complete replacements. URL up to 16384 characters; captured URL up to 2048. A replay may write server data.',
  },
  slowMs: {
    type: "integer",
    description: "aggregate only: slow threshold 0..60000 ms, default 1000.",
  },
  windowMs: {
    type: "integer",
    description: "duplicates only: fixed burst window 100..10000 ms, default 1000.",
  },
  includeControlled: {
    type: "boolean",
    description: "Analysis only: include rule/replay experiments (excluded by default).",
  },
  budget: {
    type: "integer",
    description:
      "Total JSON output bytes: 4096..262144, default 65536; export exempt. Inspect output.omitted and follow next_since/next_offset.",
  },
  url: { type: "string", description: "requests/analysis: case-sensitive URL substring." },
  method: { type: "string", description: "requests/analysis: exact HTTP method." },
  resourceType: {
    type: "string",
    description: "requests/analysis: exact resource type, e.g. Fetch or XHR.",
  },
  status: { type: "integer", description: "requests/analysis: exact HTTP status, 100..599." },
  state: {
    type: "string",
    enum: ["pending", "complete", "failed", "redirected", "interrupted"],
    description: "requests/analysis: capture state.",
  },
  kind: {
    type: "string",
    enum: ["all", "business", "resource", "extension"],
    description: "requests/analysis: traffic category.",
  },
  fields: {
    type: "string",
    description:
      "Comma-separated optional request fields; identity and body availability always remain. Discover allowed fields with capabilities.",
  },
  waitMs: {
    type: "integer",
    description: "wait only: 0..60000 ms, default 10000; observes execution, never resends it.",
  },
  commandId: {
    type: "string",
    description:
      "wait only: command ID from activity or session_busy. Omit to wait for idle. Completion is not proof of success.",
  },
  output: {
    type: "string",
    description:
      "export only: new local JSON file path. Returns path and size instead of the full recording.",
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
  offset: {
    type: "integer",
    description: "Body character or pages/console/performance/analysis entry offset, 0..65536.",
  },
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
      isConcurrencySafe: (args) => ["activity", "wait"].includes(args.debugAction),
      // Keep observation/capture ordering in the existing per-session queue.
      async execute(args, exec) {
        if (!DEBUG_PARAMETERS.debugAction.enum.includes(args.debugAction))
          throw new Error("invalid debug action");
        if (
          [
            "request",
            "operation",
            "rule_enable",
            "rule_disable",
            "rule_remove",
            "replay",
            "pin",
            "unpin",
          ].includes(args.debugAction) &&
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
          ["budget", 4096, 262144],
          ["slowMs", 0, 60000],
          ["windowMs", 100, 10000],
          ["status", 100, 599],
          ["waitMs", 0, 60000],
        ] as const) {
          const value = args[key];
          if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max))
            throw new Error(`${key} must be ${min}..${max}`);
        }
        if (args.slowMs !== undefined && args.debugAction !== "aggregate")
          throw new Error("slowMs requires aggregate");
        if (args.windowMs !== undefined && args.debugAction !== "duplicates")
          throw new Error("windowMs requires duplicates");
        if (args.includeControlled && !["aggregate", "duplicates"].includes(args.debugAction))
          throw new Error("includeControlled requires analysis");
        if (
          args.since !== undefined &&
          ["performance", "aggregate", "duplicates"].includes(args.debugAction)
        )
          throw new Error("Use offset for performance/analysis pagination");
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
        if (args.includeControlled) command.push("--include-controlled");
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
          ["budget", "budget"],
          ["slowMs", "slow-ms"],
          ["windowMs", "window-ms"],
          ["url", "url"],
          ["method", "method"],
          ["resourceType", "resource-type"],
          ["status", "status"],
          ["state", "state"],
          ["kind", "kind"],
          ["fields", "fields"],
          ["waitMs", "wait-ms"],
          ["commandId", "command-id"],
          ["output", "output"],
        ] as const)
          if (args[key] !== undefined) command.push(`--${flag}`, String(args[key]));
        return (await runtime.run(
          exec,
          command,
          "debug",
          ["activity", "wait"].includes(args.debugAction) ? undefined : session,
          args.debugAction === "wait"
            ? Math.max(deps.config.defaultTimeoutMs, (args.waitMs ?? 10000) + 15000)
            : undefined,
        )) as never;
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "debug",
          args.debugAction,
          "--session",
          args.session ?? "(current)",
        ]),
        description: "Inspect website evidence or apply explicit network controls",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );
}
