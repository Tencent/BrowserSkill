import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  appendTabId,
  isSnapshotRef,
  type PhaseOneRuntime,
  requireNonEmpty,
  requirePositive,
  runnerTimeout,
  type ToolRegistrar,
} from "./phase-one-runtime";
import { SESSION_PARAM, TAB_ID_PARAM, TIMEOUT_MS_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

interface HelpConditionInput {
  urlContains?: string;
  urlMatches?: string;
  selectorExists?: string;
  selectorMissing?: string;
  textExists?: string;
  textMissing?: string;
}

interface CompletionCriteriaInput {
  any?: HelpConditionInput[];
  all?: HelpConditionInput[];
  stableForMs?: number;
}

interface RawConsoleFrame {
  function_name?: string;
  url?: string;
  line?: number;
  column?: number;
}

interface RawConsoleEntry {
  sequence: number;
  kind: string;
  level: string;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp?: number;
  stack_trace?: RawConsoleFrame[];
  truncated?: boolean;
}

interface RawNetworkEntry {
  sequence: number;
  kind: "response" | "failure";
  method?: string;
  url?: string;
  status?: number;
  status_text?: string;
  mime_type?: string;
  resource_type?: string;
  error_text?: string;
  timestamp?: number;
  truncated?: boolean;
}

const HELP_CONDITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    urlContains: { type: "string" },
    urlMatches: { type: "string" },
    selectorExists: { type: "string" },
    selectorMissing: { type: "string" },
    textExists: { type: "string" },
    textMissing: { type: "string" },
  },
} as const;

const DEBUG_PARAMETERS = {
  session: SESSION_PARAM,
  tabId: TAB_ID_PARAM,
  since: {
    type: "integer",
    description: "Return entries with a sequence strictly greater than this cursor.",
  },
  limit: {
    type: "integer",
    description: "Maximum entries to return (default: 50, daemon cap: 200).",
  },
  maxTextChars: {
    type: "integer",
    description: "Maximum characters per entry text/URL (default: 1000, daemon cap: 4096).",
  },
} as const;

function mapCondition(condition: HelpConditionInput) {
  return {
    ...(condition.urlContains !== undefined ? { url_contains: condition.urlContains } : {}),
    ...(condition.urlMatches !== undefined ? { url_matches: condition.urlMatches } : {}),
    ...(condition.selectorExists !== undefined
      ? { selector_exists: condition.selectorExists }
      : {}),
    ...(condition.selectorMissing !== undefined
      ? { selector_missing: condition.selectorMissing }
      : {}),
    ...(condition.textExists !== undefined ? { text_exists: condition.textExists } : {}),
    ...(condition.textMissing !== undefined ? { text_missing: condition.textMissing } : {}),
  };
}

function mapCompletionCriteria(criteria: CompletionCriteriaInput) {
  return {
    ...(criteria.any !== undefined ? { any: criteria.any.map(mapCondition) } : {}),
    ...(criteria.all !== undefined ? { all: criteria.all.map(mapCondition) } : {}),
    ...(criteria.stableForMs !== undefined ? { stable_for_ms: criteria.stableForMs } : {}),
  };
}

function validateDebugArgs(args: { since?: number; limit?: number; maxTextChars?: number }): void {
  if (args.since !== undefined && args.since < 0) {
    throw new Error("since must be zero or greater");
  }
  requirePositive(args.limit, "limit");
  requirePositive(args.maxTextChars, "maxTextChars");
}

function appendDebugOptions(
  args: string[],
  options: { tabId?: number; since?: number; limit?: number; maxTextChars?: number },
): void {
  appendTabId(args, options.tabId);
  if (options.since !== undefined) args.push("--since", String(options.since));
  if (options.limit !== undefined) args.push("--limit", String(options.limit));
  if (options.maxTextChars !== undefined) {
    args.push("--max-text-chars", String(options.maxTextChars));
  }
}

