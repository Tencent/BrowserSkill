import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendTabId, type PhaseOneRuntime, type ToolRegistrar } from "./phase-one-runtime";
import { SESSION_PARAM, TAB_ID_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

/**
 * Rows returned inline enter the model context; keep that default near the
 * HTML default. File exports keep the CLI's 1 MiB default.
 */
export const INLINE_EXTRACT_MAX_BYTES = 262_144;

export const EXTRACT_PARAMETERS = {
  extractKind: {
    type: "string",
    enum: ["discover", "table", "list"],
    description: "Discover containers, or extract the loaded rows of a table/list.",
  },
  extractTarget: {
    type: "string",
    description:
      "Document-bound target_id returned by extraction discovery; valid for five minutes.",
  },
  selector: {
    type: "string",
    description:
      "Unique container CSS selector in the main document; exclusive with extractTarget/ref.",
  },
  itemSelector: { type: "string", description: "List item selector relative to the container." },
  extractFields: {
    type: "string",
    description:
      'List field JSON: {"fields":[{"key":"title","name":"Title","selector":"h3","read":"text"}]}. Reads: text, href, attribute (requires attribute).',
  },
  maxRows: { type: "integer", description: "Maximum complete data rows, 1..5000; default 500." },
  maxColumns: { type: "integer", description: "Maximum logical columns, 1..200; default 100." },
  extractTimeoutMs: {
    type: "integer",
    description: "Extraction time budget, 100..15000 milliseconds; default 5000.",
  },
  extractFormat: {
    type: "string",
    enum: ["json", "csv"],
    description: "JSON by default. CSV requires output and also writes a metadata sidecar.",
  },
  output: {
    type: "string",
    description:
      "Extract: optional new JSON/CSV file on the CLI host; returns a receipt instead of all rows.",
  },
  csvSafe: {
    type: "boolean",
    description:
      "CSV only: prefix formula-like values with an apostrophe; retain originals in metadata.",
  },
} as const;

export function registerExtractTool(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  register(
    defineTool({
      name: "inspect.extract",
      description:
        "Read loaded DOM tables/lists as rows, columns and provenance. No scrolling or pagination; inspect coverage and warnings before treating data as complete.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        ...EXTRACT_PARAMETERS,
        ref: {
          type: "string",
          description: "A fresh DOM reference; exclusive with selector/extractTarget.",
        },
        maxBytes: {
          type: "integer",
          description:
            "Total JSON byte budget, 1024..4194304; default 262144 inline, 1048576 with output.",
        },
      },
      output: {
        schema: { type: "json" },
        // Compact JSON keeps the rendered size within the requested byte budget.
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const kind = args.extractKind ?? "discover";
        if (!["discover", "table", "list"].includes(kind))
          throw new Error("invalid extraction kind");
        if (
          [args.selector, args.extractTarget, args.ref].filter((value) => value !== undefined)
            .length > 1
        )
          throw new Error("selector, extractTarget and ref are mutually exclusive");
        if (args.extractFormat === "csv" && !args.output)
          throw new Error("CSV extraction requires output");
        if (args.extractFields !== undefined) {
          const value = JSON.parse(args.extractFields);
          if (!value || !Array.isArray(value.fields))
            throw new Error("extractFields must contain a fields array");
        }
        const sessionId = deps.registry.resolve(args.session, "bsk_inspect(action=extract)");
        const command = ["extract", kind, "--session", sessionId];
        appendTabId(command, args.tabId);
        for (const [value, flag] of [
          [args.selector, "--selector"],
          [args.extractTarget, "--target"],
          [args.ref, "--ref"],
          [args.itemSelector, "--item-selector"],
          [args.extractFields, "--fields-json"],
          [args.maxRows, "--max-rows"],
          [args.maxColumns, "--max-columns"],
          [args.maxBytes ?? (args.output ? undefined : INLINE_EXTRACT_MAX_BYTES), "--max-bytes"],
          [args.extractTimeoutMs, "--timeout-ms"],
          [args.extractFormat, "--format"],
          [args.output, "--out"],
        ] as const)
          if (value !== undefined) command.push(flag, String(value));
        if (args.csvSafe) command.push("--csv-safe");
        return (await runtime.run(exec, command, "extract", sessionId)) as never;
      },
    }),
  );
}
