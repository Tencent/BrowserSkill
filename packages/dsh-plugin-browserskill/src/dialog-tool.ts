import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendTabId, type PhaseOneRuntime, type ToolRegistrar } from "./phase-one-runtime";
import { SESSION_PARAM, TAB_ID_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

export function registerDialogTool(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  register(
    defineTool({
      name: "page.dialog",
      description:
        "Inspect or answer a pending native JavaScript dialog. After a dialog_pending error, handle the dialog and inspect the page; never replay the original action automatically.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        dialogAction: { type: "string", enum: ["status", "accept", "dismiss"], required: true },
        text: {
          type: "string",
          description:
            "Prompt text for accept; omit to keep the default, or pass an empty string to clear it.",
        },
        dialogId: { type: "string", description: "Only handle this pending dialog ID." },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (!["status", "accept", "dismiss"].includes(args.dialogAction))
          throw new Error("dialogAction must be status, accept or dismiss");
        if (args.text !== undefined && args.dialogAction !== "accept")
          throw new Error("text requires dialogAction=accept");
        if (args.dialogId !== undefined && args.dialogAction === "status")
          throw new Error("dialogId requires accept or dismiss");
        const session = deps.registry.resolve(args.session, "browser_page(action=dialog)");
        const command = ["dialog", args.dialogAction, "--session", session];
        appendTabId(command, args.tabId);
        if (args.dialogId !== undefined) command.push("--dialog-id", args.dialogId);
        if (args.text !== undefined) command.push(`--text=${args.text}`);
        return (await runtime.run(exec, command, "dialog", session)) as never;
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine(["dialog", args.dialogAction]),
        description: "Handle JavaScript dialog",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );
}