/** Human help, raw HTML, diagnostics, and Agent Window sizing. */
export function registerPhaseOneSupportTools(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  const { registry } = deps;

  register(
    defineTool({
      name: "browser_request_help",
      description:
        "Pause browser automation and ask the user to complete an in-page step such as login, " +
        "captcha, OTP, or confirmation. After continued/completed, observe again before using refs.",
      parameters: {
        prompt: {
          type: "string",
          required: true,
          description: "Clear instructions shown to the user in the browser help overlay.",
        },
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        title: { type: "string", description: "Optional title for the help overlay." },
        targets: {
          type: "array",
          items: { type: "string" },
          description: "Snapshot refs or CSS selectors to scroll to and highlight for the user.",
        },
        timeoutMs: {
          ...TIMEOUT_MS_PARAM,
          description: "Maximum wait for the user in milliseconds (default: 300000).",
        },
        completionCriteria: {
          type: "object",
          additionalProperties: false,
          description: "Optional explicit success detector for automatic completion.",
          properties: {
            any: { type: "array", items: HELP_CONDITION_SCHEMA },
            all: { type: "array", items: HELP_CONDITION_SCHEMA },
            stableForMs: {
              type: "integer",
              description: "How long criteria must remain true before completing.",
            },
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            outcome: {
              type: "string",
              required: true,
              enum: ["continued", "cancelled", "timed_out", "completed", "navigated", "disabled"],
            },
            completedBy: { type: "string" },
            note: { type: "string" },
            resolvedTargets: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  matched: { type: "boolean", required: true },
                  ref: { type: "string" },
                  selector: { type: "string" },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `[session ${value.session}] user help outcome on tab ${value.tabId}: ${value.outcome}` +
              (value.note !== undefined ? ` — ${value.note}` : "") +
              (value.resolvedTargets !== undefined
                ? `\ntargets: ${value.resolvedTargets
                    .map(
                      (target) =>
                        `${target.ref ?? target.selector ?? "(unknown)"}=${target.matched ? "matched" : "not found"}`,
                    )
                    .join(", ")}`
                : ""),
          },
        ],
      },
      async execute(args, exec) {
        requireNonEmpty(args.prompt, "prompt");
        if (args.title !== undefined) requireNonEmpty(args.title, "title");
        requirePositive(args.timeoutMs, "timeoutMs");
        for (const target of args.targets ?? []) requireNonEmpty(target, "target");
        const criteria = args.completionCriteria as CompletionCriteriaInput | undefined;
        if (criteria?.stableForMs !== undefined && criteria.stableForMs < 0) {
          throw new Error("completionCriteria.stableForMs must be zero or greater");
        }
        const sessionId = registry.resolve(args.session, "browser_request_help");
        const timeoutMs = args.timeoutMs ?? 300_000;
        const cmdArgs = [
          "request-help",
          "--session",
          sessionId,
          "--prompt",
          args.prompt,
          "--timeout",
          `${timeoutMs}ms`,
        ];
        appendTabId(cmdArgs, args.tabId);
        if (args.title !== undefined) cmdArgs.push("--title", args.title);
        for (const target of args.targets ?? []) cmdArgs.push("--target", target);
        if (criteria !== undefined) {
          cmdArgs.push("--completion-criteria", JSON.stringify(mapCompletionCriteria(criteria)));
        }
        const reply = (await runtime.run(
          exec,
          cmdArgs,
          "request-help",
          sessionId,
          runnerTimeout(deps, timeoutMs),
        )) as {
          outcome: "continued" | "cancelled" | "timed_out" | "completed" | "navigated" | "disabled";
          completed_by?: string;
          note?: string;
          tab_id: number;
          resolved_targets?: { matched: boolean; ref?: string; selector?: string }[];
        };
        return {
          session: sessionId,
          tabId: reply.tab_id,
          outcome: reply.outcome,
          ...(reply.completed_by !== undefined ? { completedBy: reply.completed_by } : {}),
          ...(reply.note !== undefined ? { note: reply.note } : {}),
          ...(reply.resolved_targets !== undefined
            ? { resolvedTargets: reply.resolved_targets }
            : {}),
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine(["request-help", "--session", args.session ?? "(current)"]),
        description: "Ask the user for browser help",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "browser_get_html",
      description:
        "Read raw DOM HTML from the active Agent Window tab, optionally scoped to a fresh " +
        "snapshot ref. Use only when browser_observe/browser_snapshot cannot answer the question.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        ref: { type: "string", description: "Fresh snapshot ref that scopes the HTML subtree." },
        maxBytes: {
          type: "integer",
          description: "Maximum returned HTML bytes before truncation (default: 524288).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            html: { type: "string", required: true },
            truncated: { type: "boolean", required: true },
            byteSize: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.html +
              (value.truncated ? `\n(HTML truncated; original size ${value.byteSize} bytes)` : ""),
          },
        ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (args.ref !== undefined) {
          requireNonEmpty(args.ref, "ref");
          if (!isSnapshotRef(args.ref)) throw new Error("ref must be a snapshot ref such as @e3");
        }
        requirePositive(args.maxBytes, "maxBytes");
        const sessionId = registry.resolve(args.session, "browser_get_html");
        const cmdArgs = ["get-html", "--session", sessionId];
        appendTabId(cmdArgs, args.tabId);
        if (args.ref !== undefined) cmdArgs.push("--ref", args.ref);
        if (args.maxBytes !== undefined) cmdArgs.push("--max-bytes", String(args.maxBytes));
        const reply = (await runtime.run(exec, cmdArgs, "get-html", sessionId)) as {
          tab_id: number;
          html: string;
          truncated?: boolean;
          byte_size: number;
        };
        return {
          session: sessionId,
          tabId: reply.tab_id,
          html: reply.html,
          truncated: reply.truncated ?? false,
          byteSize: reply.byte_size,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "get-html",
          "--session",
          args.session ?? "(current)",
          ...(args.ref !== undefined ? ["--ref", args.ref] : []),
        ]),
        description: "Read raw page HTML",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "browser_console",
      description:
        "Read buffered console messages, browser log entries, and JavaScript exceptions from a tab. " +
        "This is read-only and does not evaluate JavaScript.",
      parameters: {
        ...DEBUG_PARAMETERS,
        includeStack: {
          type: "boolean",
          description: "Include structured stack frames in returned console entries.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            entries: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  sequence: { type: "integer", required: true },
                  kind: { type: "string", required: true },
                  level: { type: "string", required: true },
                  text: { type: "string", required: true },
                  url: { type: "string" },
                  line: { type: "integer" },
                  column: { type: "integer" },
                  timestamp: { type: "number" },
                  stackTrace: {
                    type: "array",
                    required: true,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        functionName: { type: "string" },
                        url: { type: "string" },
                        line: { type: "integer" },
                        column: { type: "integer" },
                      },
                    },
                  },
                  truncated: { type: "boolean", required: true },
                },
              },
            },
            nextSince: { type: "integer", required: true },
            truncated: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.entries.length === 0
                ? "(no console messages captured)"
                : value.entries
                    .map((entry) => {
                      const location =
                        entry.url === undefined
                          ? ""
                          : ` ${entry.url}${entry.line !== undefined ? `:${entry.line}` : ""}${entry.column !== undefined ? `:${entry.column}` : ""}`;
                      const stack = entry.stackTrace
                        .map(
                          (frame) =>
                            `\n  at ${frame.functionName ?? "<anonymous>"} ${frame.url ?? ""}` +
                            `${frame.line !== undefined ? `:${frame.line}` : ""}` +
                            `${frame.column !== undefined ? `:${frame.column}` : ""}`,
                        )
                        .join("");
                      return `#${entry.sequence} ${entry.level} ${entry.kind}${location} ${entry.text}${stack}`;
                    })
                    .join("\n") +
                  (value.truncated
                    ? `\n(output truncated; continue with since=${value.nextSince})`
                    : ""),
          },
        ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        validateDebugArgs(args);
        const sessionId = registry.resolve(args.session, "browser_console");
        const cmdArgs = ["console", "--session", sessionId];
        appendDebugOptions(cmdArgs, args);
        if (args.includeStack === true) cmdArgs.push("--include-stack");
        const reply = (await runtime.run(exec, cmdArgs, "console", sessionId)) as {
          tab_id: number;
          entries?: RawConsoleEntry[];
          next_since: number;
          truncated?: boolean;
        };
        return {
          session: sessionId,
          tabId: reply.tab_id,
          entries: (reply.entries ?? []).map((entry) => ({
            sequence: entry.sequence,
            kind: entry.kind,
            level: entry.level,
            text: entry.text,
            ...(entry.url !== undefined ? { url: entry.url } : {}),
            ...(entry.line !== undefined ? { line: entry.line } : {}),
            ...(entry.column !== undefined ? { column: entry.column } : {}),
            ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
            stackTrace: (entry.stack_trace ?? []).map((frame) => ({
              ...(frame.function_name !== undefined ? { functionName: frame.function_name } : {}),
              ...(frame.url !== undefined ? { url: frame.url } : {}),
              ...(frame.line !== undefined ? { line: frame.line } : {}),
              ...(frame.column !== undefined ? { column: frame.column } : {}),
            })),
            truncated: entry.truncated ?? false,
          })),
          nextSince: reply.next_since,
          truncated: reply.truncated ?? false,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine(["console", "--session", args.session ?? "(current)"]),
        description: "Read browser console messages",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "browser_network",
      description:
        "Read buffered network responses and failures from a tab. Returns metadata only; request " +
        "and response headers and bodies are not captured.",
      parameters: DEBUG_PARAMETERS,
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            entries: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  sequence: { type: "integer", required: true },
                  kind: { type: "string", required: true, enum: ["response", "failure"] },
                  method: { type: "string" },
                  url: { type: "string" },
                  status: { type: "integer" },
                  statusText: { type: "string" },
                  mimeType: { type: "string" },
                  resourceType: { type: "string" },
                  errorText: { type: "string" },
                  timestamp: { type: "number" },
                  truncated: { type: "boolean", required: true },
                },
              },
            },
            nextSince: { type: "integer", required: true },
            truncated: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.entries.length === 0
                ? "(no network activity captured)"
                : value.entries
                    .map((entry) =>
                      entry.kind === "failure"
                        ? `#${entry.sequence} FAILED ${entry.method ?? "?"} ${entry.url ?? "(unknown)"} — ${entry.errorText ?? "failed"}`
                        : `#${entry.sequence} ${entry.status ?? "?"} ${entry.method ?? "?"} ${entry.url ?? "(unknown)"}`,
                    )
                    .join("\n") +
                  (value.truncated
                    ? `\n(output truncated; continue with since=${value.nextSince})`
                    : ""),
          },
        ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        validateDebugArgs(args);
        const sessionId = registry.resolve(args.session, "browser_network");
        const cmdArgs = ["network", "--session", sessionId];
        appendDebugOptions(cmdArgs, args);
        const reply = (await runtime.run(exec, cmdArgs, "network", sessionId)) as {
          tab_id: number;
          entries?: RawNetworkEntry[];
          next_since: number;
          truncated?: boolean;
        };
        return {
          session: sessionId,
          tabId: reply.tab_id,
          entries: (reply.entries ?? []).map((entry) => ({
            sequence: entry.sequence,
            kind: entry.kind,
            ...(entry.method !== undefined ? { method: entry.method } : {}),
            ...(entry.url !== undefined ? { url: entry.url } : {}),
            ...(entry.status !== undefined ? { status: entry.status } : {}),
            ...(entry.status_text !== undefined ? { statusText: entry.status_text } : {}),
            ...(entry.mime_type !== undefined ? { mimeType: entry.mime_type } : {}),
            ...(entry.resource_type !== undefined ? { resourceType: entry.resource_type } : {}),
            ...(entry.error_text !== undefined ? { errorText: entry.error_text } : {}),
            ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
            truncated: entry.truncated ?? false,
          })),
          nextSince: reply.next_since,
          truncated: reply.truncated ?? false,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine(["network", "--session", args.session ?? "(current)"]),
        description: "Read browser network activity",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "browser_window_resize",
      description: "Resize the owned session's Agent Window using outer CSS-pixel dimensions.",
      parameters: {
        width: {
          type: "integer",
          required: true,
          description: "Agent Window outer width in CSS pixels (100..=7680).",
        },
        height: {
          type: "integer",
          required: true,
          description: "Agent Window outer height in CSS pixels (100..=7680).",
        },
        session: SESSION_PARAM,
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            windowId: { type: "integer", required: true },
            width: { type: "integer", required: true },
            height: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[session ${value.session}] resized window ${value.windowId} to ${value.width}x${value.height}`,
          },
        ],
      },
      async execute(args, exec) {
        if (args.width < 100 || args.width > 7680 || args.height < 100 || args.height > 7680) {
          throw new Error("width and height must each be in the range 100..=7680");
        }
        const sessionId = registry.resolve(args.session, "browser_window_resize");
        const reply = (await runtime.run(
          exec,
          [
            "window",
            "resize",
            "--session",
            sessionId,
            "--width",
            String(args.width),
            "--height",
            String(args.height),
          ],
          "window resize",
          sessionId,
        )) as { window_id: number; width: number; height: number };
        return {
          session: sessionId,
          windowId: reply.window_id,
          width: reply.width,
          height: reply.height,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "window",
          "resize",
          "--session",
          args.session ?? "(current)",
          "--width",
          String(args.width),
          "--height",
          String(args.height),
        ]),
        description: "Resize the Agent Window",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );
}
