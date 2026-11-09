import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type ToolResult } from "@deepseek-ai/dsh-tools";
import {
  appendTabId,
  type PhaseOneRuntime,
  requireNonEmpty,
  runnerTimeout,
  type ToolRegistrar,
} from "./phase-one-runtime";
import { createStepReceiptHandler } from "./step-receipt";
import { SESSION_PARAM, TAB_ID_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A run's 120s budget, a step still in flight, and reading its outputs. */
const RUN_BUDGET_MS = 120_000 + 3 * 35_000;

export const RECIPE_PARAMETERS = {
  session: {
    ...SESSION_PARAM,
    description:
      "run and draft: an owned session; run uses its current task tab and leaves it open.",
  },
  tabId: { ...TAB_ID_PARAM, description: "run: a task tab of the session." },
  name: { type: "string", description: "Recipe name for show, run, draft and rm." },
  params: {
    type: "object",
    additionalProperties: true,
    description: "run: parameter values by name, all strings.",
  },
  checked: {
    type: "string",
    description:
      "run: the run_id of an uncertain run whose effect you checked in the application's records. Until then the recipe does not run again.",
  },
  site: { type: "string", description: "list: only recipes allowed on this origin." },
  description: { type: "string", description: "draft: what the recipe does." },
  recipe: { type: "json", description: "save: the reviewed recipe document." },
} as const;

const output = {
  schema: { type: "json" as const },
  render: (_args: unknown, value: unknown) => [
    { type: "text" as const, text: JSON.stringify(value) },
  ],
};

function only(args: Record<string, unknown>, action: string, allowed: readonly string[]): void {
  for (const [key, value] of Object.entries(args))
    if (value !== undefined && !allowed.includes(key))
      throw new Error(`${key} does not apply to recipe ${action}`);
}

function presentRecipeResult(_args: never, result: ToolResult) {
  if (result.isError) return undefined;
  const block = result.content.find((item) => item.type === "text");
  if (!block || block.type !== "text") return undefined;
  return { card: "terminal" as const, output: block.text, exitCode: 0 };
}

/** Saved flows; a run uses an owned session so its handoff stays in this conversation. */
export function registerRecipeTool(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  const receipt = createStepReceiptHandler("recipe");
  const local = (action: string, command: string[]) =>
    defineTool({
      name: `recipe.${action}`,
      description: `Recipe ${action}; local to this machine, no browser call.`,
      parameters: RECIPE_PARAMETERS,
      output,
      async execute(args, exec) {
        only(args, action, action === "list" ? ["site"] : ["name"]);
        const cmd = ["recipe", ...command];
        if (action === "list") {
          if (args.site !== undefined) cmd.push("--site", args.site);
        } else {
          if (args.name === undefined) throw new Error("name is required");
          requireNonEmpty(args.name, "name");
          cmd.push(args.name);
        }
        return (await runtime.run(exec, cmd, `recipe ${action}`)) as never;
      },
      presentResult: presentRecipeResult,
    });
  register(local("list", ["list"]));
  register(local("show", ["show"]));
  register(local("rm", ["rm"]));

  register(
    defineTool({
      name: "recipe.save",
      description: "Check a reviewed recipe document and save it as the next revision.",
      parameters: { ...RECIPE_PARAMETERS, recipe: { ...RECIPE_PARAMETERS.recipe, required: true } },
      output,
      async execute(args, exec) {
        only(args, "save", ["recipe"]);
        if (typeof args.recipe !== "object" || args.recipe === null || Array.isArray(args.recipe))
          throw new Error("recipe must be a JSON object");
        // The CLI reads a file; a private one-off directory keeps it from other users.
        const directory = await mkdtemp(join(tmpdir(), "bsk-recipe-"));
        try {
          await chmod(directory, 0o700);
          const file = join(directory, "recipe.json");
          await writeFile(file, JSON.stringify(args.recipe), { mode: 0o600 });
          return (await runtime.run(
            exec,
            ["recipe", "save", "--file", file],
            "recipe save",
          )) as never;
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      presentResult: presentRecipeResult,
    }),
  );

  register(
    defineTool({
      name: "recipe.draft",
      description:
        "Draft a recipe from what an owned session just did, before stopping it, only if the user agrees.",
      parameters: { ...RECIPE_PARAMETERS, name: { ...RECIPE_PARAMETERS.name, required: true } },
      output,
      async execute(args, exec) {
        only(args, "draft", ["session", "name", "description"]);
        requireNonEmpty(args.name, "name");
        const session = deps.registry.resolve(args.session, "bsk_recipe(action=draft)");
        const command = ["recipe", "draft", "--session", session, "--name", args.name];
        if (args.description !== undefined) command.push("--description", args.description);
        return (await runtime.run(exec, command, "recipe draft", session)) as never;
      },
      presentResult: presentRecipeResult,
    }),
  );

  register(
    defineTool({
      name: "recipe.run",
      description:
        "Replay a saved recipe in an owned session. It stops at the first deviation and hands the page back.",
      parameters: { ...RECIPE_PARAMETERS, name: { ...RECIPE_PARAMETERS.name, required: true } },
      output,
      async execute(args, exec) {
        only(args, "run", ["session", "tabId", "name", "params", "checked"]);
        requireNonEmpty(args.name, "name");
        const session = deps.registry.resolve(args.session, "bsk_recipe(action=run)");
        const command = ["recipe", "run", args.name];
        for (const [key, value] of Object.entries(args.params ?? {})) {
          if (!IDENTIFIER.test(key)) throw new Error(`param ${key} is not an identifier`);
          if (typeof value !== "string") throw new Error(`param ${key} must be a string`);
          command.push("--param", `${key}=${value}`);
        }
        command.push("--session", session);
        appendTabId(command, args.tabId);
        if (args.checked !== undefined) {
          requireNonEmpty(args.checked, "checked");
          command.push("--checked", args.checked);
        }
        const reply = (await runtime.run(
          exec,
          command,
          "recipe run",
          session,
          runnerTimeout(deps, RUN_BUDGET_MS),
          { allowRecipeResult: true },
        )) as { status?: string };
        return receipt.complete(exec, reply, reply.status !== "completed") as never;
      },
      finalizeContent: receipt.finalizeContent,
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "recipe",
          "run",
          args.name,
          "--session",
          args.session ?? "(current)",
        ]),
        description: "Replay a saved flow; it hands the page back at the first deviation",
      }),
      presentResult: presentRecipeResult,
    }),
  );
}
