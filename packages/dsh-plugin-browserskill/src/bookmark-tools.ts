import { defineTool } from "@deepseek-ai/dsh-tools";
import type { PhaseOneRuntime, ToolRegistrar } from "./phase-one-runtime";
import { SESSION_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

export const BOOKMARK_PARAMETERS = {
  nodeId: {
    type: "string",
    description: "Bookmark or folder ID from the selected profile's bookmark tree.",
  },
  parentId: { type: "string", description: "Destination folder ID from that bookmark tree." },
  index: { type: "integer", description: "Nonnegative bookmark insertion index." },
} as const;

export function registerBookmarkTools(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  for (const [name, command] of [
    ["inspect.bookmarks", "tree"],
    ["assist.bookmarks-move", "move"],
    ["assist.bookmarks-create-folder", "create-folder"],
    ["assist.bookmarks-remove-empty-folder", "remove-empty-folder"],
  ] as const) {
    register(
      defineTool({
        name,
        description:
          "Read or edit local profile bookmarks. Requires the extension's optional bookmark permission. Save a backup before edits; inspect the tree after a lost reply.",
        parameters: {
          session: SESSION_PARAM,
          ...BOOKMARK_PARAMETERS,
          title: { type: "string", description: "Folder title for create-folder." },
        },
        output: {
          schema: { type: "json" },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
        },
        isConcurrencySafe: () => command === "tree",
        async execute(args, exec) {
          const session = deps.registry.resolve(args.session, name);
          const argv = ["bookmarks", "--session", session, command];
          const node = command === "move" || command === "remove-empty-folder";
          const parent = command === "move" || command === "create-folder";
          if (node && (!args.nodeId || !args.nodeId.trim())) throw new Error("nodeId is required");
          if (parent && (!args.parentId || !args.parentId.trim()))
            throw new Error("parentId is required");
          if (command === "create-folder" && args.title === undefined)
            throw new Error("title is required");
          if (
            (!node && args.nodeId !== undefined) ||
            (!parent && (args.parentId !== undefined || args.index !== undefined)) ||
            (command !== "create-folder" && args.title !== undefined)
          )
            throw new Error("Unexpected bookmark operation argument");
          if (args.index !== undefined && (!Number.isSafeInteger(args.index) || args.index < 0))
            throw new Error("index must be a nonnegative integer");
          if (parent) argv.push("--parent", args.parentId!);
          if (args.index !== undefined) argv.push("--index", String(args.index));
          if (node) argv.push("--", args.nodeId!);
          if (command === "create-folder") argv.push("--", args.title!);
          return (await runtime.run(
            exec,
            argv,
            name,
            session,
            Math.max(deps.config.defaultTimeoutMs, 40_000),
          )) as never;
        },
        presentCall: (args) => ({
          card: "terminal",
          title: runtime.commandLine([
            "bookmarks",
            "--session",
            args.session ?? "(current)",
            command,
          ]),
          description: "Local profile bookmarks",
        }),
        presentResult: runtime.presentTerminalResult,
      }),
    );
  }
}
