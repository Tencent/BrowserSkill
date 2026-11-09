import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendTabId, type PhaseOneRuntime, type ToolRegistrar } from "./phase-one-runtime";
import { SESSION_PARAM, TAB_ID_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

export const READ_PARAMETERS = {
  readFields: {
    type: "string",
    description:
      'read only: JSON array of {key,read,optional selector/attribute}. Reads: text (exact textContent), attribute, value, checked, exists. Example: [{"key":"index","read":"attribute","attribute":"data-swiper-slide-index"}]. No JavaScript.',
  },
  maxNodes: {
    type: "integer",
    description: "read only: 1..1000 DOM matches; default 100. Check truncated.",
  },
  readTimeoutMs: {
    type: "integer",
    description: "read only: collection budget, 100..10000ms; default 3000.",
  },
} as const;

export function registerReadTool(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  register(
    defineTool({
      name: "inspect.read",
      description:
        "Read current title/URL and bounded DOM fields through fixed synchronous isolated-world code. Tolerates unrelated dynamic changes. No scripts, input, callbacks or deferred effects. Use expect to protect these facts before acting; a read never renews control or a strict observation.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        ...READ_PARAMETERS,
        selector: {
          type: "string",
          description:
            "CSS selector in the main document; all matches up to maxNodes. Exclusive with ref. Omit both for the document root.",
        },
        ref: {
          type: "string",
          description:
            "Exact observed DOM ref, also in frames/shadow roots; never retargeted to a replacement.",
        },
        maxBytes: {
          type: "integer",
          description: "Total JSON budget, 1024..1048576; default 262144.",
        },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (args.ref !== undefined && args.selector !== undefined)
          throw new Error("ref and selector are mutually exclusive");
        if (args.readFields !== undefined && !Array.isArray(JSON.parse(args.readFields)))
          throw new Error("readFields must be a JSON array");
        const session = deps.registry.resolve(args.session, "bsk_inspect(action=read)");
        const command = ["read", "--session", session];
        appendTabId(command, args.tabId);
        for (const [value, flag] of [
          [args.selector, "--selector"],
          [args.ref, "--ref"],
          [args.readFields, "--fields-json"],
          [args.maxNodes, "--max-nodes"],
          [args.maxBytes, "--max-bytes"],
          [args.readTimeoutMs, "--timeout-ms"],
        ] as const)
          if (value !== undefined) command.push(flag, String(value));
        return (await runtime.run(exec, command, "read", session)) as never;
      },
    }),
  );
}
