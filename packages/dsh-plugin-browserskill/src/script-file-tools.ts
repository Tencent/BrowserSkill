import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  appendTabId,
  type PhaseOneRuntime,
  requireNonEmpty,
  requirePositive,
  runnerTimeout,
  type ToolRegistrar,
} from "./phase-one-runtime";
import { SESSION_PARAM, TAB_ID_PARAM, TIMEOUT_MS_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

/** Use the same ownership, queue, cancellation and context forwarding as other actions. */
export function registerScriptFileTools(
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
  const run = async (
    exec: ToolRunContext,
    session: string,
    command: string[],
    timeout?: number,
  ) => {
    const reply = await runtime.run(
      exec,
      command,
      command[0],
      session,
      runnerTimeout(deps, timeout),
    );
    return { session, ...(reply as Record<string, unknown>) };
  };
  register(
    defineTool({
      name: "interact.evaluate",
      description:
        "Evaluate JavaScript in an owned task tab. Use bsk_inspect(action=read) or extract for data on dynamic pages. Arbitrary scripts may write or defer effects, so a script is checked before it runs, in this order of preference: expect without observationId (target policy) or dependsOn (strict policy) states what the script relies on, and only that is checked, so it also runs on a page that keeps changing; observationId requires the whole page to still match; unverified, only when what the script relies on cannot be stated, compares nothing about the page and returns verified=false. A script already dispatched cannot be rolled back. Check application state after an uncertain result before retrying.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        timeoutMs: TIMEOUT_MS_PARAM,
        expression: {
          type: "string",
          required: true,
          description: "JavaScript expression to evaluate.",
        },
        awaitPromise: { type: "boolean", description: "Wait for promises (default true)." },
        returnByValue: { type: "boolean", description: "Return a JSON value (default true)." },
        unverified: {
          type: "boolean",
          description:
            "Last resort: run without comparing the page with any observation. Not with observationId, expect or dependsOn.",
        },
      },
      output,
      async execute(args, exec) {
        requireNonEmpty(args.expression, "expression");
        requirePositive(args.timeoutMs, "timeoutMs");
        // Asking for a page check and for none at once is a contradiction.
        const evidence = exec as ToolRunContext & {
          observationDependencies?: string[];
          observationId?: string;
          actionExpectations?: unknown[];
        };
        if (
          args.unverified === true &&
          (evidence.observationId !== undefined ||
            evidence.actionExpectations !== undefined ||
            evidence.observationDependencies?.length)
        )
          throw new Error(
            "unverified skips page verification; omit observationId, expect and dependsOn, or omit unverified to have them checked",
          );
        const session = deps.registry.resolve(args.session, "bsk_interact(action=evaluate)");
        const command = ["evaluate", args.expression, "--session", session];
        appendTabId(command, args.tabId);
        if (args.awaitPromise === false) command.push("--await-promise", "false");
        if (args.returnByValue === false) command.push("--return-by-value", "false");
        if (args.timeoutMs !== undefined) command.push("--timeout", `${args.timeoutMs}ms`);
        if (args.unverified === true) command.push("--unverified");
        return run(exec, session, command, args.timeoutMs ?? 30000);
      },
      presentResult: runtime.presentTerminalResult,
    }),
  );
  register(
    defineTool({
      name: "interact.upload",
      description:
        "Attach local files through an observed file chooser trigger or explicit drop target. Files are staged by the existing CLI transfer service.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        timeoutMs: TIMEOUT_MS_PARAM,
        target: {
          type: "string",
          required: true,
          description: "Observed ref or selector for the input/chooser trigger or drop target.",
        },
        files: {
          type: "array",
          required: true,
          items: { type: "string" },
          description: "One to twenty local file paths.",
        },
        mode: {
          type: "string",
          enum: ["input", "drop"],
          description: "Upload mechanism, default input.",
        },
      },
      output,
      async execute(args, exec) {
        requireNonEmpty(args.target, "target");
        requirePositive(args.timeoutMs, "timeoutMs");
        if (!args.files.length || args.files.length > 20)
          throw new Error("files requires one to twenty paths");
        for (const file of args.files) requireNonEmpty(file, "file");
        const session = deps.registry.resolve(args.session, "bsk_interact(action=upload)");
        const command = ["upload", args.target, "--session", session];
        appendTabId(command, args.tabId);
        for (const file of args.files) command.push("--file", file);
        if (args.mode) command.push("--mode", args.mode);
        if (args.timeoutMs !== undefined) command.push("--timeout", `${args.timeoutMs}ms`);
        return run(exec, session, command, args.timeoutMs ?? 120000);
      },
      presentResult: runtime.presentTerminalResult,
    }),
  );
  register(
    defineTool({
      name: "interact.download",
      description:
        "Click an observed download trigger and save one attributed browser download to a local output path. Existing files require overwrite=true.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        timeoutMs: TIMEOUT_MS_PARAM,
        target: {
          type: "string",
          required: true,
          description: "Observed ref or selector for the download trigger.",
        },
        output: { type: "string", required: true, description: "Local destination file." },
        overwrite: { type: "boolean", description: "Allow replacing the destination." },
      },
      output,
      async execute(args, exec) {
        requireNonEmpty(args.target, "target");
        requireNonEmpty(args.output, "output");
        requirePositive(args.timeoutMs, "timeoutMs");
        const session = deps.registry.resolve(args.session, "bsk_interact(action=download)");
        const command = ["download", args.target, "--session", session, "--out", args.output];
        appendTabId(command, args.tabId);
        if (args.overwrite) command.push("--overwrite");
        if (args.timeoutMs !== undefined) command.push("--timeout", `${args.timeoutMs}ms`);
        return run(exec, session, command, args.timeoutMs ?? 120000);
      },
      presentResult: runtime.presentTerminalResult,
    }),
  );
}
